import { z } from "zod";
import { isRecord } from "./guards.js";

// Subagent Handoff Contract (v1). See docs/subagent-handoff-contract.md.
// The leaf subagent ends its final assistant text with a single ```handoff
// JSON block; the orchestrator parses it via `parseHandoff`. This module is the
// schema + parser + leaf-side directive. It performs no I/O and never throws.

export const HANDOFF_SCHEMA_VERSION = "1.0";

export const HANDOFF_STATUSES = [
  "done",
  "partial",
  "blocked",
  "failed",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const HANDOFF_ARTIFACT_KINDS = [
  "file",
  "dir",
  "url",
  "process",
  "command",
  "git_ref",
  "stdout",
  "other",
] as const;
export type HandoffArtifactKind = (typeof HANDOFF_ARTIFACT_KINDS)[number];

export const HANDOFF_VERIFY_METHODS = [
  "stat",
  "sha256",
  "http_get",
  "exit_code",
  "git_rev_parse",
  "none",
] as const;
export type HandoffVerifyMethod = (typeof HANDOFF_VERIFY_METHODS)[number];

export const HANDOFF_SEVERITIES = ["info", "warn", "error"] as const;
export type HandoffSeverity = (typeof HANDOFF_SEVERITIES)[number];

export const HANDOFF_TOOL_MODES = ["native", "client"] as const;
export type HandoffToolMode = (typeof HANDOFF_TOOL_MODES)[number];

export interface HandoffVerify {
  method: HandoffVerifyMethod;
  expect?: string;
}

export interface HandoffArtifact {
  id: string;
  kind: HandoffArtifactKind;
  handle: string;
  mutated: boolean;
  description?: string;
  verify?: HandoffVerify;
}

export interface HandoffUnresolved {
  what: string;
  why: string;
  severity: HandoffSeverity;
}

export interface HandoffRecommendation {
  id: string;
  goal: string;
  rationale?: string;
  suggested_tool_mode?: HandoffToolMode;
  toolsets?: string[];
  priority?: number;
  depends_on?: string[];
}

export interface HandoffMetrics {
  tool_calls?: number;
  elapsed_ms?: number;
  model?: string;
}

export interface Handoff {
  schema_version: string;
  task_id?: string | null;
  status: HandoffStatus;
  summary: string;
  confidence?: number;
  truncated?: boolean;
  artifacts: HandoffArtifact[];
  unresolved?: HandoffUnresolved[];
  recommended_next?: HandoffRecommendation[];
  metrics?: HandoffMetrics;
  // Set by the parser when the report was degraded/soft-fixed; not emitted by leaves.
  _degraded?: boolean;
  _warnings?: string[];
}

const handoffVerifySchema = z.object({
  method: z.enum(HANDOFF_VERIFY_METHODS),
  expect: z.string().optional(),
});

const handoffArtifactSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(HANDOFF_ARTIFACT_KINDS),
  handle: z.string().min(1),
  mutated: z.boolean(),
  description: z.string().optional(),
  verify: handoffVerifySchema.optional(),
});

const handoffUnresolvedSchema = z.object({
  what: z.string().min(1),
  why: z.string().min(1),
  severity: z.enum(HANDOFF_SEVERITIES),
});

const handoffRecommendationSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  rationale: z.string().optional(),
  suggested_tool_mode: z.enum(HANDOFF_TOOL_MODES).optional(),
  toolsets: z.array(z.string()).optional(),
  priority: z.number().optional(),
  depends_on: z.array(z.string()).optional(),
});

const handoffMetricsSchema = z.object({
  tool_calls: z.number().optional(),
  elapsed_ms: z.number().optional(),
  model: z.string().optional(),
});

// z.object strips unknown keys by default, so additive/forward-compatible
// fields are ignored rather than rejected (see §8 of the contract).
export const handoffSchema = z.object({
  schema_version: z.string(),
  task_id: z.string().nullable().optional(),
  status: z.enum(HANDOFF_STATUSES),
  summary: z.string().min(1),
  confidence: z.number().optional(),
  truncated: z.boolean().optional(),
  artifacts: z.array(handoffArtifactSchema),
  unresolved: z.array(handoffUnresolvedSchema).optional(),
  recommended_next: z.array(handoffRecommendationSchema).optional(),
  metrics: handoffMetricsSchema.optional(),
});

export type HandoffParseResult =
  | { ok: true; report: Handoff; warnings: string[]; degraded: boolean }
  | { ok: false; report: Handoff; reason: string };

const HANDOFF_FENCE_RE = /```handoff[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
const HANDOFF_FENCE_STRIP_RE = /```handoff[ \t]*\r?\n[\s\S]*?(?:```|$)/g;

// Remove every ```handoff fence (and its body) from user-facing / orchestrator text.
// Parsing uses extractHandoffBlock before stripping; callers should parse first.
export function stripHandoffFence(finalText: string): string {
  return finalText.replace(HANDOFF_FENCE_STRIP_RE, "").trimEnd();
}

// Returns the body of the LAST ```handoff fence in `finalText` (last wins per
// §2). A fence opened but never closed (truncated mid-block) still matches up to
// end-of-text so JSON.parse can fail downstream into the degraded path.
export function extractHandoffBlock(finalText: string): string | null {
  let match: RegExpExecArray | null;
  let last: string | null = null;
  HANDOFF_FENCE_RE.lastIndex = 0;
  while ((match = HANDOFF_FENCE_RE.exec(finalText)) !== null) {
    const body = match[1] ?? "";
    if (body.trim()) last = body;
    if (match.index === HANDOFF_FENCE_RE.lastIndex) {
      HANDOFF_FENCE_RE.lastIndex += 1;
    }
  }
  return last;
}

function majorVersion(version: string): number | null {
  const match = /^\s*(\d+)/.exec(version);
  return match ? Number(match[1]) : null;
}

function synthesizeDegraded(finalText: string, reason: string): HandoffParseResult {
  const trimmed = finalText.trim();
  const report: Handoff = {
    schema_version: HANDOFF_SCHEMA_VERSION,
    status: "partial",
    summary: trimmed || "Leaf returned no usable output.",
    artifacts: [],
    unresolved: [
      {
        what: "structured handoff missing/invalid",
        why: "leaf returned prose only",
        severity: "warn",
      },
    ],
    _degraded: true,
  };
  return { ok: false, report, reason };
}

function collectArtifacts(
  raw: unknown,
  warnings: string[],
): { artifacts: HandoffArtifact[]; dropped: boolean } {
  if (raw === undefined) return { artifacts: [], dropped: false };
  if (!Array.isArray(raw)) {
    warnings.push("artifacts is not an array; treated as empty");
    return { artifacts: [], dropped: true };
  }
  const artifacts: HandoffArtifact[] = [];
  const seen = new Set<string>();
  let dropped = false;
  raw.forEach((element, index) => {
    const parsed = handoffArtifactSchema.safeParse(element);
    if (!parsed.success) {
      warnings.push(`artifacts[${index}] dropped: missing/invalid required field`);
      dropped = true;
      return;
    }
    const artifact = parsed.data;
    if (seen.has(artifact.id)) {
      warnings.push(`artifacts[${index}] dropped: duplicate id "${artifact.id}"`);
      dropped = true;
      return;
    }
    // §3: handle for a file/dir artifact is an absolute path, never relative.
    if (
      (artifact.kind === "file" || artifact.kind === "dir") &&
      !artifact.handle.startsWith("/") &&
      !artifact.handle.startsWith("~")
    ) {
      warnings.push(
        `artifacts[${index}] dropped: ${artifact.kind} handle "${artifact.handle}" is not an absolute path`,
      );
      dropped = true;
      return;
    }
    seen.add(artifact.id);
    artifacts.push(artifact);
  });
  return { artifacts, dropped };
}

function collectUnresolved(
  raw: unknown,
  warnings: string[],
): HandoffUnresolved[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warnings.push("unresolved is not an array; dropped");
    return undefined;
  }
  const out: HandoffUnresolved[] = [];
  raw.forEach((element, index) => {
    const parsed = handoffUnresolvedSchema.safeParse(element);
    if (!parsed.success) {
      warnings.push(`unresolved[${index}] dropped: missing/invalid required field`);
      return;
    }
    out.push(parsed.data);
  });
  return out;
}

function collectRecommendations(
  raw: unknown,
  warnings: string[],
): HandoffRecommendation[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warnings.push("recommended_next is not an array; dropped");
    return undefined;
  }
  const out: HandoffRecommendation[] = [];
  raw.forEach((element, index) => {
    const parsed = handoffRecommendationSchema.safeParse(element);
    if (!parsed.success) {
      warnings.push(
        `recommended_next[${index}] dropped: missing/invalid required field`,
      );
      return;
    }
    out.push(parsed.data);
  });
  return out;
}

function collectMetrics(raw: unknown): HandoffMetrics | undefined {
  if (raw === undefined) return undefined;
  const parsed = handoffMetricsSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// Implements §4: extract → JSON.parse → validate → degrade (hard) / soft-fix.
// Hard-malformed (rules 1–5) yields a degraded synthetic report (ok:false).
// Soft-malformed (rules 6–8) drops offending elements, attaches warnings, and
// downgrades done→partial if any artifact was dropped (ok:true). Never throws.
export function parseHandoff(finalText: string): HandoffParseResult {
  const block = extractHandoffBlock(finalText);
  if (block === null) {
    return synthesizeDegraded(finalText, "no handoff block found in final text");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return synthesizeDegraded(finalText, "handoff block is not valid JSON");
  }
  if (!isRecord(raw)) {
    return synthesizeDegraded(finalText, "handoff block is not a JSON object");
  }

  // Rule 3: schema_version present with a compatible major version.
  const version = raw.schema_version;
  if (typeof version !== "string" || majorVersion(version) !== 1) {
    return synthesizeDegraded(
      finalText,
      "schema_version missing or incompatible major version",
    );
  }
  // Rule 4: status present and in the enum.
  if (
    typeof raw.status !== "string" ||
    !HANDOFF_STATUSES.includes(raw.status as HandoffStatus)
  ) {
    return synthesizeDegraded(finalText, "status missing or not a known value");
  }
  // Rule 5: summary present and non-empty.
  if (typeof raw.summary !== "string" || !raw.summary.trim()) {
    return synthesizeDegraded(finalText, "summary missing or empty");
  }

  const warnings: string[] = [];
  const { artifacts, dropped } = collectArtifacts(raw.artifacts, warnings);
  const unresolved = collectUnresolved(raw.unresolved, warnings);
  const recommended_next = collectRecommendations(raw.recommended_next, warnings);
  const metrics = collectMetrics(raw.metrics);

  // Soft-malformed: a dropped artifact downgrades a claimed `done` to `partial`
  // so unverifiable artifacts are never trusted blind.
  let status = raw.status as HandoffStatus;
  if (status === "done" && dropped) {
    status = "partial";
    warnings.push("status downgraded done→partial: one or more artifacts dropped");
  }

  const report: Handoff = {
    schema_version: version,
    status,
    summary: raw.summary,
    artifacts,
  };
  if (raw.task_id === null || typeof raw.task_id === "string") {
    report.task_id = raw.task_id;
  }
  if (typeof raw.confidence === "number") report.confidence = raw.confidence;
  if (typeof raw.truncated === "boolean") report.truncated = raw.truncated;
  if (unresolved && unresolved.length) report.unresolved = unresolved;
  if (recommended_next && recommended_next.length) {
    report.recommended_next = recommended_next;
  }
  if (metrics) report.metrics = metrics;
  if (warnings.length) {
    report._warnings = warnings;
    report._degraded = true;
  }

  return { ok: true, report, warnings, degraded: warnings.length > 0 };
}

// Lines appended to the native leaf directive (src/prompt.ts) instructing the
// leaf to terminate its final message with a single ```handoff JSON block that
// matches the §3 schema. Kept concrete (field list + example) so the leaf has
// no ambiguity about the shape the orchestrator parses.
export function buildHandoffDirectiveLines(): string[] {
  return [
    "",
    "STRUCTURED HANDOFF (required, last thing in your final message):",
    "- After your human-readable summary, end your final message with EXACTLY ONE fenced code block tagged `handoff` containing a single JSON object. It must be the LAST thing in the message.",
    "- The prose above the block is narrative; the JSON block is the machine interface the orchestrator parses. Do not wrap it in extra prose after the closing fence.",
    "- Schema (v1). Required: schema_version (\"1.0\"), status (one of: done | partial | blocked | failed), summary (non-empty), artifacts (array, may be []).",
    "  - status: done = fully complete and artifacts verifiable; partial = real progress but incomplete/truncated (resumable); blocked = needs an external decision/input; failed = attempted and errored irrecoverably.",
    "  - Each artifact: { id, kind (file|dir|url|process|command|git_ref|stdout|other), handle (ABSOLUTE path | URL | pid | sha | git-rev — never relative), mutated (true if you created/modified it), description? , verify?: { method (stat|sha256|http_get|exit_code|git_rev_parse|none), expect? } }.",
    "  - Optional: task_id (string|null), confidence (0..1), truncated (bool), unresolved [{ what, why, severity (info|warn|error) }], recommended_next [{ id, goal, rationale?, suggested_tool_mode (native|client)?, toolsets?, priority?, depends_on? }], metrics { tool_calls?, elapsed_ms?, model? }.",
    "- If you were cut off, set status \"partial\" and truncated true, and record remaining work in unresolved / recommended_next.",
    "- Example:",
    "```handoff",
    "{",
    '  "schema_version": "1.0",',
    '  "task_id": null,',
    '  "status": "done",',
    '  "summary": "Implemented the feature and verified it builds clean.",',
    '  "confidence": 0.9,',
    '  "truncated": false,',
    '  "artifacts": [',
    '    { "id": "impl", "kind": "file", "handle": "/abs/path/to/file.ts", "mutated": true, "verify": { "method": "stat" } }',
    "  ],",
    '  "unresolved": [],',
    '  "recommended_next": [],',
    '  "metrics": { "tool_calls": 12 }',
    "}",
    "```",
  ];
}
