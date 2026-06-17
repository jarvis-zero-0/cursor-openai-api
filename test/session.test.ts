import { afterAll, describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import type { SDKAgent } from "@cursor/sdk";
import { SessionStore } from "../src/session-store.js";
import {
  resolveSessionKey,
} from "../src/session-keys.js";

const baseConfig: AppConfig = {
  CURSOR_API_KEY: "key",
  CURSOR_CWD: "/tmp",
  PORT: 8080,
  HOST: "0.0.0.0",
  DEFAULT_MODEL: "composer-2.5",
  DEBUG_STREAM: false,
  CURSOR_INCLUDE_THINKING: true,
  CURSOR_EMIT_TOOL_CALLS: false,
  CURSOR_ENABLE_SESSIONS: true,
  CURSOR_AUTO_SESSION: true,
  CURSOR_SESSION_TTL_MS: 60_000,
  CURSOR_SESSION_MAX: 8,
};

const store = new SessionStore();

describe("resolveSessionKey", () => {
  test("prefers x-session-id header", () => {
    const key = resolveSessionKey(
      { messages: [{ role: "user", content: "hi" }] },
      { "x-session-id": "sess-abc" },
    );
    expect(key).toBe("sess-abc");
  });

  test("reads metadata.session_id", () => {
    const key = resolveSessionKey({
      messages: [{ role: "user", content: "hi" }],
      metadata: { session_id: "meta-1" },
    });
    expect(key).toBe("meta-1");
  });

  test("does not use OpenAI user field as session id", () => {
    const key = resolveSessionKey({
      messages: [{ role: "user", content: "hi" }],
      user: "alice",
    });
    expect(key).toBeUndefined();
  });

  test("reads metadata.hermes_session_id as stable keyed session", () => {
    const key = resolveSessionKey({
      messages: [{ role: "user", content: "hi" }],
      metadata: { hermes_session_id: "20260615_abc123" },
    });
    expect(key).toBe("hermes:20260615_abc123");
  });

  test("returns undefined when no session id", () => {
    const key = resolveSessionKey({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(key).toBeUndefined();
  });
});

describe("findMatchingSessionEntry", () => {
  test("matches on base sdk model id (not speed alias suffix)", () => {
    const agent = { agentId: "agent-alias" } as SDKAgent;
    store.registerTestSession("auto:alias", {
      agent,
      agentId: "agent-alias",
      modelId: "composer-2.5",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "Hi" }],
      lastAccess: Date.now(),
    });

    const match = store.findMatchingSessionEntry("composer-2.5", [
      { role: "user", content: "Hi" },
      { role: "user", content: "Again" },
    ]);
    expect(match?.key).toBe("auto:alias");
  });

  test("matches a longer message list with the same prefix", () => {
    const agent = { agentId: "agent-1" } as SDKAgent;
    store.registerTestSession("auto:1", {
      agent,
      agentId: "agent-1",
      modelId: "composer-2",
      messageCount: 2,
      messagesSnapshot: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      lastAccess: Date.now(),
    });

    const match = store.findMatchingSessionEntry("composer-2", [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Follow up" },
    ]);
    expect(match?.key).toBe("auto:1");
    expect(match?.entry.agentId).toBe("agent-1");
  });
});

describe("session speed alias reuse", () => {
  test("auto-session matches base sdk id when follow-up uses slow alias", async () => {
    const agent = { agentId: "agent-speed" } as SDKAgent;
    store.registerTestSession("auto:speed", {
      agent,
      agentId: "agent-speed",
      modelId: "composer-2.5",
      messageCount: 2,
      messagesSnapshot: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      lastAccess: Date.now(),
    });

    const followUpMessages = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Hello" },
      { role: "user" as const, content: "Follow up" },
    ];

    const match = store.findMatchingSessionEntry("composer-2.5", followUpMessages);
    expect(match?.entry.agentId).toBe("agent-speed");

    const prepared = await store.prepareChatSession(
      async () => {
        throw new Error("should reuse cached agent, not create");
      },
      { messages: followUpMessages, model: "composer-2.5-slow" },
      "composer-2.5",
      baseConfig,
    );

    expect(prepared.agentId).toBe("agent-speed");
    expect(prepared.deltaMessages).toEqual([{ role: "user", content: "Follow up" }]);
  });

  test("keyed session reuses agent when follow-up uses slow alias", async () => {
    const agent = { agentId: "agent-keyed-speed" } as SDKAgent;
    store.registerTestSession("sess-speed", {
      agent,
      agentId: "agent-keyed-speed",
      modelId: "composer-2.5",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "Hi" }],
      lastAccess: Date.now(),
    });

    const followUpMessages = [
      { role: "user" as const, content: "Hi" },
      { role: "user" as const, content: "Follow up" },
    ];

    const prepared = await store.prepareChatSession(
      async () => {
        throw new Error("should reuse keyed session, not create");
      },
      {
        messages: followUpMessages,
        model: "composer-2.5-slow",
        metadata: { session_id: "sess-speed" },
      },
      "composer-2.5",
      baseConfig,
      { "x-session-id": "sess-speed" },
    );

    expect(prepared.agentId).toBe("agent-keyed-speed");
    expect(prepared.deltaMessages).toEqual([{ role: "user", content: "Follow up" }]);
  });
});

describe("cwd-aware session reuse", () => {
  const followUp = [
    { role: "user" as const, content: "Hi" },
    { role: "user" as const, content: "Follow up" },
  ];

  test("auto-match isolates agents by cwd", () => {
    const localStore = new SessionStore();
    localStore.registerTestSession("auto:cwd-a", {
      agent: { agentId: "agent-a" } as SDKAgent,
      agentId: "agent-a",
      modelId: "composer-2.5",
      cwd: "/work/a",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "Hi" }],
      lastAccess: Date.now(),
    });
    localStore.registerTestSession("auto:cwd-b", {
      agent: { agentId: "agent-b" } as SDKAgent,
      agentId: "agent-b",
      modelId: "composer-2.5",
      cwd: "/work/b",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "Hi" }],
      lastAccess: Date.now(),
    });

    expect(
      localStore.findMatchingSessionEntry("composer-2.5", followUp, "/work/a")?.entry.agentId,
    ).toBe("agent-a");
    expect(
      localStore.findMatchingSessionEntry("composer-2.5", followUp, "/work/b")?.entry.agentId,
    ).toBe("agent-b");
    expect(
      localStore.findMatchingSessionEntry("composer-2.5", followUp, "/work/c"),
    ).toBeUndefined();

    localStore.clearForTests();
  });

  test("keyed session is not reused across a different cwd", async () => {
    const localStore = new SessionStore();
    localStore.registerTestSession("sess-cwd", {
      agent: { agentId: "agent-cwd" } as SDKAgent,
      agentId: "agent-cwd",
      modelId: "composer-2.5",
      cwd: "/work/a",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "Hi" }],
      lastAccess: Date.now(),
    });

    let created = false;
    const prepared = await localStore.prepareChatSession(
      async () => {
        created = true;
        return { agentId: "agent-fresh" } as SDKAgent;
      },
      { messages: followUp, metadata: { session_id: "sess-cwd" } },
      "composer-2.5",
      baseConfig,
      { "x-session-id": "sess-cwd" },
      undefined,
      "/work/b",
    );

    expect(created).toBe(true);
    expect(prepared.agentId).toBe("agent-fresh");
    expect(prepared.cwd).toBe("/work/b");
    expect(prepared.isNewAgent).toBe(true);

    localStore.clearForTests();
  });

  test("keyed session is reused when the cwd matches", async () => {
    const localStore = new SessionStore();
    localStore.registerTestSession("sess-cwd-match", {
      agent: { agentId: "agent-cwd-match" } as SDKAgent,
      agentId: "agent-cwd-match",
      modelId: "composer-2.5",
      cwd: "/work/a",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "Hi" }],
      lastAccess: Date.now(),
    });

    const prepared = await localStore.prepareChatSession(
      async () => {
        throw new Error("should reuse keyed session, not create");
      },
      { messages: followUp, metadata: { session_id: "sess-cwd-match" } },
      "composer-2.5",
      baseConfig,
      { "x-session-id": "sess-cwd-match" },
      undefined,
      "/work/a",
    );

    expect(prepared.agentId).toBe("agent-cwd-match");
    expect(prepared.cwd).toBe("/work/a");
    expect(prepared.isNewAgent).toBe(false);

    localStore.clearForTests();
  });
});

describe("session flow integrity (three-plane: orchestrator <-> leaf)", () => {
  // A delegated native leaf always carries its OWN hermes_session_id (the child
  // Hermes agent's session_id), distinct from the orchestrator's. These tests
  // lock in that a distinct session key can never reuse or dispose the
  // orchestrator's cached agent, that a stable key reuses one agent across a
  // multi-turn loop, and (the hazard distinct keys avoid) that a SHARED key with
  // divergent history destroys + recreates the cached agent.
  const parentHistory = [
    { role: "user" as const, content: "orchestrator turn 1" },
    { role: "assistant" as const, content: "orchestrator reply 1" },
  ];

  test("a delegated child (distinct key) does not reuse or dispose the orchestrator's agent", async () => {
    const localStore = new SessionStore();
    localStore.registerTestSession("hermes:parent-1", {
      agent: { agentId: "agent-orchestrator" } as SDKAgent,
      agentId: "agent-orchestrator",
      modelId: "composer-2.5",
      cwd: "/ws/symbiosis",
      messageCount: 2,
      messagesSnapshot: parentHistory,
      lastAccess: Date.now(),
    });

    let created = false;
    // Child: distinct hermes_session_id, fresh task messages, SAME cwd — proving
    // the key alone isolates the leaf even when the workspace is identical.
    const prepared = await localStore.prepareChatSession(
      async () => {
        created = true;
        return { agentId: "agent-leaf" } as SDKAgent;
      },
      {
        messages: [{ role: "user", content: "delegated subtask" }],
        metadata: { hermes_session_id: "child-1" },
      },
      "composer-2.5",
      baseConfig,
      undefined,
      undefined,
      "/ws/symbiosis",
    );

    expect(created).toBe(true);
    expect(prepared.agentId).toBe("agent-leaf");
    expect(prepared.isNewAgent).toBe(true);

    // The orchestrator's cached agent must survive the child turn untouched.
    const stillCached = localStore
      .listActiveSessions()
      .find((s) => s.session_id === "hermes:parent-1");
    expect(stillCached?.agent_id).toBe("agent-orchestrator");

    localStore.clearForTests();
  });

  test("a stable keyed session reuses one agent across a multi-turn loop", async () => {
    const localStore = new SessionStore();
    localStore.registerTestSession("hermes:loop-1", {
      agent: { agentId: "agent-loop" } as SDKAgent,
      agentId: "agent-loop",
      modelId: "composer-2.5",
      cwd: "/ws/symbiosis",
      messageCount: 2,
      messagesSnapshot: parentHistory,
      lastAccess: Date.now(),
    });

    const followUp = [
      ...parentHistory,
      { role: "user" as const, content: "marker round-trip 2" },
    ];

    const prepared = await localStore.prepareChatSession(
      async () => {
        throw new Error("should reuse the keyed agent across the loop, not create");
      },
      { messages: followUp, metadata: { hermes_session_id: "loop-1" } },
      "composer-2.5",
      baseConfig,
      undefined,
      undefined,
      "/ws/symbiosis",
    );

    expect(prepared.agentId).toBe("agent-loop");
    expect(prepared.isNewAgent).toBe(false);
    expect(prepared.deltaMessages).toEqual([
      { role: "user", content: "marker round-trip 2" },
    ]);

    localStore.clearForTests();
  });

  test("a SHARED key with divergent (non-prefix) history disposes + recreates — why child keys must differ", async () => {
    const localStore = new SessionStore();
    localStore.registerTestSession("hermes:shared", {
      agent: { agentId: "agent-victim" } as SDKAgent,
      agentId: "agent-victim",
      modelId: "composer-2.5",
      cwd: "/ws/symbiosis",
      messageCount: 2,
      messagesSnapshot: parentHistory,
      lastAccess: Date.now(),
    });

    let created = false;
    const prepared = await localStore.prepareChatSession(
      async () => {
        created = true;
        return { agentId: "agent-replacement" } as SDKAgent;
      },
      {
        // Divergent first message: does not prefix-match the cached snapshot.
        messages: [{ role: "user", content: "totally different conversation" }],
        metadata: { hermes_session_id: "shared" },
      },
      "composer-2.5",
      baseConfig,
      undefined,
      undefined,
      "/ws/symbiosis",
    );

    expect(created).toBe(true);
    expect(prepared.agentId).toBe("agent-replacement");
    expect(prepared.isNewAgent).toBe(true);
    // The original agent's entry was invalidated by the prefix mismatch.
    expect(
      localStore.listActiveSessions().some((s) => s.agent_id === "agent-victim"),
    ).toBe(false);

    localStore.clearForTests();
  });
});

describe("session config", () => {
  test("baseConfig enables sessions by default", () => {
    expect(baseConfig.CURSOR_ENABLE_SESSIONS).toBe(true);
    expect(baseConfig.CURSOR_AUTO_SESSION).toBe(true);
  });
});

afterAll(() => {
  store.clearForTests();
});
