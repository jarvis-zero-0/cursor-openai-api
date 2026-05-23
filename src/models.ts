import type { SDKModel } from "@cursor/sdk";
import { listCachedModels } from "./model-catalog-cache.js";
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

function catalogModelToOpenAI(m: SDKModel): OpenAIModel {
  return {
    id: m.id,
    object: "model",
    created: MODEL_CREATED,
    owned_by: "cursor",
    ...(m.displayName ? { display_name: m.displayName } : {}),
    ...(m.description ? { description: m.description } : {}),
    ...(m.aliases?.length ? { cursor_aliases: m.aliases } : {}),
    ...(m.parameters?.length ? { cursor_parameters: m.parameters } : {}),
    ...(m.variants?.length ? { cursor_variants: m.variants } : {}),
  };
}

function speedAliasOpenAIModel(
  m: SDKModel,
  alias: ModelSpeedAlias,
): OpenAIModel {
  return {
    id: speedAliasModelId(m.id, alias),
    object: "model",
    created: MODEL_CREATED,
    owned_by: "cursor",
    display_name: speedAliasDisplayName(m.displayName, alias),
    ...(m.description ? { description: m.description } : {}),
    ...(m.parameters?.length ? { cursor_parameters: m.parameters } : {}),
    cursor_base_model: m.id,
    cursor_speed_alias: alias,
    cursor_model_params: [
      { id: FAST_MODEL_PARAM_ID, value: fastParamValueForSpeedAlias(alias) },
    ],
  };
}

export async function listModels(apiKey: string): Promise<ModelsListResponse> {
  const models = await listCachedModels(apiKey);
  const catalogIds = new Set(models.map((m) => m.id));
  const data: OpenAIModel[] = [];

  for (const m of models) {
    data.push(catalogModelToOpenAI(m));
    if (modelSupportsSpeedAliases(m)) {
      for (const alias of SPEED_ALIASES) {
        if (!catalogIds.has(speedAliasModelId(m.id, alias))) {
          data.push(speedAliasOpenAIModel(m, alias));
        }
      }
    }
  }

  return { object: "list", data };
}
