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

  test("lists reconciled self-serve tools that are present this turn", () => {
    const sections = buildClientToolPromptSections(
      [{ role: "user", content: "Go" }],
      [
        { name: "delegate_task" },
        { name: "memory" },
        { name: "send_message" },
        { name: "cronjob" },
        { name: "clarify" },
        { name: "web_search" },
        { name: "skill_view" },
        { name: "skills_list" },
        { name: "skill_manage" },
        { name: "session_search" },
      ],
      null,
    );
    const joined = sections.join("\n");
    expect(joined).toContain("self-serve tools directly on the main thread");
    // Manifest order: skills → session_search → web_search → hermes-only ops.
    expect(joined).toContain(
      "skill_view, skills_list, skill_manage, session_search, web_search, memory, cronjob, send_message, clarify.",
    );
  });

  test("self-serve line only names tools actually sent (intersection)", () => {
    const sections = buildClientToolPromptSections(
      [{ role: "user", content: "Go" }],
      [{ name: "delegate_task" }, { name: "memory" }, { name: "skill_view" }],
      null,
    );
    const joined = sections.join("\n");
    expect(joined).toContain("skill_view, memory.");
    expect(joined).not.toContain("session_search");
    expect(joined).not.toContain("web_search");
  });

  test("falls back to the irreducible-op line when no self-serve tools present", () => {
    const sections = buildClientToolPromptSections(
      [{ role: "user", content: "Go" }],
      [{ name: "delegate_task" }],
      null,
    );
    const joined = sections.join("\n");
    expect(joined).toContain(
      "Only a zero-lookup acknowledgement or a single irreducible Hermes-only operation",
    );
  });
});
