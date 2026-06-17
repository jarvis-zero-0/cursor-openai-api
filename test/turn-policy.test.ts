import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import type { ChatCompletionRequest } from "../src/openai.js";
import { resolveTurnPolicy } from "../src/turn-policy.js";

const baseConfig = {
  CURSOR_API_KEY: "k",
  CURSOR_CWD: "/tmp",
  PORT: 8080,
  HOST: "0.0.0.0",
  DEFAULT_MODEL: "composer-2.5",
  CURSOR_INCLUDE_THINKING: true,
  CURSOR_EMIT_TOOL_CALLS: true,
  CURSOR_TOOL_MODE: "auto" as const,
  CURSOR_ASSISTANT_TEXT_MODE: "live" as const,
  CURSOR_ENABLE_SESSIONS: true,
  CURSOR_AUTO_SESSION: true,
  CURSOR_SESSION_TTL_MS: 1,
  CURSOR_SESSION_MAX: 1,
} satisfies AppConfig;

describe("resolveTurnPolicy", () => {
  test("client tools bridged as customTools keep assistant text mode from config", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "echo", parameters: { type: "object", properties: {} } },
        },
      ],
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.clientTools).toBe(true);
    expect(policy.emitCursorTools).toBe(false);
    expect(policy.assistantTextMode).toBe("live");
  });

  test("request override wins over env", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_assistant_text_mode: "preamble-as-reasoning",
    } satisfies ChatCompletionRequest;

    expect(resolveTurnPolicy(request, baseConfig).assistantTextMode).toBe(
      "preamble-as-reasoning",
    );
  });

  test("tool_choice none disables client tools", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "echo" } }],
      tool_choice: "none",
    } satisfies ChatCompletionRequest;

    expect(resolveTurnPolicy(request, baseConfig).clientTools).toBe(false);
  });

  test("emitCursorTools follows config when no client tools", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.emitCursorTools).toBe(true);
    expect(policy.clientTools).toBe(false);
  });

  test("native tool mode disables client tools", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "echo" } }],
      cursor_tool_mode: "native",
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.toolMode).toBe("native");
    expect(policy.clientTools).toBe(false);
    expect(policy.emitCursorTools).toBe(true);
  });

  test("nativeProgress defaults on for native turns (no emit, no explicit flag)", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_tool_mode: "native",
      cursor_emit_tool_calls: false,
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.toolMode).toBe("native");
    expect(policy.nativeProgress).toBe(true);
  });

  test("nativeProgress stays off for non-native turns by default", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_emit_tool_calls: false,
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.toolMode).not.toBe("native");
    expect(policy.nativeProgress).toBe(false);
  });

  test("emitCursorTools forces nativeProgress off even on native turns", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_tool_mode: "native",
      cursor_emit_tool_calls: true,
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.emitCursorTools).toBe(true);
    expect(policy.nativeProgress).toBe(false);
  });

  test("per-request cursor_native_progress overrides the native default", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_tool_mode: "native",
      cursor_emit_tool_calls: false,
      cursor_native_progress: false,
    } satisfies ChatCompletionRequest;

    expect(resolveTurnPolicy(request, baseConfig).nativeProgress).toBe(false);
  });

  test("per-request cursor_native_progress can force on for non-native turns", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_emit_tool_calls: false,
      cursor_native_progress: true,
    } satisfies ChatCompletionRequest;

    expect(resolveTurnPolicy(request, baseConfig).nativeProgress).toBe(true);
  });

  const withTools = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "echo", parameters: { type: "object", properties: {} } },
      },
    ],
  } satisfies ChatCompletionRequest;

  test("client mode bridges client tools as native customTools", () => {
    const request = {
      ...withTools,
      cursor_tool_mode: "client",
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.toolMode).toBe("client");
    expect(policy.clientTools).toBe(true);
    // emitCursorTools forced off even though baseConfig enables it, so the
    // bridge mapping owns the single tool_calls channel.
    expect(policy.emitCursorTools).toBe(false);
    expect(policy.nativeProgress).toBe(false);
  });

  test("auto mode with client tools bridges them as customTools", () => {
    const request = {
      ...withTools,
      cursor_tool_mode: "auto",
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.toolMode).toBe("auto");
    expect(policy.clientTools).toBe(true);
    expect(policy.emitCursorTools).toBe(false);
  });

  test("client mode with no client tools does nothing special", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_tool_mode: "client",
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.clientTools).toBe(false);
    expect(policy.emitCursorTools).toBe(true);
  });
});
