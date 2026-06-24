import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { resolveLocalAgentScope } from "../src/agent-turn.js";
import type { ChatCompletionRequest } from "../src/openai.js";

const ALLOW = "/allow/repo-a,/allow/repo-b";

function cfg(allowlist = ALLOW) {
  return loadConfig({
    CURSOR_API_KEY: "cursor_test",
    CURSOR_CWD: "/global/cwd",
    CURSOR_CWD_ALLOWLIST: allowlist,
  });
}

function req(extra: Record<string, unknown>): ChatCompletionRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  } as ChatCompletionRequest;
}

describe("CURSOR_CWD_ALLOWLIST parsing", () => {
  test("splits comma-separated absolute paths and trims", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "k",
      CURSOR_CWD: "/x",
      CURSOR_CWD_ALLOWLIST: "/a, /b ,/c",
    });
    expect(config.CURSOR_CWD_ALLOWLIST).toEqual(["/a", "/b", "/c"]);
  });

  test("defaults to [] when unset", () => {
    const config = loadConfig({ CURSOR_API_KEY: "k", CURSOR_CWD: "/x" });
    expect(config.CURSOR_CWD_ALLOWLIST).toEqual([]);
  });
});

describe("resolveLocalAgentScope", () => {
  test("orchestrator (cursor_tool_mode absent) → global cwd + []", () => {
    expect(resolveLocalAgentScope(req({}), cfg())).toEqual({
      cwd: "/global/cwd",
      settingSources: [],
    });
  });

  test("client mode → global cwd + [] (unchanged)", () => {
    const scope = resolveLocalAgentScope(
      req({ cursor_tool_mode: "client", cursor_cwd: "/allow/repo-a" }),
      cfg(),
    );
    expect(scope).toEqual({ cwd: "/global/cwd", settingSources: [] });
  });

  // settingSources stays `[]` for native leaves too: the contract + skill index
  // reach delegated workers via the Hermes-assembled system message in messages[],
  // NOT via the SDK `project` setting source. A native leaf still gets its
  // allowlisted repo cwd so file/terminal tools land right.
  test("native + allowlisted cwd → that cwd + [] (no project source)", () => {
    const scope = resolveLocalAgentScope(
      req({ cursor_tool_mode: "native", cursor_cwd: "/allow/repo-a" }),
      cfg(),
    );
    expect(scope).toEqual({
      cwd: "/allow/repo-a",
      settingSources: [],
    });
  });

  test("native + nested-under-allowlist cwd → that nested cwd + []", () => {
    const scope = resolveLocalAgentScope(
      req({ cursor_tool_mode: "native", cursor_cwd: "/allow/repo-a/pkg/sub" }),
      cfg(),
    );
    expect(scope).toEqual({
      cwd: "/allow/repo-a/pkg/sub",
      settingSources: [],
    });
  });

  test("native + out-of-allowlist cwd → fallback to global cwd, still []", () => {
    const scope = resolveLocalAgentScope(
      req({ cursor_tool_mode: "native", cursor_cwd: "/somewhere/else" }),
      cfg(),
    );
    expect(scope).toEqual({ cwd: "/global/cwd", settingSources: [] });
  });

  test("native + sibling-prefix path is NOT treated as nested", () => {
    const scope = resolveLocalAgentScope(
      req({ cursor_tool_mode: "native", cursor_cwd: "/allow/repo-a-evil" }),
      cfg(),
    );
    expect(scope).toEqual({ cwd: "/global/cwd", settingSources: [] });
  });

  test("native + no cursor_cwd → global cwd + []", () => {
    const scope = resolveLocalAgentScope(
      req({ cursor_tool_mode: "native" }),
      cfg(),
    );
    expect(scope).toEqual({ cwd: "/global/cwd", settingSources: [] });
  });
});
