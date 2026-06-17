import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ChatCompletionRequest } from "./openai.js";
import { hasClientTools } from "./client-tools/request.js";

// Tool modes:
//   - `native` : delegated worker — full Cursor SDK built-ins, no client tools.
//   - `client` / `auto` : any client tools on the request are registered as
//     native SDK `customTools` and captured by the bridge as OpenAI tool_calls.
// There is no marker protocol; the native customTools channel is the only
// client-tool path.
export const CURSOR_TOOL_MODES = ["auto", "client", "native"] as const;
export type CursorToolMode = (typeof CURSOR_TOOL_MODES)[number];

export const DEFAULT_CURSOR_TOOL_MODE: CursorToolMode = "auto";

const cursorToolModeSchema = z.enum(CURSOR_TOOL_MODES);

export function parseCursorToolMode(
  value: string | undefined,
): CursorToolMode | undefined {
  if (value === undefined) return undefined;
  const parsed = cursorToolModeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function toolModeFromMetadata(
  request: ChatCompletionRequest,
): CursorToolMode | undefined {
  const meta = request.metadata;
  if (!meta) return undefined;
  return (
    parseCursorToolMode(meta["cursor_tool_mode"]) ??
    parseCursorToolMode(meta["cursorToolMode"])
  );
}

export function resolveCursorToolMode(
  request: ChatCompletionRequest,
  config: AppConfig,
): CursorToolMode {
  if (request.cursor_tool_mode !== undefined) {
    return request.cursor_tool_mode;
  }
  const fromMeta = toolModeFromMetadata(request);
  if (fromMeta) return fromMeta;
  return config.CURSOR_TOOL_MODE ?? DEFAULT_CURSOR_TOOL_MODE;
}

/**
 * Whether this turn should register the request's client tools as native SDK
 * `customTools` (captured by the bridge as OpenAI tool_calls). `native` is a
 * delegated worker and never bridges client tools; `client` and `auto` bridge
 * them whenever the request actually carries any.
 */
export function resolveClientToolsEnabled(
  request: ChatCompletionRequest,
  toolMode: CursorToolMode,
): boolean {
  switch (toolMode) {
    case "native":
      return false;
    case "client":
    case "auto":
    default:
      return hasClientTools(request);
  }
}
