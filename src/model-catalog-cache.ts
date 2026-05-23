import { Cursor, type ModelListItem } from "@cursor/sdk";

const CACHE_TTL_MS = 60_000;

interface CatalogCacheEntry {
  models: ModelListItem[];
  fetchedAt: number;
}

const catalogByApiKey = new Map<string, CatalogCacheEntry>();

export async function listCachedModels(apiKey: string): Promise<ModelListItem[]> {
  const now = Date.now();
  const cached = catalogByApiKey.get(apiKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }

  const models = await Cursor.models.list({ apiKey });
  catalogByApiKey.set(apiKey, { models, fetchedAt: now });
  return models;
}

export function clearModelCatalogCacheForTests(): void {
  catalogByApiKey.clear();
}

export function seedModelCatalogForTests(
  apiKey: string,
  models: ModelListItem[],
): void {
  catalogByApiKey.set(apiKey, { models, fetchedAt: Date.now() });
}
