import type { AppConfig } from "./config.js";
import type { AssistantTextMode } from "./assistant-text-mode.js";
import { resolveAssistantTextMode } from "./assistant-text-mode.js";
import type { ChatCompletionRequest } from "./openai.js";
import {
  resolveClientToolsEnabled,
  resolveCursorToolMode,
  type CursorToolMode,
} from "./tool-mode.js";

export type { AssistantTextMode } from "./assistant-text-mode.js";
export type { CursorToolMode } from "./tool-mode.js";

export interface TurnPolicy {
  includeThinking: boolean;
  emitCursorTools: boolean;
  // When true, narrate native tool starts/results as reasoning_content. Mutually
  // exclusive with emitCursorTools and never set when client tools are bridged.
  nativeProgress: boolean;
  // When true, the request's client tools are registered as SDK customTools and
  // captured by the bridge as OpenAI tool_calls. customTools are built in
  // agent-turn.ts when this is set.
  clientTools: boolean;
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

export function resolveNativeProgress(
  request: ChatCompletionRequest,
  config: AppConfig,
  toolMode: CursorToolMode,
): boolean {
  if (request.cursor_native_progress !== undefined) {
    return request.cursor_native_progress;
  }
  if (config.CURSOR_NATIVE_PROGRESS !== undefined) {
    return config.CURSOR_NATIVE_PROGRESS;
  }
  // Native turns are delegated Cursor workers whose tool activity is invisible
  // to the caller, so narrate by default. Client/auto text turns stay silent
  // unless explicitly opted in via cursor_native_progress / CURSOR_NATIVE_PROGRESS.
  return toolMode === "native";
}

export function resolveTurnPolicy(
  request: ChatCompletionRequest,
  config: AppConfig,
): TurnPolicy {
  const toolMode = resolveCursorToolMode(request, config);
  const clientTools = resolveClientToolsEnabled(request, toolMode);
  const includeThinking = resolveIncludeThinking(request, config);
  // The captured native tool calls are surfaced as OpenAI tool_calls by the
  // bridge mapping in agent-turn.ts, so emitCursorTools (which would also map
  // SDK tool deltas) must stay off for client-tool turns — one channel.
  const emitCursorTools =
    !clientTools && resolveEmitToolCalls(request, config);
  // Narration shares the SDK tool-event stream with emitCursorTools but writes a
  // different channel (reasoning_content vs tool_calls). Force it off whenever
  // client tools are bridged, or tool calls are already emitted as tool_calls,
  // so a tool event is never narrated twice.
  const nativeProgress =
    !clientTools &&
    !emitCursorTools &&
    resolveNativeProgress(request, config, toolMode);
  return {
    includeThinking,
    emitCursorTools,
    nativeProgress,
    clientTools,
    toolMode,
    debugStream: config.DEBUG_STREAM ?? false,
    assistantTextMode: resolveAssistantTextMode(request, config),
  };
}
