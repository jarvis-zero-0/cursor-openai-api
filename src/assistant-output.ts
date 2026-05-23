import type { ChatCompletionChunk } from "./openai.js";
import {
  bufferAssistantText,
  chunkFromAssistantText,
  chunkFromReasoningText,
  flushBufferedAssistantText,
  flushBufferedAssistantTextAsReasoning,
  type StreamState,
} from "./stream.js";
import type { TurnPolicy } from "./turn-policy.js";

export function emitAssistantText(
  state: StreamState,
  policy: TurnPolicy,
  text: string,
): ChatCompletionChunk | null {
  if (!text) return null;
  if (policy.assistantTextMode === "live") {
    return chunkFromAssistantText(state, text);
  }
  bufferAssistantText(state, text);
  return null;
}

export function* beforeInterleavedBoundary(
  state: StreamState,
  policy: TurnPolicy,
): Generator<ChatCompletionChunk | null> {
  if (!state.pendingText || policy.assistantTextMode === "live") return;

  if (policy.assistantTextMode === "preamble-as-reasoning" && policy.includeThinking) {
    const flushed = flushBufferedAssistantTextAsReasoning(state);
    if (flushed) yield flushed;
  }
}

export function flushAssistantText(
  state: StreamState,
  policy: TurnPolicy,
): ChatCompletionChunk | null {
  if (policy.assistantTextMode === "live" || !state.pendingText) {
    return null;
  }
  return flushBufferedAssistantText(state);
}
