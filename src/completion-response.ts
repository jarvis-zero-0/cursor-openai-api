import { attachCursorMeta, type CursorCompletionMeta } from "./cursor-meta.js";
import { resolveFinishReason } from "./finish-reason.js";
import type {
  ChatCompletionChoice,
  ChatCompletionResponse,
} from "./openai.js";
import { finalizeToolCalls, type StreamState } from "./stream.js";
import { normalizeToolArguments } from "./tool-args.js";

export function buildCompletionResponse(
  state: StreamState,
  meta: CursorCompletionMeta,
  finalText?: string,
): ChatCompletionResponse {
  finalizeToolCalls(state);
  const text = finalText?.trim() || state.text.trim();
  const content = text.length > 0 ? text : null;
  const toolCalls = [...state.toolCalls.values()].map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: normalizeToolArguments(tc.arguments),
    },
  }));

  const choice: ChatCompletionChoice = {
    index: 0,
    message: {
      role: "assistant",
      content: toolCalls.length > 0 ? content : (content ?? ""),
      ...(state.reasoningText.trim()
        ? { reasoning_content: state.reasoningText.trim() }
        : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: resolveFinishReason(state, "stop"),
  };

  return attachCursorMeta(
    {
      id: state.completionId,
      object: "chat.completion",
      created: state.created,
      model: state.model,
      choices: [choice],
      ...(state.usage ? { usage: state.usage } : {}),
    },
    meta,
  );
}
