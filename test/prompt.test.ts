import { describe, expect, test } from "bun:test";
import { buildSendPayload } from "../src/messages.js";
import { serializeMessagesToPrompt } from "../src/prompt.js";

describe("serializeMessagesToPrompt", () => {
  test("formats system and user messages", () => {
    const prompt = serializeMessagesToPrompt([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ]);
    expect(prompt).toContain("## SYSTEM");
    expect(prompt).toContain("Be concise.");
    expect(prompt).toContain("## USER");
    expect(prompt).toContain("Hello");
  });

  test("formats assistant reasoning_content for multi-turn", () => {
    const prompt = serializeMessagesToPrompt([
      {
        role: "assistant",
        content: "Answer.",
        reasoning_content: "Internal plan.",
      },
    ]);
    expect(prompt).toContain("reasoning_content:");
    expect(prompt).toContain("Internal plan.");
    expect(prompt).toContain("Answer.");
  });

  test("formats assistant tool_calls", () => {
    const prompt = serializeMessagesToPrompt([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
    ]);
    expect(prompt).toContain("tool_call id=call_1");
    expect(prompt).toContain("get_weather");
  });

  test("buildSendPayload sends plain text for a single user follow-up", () => {
    const payload = buildSendPayload([{ role: "user", content: "What is it?" }]);
    expect(payload).toBe("What is it?");
    expect(payload).not.toContain("## USER");
  });

  test("includes client tools when provided", () => {
    const prompt = serializeMessagesToPrompt([{ role: "user", content: "Hi" }], {
      tools: [{ type: "function", function: { name: "foo" } }],
    });
    expect(prompt).toContain("CLIENT_TOOLS");
    expect(prompt).toContain("foo");
  });

  test("uses client tool loop prompt when specs are provided", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Hi" }],
      {
        tools: [{ type: "function", function: { name: "foo" } }],
      },
      [{ name: "foo" }],
    );
    expect(prompt).toContain("CLIENT TOOL INVENTORY");
    expect(prompt).toContain("tool_calls_begin");
    expect(prompt).toContain("TOOL ROUTING (authoritative");
    expect(prompt).toContain("cursor_tool_mode=client");
    expect(prompt).not.toContain("## CLIENT_TOOLS");
  });

  test("uses native directive when tool mode is native", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Refactor auth.ts" }],
      undefined,
      undefined,
      "native",
    );
    expect(prompt).toContain("standalone Cursor SDK agent");
    expect(prompt).toContain("Do NOT use the Hermes/client marker protocol");
  });

  test("client mode forbids Cursor citation code fences", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Explain the cwd plumbing" }],
      { tools: [{ type: "function", function: { name: "foo" } }] },
      [{ name: "foo" }],
    );
    expect(prompt).toContain("OUTPUT FORMATTING");
    expect(prompt).toContain("line-numbered citation code fences");
    expect(prompt).toContain("startLine:endLine:filepath");
  });

  test("client mode explains how to signal completion / return control", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Do the thing" }],
      { tools: [{ type: "function", function: { name: "foo" } }] },
      [{ name: "foo" }],
    );
    expect(prompt).toContain("COMPLETION / RETURNING CONTROL");
    expect(prompt).toContain("absence of a tool call");
    expect(prompt).toContain("main agent thread");
  });

  test("client mode explains calling other models / subagents", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Do the thing" }],
      { tools: [{ type: "function", function: { name: "delegate_task" } }] },
      [{ name: "delegate_task" }],
    );
    expect(prompt).toContain("CALLING OTHER MODELS / SUBAGENTS");
    expect(prompt).toContain("delegate_task");
  });

  test("tiered tool mode renders resident schemas full and the rest brief", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Hi" }],
      {
        tools: [
          { type: "function", function: { name: "read_file" } },
          { type: "function", function: { name: "cronjob" } },
        ],
        toolTier: { mode: "tiered", resident: new Set(["read_file"]) },
      },
      [
        { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: {} }, required: ["path"] } },
        { name: "cronjob", description: "Manage cron. Second sentence.", parameters: { type: "object", properties: { action: {}, job_id: {} }, required: ["action"] } },
      ],
    );
    expect(prompt).toContain("BRIEF TOOLS");
    expect(prompt).toContain("cronjob(action, job_id?) — Manage cron.");
    expect(prompt).toContain('{"name":"read_file"');
    expect(prompt).not.toContain('{"name":"cronjob"');
  });

  test("brief tool mode renders every tool as a signature", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Hi" }],
      {
        tools: [{ type: "function", function: { name: "terminal" } }],
        toolTier: { mode: "brief", resident: new Set() },
      },
      [
        { name: "terminal", description: "Run shell.", parameters: { type: "object", properties: { command: {}, timeout: {} }, required: ["command"] } },
      ],
    );
    expect(prompt).toContain("BRIEF TOOLS");
    expect(prompt).toContain("terminal(command, timeout?) — Run shell.");
    expect(prompt).not.toContain('{"name":"terminal"');
  });

  test("default (no tier) still renders full schemas", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Hi" }],
      { tools: [{ type: "function", function: { name: "foo" } }] },
      [{ name: "foo", description: "Foo tool.", parameters: { type: "object", properties: {} } }],
    );
    expect(prompt).not.toContain("BRIEF TOOLS");
    expect(prompt).toContain('{"name":"foo"');
  });

  test("native mode explains how to signal completion / return control", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Refactor auth.ts" }],
      undefined,
      undefined,
      "native",
    );
    expect(prompt).toContain("COMPLETION / RETURNING CONTROL");
    expect(prompt).toContain("control returns to the orchestrator");
    expect(prompt).toContain("no done/stop token");
  });
});
