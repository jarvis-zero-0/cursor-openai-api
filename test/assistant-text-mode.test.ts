import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import {
  DEFAULT_ASSISTANT_TEXT_MODE,
  parseAssistantTextMode,
  resolveAssistantTextMode,
} from "../src/assistant-text-mode.js";
import type { ChatCompletionRequest } from "../src/openai.js";

describe("assistant text mode", () => {
  test("default mode is live", () => {
    expect(DEFAULT_ASSISTANT_TEXT_MODE).toBe("live");
  });

  test("parseAssistantTextMode rejects invalid values", () => {
    expect(parseAssistantTextMode("transcript")).toBeUndefined();
    expect(parseAssistantTextMode("preamble-as-reasoning")).toBe(
      "preamble-as-reasoning",
    );
  });

  test("resolveAssistantTextMode prefers request override", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "k",
      CURSOR_CWD: "/tmp",
      CURSOR_ASSISTANT_TEXT_MODE: "final-content",
    });
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_assistant_text_mode: "preamble-as-reasoning",
    } satisfies ChatCompletionRequest;

    expect(resolveAssistantTextMode(request, config)).toBe(
      "preamble-as-reasoning",
    );
  });

  test("loadConfig defaults CURSOR_ASSISTANT_TEXT_MODE to live", () => {
    const config = loadConfig({ CURSOR_API_KEY: "k", CURSOR_CWD: "/tmp" });
    expect(config.CURSOR_ASSISTANT_TEXT_MODE).toBe("live");
  });
});
