import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { SDKUserMessage } from "@cursor/sdk";
import type { ChatCompletionRequest } from "./openai.js";

/**
 * Durable contract + skill-index injection for delegated Cursor workers.
 *
 * A delegated native leaf runs through this proxy with `settingSources: []`
 * (see `resolveLocalAgentScope` in agent-turn.ts — deliberate, so it does NOT
 * pull the project `.cursor/rules` contract + project MCP via the SDK's single
 * coupled `project` switch). That leaves the worker with no Hermes persona /
 * posture and no awareness of the Hermes skill library.
 *
 * This module closes that gap WITHOUT touching `settingSources`: it injects, at
 * session start (the first send to a freshly created agent), a compact preamble
 * carrying (a) the already-generated Hermes contract and (b) a one-line-per-skill
 * index of the available Hermes skills. The preamble is prepended to the prompt
 * (the SDK exposes no dedicated system-prompt seam beyond settingSources), so it
 * lands in the agent's persisted conversation once and steers every later turn.
 *
 * Single source of truth: the skill index is read from the JSON that
 * `.hermes/scripts/generate-cursor-skill-stubs.py` writes from the SAME eligible
 * set that drives the Cursor skill stubs — so this list can never drift from the
 * stubs. The contract text is read verbatim from the generated rule file; it is
 * never re-derived here.
 */

/** Marker prepended to the injected preamble; also used to detect (and skip)
 * double-injection when a prompt already carries the worker context. */
export const WORKER_CONTEXT_SENTINEL = "<!-- hermes:worker-context:v1 -->";

const CONTRACT_REL = path.join(
  ".cursor",
  "rules",
  "hermes-contract.generated.mdc",
);
const INDEX_REL = path.join(".cursor", "skills", ".hermes-skill-index.json");

interface SkillIndexEntry {
  name: string;
  description: string;
  source: string;
}

interface PreambleCache {
  contractPath: string;
  indexPath: string;
  contractMtimeMs: number;
  indexMtimeMs: number;
  preamble: string | undefined;
}

let cache: PreambleCache | undefined;
let rootResolved = false;
let cachedRoot: string | undefined;
let warnedMissing = false;

/**
 * Locate the `~/hermes` control-plane root that owns the generated contract +
 * skill index. Prefers the `HERMES_ROOT` env override; otherwise walks up from
 * this module (works from `src/` in dev and `dist/` after build, both nested
 * under `~/hermes/cursor-openai-api`) until it finds the generated contract.
 */
function resolveHermesRoot(): string | undefined {
  if (rootResolved) return cachedRoot;
  rootResolved = true;

  const envRoot = process.env.HERMES_ROOT?.trim();
  if (envRoot) {
    cachedRoot = envRoot;
    return cachedRoot;
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));
  // Walk up to the filesystem root looking for the generated contract.
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, CONTRACT_REL))) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = undefined;
  return cachedRoot;
}

/** Strip the leading YAML frontmatter fence from the generated contract mdc. */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text.trim();
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text.trim();
  const after = text.indexOf("\n", end + 1);
  return (after === -1 ? "" : text.slice(after + 1)).trim();
}

function formatSkillIndex(entries: SkillIndexEntry[]): string {
  if (entries.length === 0) return "(none)";
  return entries
    .map(
      (e) =>
        `- **${e.name}**: ${e.description} — load via \`hermes-tools\` MCP ` +
        `\`skill_view(name="${e.name}")\` or read \`${e.source}\`.`,
    )
    .join("\n");
}

function buildPreamble(contractBody: string, skillIndex: string): string {
  return [
    WORKER_CONTEXT_SENTINEL,
    "# Hermes worker context (injected at session start)",
    "",
    "You are a Cursor worker delegated by Hermes. The Hermes control plane is " +
      "not loaded via project settings for delegated workers, so the durable " +
      "contract and skill index below are injected directly. Follow the " +
      "contract. When a task matches a skill, load that skill's canonical body " +
      "first (via the `hermes-tools` MCP `skill_view`, or by reading the listed " +
      "`SKILL.md` path) and follow it — do not reinvent the procedure.",
    "",
    "## Hermes contract",
    "",
    contractBody,
    "",
    "## Available Hermes skills (load on demand)",
    "",
    skillIndex,
    "",
    "---",
    "",
  ].join("\n");
}

function readSkillIndex(indexPath: string): SkillIndexEntry[] {
  const raw = JSON.parse(readFileSync(indexPath, "utf8")) as {
    skills?: unknown;
  };
  if (!Array.isArray(raw.skills)) return [];
  const entries: SkillIndexEntry[] = [];
  for (const s of raw.skills) {
    if (
      s &&
      typeof s === "object" &&
      typeof (s as SkillIndexEntry).name === "string" &&
      typeof (s as SkillIndexEntry).description === "string"
    ) {
      const e = s as SkillIndexEntry;
      entries.push({
        name: e.name,
        description: e.description,
        source: typeof e.source === "string" ? e.source : "",
      });
    }
  }
  return entries;
}

/**
 * Build (or return the cached) worker preamble: the Hermes contract followed by
 * the skill index. Returns `undefined` when the control-plane files are not
 * found (injection is then a no-op). Re-reads when either source file's mtime
 * changes so a `generate-cursor-skill-stubs.py` / contract regeneration is
 * picked up without a proxy restart.
 */
export function loadWorkerPreamble(): string | undefined {
  const root = resolveHermesRoot();
  if (!root) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "[cursor-openai-api] worker-context: Hermes root not found " +
          "(set HERMES_ROOT); skill/contract injection disabled.",
      );
    }
    return undefined;
  }

  const contractPath = path.join(root, CONTRACT_REL);
  const indexPath = path.join(root, INDEX_REL);

  let contractMtimeMs = 0;
  let indexMtimeMs = 0;
  try {
    contractMtimeMs = statSync(contractPath).mtimeMs;
  } catch {
    contractMtimeMs = -1;
  }
  try {
    indexMtimeMs = statSync(indexPath).mtimeMs;
  } catch {
    indexMtimeMs = -1;
  }

  if (
    cache &&
    cache.contractPath === contractPath &&
    cache.indexPath === indexPath &&
    cache.contractMtimeMs === contractMtimeMs &&
    cache.indexMtimeMs === indexMtimeMs
  ) {
    return cache.preamble;
  }

  let preamble: string | undefined;
  try {
    const contractBody =
      contractMtimeMs >= 0
        ? stripFrontmatter(readFileSync(contractPath, "utf8"))
        : "";
    const entries = indexMtimeMs >= 0 ? readSkillIndex(indexPath) : [];
    // Need at least one of the two to be worth injecting.
    if (contractBody || entries.length > 0) {
      preamble = buildPreamble(
        contractBody || "(contract unavailable)",
        formatSkillIndex(entries),
      );
    }
  } catch (err) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "[cursor-openai-api] worker-context: failed to build preamble: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    preamble = undefined;
  }

  cache = {
    contractPath,
    indexPath,
    contractMtimeMs,
    indexMtimeMs,
    preamble,
  };
  return preamble;
}

/** A delegated native worker leaf (the only turn that should be injected). The
 * orchestrator (client mode) already carries the contract via its Hermes prompt
 * and must NOT be double-injected. */
export function isNativeWorkerRequest(request: ChatCompletionRequest): boolean {
  const mode = (request as Record<string, unknown>).cursor_tool_mode;
  return typeof mode === "string" && mode.trim() === "native";
}

function payloadHasContext(payload: string | SDKUserMessage): boolean {
  const text = typeof payload === "string" ? payload : payload.text;
  return text.includes(WORKER_CONTEXT_SENTINEL);
}

function prepend(
  payload: string | SDKUserMessage,
  preamble: string,
): string | SDKUserMessage {
  if (typeof payload === "string") return `${preamble}\n${payload}`;
  return { ...payload, text: `${preamble}\n${payload.text}` };
}

/**
 * Inject the worker contract + skill index into `payload` when this turn is the
 * first send to a freshly created native delegated worker. No-ops for the
 * orchestrator, for reused agents (the preamble is already in their persisted
 * history), when the control-plane files are missing, or when the payload
 * already carries the sentinel (defensive double-injection guard).
 */
export function maybeInjectWorkerContext(
  payload: string | SDKUserMessage,
  request: ChatCompletionRequest,
  isNewAgent: boolean,
): string | SDKUserMessage {
  if (!isNewAgent) return payload;
  if (!isNativeWorkerRequest(request)) return payload;
  if (payloadHasContext(payload)) return payload;
  const preamble = loadWorkerPreamble();
  if (!preamble) return payload;
  return prepend(payload, preamble);
}

/** Test-only: drop the cached preamble + resolved root so a test can re-resolve
 * against a fresh fixture root / env. */
export function __resetWorkerContextCacheForTests(): void {
  cache = undefined;
  rootResolved = false;
  cachedRoot = undefined;
  warnedMissing = false;
}
