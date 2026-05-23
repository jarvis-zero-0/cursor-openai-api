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
