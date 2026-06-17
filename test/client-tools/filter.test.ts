import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../src/config.js";
import type { ChatCompletionRequest } from "../../src/openai.js";
import {
  applyToolFilter,
  filterClientTools,
  isNoopToolFilter,
  resolveToolFilter,
  type ToolFilter,
} from "../../src/client-tools/filter.js";
import {
  knownToolsets,
  toolNamesForToolsets,
  toolsetForTool,
} from "../../src/client-tools/toolsets.js";
import type { ClientToolSpec } from "../../src/client-tools/types.js";

const baseConfig = {
  CURSOR_API_KEY: "k",
  CURSOR_CWD: "/tmp",
  PORT: 8080,
  HOST: "0.0.0.0",
  DEFAULT_MODEL: "composer-2.5",
  CURSOR_INCLUDE_THINKING: true,
  CURSOR_EMIT_TOOL_CALLS: false,
  CURSOR_ASSISTANT_TEXT_MODE: "live" as const,
  CURSOR_TOOL_MODE: "auto" as const,
  CURSOR_ENABLE_SESSIONS: true,
  CURSOR_AUTO_SESSION: true,
  CURSOR_SESSION_TTL_MS: 1,
  CURSOR_SESSION_MAX: 1,
} satisfies AppConfig;

const specs: ClientToolSpec[] = [
  { name: "read_file" },
  { name: "write_file" },
  { name: "patch" },
  { name: "terminal" },
  { name: "browser_navigate" },
  { name: "browser_click" },
  { name: "cronjob" },
  { name: "computer_use" },
  { name: "delegate_task" },
  { name: "some_new_tool" },
];

const names = (out: ClientToolSpec[]) => out.map((s) => s.name);

describe("toolsets", () => {
  test("maps known tools and falls back to other", () => {
    expect(toolsetForTool("read_file")).toBe("file");
    expect(toolsetForTool("browser_click")).toBe("browser");
    expect(toolsetForTool("session_title")).toBe("session_title");
    expect(toolsetForTool("totally_unknown")).toBe("other");
  });

  test("expands toolsets to tool names", () => {
    const fileTools = toolNamesForToolsets(["file"]);
    expect(fileTools.has("read_file")).toBe(true);
    expect(fileTools.has("terminal")).toBe(false);
  });

  test("knownToolsets excludes the synthetic bucket", () => {
    expect(knownToolsets()).not.toContain("other");
    expect(knownToolsets()).toContain("browser");
  });
});

describe("applyToolFilter", () => {
  test("no-op filter returns all specs", () => {
    const filter: ToolFilter = { keepUnmapped: true };
    expect(isNoopToolFilter(filter)).toBe(true);
    expect(applyToolFilter(specs, filter)).toBe(specs);
  });

  test("denylist drops exact and wildcard matches", () => {
    const out = applyToolFilter(specs, {
      deny: ["browser_*", "cronjob", "computer_use"],
      keepUnmapped: true,
    });
    expect(names(out)).not.toContain("browser_navigate");
    expect(names(out)).not.toContain("browser_click");
    expect(names(out)).not.toContain("cronjob");
    expect(names(out)).not.toContain("computer_use");
    expect(names(out)).toContain("read_file");
  });

  test("allowlist keeps only matching tools", () => {
    const out = applyToolFilter(specs, {
      allow: ["read_file", "write_file", "patch", "terminal"],
      keepUnmapped: false,
    });
    expect(names(out).sort()).toEqual(
      ["patch", "read_file", "terminal", "write_file"].sort(),
    );
  });

  test("toolsets keep matching groups and drop the rest", () => {
    const out = applyToolFilter(specs, {
      toolsets: ["file", "terminal"],
      keepUnmapped: false,
    });
    expect(names(out)).toContain("read_file");
    expect(names(out)).toContain("terminal");
    expect(names(out)).not.toContain("browser_navigate");
    expect(names(out)).not.toContain("some_new_tool");
  });

  test("keepUnmapped retains tools with no known toolset", () => {
    const out = applyToolFilter(specs, {
      toolsets: ["file"],
      keepUnmapped: true,
    });
    expect(names(out)).toContain("some_new_tool");
    expect(names(out)).toContain("read_file");
    expect(names(out)).not.toContain("terminal");
  });

  test("deny takes precedence over allow", () => {
    const out = applyToolFilter(specs, {
      allow: ["read_file", "terminal"],
      deny: ["terminal"],
      keepUnmapped: false,
    });
    expect(names(out)).toEqual(["read_file"]);
  });

  test("allow and toolsets union", () => {
    const out = applyToolFilter(specs, {
      allow: ["cronjob"],
      toolsets: ["file"],
      keepUnmapped: false,
    });
    expect(names(out)).toContain("cronjob");
    expect(names(out)).toContain("read_file");
    expect(names(out)).not.toContain("terminal");
  });
});

describe("resolveToolFilter", () => {
  test("request fields win over metadata and config", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_tools_deny: ["cronjob"],
      metadata: { cursor_tools_deny: "terminal" },
    } satisfies ChatCompletionRequest;
    const config = {
      ...baseConfig,
      CURSOR_TOOL_DENYLIST: "read_file",
    } satisfies AppConfig;
    expect(resolveToolFilter(request, config).deny).toEqual(["cronjob"]);
  });

  test("metadata used when request field absent", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      metadata: { cursor_enabled_toolsets: "file, terminal" },
    } satisfies ChatCompletionRequest;
    expect(resolveToolFilter(request, baseConfig).toolsets).toEqual([
      "file",
      "terminal",
    ]);
  });

  test("config default used when request and metadata absent", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatCompletionRequest;
    const config = {
      ...baseConfig,
      CURSOR_TOOL_DENYLIST: "browser_*,cronjob",
    } satisfies AppConfig;
    expect(resolveToolFilter(request, config).deny).toEqual([
      "browser_*",
      "cronjob",
    ]);
  });

  test("keepUnmapped defaults to true", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatCompletionRequest;
    expect(resolveToolFilter(request, baseConfig).keepUnmapped).toBe(true);
  });

  test("keepUnmapped honored from request field", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_toolsets_keep_unmapped: false,
    } satisfies ChatCompletionRequest;
    expect(resolveToolFilter(request, baseConfig).keepUnmapped).toBe(false);
  });
});

describe("filterClientTools", () => {
  test("end-to-end: deny config trims the inventory", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_enabled_toolsets: ["file"],
      cursor_toolsets_keep_unmapped: false,
    } satisfies ChatCompletionRequest;
    const out = filterClientTools(specs, request, baseConfig);
    expect(names(out).sort()).toEqual(
      ["patch", "read_file", "write_file"].sort(),
    );
  });

  test("no filter leaves specs untouched", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatCompletionRequest;
    expect(filterClientTools(specs, request, baseConfig)).toBe(specs);
  });
});
