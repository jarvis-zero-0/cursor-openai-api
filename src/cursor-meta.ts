import type { StreamState } from "./stream.js";
import type { Handoff } from "./client-tools/handoff.js";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  CursorCompletionMeta,
} from "./openai.js";

export type { CursorCompletionMeta };

export function cursorResponseHeaders(
  meta: CursorCompletionMeta | undefined,
): Record<string, string> {
  if (!meta) return {};
  const headers: Record<string, string> = {
    "X-Cursor-Agent-Id": meta.agent_id,
  };
  if (meta.run_id) headers["X-Cursor-Run-Id"] = meta.run_id;
  if (meta.session_id) headers["X-Cursor-Session-Id"] = meta.session_id;
  if (meta.request_id) headers["X-Cursor-Request-Id"] = meta.request_id;
  if (meta.actual_model) headers["X-Cursor-Actual-Model"] = meta.actual_model;
  return headers;
}

export function attachCursorMeta<
  T extends ChatCompletionResponse | ChatCompletionChunk,
>(payload: T, meta: CursorCompletionMeta | undefined): T {
  if (!meta) return payload;
  return { ...payload, cursor: meta };
}

export class CursorMetaAccumulator {
  private readonly base: CursorCompletionMeta;

  constructor(agentId: string, sessionKey?: string) {
    this.base = {
      agent_id: agentId,
      ...(sessionKey ? { session_id: sessionKey } : {}),
    };
  }

  mergeFromStream(state: StreamState): void {
    if (state.cursorMeta.actual_model) {
      this.base.actual_model = state.cursorMeta.actual_model;
    }
    if (state.cursorMeta.request_id) {
      this.base.request_id = state.cursorMeta.request_id;
    }
    if (state.cursorMeta.thinking_duration_ms != null) {
      this.base.thinking_duration_ms = state.cursorMeta.thinking_duration_ms;
    }
    if (state.cursorMeta.cache_write_tokens != null) {
      this.base.cache_write_tokens = state.cursorMeta.cache_write_tokens;
    }
  }

  setRunId(runId: string): void {
    this.base.run_id = runId;
  }

  setSessionId(sessionId: string): void {
    this.base.session_id = sessionId;
  }

  setHandoff(handoff: Handoff): void {
    this.base.handoff = handoff;
  }

  snapshot(): CursorCompletionMeta {
    return { ...this.base };
  }

  headers(): Record<string, string> {
    return cursorResponseHeaders(this.snapshot());
  }
}
