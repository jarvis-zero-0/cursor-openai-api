import { describe, expect, test } from "bun:test";
import {
  NATIVE_CLIENT_TOOL_STEER,
  ORCHESTRATOR_CLIENT_STEER,
  resolveClientToolSteer,
} from "../../src/client-tools/prompt.js";

describe("resolveClientToolSteer", () => {
  test("returns orchestrator steer when delegate_task is present", () => {
    expect(resolveClientToolSteer(["read_file", "delegate_task"])).toBe(
      ORCHESTRATOR_CLIENT_STEER,
    );
  });

  test("returns generic steer without delegate_task", () => {
    expect(resolveClientToolSteer(["read_file", "terminal"])).toBe(
      NATIVE_CLIENT_TOOL_STEER,
    );
  });
});
