import { describe, expect, test } from "bun:test";
import {
  defaultThinkingEffortValue,
  findThinkingEffortParamId,
  mergeModelParams,
} from "../src/model.js";

describe("findThinkingEffortParamId", () => {
  test("prefers exact thinking_effort id", () => {
    const id = findThinkingEffortParamId({
      parameters: [
        { id: "other", values: [{ value: "x" }] },
        { id: "thinking_effort", values: [{ value: "low" }] },
      ],
    });
    expect(id).toBe("thinking_effort");
  });

  test("falls back to id containing thinking", () => {
    const id = findThinkingEffortParamId({
      parameters: [
        { id: "max_mode", values: [{ value: "on" }] },
        { id: "thinking", values: [{ value: "high" }] },
      ],
    });
    expect(id).toBe("thinking");
  });

  test("reads effort param from variant presets", () => {
    const id = findThinkingEffortParamId({
      variants: [
        {
          displayName: "High",
          params: [{ id: "thinking_effort", value: "high" }],
        },
      ],
    });
    expect(id).toBe("thinking_effort");
  });

  test("returns undefined when no match", () => {
    expect(findThinkingEffortParamId(undefined)).toBeUndefined();
    expect(findThinkingEffortParamId({ parameters: [] })).toBeUndefined();
  });
});

describe("mergeModelParams", () => {
  test("merges explicit params over reasoning_effort", () => {
    const params = mergeModelParams(
      [{ id: "thinking_effort", value: "high" }],
      "low",
      "thinking_effort",
    );
    expect(params).toEqual([{ id: "thinking_effort", value: "high" }]);
  });

  test("adds reasoning_effort when not in explicit params", () => {
    const params = mergeModelParams(undefined, "medium", "thinking_effort");
    expect(params).toEqual([{ id: "thinking_effort", value: "medium" }]);
  });

  test("returns undefined when empty", () => {
    expect(mergeModelParams(undefined, undefined, undefined)).toBeUndefined();
  });

  test("applies auto thinking effort before explicit overrides", () => {
    const params = mergeModelParams(
      [{ id: "thinking_effort", value: "high" }],
      undefined,
      "thinking_effort",
      "low",
    );
    expect(params).toEqual([{ id: "thinking_effort", value: "high" }]);
  });

  test("uses auto thinking effort when nothing else set", () => {
    const params = mergeModelParams(
      undefined,
      undefined,
      "thinking_effort",
      "medium",
    );
    expect(params).toEqual([{ id: "thinking_effort", value: "medium" }]);
  });
});

describe("defaultThinkingEffortValue", () => {
  test("prefers default variant params", () => {
    const value = defaultThinkingEffortValue(
      {
        id: "composer-2.5",
        displayName: "Composer",
        variants: [
          {
            displayName: "Default",
            isDefault: true,
            params: [{ id: "thinking_effort", value: "high" }],
          },
        ],
        parameters: [
          {
            id: "thinking_effort",
            values: [{ value: "low" }, { value: "high" }],
          },
        ],
      },
      "thinking_effort",
    );
    expect(value).toBe("high");
  });
});
