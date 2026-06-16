import type { AppConfig } from "../config.js";
import type { ChatCompletionRequest } from "../openai.js";
import type { ClientToolSpec } from "./types.js";
import { UNMAPPED_TOOLSET, toolsetForTool } from "./toolsets.js";

/**
 * Per-request restriction on which client tools get serialized into the prompt.
 *
 * Every Hermes tool ships a prose-heavy JSON schema; injecting all ~28 of them
 * every turn is the dominant fixed cost on the client-mode path. A filter lets a
 * caller (or the proxy default) drop tools a turn cannot use before they are ever
 * serialized, without any upstream Hermes change.
 */
export interface ToolFilter {
  /** Tool-name patterns to keep (exact, or trailing `*` prefix). */
  allow?: string[];
  /** Tool-name patterns to always drop (exact, or trailing `*` prefix). */
  deny?: string[];
  /** Toolset names to keep (see toolsets.ts). */
  toolsets?: string[];
  /** When toolset filtering is active, keep tools with no known toolset. */
  keepUnmapped: boolean;
}

function parseList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : value.split(",");
  return raw.map((entry) => entry.trim()).filter(Boolean);
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function metaValue(
  request: ChatCompletionRequest,
  key: string,
): string | undefined {
  return request.metadata?.[key];
}

function resolveList(
  requestValue: string[] | undefined,
  metaValueRaw: string | undefined,
  configValue: string | undefined,
): string[] | undefined {
  if (requestValue !== undefined) return parseList(requestValue);
  if (metaValueRaw !== undefined) return parseList(metaValueRaw);
  if (configValue !== undefined) return parseList(configValue);
  return undefined;
}

function resolveKeepUnmapped(
  request: ChatCompletionRequest,
  config: AppConfig,
): boolean {
  if (request.cursor_toolsets_keep_unmapped !== undefined) {
    return request.cursor_toolsets_keep_unmapped;
  }
  const fromMeta = parseBool(metaValue(request, "cursor_toolsets_keep_unmapped"));
  if (fromMeta !== undefined) return fromMeta;
  if (config.CURSOR_TOOLSETS_KEEP_UNMAPPED !== undefined) {
    return config.CURSOR_TOOLSETS_KEEP_UNMAPPED;
  }
  // Fail open: an incomplete toolset map must never silently strip a needed tool.
  return true;
}

export function resolveToolFilter(
  request: ChatCompletionRequest,
  config: AppConfig,
): ToolFilter {
  return {
    allow: resolveList(
      request.cursor_tools_allow,
      metaValue(request, "cursor_tools_allow"),
      config.CURSOR_TOOL_ALLOWLIST,
    ),
    deny: resolveList(
      request.cursor_tools_deny,
      metaValue(request, "cursor_tools_deny"),
      config.CURSOR_TOOL_DENYLIST,
    ),
    toolsets: resolveList(
      request.cursor_enabled_toolsets,
      metaValue(request, "cursor_enabled_toolsets"),
      config.CURSOR_ENABLED_TOOLSETS,
    ),
    keepUnmapped: resolveKeepUnmapped(request, config),
  };
}

/** True when the filter would keep every tool (no positive or negative rule). */
export function isNoopToolFilter(filter: ToolFilter): boolean {
  return (
    !(filter.allow && filter.allow.length) &&
    !(filter.deny && filter.deny.length) &&
    !(filter.toolsets && filter.toolsets.length)
  );
}

function matchesPattern(pattern: string, name: string): boolean {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, name));
}

export function applyToolFilter(
  specs: ClientToolSpec[],
  filter: ToolFilter,
): ClientToolSpec[] {
  if (isNoopToolFilter(filter)) return specs;

  const allow = filter.allow ?? [];
  const deny = filter.deny ?? [];
  const toolsets = new Set(filter.toolsets ?? []);
  const hasAllow = allow.length > 0;
  const hasToolsets = toolsets.size > 0;

  return specs.filter((spec) => {
    if (deny.length && matchesAny(deny, spec.name)) return false;
    if (!hasAllow && !hasToolsets) return true;

    if (hasAllow && matchesAny(allow, spec.name)) return true;
    if (hasToolsets) {
      const toolset = toolsetForTool(spec.name);
      if (toolsets.has(toolset)) return true;
      if (filter.keepUnmapped && toolset === UNMAPPED_TOOLSET) return true;
    }
    return false;
  });
}

/** Resolve and apply the request's tool filter in one step. */
export function filterClientTools(
  specs: ClientToolSpec[],
  request: ChatCompletionRequest,
  config: AppConfig,
): ClientToolSpec[] {
  return applyToolFilter(specs, resolveToolFilter(request, config));
}
