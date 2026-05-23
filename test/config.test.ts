import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  test("requires CURSOR_API_KEY", () => {
    expect(() =>
      loadConfig({
        PORT: "8080",
        CURSOR_CWD: "/tmp",
      }),
    ).toThrow(/CURSOR_API_KEY is not set/);
  });

  test("rejects empty CURSOR_API_KEY", () => {
    expect(() =>
      loadConfig({
        CURSOR_API_KEY: "",
        CURSOR_CWD: "/tmp",
      }),
    ).toThrow(/CURSOR_API_KEY is not set/);
  });

  test("parses defaults", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "cursor_test",
      CURSOR_CWD: "/repo",
    });
    expect(config.PORT).toBe(8080);
    expect(config.DEFAULT_MODEL).toBe("composer-2.5");
    expect(config.DEBUG_STREAM).toBe(false);
    expect(config.CURSOR_INCLUDE_THINKING).toBe(true);
    expect(config.CURSOR_ENABLE_SESSIONS).toBe(true);
    expect(config.CURSOR_SESSION_TTL_MS).toBe(30 * 60 * 1000);
    expect(config.CURSOR_SESSION_MAX).toBe(64);
    expect(config.CURSOR_EMIT_TOOL_CALLS).toBe(false);
  });

  test("CURSOR_EMIT_TOOL_CALLS can be enabled", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "cursor_test",
      CURSOR_CWD: "/repo",
      CURSOR_EMIT_TOOL_CALLS: "true",
    });
    expect(config.CURSOR_EMIT_TOOL_CALLS).toBe(true);
  });

  test("CURSOR_INCLUDE_THINKING can be disabled", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "cursor_test",
      CURSOR_CWD: "/repo",
      CURSOR_INCLUDE_THINKING: "false",
    });
    expect(config.CURSOR_INCLUDE_THINKING).toBe(false);
  });
});
