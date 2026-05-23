import { describe, expect, test } from "bun:test";
import { hashMessageSnapshot, stableMessageShape } from "../src/message-fingerprint.js";

describe("message fingerprint", () => {
  test("stableMessageShape is deterministic", () => {
    const message = { role: "user" as const, content: "Hi" };
    expect(stableMessageShape(message)).toBe(stableMessageShape(message));
  });

  test("hash differs when prefix content differs", () => {
    const a = hashMessageSnapshot([{ role: "user", content: "Hi" }]);
    const b = hashMessageSnapshot([{ role: "user", content: "Bye" }]);
    expect(a).not.toBe(b);
  });

  test("hash differs when reasoning differs", () => {
    const a = hashMessageSnapshot([
      { role: "assistant", content: "Hi", reasoning_content: "plan A" },
    ]);
    const b = hashMessageSnapshot([
      { role: "assistant", content: "Hi", reasoning_content: "plan B" },
    ]);
    expect(a).not.toBe(b);
  });

  test("hash matches for equivalent prefixes", () => {
    const messages = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Hello" },
    ];
    const full = hashMessageSnapshot(messages);
    const prefix = hashMessageSnapshot(messages.slice(0, 1));
    expect(full).not.toBe(prefix);
    expect(hashMessageSnapshot([{ role: "user", content: "Hi" }])).toBe(prefix);
  });
});
