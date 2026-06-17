import { CursorAgentError } from "@cursor/sdk";

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

/**
 * The Cursor SDK throws `Error("Agent <id> already has active run")` from
 * `agent.send` when the agent's local store still points `activeRunId` at a
 * non-terminal run. A cached/reused agent left in that state (e.g. a stream
 * dropped before its run reached a terminal status) is effectively poisoned —
 * every subsequent reuse throws this, permanently wedging the session. The
 * message survives `mapCursorError` wrapping, so match against it directly.
 */
export function isActiveRunError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /already has active run/i.test(message);
}

export function mapCursorError(err: unknown): ProxyError {
  if (err instanceof ProxyError) return err;
  if (err instanceof CursorAgentError) {
    const status =
      err.name === "AuthenticationError"
        ? 401
        : err.name === "RateLimitError"
          ? 429
          : err.name === "ConfigurationError"
            ? 400
            : 502;
    return new ProxyError(err.message, status, "api_error", err.code);
  }
  if (err instanceof Error) {
    return new ProxyError(err.message, 500, "server_error");
  }
  return new ProxyError("Unknown error", 500, "server_error");
}
