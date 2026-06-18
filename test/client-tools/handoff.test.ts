import { describe, expect, test } from "bun:test";
import {
  buildHandoffDirectiveLines,
  extractHandoffBlock,
  HANDOFF_SCHEMA_VERSION,
  parseHandoff,
  stripHandoffFence,
} from "../../src/client-tools/handoff.js";

function fence(json: unknown): string {
  return ["```handoff", JSON.stringify(json, null, 2), "```"].join("\n");
}

const minimalDone = {
  schema_version: "1.0",
  status: "done",
  summary: "Did the thing.",
  artifacts: [],
};

describe("extractHandoffBlock", () => {
  test("returns null when no handoff fence is present", () => {
    expect(extractHandoffBlock("just prose, no block")).toBeNull();
  });

  test("returns null for an empty/whitespace-only fence body", () => {
    expect(extractHandoffBlock("```handoff\n   \n```")).toBeNull();
  });

  test("extracts the body of a single fence", () => {
    const text = `narrative\n\n${fence(minimalDone)}`;
    const body = extractHandoffBlock(text);
    expect(body).not.toBeNull();
    expect(JSON.parse(body!)).toMatchObject({ status: "done" });
  });

  test("last fence wins when multiple are present", () => {
    const first = fence({ ...minimalDone, summary: "draft" });
    const second = fence({ ...minimalDone, summary: "final" });
    const body = extractHandoffBlock(`${first}\n\n${second}`);
    expect(JSON.parse(body!).summary).toBe("final");
  });

  test("matches an unterminated (truncated) fence up to end of text", () => {
    const truncated = '```handoff\n{ "schema_version": "1.0", "status": "partial"';
    const body = extractHandoffBlock(truncated);
    expect(body).not.toBeNull();
    // It is intentionally not valid JSON; parseHandoff degrades it downstream.
    expect(() => JSON.parse(body!)).toThrow();
  });
});

describe("parseHandoff — hard-malformed (degraded synthetic report)", () => {
  test("rule 1: no fence yields degraded failed from prose", () => {
    const result = parseHandoff("I finished but forgot the block.");
    expect(result.ok).toBe(false);
    expect(result.report.status).toBe("failed");
    expect(result.report.summary).toBe("I finished but forgot the block.");
    expect(result.report._degraded).toBe(true);
    expect(result.report.unresolved?.[0]?.severity).toBe("error");
  });

  test("no usable output falls back to a placeholder summary", () => {
    const result = parseHandoff("   ");
    expect(result.ok).toBe(false);
    expect(result.report.summary).toBe("Leaf returned no usable output.");
  });

  test("rule 2: invalid JSON degrades", () => {
    const result = parseHandoff("```handoff\n{ not json }\n```");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/);
  });

  test("non-object JSON primitive degrades", () => {
    // `isRecord` treats arrays as objects, so a bare primitive is what trips the
    // "not a JSON object" branch; an array instead fails later at schema_version.
    const result = parseHandoff("```handoff\n42\n```");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a JSON object/);
  });

  test("rule 3: incompatible major version degrades", () => {
    const result = parseHandoff(fence({ ...minimalDone, schema_version: "2.0" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/major version/);
  });

  test("rule 3: missing schema_version degrades", () => {
    const result = parseHandoff(
      fence({ status: "done", summary: "x", artifacts: [] }),
    );
    expect(result.ok).toBe(false);
  });

  test("rule 4: unknown status degrades", () => {
    const result = parseHandoff(fence({ ...minimalDone, status: "kinda-done" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/status/);
  });

  test("rule 5: empty summary degrades", () => {
    const result = parseHandoff(fence({ ...minimalDone, summary: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/summary/);
  });
});

describe("parseHandoff — valid reports", () => {
  test("minimal done report parses clean (not degraded)", () => {
    const result = parseHandoff(fence(minimalDone));
    expect(result.ok).toBe(true);
    expect(result.report.status).toBe("done");
    expect(result.degraded).toBe(false);
    expect(result.report._degraded).toBeUndefined();
  });

  test("full report preserves all optional sections", () => {
    const full = {
      schema_version: "1.0",
      task_id: "t-1",
      status: "done",
      summary: "All good.",
      confidence: 0.9,
      truncated: false,
      artifacts: [
        {
          id: "impl",
          kind: "file",
          handle: "/abs/path/file.ts",
          mutated: true,
          verify: { method: "stat" },
        },
        { id: "home", kind: "dir", handle: "~/work", mutated: false },
      ],
      unresolved: [{ what: "tests", why: "not run", severity: "info" }],
      recommended_next: [
        { id: "r1", goal: "run tests", suggested_tool_mode: "native", priority: 1 },
      ],
      metrics: { tool_calls: 12, model: "opus" },
    };
    const result = parseHandoff(fence(full));
    expect(result.ok).toBe(true);
    expect(result.report.task_id).toBe("t-1");
    expect(result.report.artifacts).toHaveLength(2);
    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.recommended_next?.[0]?.goal).toBe("run tests");
    expect(result.report.metrics?.tool_calls).toBe(12);
    expect(result.degraded).toBe(false);
  });

  test("task_id null is preserved", () => {
    const result = parseHandoff(fence({ ...minimalDone, task_id: null }));
    expect(result.ok).toBe(true);
    expect(result.report.task_id).toBeNull();
  });

  test("unknown extra fields are ignored (forward-compatible)", () => {
    const result = parseHandoff(
      fence({ ...minimalDone, future_field: { nested: true } }),
    );
    expect(result.ok).toBe(true);
    expect((result.report as Record<string, unknown>).future_field).toBeUndefined();
  });

  test("prose before the block does not break parsing", () => {
    const text = `Here is what I did.\n\nDetails...\n\n${fence(minimalDone)}`;
    expect(parseHandoff(text).ok).toBe(true);
  });
});

describe("parseHandoff — soft-malformed (drop + warn + downgrade)", () => {
  test("artifacts not an array drops to empty and downgrades done→partial", () => {
    const result = parseHandoff(
      fence({ ...minimalDone, artifacts: "nope" }),
    );
    expect(result.ok).toBe(true);
    expect(result.report.status).toBe("partial");
    expect(result.report.artifacts).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.report._warnings?.join(" ")).toMatch(/not an array/);
  });

  test("artifact missing required field is dropped with a warning", () => {
    const result = parseHandoff(
      fence({
        ...minimalDone,
        artifacts: [{ id: "a", kind: "file" /* no handle/mutated */ }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.report.artifacts).toHaveLength(0);
    expect(result.report.status).toBe("partial");
    expect(result.report._warnings?.join(" ")).toMatch(/artifacts\[0\] dropped/);
  });

  test("duplicate artifact ids drop the later one", () => {
    const dup = (id: string) => ({
      id,
      kind: "file",
      handle: `/abs/${id}.ts`,
      mutated: true,
    });
    const result = parseHandoff(
      fence({ ...minimalDone, artifacts: [dup("x"), dup("x")] }),
    );
    expect(result.ok).toBe(true);
    expect(result.report.artifacts).toHaveLength(1);
    expect(result.report._warnings?.join(" ")).toMatch(/duplicate id/);
    expect(result.report.status).toBe("partial");
  });

  test("relative file handle is rejected; absolute and ~ are accepted", () => {
    const result = parseHandoff(
      fence({
        ...minimalDone,
        status: "partial",
        artifacts: [
          { id: "rel", kind: "file", handle: "relative/path.ts", mutated: true },
          { id: "abs", kind: "file", handle: "/abs/path.ts", mutated: true },
          { id: "tilde", kind: "dir", handle: "~/proj", mutated: false },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    const ids = result.report.artifacts.map((a) => a.id);
    expect(ids).toEqual(["abs", "tilde"]);
    expect(result.report._warnings?.join(" ")).toMatch(/not an absolute path/);
  });

  test("non-file/dir kinds skip the absolute-path rule", () => {
    const result = parseHandoff(
      fence({
        ...minimalDone,
        artifacts: [
          { id: "u", kind: "url", handle: "https://example.com", mutated: false },
          { id: "p", kind: "process", handle: "12345", mutated: true },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.report.artifacts).toHaveLength(2);
    expect(result.report.status).toBe("done");
    expect(result.degraded).toBe(false);
  });

  test("invalid unresolved/recommended_next arrays are dropped without failing", () => {
    const result = parseHandoff(
      fence({
        ...minimalDone,
        unresolved: "nope",
        recommended_next: [{ id: "r" /* missing goal */ }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.report.unresolved).toBeUndefined();
    expect(result.report.recommended_next).toBeUndefined();
    expect(result.report._warnings?.join(" ")).toMatch(/unresolved is not an array/);
  });

  test("invalid metrics object is dropped silently", () => {
    const result = parseHandoff(
      fence({ ...minimalDone, metrics: { tool_calls: "many" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.report.metrics).toBeUndefined();
  });

  test("dropped artifact does NOT downgrade a non-done status further", () => {
    const result = parseHandoff(
      fence({
        ...minimalDone,
        status: "blocked",
        artifacts: [{ id: "bad", kind: "file", handle: "rel.ts", mutated: true }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.report.status).toBe("blocked");
  });
});

describe("stripHandoffFence", () => {
  test("leaves prose-only text unchanged", () => {
    expect(stripHandoffFence("just prose, no block")).toBe(
      "just prose, no block",
    );
  });

  test("removes a trailing handoff fence and preserves narrative", () => {
    const text = `Here is what I did.\n\nDetails...\n\n${fence(minimalDone)}`;
    expect(stripHandoffFence(text)).toBe("Here is what I did.\n\nDetails...");
  });

  test("removes multiple handoff fences", () => {
    const first = fence({ ...minimalDone, summary: "draft" });
    const second = fence({ ...minimalDone, summary: "final" });
    expect(stripHandoffFence(`${first}\n\nprose\n\n${second}`)).toBe("\n\nprose");
  });
});

describe("buildHandoffDirectiveLines", () => {
  test("includes the required schema fields and a fenced example", () => {
    const text = buildHandoffDirectiveLines().join("\n");
    expect(text).toContain("```handoff");
    expect(text).toContain(HANDOFF_SCHEMA_VERSION);
    expect(text).toMatch(/schema_version/);
    expect(text).toMatch(/done \| partial \| blocked \| failed/);
  });
});
