import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WORKER_CONTEXT_SENTINEL,
  isNativeWorkerRequest,
  loadWorkerPreamble,
  maybeInjectWorkerContext,
  __resetWorkerContextCacheForTests,
} from "../src/worker-context.js";
import type { ChatCompletionRequest } from "../src/openai.js";

const CONTRACT = [
  "---",
  "description: test contract",
  "alwaysApply: true",
  "---",
  "",
  "# Hermes contract (inlined canonical directives)",
  "",
  "Be plain and concise.",
  "",
].join("\n");

const INDEX = JSON.stringify({
  version: 1,
  generated_by: "test",
  skills: [
    {
      name: "jarvis-orchestrator-routing",
      description: "Routing policy.",
      source: "/abs/skills/jarvis-orchestrator-routing/SKILL.md",
    },
    {
      name: "jarvis-diary",
      description: "Maintain the diary.",
      source: "/abs/skills/jarvis-diary/SKILL.md",
    },
  ],
});

let root: string;
const prevRoot = process.env.HERMES_ROOT;

function writeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hermes-wc-"));
  mkdirSync(path.join(dir, ".cursor", "rules"), { recursive: true });
  mkdirSync(path.join(dir, ".cursor", "skills"), { recursive: true });
  writeFileSync(
    path.join(dir, ".cursor", "rules", "hermes-contract.generated.mdc"),
    CONTRACT,
  );
  writeFileSync(
    path.join(dir, ".cursor", "skills", ".hermes-skill-index.json"),
    INDEX,
  );
  return dir;
}

function req(extra: Record<string, unknown>): ChatCompletionRequest {
  return { messages: [{ role: "user", content: "hi" }], ...extra } as ChatCompletionRequest;
}

beforeEach(() => {
  root = writeFixture();
  process.env.HERMES_ROOT = root;
  __resetWorkerContextCacheForTests();
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.HERMES_ROOT;
  else process.env.HERMES_ROOT = prevRoot;
  __resetWorkerContextCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("loadWorkerPreamble", () => {
  test("includes the sentinel, contract body, and skill index", () => {
    const preamble = loadWorkerPreamble();
    expect(preamble).toBeDefined();
    expect(preamble!).toContain(WORKER_CONTEXT_SENTINEL);
    expect(preamble!).toContain("Hermes contract (inlined canonical directives)");
    expect(preamble!).toContain("Be plain and concise.");
    expect(preamble!).toContain("jarvis-orchestrator-routing");
    expect(preamble!).toContain('skill_view(name="jarvis-diary")');
    // Frontmatter must be stripped (no alwaysApply leakage).
    expect(preamble!).not.toContain("alwaysApply");
  });

  test("returns undefined when root has no control-plane files", () => {
    process.env.HERMES_ROOT = mkdtempSync(path.join(tmpdir(), "empty-"));
    __resetWorkerContextCacheForTests();
    expect(loadWorkerPreamble()).toBeUndefined();
  });
});

describe("isNativeWorkerRequest", () => {
  test("true only for cursor_tool_mode === native", () => {
    expect(isNativeWorkerRequest(req({ cursor_tool_mode: "native" }))).toBe(true);
    expect(isNativeWorkerRequest(req({ cursor_tool_mode: "client" }))).toBe(false);
    expect(isNativeWorkerRequest(req({}))).toBe(false);
  });
});

describe("maybeInjectWorkerContext", () => {
  test("injects for a fresh native worker (string payload)", () => {
    const out = maybeInjectWorkerContext(
      "USER: do the thing",
      req({ cursor_tool_mode: "native" }),
      true,
    );
    expect(typeof out).toBe("string");
    expect(out as string).toContain(WORKER_CONTEXT_SENTINEL);
    expect(out as string).toContain("USER: do the thing");
    // Preamble precedes the original prompt.
    expect((out as string).indexOf(WORKER_CONTEXT_SENTINEL)).toBeLessThan(
      (out as string).indexOf("USER: do the thing"),
    );
  });

  test("injects into SDKUserMessage.text and preserves images", () => {
    const out = maybeInjectWorkerContext(
      { text: "look", images: [{ url: "x" }] },
      req({ cursor_tool_mode: "native" }),
      true,
    );
    expect(typeof out).toBe("object");
    const msg = out as { text: string; images: unknown[] };
    expect(msg.text).toContain(WORKER_CONTEXT_SENTINEL);
    expect(msg.text).toContain("look");
    expect(msg.images).toHaveLength(1);
  });

  test("no-op for a reused agent (isNewAgent false)", () => {
    const out = maybeInjectWorkerContext(
      "again",
      req({ cursor_tool_mode: "native" }),
      false,
    );
    expect(out).toBe("again");
  });

  test("no-op for the orchestrator (not native)", () => {
    const out = maybeInjectWorkerContext("plan", req({}), true);
    expect(out).toBe("plan");
  });

  test("double-injection guard: payload already carrying the sentinel is unchanged", () => {
    const already = `${WORKER_CONTEXT_SENTINEL}\nalready here`;
    const out = maybeInjectWorkerContext(
      already,
      req({ cursor_tool_mode: "native" }),
      true,
    );
    expect(out).toBe(already);
  });
});
