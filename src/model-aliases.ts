import type { ModelListItem } from "@cursor/sdk";
import { ProxyError } from "./errors.js";

export const MODEL_SPEED_SLOW_SUFFIX = "-slow";
export const MODEL_SPEED_FAST_SUFFIX = "-fast";

/** Cursor catalog param id for the fast-mode toggle. */
export const FAST_MODEL_PARAM_ID = "fast" as const;

export type ModelSpeedAlias = "slow" | "fast";

export type FastParamValue = "true" | "false";

const FAST_VALUE_BY_ALIAS: Record<ModelSpeedAlias, FastParamValue> = {
  slow: "false",
  fast: "true",
};

const SPEED_SUFFIX: ReadonlyArray<{
  suffix: string;
  alias: ModelSpeedAlias;
}> = [
  { suffix: MODEL_SPEED_SLOW_SUFFIX, alias: "slow" },
  { suffix: MODEL_SPEED_FAST_SUFFIX, alias: "fast" },
];

export function requestedIdHasSpeedSuffix(requestedId: string): boolean {
  return SPEED_SUFFIX.some(({ suffix }) => requestedId.endsWith(suffix));
}

export function fastParamValueForSpeedAlias(alias: ModelSpeedAlias): FastParamValue {
  return FAST_VALUE_BY_ALIAS[alias];
}

export function modelSupportsSpeedAliases(
  model: Pick<ModelListItem, "parameters"> | undefined,
): boolean {
  const values = new Set(
    model?.parameters
      ?.find((p) => p.id === FAST_MODEL_PARAM_ID)
      ?.values.map((v) => v.value) ?? [],
  );
  return (
    values.has(FAST_VALUE_BY_ALIAS.slow) &&
    values.has(FAST_VALUE_BY_ALIAS.fast)
  );
}

export type SpeedAliasContext = {
  requestedId: string;
  baseId: string;
  speedAlias?: ModelSpeedAlias;
  catalogModel: ModelListItem | undefined;
  /** When true, unknown base ids for aliased requests are rejected. */
  validateAgainstCatalog: boolean;
};

/**
 * Validates `*-slow` / `*-fast` requests and returns the `fast` param value
 * implied by the alias. `mergeModelParams` applies explicit
 * `cursor_model_params` on top when present.
 */
export function resolveSpeedAliasParams(
  ctx: SpeedAliasContext,
): FastParamValue | undefined {
  const { requestedId, baseId, speedAlias, catalogModel, validateAgainstCatalog } = ctx;

  if (!speedAlias) {
    return undefined;
  }

  if (validateAgainstCatalog && !catalogModel) {
    throw new ProxyError(
      `Model "${requestedId}" is unknown (resolved base id "${baseId}")`,
      400,
      "invalid_request_error",
      "model_not_found",
    );
  }

  if (!modelSupportsSpeedAliases(catalogModel)) {
    throw new ProxyError(
      `Model "${requestedId}" does not support speed aliases (*-slow / *-fast)`,
      400,
      "invalid_request_error",
      "unsupported_speed_alias",
    );
  }

  return fastParamValueForSpeedAlias(speedAlias);
}

/**
 * Parses `base-slow` / `base-fast` unless `requestedId` is an exact catalog id
 * (so a hypothetical future `foo-fast` sku is not stripped).
 */
export function resolveRequestedModelId(
  requestedId: string,
  catalogIds?: ReadonlySet<string>,
): { baseId: string; speedAlias?: ModelSpeedAlias } {
  if (catalogIds?.has(requestedId)) {
    return { baseId: requestedId };
  }

  for (const { suffix, alias } of SPEED_SUFFIX) {
    if (requestedId.endsWith(suffix)) {
      const baseId = requestedId.slice(0, -suffix.length);
      if (baseId.length > 0) {
        return { baseId, speedAlias: alias };
      }
    }
  }

  return { baseId: requestedId };
}

export function speedAliasModelId(baseId: string, alias: ModelSpeedAlias): string {
  return `${baseId}${alias === "slow" ? MODEL_SPEED_SLOW_SUFFIX : MODEL_SPEED_FAST_SUFFIX}`;
}

export function speedAliasDisplayName(
  displayName: string | undefined,
  alias: ModelSpeedAlias,
): string {
  const label = alias === "slow" ? "Slow" : "Fast";
  return displayName ? `${displayName} (${label})` : label;
}
