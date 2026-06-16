import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../src/config.js";
import type { ChatCompletionRequest } from "../../src/openai.js";
import {
  DEFAULT_RESIDENT_TOOLS,
  briefToolLine,
  firstSentence,
  resolveToolTier,
  splitToolTiers,
  toolSignature,
} from "../../src/client-tools/catalog.js";
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

const cronjob: ClientToolSpec = {
  name: "cronjob",
  description:
    "Manage scheduled cron jobs with a single compressed tool. Use action='create' to schedule a new job.",
  parameters: {
    type: "object",
    properties: { action: {}, job_id: {}, schedule: {} },
    required: ["action"],
  },
};

describe("firstSentence", () => {
  test("takes the first sentence and collapses whitespace", () => {
    expect(firstSentence("Do a thing.  Then another thing.")).toBe(
      "Do a thing.",
    );
    expect(firstSentence("Line one\nline two")).toBe("Line one line two");
  });

  test("caps length with an ellipsis", () => {
    const long = `${"x".repeat(200)} more`;
    const out = firstSentence(long, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("toolSignature", () => {
  test("marks optional args with ? and keeps required bare", () => {
    expect(toolSignature(cronjob)).toBe("cronjob(action, job_id?, schedule?)");
  });

  test("empty parens when no parameters", () => {
    expect(toolSignature({ name: "browser_back" })).toBe("browser_back()");
  });
});

describe("briefToolLine", () => {
  test("renders signature plus first sentence", () => {
    expect(briefToolLine(cronjob)).toBe(
      "cronjob(action, job_id?, schedule?) — Manage scheduled cron jobs with a single compressed tool.",
    );
  });

  test("signature only when no description", () => {
    expect(briefToolLine({ name: "browser_back" })).toBe("browser_back()");
  });
});

describe("splitToolTiers", () => {
  const tools: ClientToolSpec[] = [
    { name: "read_file" },
    { name: "terminal" },
    { name: "cronjob" },
    { name: "computer_use" },
  ];

  test("full mode keeps everything in full", () => {
    const { full, brief } = splitToolTiers(tools, {
      mode: "full",
      resident: new Set(),
    });
    expect(full).toBe(tools);
    expect(brief).toHaveLength(0);
  });

  test("brief mode moves everything to brief", () => {
    const { full, brief } = splitToolTiers(tools, {
      mode: "brief",
      resident: new Set(),
    });
    expect(full).toHaveLength(0);
    expect(brief).toBe(tools);
  });

  test("tiered mode splits on the resident set", () => {
    const { full, brief } = splitToolTiers(tools, {
      mode: "tiered",
      resident: new Set(["read_file", "terminal"]),
    });
    expect(full.map((t) => t.name)).toEqual(["read_file", "terminal"]);
    expect(brief.map((t) => t.name)).toEqual(["cronjob", "computer_use"]);
  });
});

describe("resolveToolTier", () => {
  test("defaults to full with the default resident set", () => {
    const tier = resolveToolTier(
      { messages: [{ role: "user", content: "hi" }] },
      baseConfig,
    );
    expect(tier.mode).toBe("full");
    expect(tier.resident.has(DEFAULT_RESIDENT_TOOLS[0]!)).toBe(true);
  });

  test("request field wins over metadata and config", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_tool_tier: "brief",
      metadata: { cursor_tool_tier: "tiered" },
    } satisfies ChatCompletionRequest;
    const config = { ...baseConfig, CURSOR_TOOL_TIER: "full" } satisfies AppConfig;
    expect(resolveToolTier(request, config).mode).toBe("brief");
  });

  test("config default and resident list apply when request is silent", () => {
    const config = {
      ...baseConfig,
      CURSOR_TOOL_TIER: "tiered" as const,
      CURSOR_TOOL_RESIDENT: "read_file, patch",
    } satisfies AppConfig;
    const tier = resolveToolTier(
      { messages: [{ role: "user", content: "hi" }] },
      config,
    );
    expect(tier.mode).toBe("tiered");
    expect([...tier.resident].sort()).toEqual(["patch", "read_file"]);
  });
});
