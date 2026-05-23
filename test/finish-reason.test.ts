import { describe, expect, test } from "bun:test";
import { resolveFinishReason } from "../src/finish-reason.js";

describe("resolveFinishReason", () => {
  test("prefers tool_calls when tools present", () => {
    expect(
      resolveFinishReason({
        toolCalls: { size: 1 },
        usage: undefined,
      }),
    ).toBe("tool_calls");
  });

  test("returns length when completion meets max_tokens", () => {
    expect(
      resolveFinishReason({
        toolCalls: { size: 0 },
        maxTokens: 100,
        usage: { completion_tokens: 100 },
      }),
    ).toBe("length");
  });

  test("returns stop by default", () => {
    expect(
      resolveFinishReason({
        toolCalls: { size: 0 },
        usage: { completion_tokens: 10 },
      }),
    ).toBe("stop");
  });
});
