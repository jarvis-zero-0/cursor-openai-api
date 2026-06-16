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
    const separated = applyPendingSeparator(state, text);
    return chunkFromAssistantText(state, separated);
  }
  bufferAssistantText(state, text);
  return null;
}

// In live mode a boundary cannot rewrite already-emitted text, so it instead
// records that the next text run must be separated. Inject a newline only when
// neither side already supplies whitespace, avoiding fused sentences without
// adding stray blank lines mid-paragraph.
function applyPendingSeparator(state: StreamState, text: string): string {
  if (!state.needsTextSeparator) return text;
  state.needsTextSeparator = false;
  const lastChar = state.text.slice(-1);
  if (lastChar && !/\s/.test(lastChar) && !/^\s/.test(text)) {
    return `\n${text}`;
  }
  return text;
}

export function* beforeInterleavedBoundary(
  state: StreamState,
  policy: TurnPolicy,
): Generator<ChatCompletionChunk | null> {
  if (policy.assistantTextMode === "live") {
    if (state.text && !/\s$/.test(state.text)) {
      state.needsTextSeparator = true;
    }
    return;
  }

  if (!state.pendingText) return;

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
