import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const shellTest = path.join(here, "proxy-watchdog.test.sh");

describe("proxy-watchdog.sh (behavioral, stubbed externals)", () => {
  test("confirms before restart, parses content, dedups pages", () => {
    const result = spawnSync("bash", [shellTest], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(
        `watchdog shell test failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.stdout).toContain("0 failed");
  });
});
