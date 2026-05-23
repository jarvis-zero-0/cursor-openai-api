import type { AppConfig } from "./config.js";
import type { AssistantTextMode } from "./assistant-text-mode.js";
import { resolveAssistantTextMode } from "./assistant-text-mode.js";
import { isClientToolLoop } from "./client-tools/request.js";
import type { ChatCompletionRequest } from "./openai.js";

export type { AssistantTextMode } from "./assistant-text-mode.js";

export interface TurnPolicy {
  includeThinking: boolean;
  emitCursorTools: boolean;
  clientToolLoop: boolean;
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
  const clientToolLoop = isClientToolLoop(request);
  const includeThinking = resolveIncludeThinking(request, config);
  const emitCursorTools =
    !clientToolLoop && resolveEmitToolCalls(request, config);
  return {
    includeThinking,
    emitCursorTools,
    clientToolLoop,
    debugStream: config.DEBUG_STREAM ?? false,
    assistantTextMode: resolveAssistantTextMode(request, config),
  };
}
