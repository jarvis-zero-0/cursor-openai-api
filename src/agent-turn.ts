import path from "node:path";
import { realpathSync } from "node:fs";
import {
  Agent,
  type ModelSelection,
  type Run,
  type SettingSource,
} from "@cursor/sdk";
import {
  buildSendOptions,
  pumpSdkMessageStream,
  startStreamWatchdog,
  type StreamActivity,
} from "./agent-stream.js";
import { authHealth } from "./auth-health.js";
import { beginTurn, endTurn } from "./recycle.js";
import { CursorMetaAccumulator } from "./cursor-meta.js";
import {
  isActiveRunError,
  isAuthWedgeError,
  ProxyError,
  mapCursorError,
} from "./errors.js";
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

interface LocalAgentScope {
  cwd: string;
  settingSources: SettingSource[];
}

/**
 * Canonicalize a path for allowlist containment: absolute-resolve, then follow
 * symlinks when the path exists (so a symlinked repo root and its real path
 * compare equal). Falls back to the resolved path when realpath fails.
 */
function canonicalize(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** True when `target` is one of, or nested under, an allowlist entry. */
function isUnderAllowlist(target: string, allowlist: string[]): boolean {
  const t = canonicalize(target);
  for (const entry of allowlist) {
    const base = canonicalize(entry);
    if (t === base || t.startsWith(base + path.sep)) return true;
  }
  return false;
}

function readRequestString(
  request: ChatCompletionRequest,
  key: string,
): string | undefined {
  const value = (request as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the local-agent scope (cwd + settingSources) for this turn.
 *
 * `settingSources` is always empty — no entry point loads ambient `project`
 * disk settings via the SDK. In the Cursor SDK, the `project` setting source is
 * a single coupled switch that gates BOTH `.cursor/rules` + AGENTS.md AND the
 * project `.cursor/mcp.json` servers (see `includeProjectMcp` in the SDK), so
 * we deliberately leave it off: delegated native leaves must NOT pull in the
 * heavy generated contract mdc or project hermes-tools MCP. The generated
 * contract is IDE-only — native leaves receive no contract document via
 * ``messages[]`` or ``settingSources``; skill delivery is task-scoped pointers
 * in ``context`` (orchestrator packs, worker Read's SKILL.md).
 *
 * Hermes tool delivery is entry-point-specific:
 * - **Orchestrator (client mode):** OpenAI `tools[]` → SDK `customTools` bridge
 *   (capture-only; Hermes executes handlers) — independent of `settingSources`.
 * - **Native delegated leaf:** `tool_choice: "none"` — no customTools bridge, no
 *   Hermes tools on the wire; Cursor built-ins only.
 * - **Plain Cursor IDE (not this proxy):** loads `hermes-tools` MCP from
 *   `.cursor/mcp.json` natively; unaffected by this scope.
 *
 * A native worker leaf still runs at its own repo cwd (an allowlisted
 * `cursor_cwd`) so file/terminal tools operate in the right tree; an
 * out-of-allowlist `cursor_cwd` warns and falls back to `CURSOR_CWD`.
 */
export function resolveLocalAgentScope(
  request: ChatCompletionRequest,
  config: ProxyContext["config"],
): LocalAgentScope {
  if (readRequestString(request, "cursor_tool_mode") !== "native") {
    return { cwd: config.CURSOR_CWD, settingSources: [] };
  }

  let cwd = config.CURSOR_CWD;
  const requestedCwd = readRequestString(request, "cursor_cwd");
  if (requestedCwd) {
    if (isUnderAllowlist(requestedCwd, config.CURSOR_CWD_ALLOWLIST)) {
      cwd = requestedCwd;
    } else {
      console.warn(
        `[cursor-openai-api] native cursor_cwd ${JSON.stringify(requestedCwd)} ` +
          `is not under CURSOR_CWD_ALLOWLIST; falling back to ${config.CURSOR_CWD}.`,
      );
    }
  }
  return { cwd, settingSources: [] };
}

function createAgentOptions(
  config: ProxyContext["config"],
  sdkModel: ModelSelection,
  scope: LocalAgentScope,
) {
  return {
    apiKey: config.CURSOR_API_KEY,
    model: sdkModel,
    local: { cwd: scope.cwd, settingSources: scope.settingSources },
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
  const scope = resolveLocalAgentScope(request, config);
  const agentOptions = createAgentOptions(config, resolved.sdk, scope);

  const prepared = await sessions.prepareChatSession(
    () => Agent.create(agentOptions),
    request,
    resolved.sdk.id,
    config,
    headers,
    agentOptions,
  );

  const runPrepared = async (p: PreparedChatSession) => {
    // Count this turn so the proactive recycle waits for it to drain before
    // restarting (it must never cut off a live streaming request).
    beginTurn();
    try {
      const outcome = await sessions.withAgentTurn(p.agentId, () =>
        runTurnBody(ctx, options, p, resolved, turnStream),
      );
      // A completed turn proves auth is healthy; clear any auth-wedge streak.
      authHealth.recordSuccess();
      return outcome;
    } finally {
      endTurn();
    }
  };

  try {
    return await runPrepared(prepared);
  } catch (err) {
    // Stale-auth wedge: the long-lived process holds a rejected Cursor auth
    // session, so a fresh in-process agent reuses the same poisoned transport
    // and keeps failing (an in-process self-heal here would loop uselessly).
    // Count it; the monitor exits the process after a threshold so launchd
    // KeepAlive restarts with fresh auth — the only known recovery.
    if (isAuthWedgeError(err)) {
      authHealth.recordAuthWedge();
      throw err;
    }
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
      // Same agentOptions → same scope as the evicted agent.
      scopeSig: prepared.scopeSig,
    };
    return await runPrepared(fresh);
  }
}
