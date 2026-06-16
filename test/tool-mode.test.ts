import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import type { ChatCompletionRequest } from "../src/openai.js";
import {
  resolveClientToolLoopEnabled,
  resolveCursorToolMode,
} from "../src/tool-mode.js";

const baseConfig = {
  CURSOR_API_KEY: "k",
  CURSOR_CWD: "/tmp",
  PORT: 8080,
  HOST: "0.0.0.0",
  DEFAULT_MODEL: "composer-2.5",
  CURSOR_INCLUDE_THINKING: true,
  CURSOR_EMIT_TOOL_CALLS: false,
  CURSOR_ASSISTANT_TEXT_MODE: "live" as const,
  CURSOR_TOOL_MODE: "auto" as const,
  CURSOR_ENABLE_SESSIONS: true,
  CURSOR_AUTO_SESSION: true,
  CURSOR_SESSION_TTL_MS: 1,
  CURSOR_SESSION_MAX: 1,
} satisfies AppConfig;

describe("resolveCursorToolMode", () => {
  test("defaults to auto", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatCompletionRequest;
    expect(resolveCursorToolMode(request, baseConfig)).toBe("auto");
  });

  test("request field wins over metadata and config", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_tool_mode: "native",
      metadata: { cursor_tool_mode: "client" },
    } satisfies ChatCompletionRequest;
    expect(resolveCursorToolMode(request, baseConfig)).toBe("native");
  });

  test("metadata cursorToolMode is accepted", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      metadata: { cursorToolMode: "client" },
    } satisfies ChatCompletionRequest;
    expect(resolveCursorToolMode(request, baseConfig)).toBe("client");
  });
});

describe("resolveClientToolLoopEnabled", () => {
  const withTools = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
  } satisfies ChatCompletionRequest;

  test("auto enables loop when tools are present", () => {
    expect(resolveClientToolLoopEnabled(withTools, "auto")).toBe(true);
  });

  test("client enables loop when tools are present", () => {
    expect(resolveClientToolLoopEnabled(withTools, "client")).toBe(true);
  });

  test("native disables loop even when tools are present", () => {
    expect(resolveClientToolLoopEnabled(withTools, "native")).toBe(false);
  });

  test("client without tools stays disabled", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatCompletionRequest;
    expect(resolveClientToolLoopEnabled(request, "client")).toBe(false);
  });
});
