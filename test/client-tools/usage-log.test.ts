import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getToolUsage,
  recordToolUsage,
  resetToolUsage,
} from "../../src/client-tools/usage-log.js";

// The counter is a process-global singleton; reset around each test so other
// suites that exercise the client-tool loop can't leak counts into these.
beforeEach(() => resetToolUsage());
afterEach(() => resetToolUsage());

describe("usage-log", () => {
  test("counts calls and sorts highest first", () => {
    recordToolUsage("read_file");
    recordToolUsage("terminal");
    recordToolUsage("read_file");
    expect(getToolUsage()).toEqual({ read_file: 2, terminal: 1 });
  });

  test("ignores empty tool names", () => {
    recordToolUsage("");
    expect(getToolUsage()).toEqual({});
  });

  test("reset clears counts", () => {
    recordToolUsage("patch");
    resetToolUsage();
    expect(getToolUsage()).toEqual({});
  });
});
