import { describe, expect, test } from "bun:test";
import { buildSendPayload } from "../src/messages.js";
import {
  buildNativeToolDirective,
  serializeMessagesToPrompt,
} from "../src/prompt.js";

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

  test("uses native directive when tool mode is native", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Refactor auth.ts" }],
      undefined,
      "native",
    );
    expect(prompt).toContain("standalone Cursor SDK agent");
    expect(prompt).toContain("Use Cursor built-in tools directly");
  });

  test("native mode explains how to signal completion / return control", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Refactor auth.ts" }],
      undefined,
      "native",
    );
    expect(prompt).toContain("COMPLETION / RETURNING CONTROL");
    expect(prompt).toContain("control returns to the orchestrator");
    expect(prompt).toContain("no done/stop token");
  });
});

describe("buildNativeToolDirective SKILLS", () => {
  test("includes the SKILLS execution-plane block by default", () => {
    const directive = buildNativeToolDirective();
    expect(directive).toContain("SKILLS (execution-plane model):");
    expect(directive).toContain("AUTO-LOADED from ~/.cursor/skills-cursor/");
    expect(directive).toContain(
      "skill_view / skills_list / skill_manage are Hermes CONTROL-PLANE tools",
    );
    expect(directive).toContain(
      "author it under <workspace>/.cursor/skills/<name>/SKILL.md",
    );
  });

  test("omits SKILL ROUTING when no skillNote is supplied", () => {
    expect(buildNativeToolDirective()).not.toContain("SKILL ROUTING");
    expect(
      buildNativeToolDirective({ workspacePath: "/work" }),
    ).not.toContain("SKILL ROUTING");
  });

  test("appends the orchestrator SKILL ROUTING note when provided", () => {
    const directive = buildNativeToolDirective({
      skillNote: "Use the pdf-export skill for this task.",
    });
    expect(directive).toContain("SKILL ROUTING (from orchestrator):");
    expect(directive).toContain("Use the pdf-export skill for this task.");
  });
});
