import type { InteractionUpdate } from "@cursor/sdk";
import type { OpenAIUsage } from "./openai.js";

export type CursorTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type UsageContentLengths = {
  reasoningText?: string;
  completionText?: string;
};

export function estimateReasoningTokens(
  outputTokens: number,
  reasoningText: string,
  completionText: string,
): number {
  if (outputTokens <= 0) return 0;

  const reasoningChars = reasoningText.trim().length;
  if (reasoningChars === 0) return 0;

  const textChars = completionText.trim().length;
  const totalChars = reasoningChars + textChars;
  if (totalChars === 0) return 0;

  return Math.min(
    outputTokens,
    Math.max(1, Math.round((outputTokens * reasoningChars) / totalChars)),
  );
}

export function mapCursorUsageToOpenAI(
  usage: CursorTurnUsage,
  content?: UsageContentLengths,
): OpenAIUsage {
  const prompt_tokens =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const completion_tokens = usage.outputTokens;
  const result: OpenAIUsage = {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
  if (usage.cacheReadTokens > 0) {
    result.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens };
  }
  // cache_write is not in the OpenAI usage schema; exposed via `cursor.cache_write_tokens`.

  const reasoning_tokens = estimateReasoningTokens(
    completion_tokens,
    content?.reasoningText ?? "",
    content?.completionText ?? "",
  );
  if (reasoning_tokens > 0) {
    result.completion_tokens_details = { reasoning_tokens };
  }

  return result;
}

export function applyTurnEndedUsage(
  update: InteractionUpdate,
  content?: UsageContentLengths,
): OpenAIUsage | undefined {
  if (update.type !== "turn-ended" || !update.usage) return undefined;
  return mapCursorUsageToOpenAI(update.usage, content);
}
