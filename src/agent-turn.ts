import {
  Agent,
  type ModelSelection,
  type Run,
  type SettingSource,
} from "@cursor/sdk";
import type { CursorToolMode } from "./tool-mode.js";
import {
  cwdIdentity,
  requestedSkillNote,
  resolveWorkspaceCwd,
} from "./workspace.js";
import { buildSendOptions, pumpSdkMessageStream } from "./agent-stream.js";
import { CursorMetaAccumulator } from "./cursor-meta.js";
import { isActiveRunError, ProxyError, mapCursorError } from "./errors.js";
import { resolveModel, type ResolvedModel } from "./model.js";
import { resolveTurnStreamContext, type TurnStreamContext } from "./turn-stream.js";
import {
  buildSendPayload,
  promptExtrasFromRequest,
} from "./messages.js";
import { resolveToolTier } from "./client-tools/catalog.js";
import {
  parseHandoff,
  stripHandoffFence,
  type Handoff,
} from "./client-tools/handoff.js";
import {
  ClientToolCaptureSink,
  buildClientToolCustomTools,
} from "./client-tools/custom-tools-bridge.js";
import { toOpenAiToolCalls } from "./client-tools/openai-map.js";
import { recordToolUsage } from "./client-tools/usage-log.js";
import type { NativeToolContext } from "./prompt.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "./openai.js";
import type { ProxyContext } from "./proxy-context.js";
import { bindRunAbort, cancelRunIfIncomplete } from "./run-lifecycle.js";
import type { PreparedChatSession } from "./session-store.js";
import type { SessionRequestHeaders } from "./session-keys.js";
import {
  chunkFromToolDelta,
  createStreamState,
  type StreamState,
} from "./stream.js";
import {
  type ChatChunkWriter,
  createStreamSink,
} from "./stream-sink.js";

export type { ChatChunkWriter } from "./stream-sink.js";

interface AgentTurnContext {
  proxy: ProxyContext;
  request: ChatCompletionRequest;
  headers?: SessionRequestHeaders;
  abortSignal?: AbortSignal;
}

export interface AgentTurnOptions {
  stream?: {
    write: ChatChunkWriter;
  };
}

export interface AgentTurnOutcome {
  state: StreamState;
  meta: CursorMetaAccumulator;
  prepared: PreparedChatSession;
  finalText?: string;
  // Parsed structured self-report from a native leaf's final text (subagent
  // handoff contract, §4). Present only on the native success path; undefined for
  // client turns, which do not participate in the handoff contract.
  handoff?: Handoff;
}

function createAgentOptions(
  config: ProxyContext["config"],
  sdkModel: ModelSelection,
  cwd: string | string[],
  toolMode: CursorToolMode,
) {
  // Native-mode agents run Cursor's built-in tools directly against `cwd`, so
  // load the workspace's project rules (AGENTS.md / .cursorrules) to steer them.
  // Client/auto turns bridge tool calls back to the caller as customTools and do
  // not run SDK tools locally, so keep their setup minimal: identity comes from
  // being a real Cursor agent + the slim Hermes content, not project rules.
  //
  // The SDK cannot disable/allowlist the always-live built-in Read/Shell/Grep,
  // so client/auto turns rely on the minimal prompt steer (NATIVE_CLIENT_TOOL_STEER).
  const settingSources: SettingSource[] =
    toolMode === "native" ? ["project"] : [];
  return {
    apiKey: config.CURSOR_API_KEY,
    model: sdkModel,
    local: { cwd, settingSources },
  };
}

async function runTurnBody(
  ctx: AgentTurnContext,
  options: AgentTurnOptions,
  prepared: PreparedChatSession,
  resolved: ResolvedModel,
  turnStream: TurnStreamContext,
): Promise<AgentTurnOutcome> {
  const { request, proxy, abortSignal, headers } = ctx;
  const { config, sessions } = proxy;
  const extras = promptExtrasFromRequest(request);
  extras.toolTier = resolveToolTier(request, config);

  const state = createStreamState(resolved.clientModel, {
    maxTokens: request.max_tokens,
    agentId: prepared.agentId,
  });
  const cursorMeta = new CursorMetaAccumulator(
    prepared.agentId,
    prepared.sessionKey,
  );

  // The native tool directive is a one-time system-style preamble. Reused
  // (keyed/auto/resumed) agents already have it from the turn that created them,
  // so only inject it on a fresh agent; otherwise every follow-up turn re-sends
  // the whole ROLE/CAPABILITIES block and burns tokens.
  const injectNativeDirective =
    turnStream.policy.toolMode === "native" && prepared.isNewAgent;
  const nativeCtx: NativeToolContext | undefined = injectNativeDirective
    ? {
        workspacePath: prepared.cwd,
        proxyBaseUrl: `http://localhost:${config.PORT}`,
        skillNote: requestedSkillNote(request, headers),
      }
    : undefined;

  // Self-delegation note (handoff contract §6): a native leaf drives Cursor's
  // own SDK tools. `turnStream.clientToolSpecs` is only ever populated when
  // `policy.clientTools` is true, and `resolveClientToolsEnabled` returns false
  // for `native` regardless of the request's `tools[]` (src/tool-mode.ts) — so a
  // native turn NEVER has client tool specs and the client-tools payload path is
  // never taken. A delegated child legitimately still carries Hermes `tools[]`
  // on the wire (with `tool_choice: "none"`), and native simply ignores them by
  // design rather than rejecting — a hard 400 here would break that path.
  const payload = buildSendPayload(
    prepared.deltaMessages,
    extras,
    turnStream.clientToolSpecs,
    injectNativeDirective ? "native" : undefined,
    nativeCtx,
  );

  // Client-tool bridge: register the request's client tools as in-process SDK
  // customTools so a native invocation of a Hermes tool is captured (and
  // converted to an OpenAI tool_call) instead of failing with "Tool not found".
  // This is the PRIMARY (and only) client-tool channel; native/auto-plain turns
  // skip it entirely.
  const clientToolSpecs = turnStream.clientToolSpecs;
  const buildCustomTools =
    turnStream.policy.clientTools && !!clientToolSpecs?.length;
  const captureSink = buildCustomTools
    ? new ClientToolCaptureSink()
    : undefined;
  // Apply the tiered customTool schemas — the prompt tool-dump is stripped
  // entirely on the client-tool path, so tiering MUST live in the customTool
  // schemas.
  const customToolTier = extras.toolTier;
  const customTools =
    captureSink && clientToolSpecs
      ? buildClientToolCustomTools(clientToolSpecs, captureSink, customToolTier)
      : undefined;

  let run: Run | undefined;
  let runCompleted = false;
  let unbindAbort: (() => void) | undefined;
  const sink = createStreamSink(options.stream?.write, state, cursorMeta);
  const onChunk = (chunk: ChatCompletionChunk) => sink.writeDelta(chunk);

  try {
    // Per-send `model` is authoritative for tier/params; create-time model on reused
    // agents may differ when switching `*-slow` / `*-fast` mid-session.
    run = await prepared.agent.send(
      payload,
      buildSendOptions(state, turnStream, resolved.sdk, onChunk, customTools),
    );
    unbindAbort = bindRunAbort(run, abortSignal);
    // Cancel the run once a client tool is captured so the turn ends with the
    // tool call(s) for the caller to execute, rather than the SDK feeding a
    // placeholder result back to the model and continuing. The sink DEBOUNCES
    // this cancel (deferred to the next macrotask, re-armed on each capture) so
    // that when the model emits N parallel tool calls in one turn, all N land in
    // `execute` before the run is cancelled — cancelling on the first capture
    // would abort the stream and drop calls 2..N. Cancel is fire-and-forget.
    if (captureSink) {
      const activeRun = run;
      captureSink.bindCancel(() => {
        if (activeRun.supports("cancel")) {
          void activeRun.cancel().catch(() => {});
        }
      });
    }
    cursorMeta.setRunId(run.id);
    await sink.begin();

    await pumpSdkMessageStream(run, state, turnStream.policy, onChunk);

    const result = await run.wait();
    runCompleted = true;

    // A bridged turn deliberately cancels its own run, so a "cancelled" (or even
    // "error") status with captures in hand is the success path, not a failure.
    const bridged = captureSink?.hasCaptured() ?? false;
    if (!bridged) {
      if (result.status === "error") {
        throw new ProxyError(
          result.result ?? "Agent run failed",
          502,
          "server_error",
          "agent_run_error",
        );
      }
      if (result.status === "cancelled") {
        throw new ProxyError("Agent run was cancelled", 499, "server_error");
      }
    }

    if (bridged && captureSink && clientToolSpecs) {
      // Convert the captured native calls into OpenAI tool_calls. Emitting via
      // chunkFromToolDelta both streams the delta (when streaming) and populates
      // state.toolCalls, so finish_reason resolves to "tool_calls" on both paths.
      const mapped = toOpenAiToolCalls({
        toolCalls: [...captureSink.captured],
        tools: clientToolSpecs,
        responseId: state.completionId,
        startIndex: state.toolCalls.size,
      });
      for (const call of mapped) {
        recordToolUsage(call.function.name);
        await onChunk(
          chunkFromToolDelta(
            state,
            call.id,
            call.function.name,
            call.function.arguments,
          ),
        );
      }
    }

    cursorMeta.mergeFromStream(state);
    const committedKey = sessions.commitChatSession(
      prepared,
      request,
      resolved.sdk.id,
      config,
    );
    if (committedKey) {
      cursorMeta.setSessionId(committedKey);
      prepared.sessionKey = committedKey;
    }

    // Parse the structured handoff block out of the leaf's final text (§4).
    // Only native leaves participate in the handoff contract; for client turns
    // parsing would fabricate a degraded 'partial' report from ordinary chat, so
    // leave `handoff` undefined. Strip the ```handoff fence from message content
    // so orchestrators never see raw machine blocks; the parsed report rides
    // `cursor.handoff` and AgentTurnOutcome.handoff.
    const rawFinalText = result.result ?? "";
    const handoff =
      turnStream.policy.toolMode === "native"
        ? parseHandoff(rawFinalText).report
        : undefined;
    if (handoff) cursorMeta.setHandoff(handoff);
    const finalText =
      turnStream.policy.toolMode === "native"
        ? stripHandoffFence(rawFinalText)
        : rawFinalText;

    await sink.complete();

    return {
      state,
      meta: cursorMeta,
      prepared,
      finalText,
      handoff,
    };
  } catch (err) {
    cursorMeta.mergeFromStream(state);
    await sink.fail();
    throw mapCursorError(err);
  } finally {
    unbindAbort?.();
    await cancelRunIfIncomplete(run, runCompleted);
    await sessions.releaseChatAgent(prepared);
  }
}

export async function executeAgentTurn(
  ctx: AgentTurnContext,
  options: AgentTurnOptions = {},
): Promise<AgentTurnOutcome> {
  const { request, proxy, headers } = ctx;
  const { config, sessions } = proxy;
  const turnStream = resolveTurnStreamContext(request, config);
  const resolved = await resolveModel(
    request,
    config,
    turnStream.policy.includeThinking,
  );
  const cwd = resolveWorkspaceCwd(request, headers, config);
  const agentOptions = createAgentOptions(
    config,
    resolved.sdk,
    cwd,
    turnStream.policy.toolMode,
  );

  // The SDK agent is created with the full (possibly multi-root) cwd, but the
  // session cache keys by a single canonical string so reuse keeps matching.
  const prepared = await sessions.prepareChatSession(
    () => Agent.create(agentOptions),
    request,
    resolved.sdk.id,
    config,
    headers,
    agentOptions,
    cwdIdentity(cwd),
  );

  const runPrepared = (p: PreparedChatSession) =>
    sessions.withAgentTurn(p.agentId, () =>
      runTurnBody(ctx, options, p, resolved, turnStream),
    );

  try {
    return await runPrepared(prepared);
  } catch (err) {
    // Self-heal a cached agent left with a lingering non-terminal run (e.g. a
    // dropped stream / client disconnect). Reusing such an agent makes the SDK
    // throw "already has active run" on every turn, permanently wedging the
    // session (Hermes then exhausts its retries against the same poisoned
    // agent). The guard throws before any stream output is written, so evicting
    // the agent and retrying once on a fresh one is safe even when streaming —
    // and since Hermes resends the full conversation, the fresh agent recovers
    // cleanly. Only attempt this for a reused, keyed agent; a fresh agent that
    // hits this is a genuine error, not a stale-cache artifact.
    if (!isActiveRunError(err) || prepared.isNewAgent || !prepared.sessionKey) {
      throw err;
    }
    sessions.evictSession(prepared.sessionKey);
    const freshAgent = await Agent.create(agentOptions);
    const fresh: PreparedChatSession = {
      agent: freshAgent,
      agentId: freshAgent.agentId,
      deltaMessages: request.messages,
      sessionKey: prepared.sessionKey,
      cwd: prepared.cwd,
      retainAgent: true,
      isNewAgent: true,
    };
    return await runPrepared(fresh);
  }
}
