import type { SDKModel } from "@cursor/sdk";
import { listCachedModels } from "./model-catalog-cache.js";
import {
  buildCatalogLookup,
  catalogEntryIsVisible,
  parseModelAllowlist,
  publicModelId,
} from "./model-catalog-filter.js";
import {
  FAST_MODEL_PARAM_ID,
  type ModelSpeedAlias,
  fastParamValueForSpeedAlias,
  modelSupportsSpeedAliases,
  speedAliasDisplayName,
  speedAliasModelId,
} from "./model-aliases.js";
import type { ModelsListResponse, OpenAIModel } from "./openai.js";

const MODEL_CREATED = 1700000000;
const SPEED_ALIASES = ["slow", "fast"] as const satisfies readonly ModelSpeedAlias[];

function catalogModelToOpenAI(m: SDKModel, publicId: string): OpenAIModel {
  return {
    id: publicId,
    object: "model",
    created: MODEL_CREATED,
    owned_by: "cursor",
    ...(m.displayName ? { display_name: m.displayName } : {}),
    ...(m.description ? { description: m.description } : {}),
    ...(publicId !== m.id ? { cursor_catalog_id: m.id } : {}),
    ...(m.aliases?.length ? { cursor_aliases: m.aliases } : {}),
    ...(m.parameters?.length ? { cursor_parameters: m.parameters } : {}),
    ...(m.variants?.length ? { cursor_variants: m.variants } : {}),
  };
}

function speedAliasOpenAIModel(
  m: SDKModel,
  publicId: string,
  alias: ModelSpeedAlias,
): OpenAIModel {
  return {
    id: speedAliasModelId(publicId, alias),
    object: "model",
    created: MODEL_CREATED,
    owned_by: "cursor",
    display_name: speedAliasDisplayName(m.displayName, alias),
    ...(m.description ? { description: m.description } : {}),
    ...(m.parameters?.length ? { cursor_parameters: m.parameters } : {}),
    cursor_base_model: publicId,
    ...(publicId !== m.id ? { cursor_catalog_id: m.id } : {}),
    cursor_speed_alias: alias,
    cursor_model_params: [
      { id: FAST_MODEL_PARAM_ID, value: fastParamValueForSpeedAlias(alias) },
    ],
  };
}

export async function listModels(
  apiKey: string,
  emitSpeedAliases = true,
  modelAllowlistRaw?: string,
): Promise<ModelsListResponse> {
  const models = await listCachedModels(apiKey);
  const allowlist = parseModelAllowlist(modelAllowlistRaw);
  const lookup = buildCatalogLookup(models);
  const emittedIds = new Set<string>();
  const data: OpenAIModel[] = [];

  for (const m of models) {
    if (!catalogEntryIsVisible(m, allowlist)) {
      continue;
    }
    const publicId = publicModelId(m);
    if (emittedIds.has(publicId)) {
      continue;
    }
    emittedIds.add(publicId);
    data.push(catalogModelToOpenAI(m, publicId));
    if (emitSpeedAliases && modelSupportsSpeedAliases(m)) {
      for (const alias of SPEED_ALIASES) {
        const speedId = speedAliasModelId(publicId, alias);
        if (!lookup.allKnownIds.has(speedId) && !emittedIds.has(speedId)) {
          data.push(speedAliasOpenAIModel(m, publicId, alias));
          emittedIds.add(speedId);
        }
      }
    }
  }

  return { object: "list", data };
}
