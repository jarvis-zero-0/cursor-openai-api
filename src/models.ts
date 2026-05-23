import type { SDKModel } from "@cursor/sdk";
import { listCachedModels } from "./model-catalog-cache.js";
import type { ModelsListResponse } from "./openai.js";

const MODEL_CREATED = 1700000000;

export async function listModels(apiKey: string): Promise<ModelsListResponse> {
  const models = await listCachedModels(apiKey);
  return {
    object: "list",
    data: models.map((m: SDKModel) => ({
      id: m.id,
      object: "model" as const,
      created: MODEL_CREATED,
      owned_by: "cursor",
      ...(m.displayName ? { display_name: m.displayName } : {}),
      ...(m.description ? { description: m.description } : {}),
      ...(m.aliases?.length ? { cursor_aliases: m.aliases } : {}),
      ...(m.parameters?.length ? { cursor_parameters: m.parameters } : {}),
      ...(m.variants?.length ? { cursor_variants: m.variants } : {}),
    })),
  };
}
