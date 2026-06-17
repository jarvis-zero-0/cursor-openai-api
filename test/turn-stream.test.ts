import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import type { ChatCompletionRequest } from "../src/openai.js";
import { resolveTurnStreamContext } from "../src/turn-stream.js";

const baseConfig = {
  CURSOR_API_KEY: "k",
  CURSOR_CWD: "/tmp",
  PORT: 8080,
  HOST: "0.0.0.0",
  DEFAULT_MODEL: "composer-2.5",
  CURSOR_INCLUDE_THINKING: true,
  CURSOR_EMIT_TOOL_CALLS: false,
  CURSOR_ASSISTANT_TEXT_MODE: "live" as const,
  CURSOR_TOOL_MODE: "client" as const,
  CURSOR_ENABLE_SESSIONS: true,
  CURSOR_AUTO_SESSION: true,
  CURSOR_SESSION_TTL_MS: 1,
  CURSOR_SESSION_MAX: 1,
} satisfies AppConfig;

function fn(name: string) {
  return { type: "function", function: { name } };
}

describe("resolveTurnStreamContext tool filtering", () => {
  test("filters client tool specs by enabled toolsets", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [fn("read_file"), fn("terminal"), fn("browser_navigate"), fn("cronjob")],
      cursor_enabled_toolsets: ["file", "terminal"],
      cursor_toolsets_keep_unmapped: false,
    } satisfies ChatCompletionRequest;

    const ctx = resolveTurnStreamContext(request, baseConfig);
    const names = ctx.clientToolSpecs?.map((s) => s.name).sort();
    expect(names).toEqual(["read_file", "terminal"]);
  });

  test("leaves specs intact when no filter configured", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [fn("read_file"), fn("browser_navigate")],
    } satisfies ChatCompletionRequest;

    const ctx = resolveTurnStreamContext(request, baseConfig);
    expect(ctx.clientToolSpecs?.map((s) => s.name)).toEqual([
      "read_file",
      "browser_navigate",
    ]);
  });

  test("client mode populates client tool specs (for the customTools build)", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [fn("read_file"), fn("terminal")],
      cursor_tool_mode: "client",
    } satisfies ChatCompletionRequest;

    const ctx = resolveTurnStreamContext(request, baseConfig);
    expect(ctx.policy.clientTools).toBe(true);
    expect(ctx.clientToolSpecs?.map((s) => s.name)).toEqual([
      "read_file",
      "terminal",
    ]);
  });

  test("native mode does not populate client tool specs", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [fn("read_file"), fn("terminal")],
      cursor_tool_mode: "native",
    } satisfies ChatCompletionRequest;

    const ctx = resolveTurnStreamContext(request, baseConfig);
    expect(ctx.policy.clientTools).toBe(false);
    expect(ctx.clientToolSpecs).toBeUndefined();
  });
});
