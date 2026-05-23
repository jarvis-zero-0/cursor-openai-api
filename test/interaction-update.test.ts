import { describe, expect, test } from "bun:test";
import { normalizeInteractionUpdate } from "../src/interaction-update.js";

describe("normalizeInteractionUpdate", () => {
  test("maps tool-call-started with snake_case keys", () => {
    const normalized = normalizeInteractionUpdate({
      type: "tool-call-started",
      call_id: "c1",
      tool_name: "grep",
      args: { pattern: "x" },
    } as never);
    expect(normalized).toEqual({
      type: "tool-call-started",
      callId: "c1",
      name: "grep",
      args: '{"pattern":"x"}',
    });
  });

  test("maps partial-tool-call args delta", () => {
    const normalized = normalizeInteractionUpdate({
      type: "partial-tool-call",
      callId: "c1",
      argsDelta: '{"a":',
    } as never);
    expect(normalized).toMatchObject({
      type: "partial-tool-call",
      callId: "c1",
      args: '{"a":',
    });
  });

  test("returns ignored when tool-call-started missing ids", () => {
    expect(
      normalizeInteractionUpdate({ type: "tool-call-started" } as never),
    ).toEqual({
      type: "ignored",
      sourceType: "tool-call-started",
      reason: "tool-call-started requires callId and tool name",
    });
  });
});
