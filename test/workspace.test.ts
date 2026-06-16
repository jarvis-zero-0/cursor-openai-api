import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  isCwdAllowed,
  parseCwdAllowlist,
  resolveWorkspaceCwd,
} from "../src/workspace.js";
import { testProxyConfig } from "./helpers/test-config.js";

describe("resolveWorkspaceCwd", () => {
  test("falls back to CURSOR_CWD when no override is supplied", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd({ messages: [{ role: "user", content: "hi" }] }, undefined, config),
    ).toBe("/srv/sandbox");
  });

  test("normalizes the default CURSOR_CWD so it matches resolved overrides", () => {
    // A non-normalized default (trailing slash here) must resolve to the same
    // string a later turn produces from `path.resolve`, otherwise cwd-aware
    // session reuse breaks and a new agent is spawned every turn.
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox/" });
    const fromDefault = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }] },
      undefined,
      config,
    );
    const fromOverride = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/srv/sandbox" },
      undefined,
      config,
    );
    expect(fromDefault).toBe("/srv/sandbox");
    expect(fromDefault).toBe(fromOverride);
  });

  test("reads the cursor_cwd request field", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/srv/hermes" },
        undefined,
        config,
      ),
    ).toBe("/srv/hermes");
  });

  test("reads metadata.cursor_cwd", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], metadata: { cursor_cwd: "/srv/repo" } },
        undefined,
        config,
      ),
    ).toBe("/srv/repo");
  });

  test("reads the x-cursor-cwd header", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }] },
        { "x-cursor-cwd": "/srv/header" },
        config,
      ),
    ).toBe("/srv/header");
  });

  test("field beats metadata beats header", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        {
          messages: [{ role: "user", content: "hi" }],
          cursor_cwd: "/srv/field",
          metadata: { cursor_cwd: "/srv/meta" },
        },
        { "x-cursor-cwd": "/srv/header" },
        config,
      ),
    ).toBe("/srv/field");
  });

  test("resolves relative overrides to absolute paths", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "./nested" },
        undefined,
        config,
      ),
    ).toBe(path.resolve("./nested"));
  });

  test("rejects a cwd outside the allowlist", () => {
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: "/srv/hermes,/srv/repos",
    });
    expect(() =>
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/etc" },
        undefined,
        config,
      ),
    ).toThrow(/not permitted/);
  });

  test("allows a cwd nested under an allowlisted root", () => {
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: "/srv/hermes",
    });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/srv/hermes/skills" },
        undefined,
        config,
      ),
    ).toBe("/srv/hermes/skills");
  });

  test("the default CURSOR_CWD is always allowed even when not listed", () => {
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: "/srv/hermes",
    });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/srv/sandbox" },
        undefined,
        config,
      ),
    ).toBe("/srv/sandbox");
  });
});

describe("isCwdAllowed", () => {
  test("unrestricted when no allowlist is configured", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(isCwdAllowed("/anywhere/at/all", config)).toBe(true);
  });

  test("a root equal to an allowlisted entry is permitted", () => {
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: "/srv/hermes",
    });
    expect(isCwdAllowed("/srv/hermes", config)).toBe(true);
    expect(isCwdAllowed("/srv/hermes-evil", config)).toBe(false);
  });
});

describe("parseCwdAllowlist", () => {
  test("splits, trims, and resolves entries", () => {
    expect(parseCwdAllowlist(" /srv/a , /srv/b ")).toEqual([
      path.resolve("/srv/a"),
      path.resolve("/srv/b"),
    ]);
  });

  test("returns an empty list for undefined/empty input", () => {
    expect(parseCwdAllowlist(undefined)).toEqual([]);
    expect(parseCwdAllowlist("  ")).toEqual([]);
  });
});
