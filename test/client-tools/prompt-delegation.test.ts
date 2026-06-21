import { describe, expect, test } from "bun:test";
import { buildClientToolPromptSections } from "../../src/client-tools/prompt.js";

describe("buildClientToolPromptSections — DELEGATION_DIRECTIVE", () => {
  test("does NOT inject delegation directive when delegate_task is absent", () => {
    const sections = buildClientToolPromptSections(
      [{ role: "user", content: "Hello" }],
      [{ name: "foo" }, { name: "bar" }],
      null,
    );
    const joined = sections.join("\n");
    expect(joined).not.toContain("orchestrator/router");
    expect(joined).not.toContain("delegate_task");
  });

  test("injects DELEGATION_DIRECTIVE when delegate_task is in tools list", () => {
    const sections = buildClientToolPromptSections(
      [{ role: "user", content: "Do some research" }],
      [{ name: "memory" }, { name: "delegate_task" }, { name: "send_message" }],
      null,
    );
    const joined = sections.join("\n");
    expect(joined).toContain("orchestrator/router");
    expect(joined).toContain("Do NOT do substantive work yourself");
    expect(joined).toContain("classify the request");
  });

  test("DELEGATION_DIRECTIVE appears right after TOOL_SYSTEM_DIRECTIVE (second section)", () => {
    const sections = buildClientToolPromptSections(
      [{ role: "user", content: "Hi" }],
      [{ name: "delegate_task" }],
      null,
    );
    // sections[0] = TOOL_SYSTEM_DIRECTIVE, sections[1] = DELEGATION_DIRECTIVE
    expect(sections[0]).toContain("OpenAI-compatible API request through Cursor");
    expect(sections[1]).toContain("orchestrator/router");
  });

  test("still includes conversation and base directive alongside delegation steer", () => {
    const sections = buildClientToolPromptSections(
      [{ role: "user", content: "Plan this" }],
      [{ name: "delegate_task" }],
      null,
    );
    const joined = sections.join("\n");
    expect(joined).toContain("OpenAI-compatible API request through Cursor");
    expect(joined).toContain("Conversation:");
    expect(joined).toContain("Plan this");
  });

  test("works with delegate_task as the sole tool", () => {
    const sections = buildClientToolPromptSections(
      [{ role: "user", content: "Go" }],
      [{ name: "delegate_task" }],
      null,
    );
    expect(sections.join("\n")).toContain("orchestrator/router");
  });
});
