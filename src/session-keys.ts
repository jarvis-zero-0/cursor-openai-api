import type { ChatCompletionRequest } from "./openai.js";

export interface SessionRequestHeaders {
  "x-session-id"?: string;
  "x-cursor-cwd"?: string;
  "x-cursor-skill-note"?: string;
}

export function resolveSessionKey(
  request: ChatCompletionRequest,
  headers?: SessionRequestHeaders,
): string | undefined {
  const fromHeader = headers?.["x-session-id"]?.trim();
  if (fromHeader) return fromHeader;

  const meta = request.metadata;
  if (meta) {
    const fromMeta =
      meta["session_id"]?.trim() || meta["sessionId"]?.trim();
    if (fromMeta) return fromMeta;

    // Hermes and other gateways can pass a stable upstream session id so the
    // proxy reuses one Cursor agent per logical conversation instead of
    // relying on fragile auto-session message-prefix matching.
    const hermesId =
      meta["hermes_session_id"]?.trim() || meta["hermesSessionId"]?.trim();
    if (hermesId) return `hermes:${hermesId}`;
  }

  return undefined;
}

export function resolveResumeAgentId(
  request: ChatCompletionRequest,
): string | undefined {
  const meta = request.metadata;
  const fromMeta =
    meta?.["cursor_agent_id"]?.trim() || meta?.["cursorAgentId"]?.trim();
  return fromMeta;
}
