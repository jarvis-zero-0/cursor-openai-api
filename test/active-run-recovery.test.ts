import { afterEach, describe, expect, test } from "bun:test";
import type { SDKAgent } from "@cursor/sdk";
import { isActiveRunError, mapCursorError } from "../src/errors.js";
import { SessionStore } from "../src/session-store.js";

describe("isActiveRunError", () => {
  test("matches the SDK's raw 'already has active run' error", () => {
    const err = new Error("Agent agent-5e6ea7ec already has active run");
    expect(isActiveRunError(err)).toBe(true);
  });

  test("still matches after mapCursorError wrapping (message preserved)", () => {
    const wrapped = mapCursorError(
      new Error("Agent agent-abc already has active run"),
    );
    expect(isActiveRunError(wrapped)).toBe(true);
  });

  test("matches a bare string", () => {
    expect(isActiveRunError("already has active run")).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isActiveRunError(new Error("Agent run failed"))).toBe(false);
    expect(isActiveRunError(undefined)).toBe(false);
    expect(isActiveRunError({ nope: 1 })).toBe(false);
  });
});

describe("evictSession", () => {
  const store = new SessionStore();
  afterEach(() => store.clearForTests());

  test("drops and disposes a poisoned cached agent so reuse is gone", () => {
    let disposed = false;
    const agent = {
      agentId: "agent-poisoned",
      [Symbol.asyncDispose]: async () => {
        disposed = true;
      },
    } as unknown as SDKAgent;

    store.registerTestSession("hermes:wedged", {
      agent,
      agentId: "agent-poisoned",
      modelId: "composer-2.5",
      messageCount: 2,
      messagesSnapshot: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      lastAccess: Date.now(),
    });

    expect(
      store.listActiveSessions().some((s) => s.session_id === "hermes:wedged"),
    ).toBe(true);

    store.evictSession("hermes:wedged");

    expect(
      store.listActiveSessions().some((s) => s.session_id === "hermes:wedged"),
    ).toBe(false);
    expect(disposed).toBe(true);
  });

  test("evicting an unknown key is a no-op", () => {
    expect(() => store.evictSession("hermes:does-not-exist")).not.toThrow();
  });
});
