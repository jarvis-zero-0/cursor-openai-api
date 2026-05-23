import { describe, expect, test } from "bun:test";
import { finishChunk, createStreamState } from "../src/stream.js";
import {
  applyTurnEndedUsage,
  estimateReasoningTokens,
  mapCursorUsageToOpenAI,
} from "../src/usage.js";

describe("usage mapping", () => {
  test("maps Cursor turn usage to OpenAI usage", () => {
    expect(
      mapCursorUsageToOpenAI({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
      }),
    ).toEqual({
      prompt_tokens: 130,
      completion_tokens: 50,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 20 },
    });
  });

  test("omits prompt_tokens_details when no cache read", () => {
    expect(
      mapCursorUsageToOpenAI({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 10,
      }),
    ).toEqual({
      prompt_tokens: 110,
      completion_tokens: 50,
      total_tokens: 160,
    });
  });

  test("estimateReasoningTokens splits output by character ratio", () => {
    expect(estimateReasoningTokens(100, "aaaa", "bbbb")).toBe(50);
    expect(estimateReasoningTokens(100, "reasoning only", "")).toBe(100);
    expect(estimateReasoningTokens(100, "", "text only")).toBe(0);
  });

  test("maps reasoning_tokens when reasoning text was streamed", () => {
    expect(
      mapCursorUsageToOpenAI(
        {
          inputTokens: 10,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        { reasoningText: "x".repeat(75), completionText: "y".repeat(25) },
      ),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 100,
      total_tokens: 110,
      completion_tokens_details: { reasoning_tokens: 75 },
    });
  });

  test("omits completion_tokens_details when no reasoning text", () => {
    expect(
      mapCursorUsageToOpenAI(
        {
          inputTokens: 10,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        { completionText: "answer" },
      ).completion_tokens_details,
    ).toBeUndefined();
  });

  test("applyTurnEndedUsage ignores non turn-ended updates", () => {
    expect(applyTurnEndedUsage({ type: "text-delta", text: "hi" })).toBeUndefined();
  });

  test("applyTurnEndedUsage extracts turn-ended usage", () => {
    expect(
      applyTurnEndedUsage({
        type: "turn-ended",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
        },
      }),
    ).toEqual({
      prompt_tokens: 13,
      completion_tokens: 5,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 },
    });
  });

  test("applyTurnEndedUsage includes reasoning_tokens from stream state", () => {
    expect(
      applyTurnEndedUsage(
        {
          type: "turn-ended",
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        { reasoningText: "thinking", completionText: "" },
      ),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 20 },
    });
  });

  test("finish chunk includes usage when captured", () => {
    const state = createStreamState("composer-2");
    state.usage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    };
    const done = finishChunk(state);
    expect(done.usage).toEqual(state.usage);
  });
});
