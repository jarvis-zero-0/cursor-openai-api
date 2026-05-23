import { describe, expect, test } from "bun:test";
import { clearModelCatalogCacheForTests } from "../src/model-catalog-cache.js";

describe("model catalog cache", () => {
  test("clearForTests is safe to call", () => {
    expect(() => clearModelCatalogCacheForTests()).not.toThrow();
  });
});
