import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv } from "../src/load-env.js";

const tmpFiles: string[] = [];

function writeEnv(contents: string): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "envtest-")),
    ".env",
  );
  fs.writeFileSync(file, contents);
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  while (tmpFiles.length) {
    const f = tmpFiles.pop()!;
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});

describe("loadDotEnv", () => {
  test("loads KEY=VALUE pairs into a fresh env", () => {
    const file = writeEnv("FOO=bar\nBAZ=qux\n");
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(file, env);
    expect(env.FOO).toBe("bar");
    expect(env.BAZ).toBe("qux");
  });

  test("existing env values win (process.env precedence)", () => {
    const file = writeEnv("CURSOR_CWD=/from/dotenv\n");
    const env: NodeJS.ProcessEnv = { CURSOR_CWD: "/from/plist" };
    loadDotEnv(file, env);
    expect(env.CURSOR_CWD).toBe("/from/plist");
  });

  test("fills in keys the process env is missing", () => {
    const file = writeEnv("CURSOR_CWD_ALLOWLIST=/a,/b\n");
    const env: NodeJS.ProcessEnv = { CURSOR_CWD: "/x" };
    loadDotEnv(file, env);
    expect(env.CURSOR_CWD_ALLOWLIST).toBe("/a,/b");
  });

  test("ignores comments, blanks, and strips surrounding quotes", () => {
    const file = writeEnv('\n# a comment\nA="quoted value"\nB=\'single\'\n');
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(file, env);
    expect(env.A).toBe("quoted value");
    expect(env.B).toBe("single");
  });

  test("a missing file is a silent no-op", () => {
    const env: NodeJS.ProcessEnv = { KEEP: "1" };
    expect(() => loadDotEnv("/no/such/.env", env)).not.toThrow();
    expect(env.KEEP).toBe("1");
  });

  test("values containing '=' keep everything after the first '='", () => {
    const file = writeEnv("URL=https://x/y?a=1&b=2\n");
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(file, env);
    expect(env.URL).toBe("https://x/y?a=1&b=2");
  });
});
