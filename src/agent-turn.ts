import { Agent, type ModelSelection, type Run } from "@cursor/sdk";
import {
  buildSendOptions,
  pumpSdkMessageStream,
  startStreamWatchdog,
  type StreamActivity,
} from "./agent-stream.js";
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
  ClientToolCaptureSink,
  buildClientToolCustomTools,
} from "./client-tools/custom-tools-bridge.js";
import { toOpenAiToolCalls } from "./client-tools/openai-map.js";
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
}

function createAgentOptions(
  config: ProxyContext["config"],
  sdkModel: ModelSelection,
) {
  return {
    apiKey: config.CURSOR_API_KEY,
    model: sdkModel,
    local: { cwd: config.CURSOR_CWD, settingSources: [] },
  };
}

async function runTurnBody(
  ctx: AgentTurnContext,
  options: AgentTurnOptions,
  prepared: PreparedChatSession,
  resolved: ResolvedModel,
  turnStream: TurnStreamContext,
): Promise<AgentTurnOutcome> {
  const { request, proxy, abortSignal } = ctx;
  const { config, sessions } = proxy;
  const extras = promptExtrasFromRequest(request);

  const state = createStreamState(resolved.clientModel, {
    maxTokens: request.max_tokens,
    agentId: prepared.agentId,
  });
  const cursorMeta = new CursorMetaAccumulator(
    prepared.agentId,
    prepared.sessionKey,
  );

  const payload = buildSendPayload(
    prepared.deltaMessages,
    extras,
    turnStream.clientToolSpecs,
  );

  // Client-tool bridge: register the request's client tools as in-process SDK
  // customTools so a native invocation of a caller tool is captured (and
  // converted to an OpenAI tool_call) instead of failing with "Tool not found".
  // This is the sole client-tool channel; non-client turns skip it entirely.
  // Tiering is applied to the customTool schemas (the prompt no longer carries a
  // tool inventory), so it MUST live here to stay token-neutral.
  const clientToolSpecs = turnStream.clientToolSpecs;
  const captureSink =
    turnStream.policy.clientToolLoop && clientToolSpecs?.length
      ? new ClientToolCaptureSink()
      : undefined;
  const customTools =
    captureSink && clientToolSpecs
      ? buildClientToolCustomTools(
          clientToolSpecs,
          captureSink,
          resolveToolTier(config),
        )
      : undefined;

  let run: Run | undefined;
  let runCompleted = false;
  let unbindAbort: (() => void) | undefined;
  const sink = createStreamSink(options.stream?.write, state, cursorMeta);
  // Track liveness off the emitted deltas (what the consumer actually sees) so
  // the stall watchdog measures TTFB and inter-delta idle, not raw SDK events.
  const activity: StreamActivity = {
    firstDeltaAt: undefined,
    lastActivityAt: Date.now(),
  };
  const onChunk = (chunk: ChatCompletionChunk) => {
    const now = Date.now();
    activity.lastActivityAt = now;
    if (activity.firstDeltaAt === undefined) activity.firstDeltaAt = now;
    return sink.writeDelta(chunk);
  };

  try {
    // Per-send `model` is authoritative for tier/params; create-time model on reused
    // agents may differ when switching `*-slow` / `*-fast` mid-session.
    const sendStartedAt = Date.now();
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

    // Bound the streaming window: cancel + 504 if the run never produces a first
    // delta (TTFB) or goes silent mid-stream (idle), instead of hanging forever.
    const watchdog = startStreamWatchdog(run, activity, {
      ttfbTimeoutMs: config.CURSOR_STREAM_TTFB_TIMEOUT_MS,
      idleTimeoutMs: config.CURSOR_STREAM_IDLE_TIMEOUT_MS,
      sendStartedAt,
    });
    try {
      const pump = pumpSdkMessageStream(
        run,
        state,
        turnStream.policy.debugStream,
        onChunk,
      );
      // The race's loser keeps running; ensure its rejection can't go unhandled.
      pump.catch(() => {});
      await Promise.race([pump, watchdog.expired]);
    } finally {
      // Once the stream has drained, idle/TTFB no longer apply — only the
      // streaming window is guarded.
      watchdog.stop();
    }

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

    await sink.complete();

    return {
      state,
      meta: cursorMeta,
      prepared,
      finalText: result.result,
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
  const agentOptions = createAgentOptions(config, resolved.sdk);

  const prepared = await sessions.prepareChatSession(
    () => Agent.create(agentOptions),
    request,
    resolved.sdk.id,
    config,
    headers,
    agentOptions,
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
    // session. The guard throws before any stream output is written, so evicting
    // the agent and retrying once on a fresh one is safe even when streaming —
    // and since the caller resends the full conversation, the fresh agent
    // recovers cleanly. Only attempt this for a reused, keyed agent; a fresh
    // agent that hits this is a genuine error, not a stale-cache artifact.
    if (!isActiveRunError(err) || prepared.isNewAgent || !prepared.sessionKey) {
      throw err;
    }
    // Observable so a giant double-prefill (the fresh agent re-sends the full
    // conversation) doesn't look like a silent retry.
    console.warn(
      `[cursor-openai-api] active-run self-heal: evicting wedged session ` +
        `${prepared.sessionKey} and retrying once on a fresh agent ` +
        `(re-sends the full conversation — watch for a double prefill).`,
    );
    sessions.evictSession(prepared.sessionKey);
    const freshAgent = await Agent.create(agentOptions);
    const fresh: PreparedChatSession = {
      agent: freshAgent,
      agentId: freshAgent.agentId,
      deltaMessages: request.messages,
      sessionKey: prepared.sessionKey,
      retainAgent: true,
      isNewAgent: true,
    };
    return await runPrepared(fresh);
  }
}
