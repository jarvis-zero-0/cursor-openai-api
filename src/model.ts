import { Cursor, type ModelListItem, type ModelParameterValue } from "@cursor/sdk";
import type { AppConfig } from "./config.js";
import type { ChatCompletionRequest } from "./openai.js";
import { ProxyError } from "./errors.js";
import { listCachedModels } from "./model-catalog-cache.js";
import { resolveIncludeThinking } from "./turn-policy.js";

export type ModelSelection = {
  id: string;
  params?: ModelParameterValue[];
};

function paramIdLooksLikeThinkingEffort(
  id: string,
  displayName?: string,
): boolean {
  if (id === "thinking_effort" || id === "thinking") return true;
  return displayName?.toLowerCase().includes("thinking") ?? false;
}

export function findThinkingEffortParamId(
  model: Pick<ModelListItem, "parameters" | "variants"> | undefined,
): string | undefined {
  if (!model) return undefined;

  const fromParameters = model.parameters?.find((p) =>
    paramIdLooksLikeThinkingEffort(p.id, p.displayName),
  )?.id;
  if (fromParameters) return fromParameters;

  for (const variant of model.variants ?? []) {
    for (const param of variant.params) {
      if (paramIdLooksLikeThinkingEffort(param.id)) return param.id;
    }
  }

  return undefined;
}

export function defaultThinkingEffortValue(
  model: ModelListItem,
  effortParamId: string,
): string {
  const fromDefaultVariant = model.variants?.find((v) => v.isDefault)?.params;
  const variantValue = fromDefaultVariant?.find((p) => p.id === effortParamId)?.value;
  if (variantValue) return variantValue;

  const param = model.parameters?.find((p) => p.id === effortParamId);
  return param?.values[0]?.value ?? "medium";
}

export function mergeModelParams(
  explicit: ModelParameterValue[] | undefined,
  reasoningEffort: string | undefined,
  effortParamId: string | undefined,
  autoThinkingEffort?: string,
): ModelParameterValue[] | undefined {
  const byId = new Map<string, string>();
  if (effortParamId && autoThinkingEffort !== undefined) {
    byId.set(effortParamId, autoThinkingEffort);
  }
  if (effortParamId && reasoningEffort !== undefined) {
    byId.set(effortParamId, reasoningEffort);
  }
  for (const param of explicit ?? []) {
    byId.set(param.id, param.value);
  }
  if (byId.size === 0) return undefined;
  return [...byId.entries()].map(([id, value]) => ({ id, value }));
}

export async function resolveModelSelection(
  request: ChatCompletionRequest,
  config: AppConfig,
  includeThinking = resolveIncludeThinking(request, config),
): Promise<ModelSelection> {
  const id = request.model ?? config.DEFAULT_MODEL;
  const explicit = request.cursor_model_params;

  if (explicit?.some((p) => !p.id?.trim())) {
    throw new ProxyError(
      "cursor_model_params entries require a non-empty id",
      400,
      "invalid_request_error",
      "invalid_cursor_model_params",
    );
  }

  const needsCatalog =
    request.reasoning_effort !== undefined || includeThinking;

  let catalogModel: ModelListItem | undefined;
  if (needsCatalog) {
    const models = await listCachedModels(config.CURSOR_API_KEY);
    catalogModel = models.find((m) => m.id === id);
  }

  const effortParamId = findThinkingEffortParamId(catalogModel);

  if (request.reasoning_effort !== undefined && !effortParamId) {
    throw new ProxyError(
      `Model "${id}" does not support reasoning_effort`,
      400,
      "invalid_request_error",
      "unsupported_reasoning_effort",
    );
  }

  const reasoningEffort =
    request.reasoning_effort !== undefined && effortParamId
      ? request.reasoning_effort
      : undefined;

  const explicitHasEffort =
    effortParamId != null &&
    explicit?.some((p) => p.id === effortParamId);

  const autoThinkingEffort =
    includeThinking &&
    effortParamId &&
    !explicitHasEffort &&
    request.reasoning_effort === undefined &&
    catalogModel
      ? defaultThinkingEffortValue(catalogModel, effortParamId)
      : undefined;

  const params = mergeModelParams(
    explicit,
    reasoningEffort,
    effortParamId,
    autoThinkingEffort,
  );

  return params ? { id, params } : { id };
}
