import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_ALLOWLIST,
  catalogEntryIsVisible,
  isCatalogModelVisible,
  parseModelAllowlist,
  publicModelId,
} from "../src/model-catalog-filter.js";

describe("parseModelAllowlist", () => {
  test("defaults to curated latest sku set when unset", () => {
    const allowlist = parseModelAllowlist(undefined);
    expect(allowlist).toEqual(new Set(DEFAULT_MODEL_ALLOWLIST));
  });

  test("returns undefined for wildcard (no filter)", () => {
    expect(parseModelAllowlist("*")).toBeUndefined();
  });

  test("parses comma-separated override", () => {
    expect(parseModelAllowlist("composer-2.5, claude-opus-4-8")).toEqual(
      new Set(["composer-2.5", "claude-opus-4-8"]),
    );
  });
});

describe("catalogEntryIsVisible", () => {
  test("allows everything when allowlist is undefined", () => {
    expect(
      catalogEntryIsVisible({ id: "composer-2" }, undefined),
    ).toBe(true);
  });

  test("matches catalog id against allowlist", () => {
    const allowlist = new Set(["composer-2.5"]);
    const entry = {
      id: "composer-2.5",
      aliases: ["composer-latest", "composer"],
    };
    expect(catalogEntryIsVisible(entry, allowlist)).toBe(true);
    expect(catalogEntryIsVisible({ id: "composer-2" }, allowlist)).toBe(false);
  });
});

describe("publicModelId", () => {
  test("returns catalog sku id", () => {
    expect(
      publicModelId({
        id: "claude-opus-4-8",
        aliases: ["opus-latest", "opus"],
      }),
    ).toBe("claude-opus-4-8");
    expect(
      publicModelId({
        id: "gemini-3.5-flash",
        aliases: ["gemini-flash-latest", "gemini-flash"],
      }),
    ).toBe("gemini-3.5-flash");
  });
});

describe("isCatalogModelVisible", () => {
  test("allows everything when allowlist is undefined", () => {
    expect(isCatalogModelVisible("composer-2", undefined)).toBe(true);
  });

  test("filters to allowlist members", () => {
    const allowlist = new Set(["composer-2.5"]);
    expect(isCatalogModelVisible("composer-2.5", allowlist)).toBe(true);
    expect(isCatalogModelVisible("composer-2", allowlist)).toBe(false);
  });
});
