import { describe, expect, test } from "bun:test";
import { normalizeToolArguments } from "../src/tool-args.js";

describe("normalizeToolArguments", () => {
  test("returns empty object for blank input", () => {
    expect(normalizeToolArguments("")).toBe("{}");
    expect(normalizeToolArguments("   ")).toBe("{}");
  });

  test("preserves valid JSON", () => {
    expect(normalizeToolArguments('{"a":1}')).toBe('{"a":1}');
  });

  test("wraps invalid JSON as a JSON string", () => {
    expect(normalizeToolArguments("not-json")).toBe('"not-json"');
  });

  test("unwraps double-encoded JSON objects", () => {
    const inner = '{"goal":"Fix bug","context":"repo"}';
    const doubleEncoded = JSON.stringify(inner);
    expect(normalizeToolArguments(doubleEncoded)).toBe(inner);
  });
});
