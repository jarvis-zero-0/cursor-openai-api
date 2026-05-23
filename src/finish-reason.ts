import type { ChatCompletionChoice } from "./openai.js";
import type { StreamState } from "./stream.js";

export type CompletionFinishReason = ChatCompletionChoice["finish_reason"];

export function resolveFinishReason(
  state: Pick<StreamState, "toolCalls" | "maxTokens" | "usage">,
  preferred: "stop" | "tool_calls" = "stop",
): CompletionFinishReason {
  if (state.toolCalls.size > 0) return "tool_calls";
  if (
    state.maxTokens != null &&
    state.maxTokens > 0 &&
    state.usage?.completion_tokens != null &&
    state.usage.completion_tokens >= state.maxTokens
  ) {
    return "length";
  }
  return preferred;
}
