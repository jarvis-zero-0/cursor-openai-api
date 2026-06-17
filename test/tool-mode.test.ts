import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import type { ChatCompletionRequest } from "../src/openai.js";
import {
  resolveClientToolsEnabled,
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

  test("client-native is no longer a recognized mode value (falls back to config)", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      metadata: { cursor_tool_mode: "client-native" },
    } satisfies ChatCompletionRequest;
    // Unrecognized metadata value is ignored; resolution falls back to config default.
    expect(resolveCursorToolMode(request, baseConfig)).toBe("auto");
  });
});

describe("resolveClientToolsEnabled", () => {
  const withTools = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
  } satisfies ChatCompletionRequest;

  test("auto enables client tools when tools are present", () => {
    expect(resolveClientToolsEnabled(withTools, "auto")).toBe(true);
  });

  test("client enables client tools when tools are present", () => {
    expect(resolveClientToolsEnabled(withTools, "client")).toBe(true);
  });

  test("native disables client tools even when tools are present", () => {
    expect(resolveClientToolsEnabled(withTools, "native")).toBe(false);
  });

  test("client without tools stays disabled", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatCompletionRequest;
    expect(resolveClientToolsEnabled(request, "client")).toBe(false);
  });

  test("tool_choice none disables client tools", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: "none",
    } satisfies ChatCompletionRequest;
    expect(resolveClientToolsEnabled(request, "client")).toBe(false);
  });
});
