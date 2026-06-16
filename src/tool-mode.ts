import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ChatCompletionRequest } from "./openai.js";
import { isClientToolLoop } from "./client-tools/request.js";

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

export function resolveClientToolLoopEnabled(
  request: ChatCompletionRequest,
  toolMode: CursorToolMode,
): boolean {
  const hasClientTools = isClientToolLoop(request);
  switch (toolMode) {
    case "native":
      return false;
    case "client":
      return hasClientTools;
    case "auto":
    default:
      return hasClientTools;
  }
}
