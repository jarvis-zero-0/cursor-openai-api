import type { AppConfig } from "./config.js";
import type { AssistantTextMode } from "./assistant-text-mode.js";
import { resolveAssistantTextMode } from "./assistant-text-mode.js";
import type { ChatCompletionRequest } from "./openai.js";
import {
  resolveClientToolLoopEnabled,
  resolveCursorToolMode,
  type CursorToolMode,
} from "./tool-mode.js";

export type { AssistantTextMode } from "./assistant-text-mode.js";
export type { CursorToolMode } from "./tool-mode.js";

export interface TurnPolicy {
  includeThinking: boolean;
  emitCursorTools: boolean;
  clientToolLoop: boolean;
  toolMode: CursorToolMode;
  debugStream: boolean;
  assistantTextMode: AssistantTextMode;
}

export function resolveIncludeThinking(
  request: ChatCompletionRequest,
  config: AppConfig,
): boolean {
  if (request.cursor_include_thinking !== undefined) {
    return request.cursor_include_thinking;
  }
  return config.CURSOR_INCLUDE_THINKING;
}

export function resolveEmitToolCalls(
  request: ChatCompletionRequest,
  config: AppConfig,
): boolean {
  if (request.cursor_emit_tool_calls !== undefined) {
    return request.cursor_emit_tool_calls;
  }
  return config.CURSOR_EMIT_TOOL_CALLS;
}

export function resolveTurnPolicy(
  request: ChatCompletionRequest,
  config: AppConfig,
): TurnPolicy {
  const toolMode = resolveCursorToolMode(request, config);
  const clientToolLoop = resolveClientToolLoopEnabled(request, toolMode);
  const includeThinking = resolveIncludeThinking(request, config);
  const emitCursorTools =
    !clientToolLoop && resolveEmitToolCalls(request, config);
  return {
    includeThinking,
    emitCursorTools,
    clientToolLoop,
    toolMode,
    debugStream: config.DEBUG_STREAM ?? false,
    assistantTextMode: resolveAssistantTextMode(request, config),
  };
}
