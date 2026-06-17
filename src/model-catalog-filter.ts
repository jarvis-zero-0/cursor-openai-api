import type { ModelListItem } from "@cursor/sdk";

/**
 * Curated Cursor catalog sku ids exposed on GET /v1/models.
 * These are the real ids from Cursor.models.list() — versioned, not generic aliases.
 * Override with CURSOR_MODEL_ALLOWLIST (comma-separated). Use "*" for no filter.
 */
export const DEFAULT_MODEL_ALLOWLIST = [
  // Cursor "Auto": server-side picks the best available model for the request.
  // At worst this resolves to Composer 2.5; often a stronger model.
  "default",
  "composer-2.5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gemini-3.5-flash",
  "gemini-3-flash",
  "gemini-3.1-pro",
  "gpt-5.5",
] as const;

export type CatalogLookup = {
  byId: Map<string, ModelListItem>;
  byAlias: Map<string, ModelListItem>;
  /** Catalog ids plus every alias string (for exact-id checks). */
  allKnownIds: Set<string>;
};

export function buildCatalogLookup(
  models: readonly ModelListItem[],
): CatalogLookup {
  const byId = new Map<string, ModelListItem>();
  const byAlias = new Map<string, ModelListItem>();
  const allKnownIds = new Set<string>();

  for (const model of models) {
    byId.set(model.id, model);
    allKnownIds.add(model.id);
    for (const alias of model.aliases ?? []) {
      byAlias.set(alias, model);
      allKnownIds.add(alias);
    }
  }

  return { byId, byAlias, allKnownIds };
}

export function resolveCatalogEntry(
  requestedId: string,
  lookup: CatalogLookup,
): ModelListItem | undefined {
  return lookup.byId.get(requestedId) ?? lookup.byAlias.get(requestedId);
}

export function parseModelAllowlist(
  raw: string | undefined,
): ReadonlySet<string> | undefined {
  if (raw === undefined || raw.trim() === "") {
    return new Set(DEFAULT_MODEL_ALLOWLIST);
  }
  const trimmed = raw.trim();
  if (trimmed === "*") {
    return undefined;
  }
  const ids = trimmed
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : undefined;
}

/** Public OpenAI model id — always the catalog sku (e.g. `claude-opus-4-8`). */
export function publicModelId(entry: ModelListItem): string {
  return entry.id;
}

export function catalogEntryIsVisible(
  entry: ModelListItem,
  allowlist: ReadonlySet<string> | undefined,
): boolean {
  if (!allowlist) {
    return true;
  }
  if (allowlist.has(entry.id)) {
    return true;
  }
  return (entry.aliases ?? []).some((alias) => allowlist.has(alias));
}

/** @deprecated Use catalogEntryIsVisible with a full catalog entry. */
export function isCatalogModelVisible(
  modelId: string,
  allowlist: ReadonlySet<string> | undefined,
): boolean {
  if (!allowlist) {
    return true;
  }
  return allowlist.has(modelId);
}
