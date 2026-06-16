import type { AppConfig } from "../config.js";
import type { ChatCompletionRequest } from "../openai.js";
import { isRecord } from "./guards.js";
import type { ClientToolSpec } from "./types.js";

/**
 * Progressive disclosure for the client-mode tool inventory (Phase 1).
 *
 * Key realization: the model does not need a tool's full prose JSON schema to
 * emit a correct marker call — it only needs the tool name and its argument
 * names. Hermes (the executor) already holds the real schemas. So rarely-used
 * tools can be rendered as a compact signature (`name(arg1, arg2?) — summary`)
 * instead of the full schema, end-to-end, with no upstream change and no
 * meta-tool round trip.
 *
 * Tiers:
 *  - `full`   : every tool gets its full JSON schema (legacy behavior, default).
 *  - `tiered` : resident tools get full schemas; the rest get brief signatures.
 *  - `brief`  : every tool gets a brief signature.
 */

export const TOOL_TIER_MODES = ["full", "tiered", "brief"] as const;
export type ToolTierMode = (typeof TOOL_TIER_MODES)[number];

export const DEFAULT_TOOL_TIER_MODE: ToolTierMode = "full";

/**
 * High-frequency tools that stay resident (full schema) in `tiered` mode. These
 * are the ones an orchestrator calls directly most often; everything else is
 * cheap to render as a signature and pull detail for only when needed.
 */
export const DEFAULT_RESIDENT_TOOLS = [
  "read_file",
  "write_file",
  "patch",
  "search_files",
  "terminal",
  "delegate_task",
];

export interface ToolTierPolicy {
  mode: ToolTierMode;
  resident: Set<string>;
}

function parseList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : value.split(",");
  return raw.map((entry) => entry.trim()).filter(Boolean);
}

function parseTierMode(value: string | undefined): ToolTierMode | undefined {
  return (TOOL_TIER_MODES as readonly string[]).includes(value ?? "")
    ? (value as ToolTierMode)
    : undefined;
}

export function resolveToolTier(
  request: ChatCompletionRequest,
  config: AppConfig,
): ToolTierPolicy {
  const mode =
    request.cursor_tool_tier ??
    parseTierMode(request.metadata?.["cursor_tool_tier"]) ??
    config.CURSOR_TOOL_TIER ??
    DEFAULT_TOOL_TIER_MODE;

  const resident =
    parseList(request.cursor_tool_resident) ??
    parseList(request.metadata?.["cursor_tool_resident"]) ??
    parseList(config.CURSOR_TOOL_RESIDENT) ??
    DEFAULT_RESIDENT_TOOLS;

  return { mode, resident: new Set(resident) };
}

/** First sentence of a description, whitespace-collapsed and length-capped. */
export function firstSentence(text: string, max = 160): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  const period = trimmed.indexOf(". ");
  let sentence = period === -1 ? trimmed : trimmed.slice(0, period + 1);
  if (sentence.length > max) {
    sentence = `${sentence.slice(0, max - 1).trimEnd()}…`;
  }
  return sentence;
}

/** `name(req, opt?)` — argument names from the JSON schema, `?` = optional. */
export function toolSignature(spec: ClientToolSpec): string {
  const params = isRecord(spec.parameters) ? spec.parameters : undefined;
  const properties = isRecord(params?.properties) ? params.properties : undefined;
  if (!properties) return `${spec.name}()`;

  const required = new Set(
    Array.isArray(params?.required)
      ? (params.required as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [],
  );
  const args = Object.keys(properties).map((key) =>
    required.has(key) ? key : `${key}?`,
  );
  return `${spec.name}(${args.join(", ")})`;
}

/** Compact one-line catalog entry: `name(args) — first sentence`. */
export function briefToolLine(spec: ClientToolSpec): string {
  const signature = toolSignature(spec);
  const summary = spec.description ? firstSentence(spec.description) : "";
  return summary ? `${signature} — ${summary}` : signature;
}

export interface ToolTierSplit {
  full: ClientToolSpec[];
  brief: ClientToolSpec[];
}

export function splitToolTiers(
  tools: ClientToolSpec[],
  tier: ToolTierPolicy,
): ToolTierSplit {
  if (tier.mode === "full") return { full: tools, brief: [] };
  if (tier.mode === "brief") return { full: [], brief: tools };
  const full: ClientToolSpec[] = [];
  const brief: ClientToolSpec[] = [];
  for (const tool of tools) {
    (tier.resident.has(tool.name) ? full : brief).push(tool);
  }
  return { full, brief };
}
