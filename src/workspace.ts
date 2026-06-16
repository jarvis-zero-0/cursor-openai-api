import path from "node:path";
import type { AppConfig } from "./config.js";
import { ProxyError } from "./errors.js";
import type { ChatCompletionRequest } from "./openai.js";
import type { SessionRequestHeaders } from "./session-keys.js";

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/**
 * Per-request workspace override, mirroring how session id / tool mode are
 * threaded through metadata + headers. Precedence: explicit `cursor_cwd` field,
 * then `metadata.cursor_cwd` / `metadata.cursorCwd`, then the `x-cursor-cwd`
 * header. Falls back to the server default when nothing is supplied.
 */
function requestedCwd(
  request: ChatCompletionRequest,
  headers?: SessionRequestHeaders,
): string | undefined {
  const meta = request.metadata;
  return (
    trimmed(request.cursor_cwd) ??
    trimmed(meta?.["cursor_cwd"]) ??
    trimmed(meta?.["cursorCwd"]) ??
    trimmed(headers?.["x-cursor-cwd"])
  );
}

export function parseCwdAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

function isWithinRoot(target: string, root: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A requested cwd is allowed when no allowlist is configured (unrestricted), or
 * when it equals / sits under the configured default or one of the allowlisted
 * roots. The default `CURSOR_CWD` is always implicitly permitted.
 */
export function isCwdAllowed(target: string, config: AppConfig): boolean {
  const roots = parseCwdAllowlist(config.CURSOR_CWD_ALLOWLIST);
  if (roots.length === 0) return true;
  const allowed = [path.resolve(config.CURSOR_CWD), ...roots];
  return allowed.some((root) => isWithinRoot(target, root));
}

export function resolveWorkspaceCwd(
  request: ChatCompletionRequest,
  headers: SessionRequestHeaders | undefined,
  config: AppConfig,
): string {
  const requested = requestedCwd(request, headers);
  // Normalize the default the same way as overrides. cwd is part of an agent's
  // identity (see `cwdMatches` in session-cache.ts), so a raw, un-normalized
  // CURSOR_CWD here would not string-equal the `path.resolve()`d cwd a later
  // turn supplies for the same workspace — silently invalidating the keyed
  // session and spawning a fresh agent every turn.
  if (!requested) return path.resolve(config.CURSOR_CWD);

  const resolved = path.resolve(requested);
  if (!isCwdAllowed(resolved, config)) {
    throw new ProxyError(
      `Requested workspace cwd '${resolved}' is not permitted by CURSOR_CWD_ALLOWLIST`,
      400,
      "invalid_request_error",
      "cwd_not_allowed",
    );
  }
  return resolved;
}
