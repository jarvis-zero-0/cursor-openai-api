import { describe, expect, test } from "bun:test";
import { chatCompletionRequestSchema } from "../src/openai.js";

describe("chatCompletionRequestSchema", () => {
  test("accepts minimal valid request", () => {
    const parsed = chatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stream).toBe(false);
    }
  });

  test("rejects empty messages", () => {
    const parsed = chatCompletionRequestSchema.safeParse({ messages: [] });
    expect(parsed.success).toBe(false);
  });

  test("preserves unknown fields", () => {
    const parsed = chatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "hi" }],
      custom_client_field: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        (parsed.data as Record<string, unknown>).custom_client_field,
      ).toBe(true);
    }
  });

  test("accepts cursor model params and thinking flags", () => {
    const parsed = chatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "hi" }],
      cursor_model_params: [{ id: "thinking_effort", value: "high" }],
      reasoning_effort: "low",
      cursor_include_thinking: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cursor_model_params).toEqual([
        { id: "thinking_effort", value: "high" },
      ]);
      expect(parsed.data.reasoning_effort).toBe("low");
      expect(parsed.data.cursor_include_thinking).toBe(false);
    }
  });

  test("rejects cursor_model_params with empty id", () => {
    const parsed = chatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "hi" }],
      cursor_model_params: [{ id: "", value: "high" }],
    });
    expect(parsed.success).toBe(false);
  });
});
