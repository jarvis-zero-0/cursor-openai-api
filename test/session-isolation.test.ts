import { describe, expect, test } from "bun:test";
import type { SDKAgent } from "@cursor/sdk";
import type { AppConfig } from "../src/config.js";
import type { ChatCompletionRequest } from "../src/openai.js";
import { resolveSessionKey } from "../src/session-keys.js";
import { SessionStore } from "../src/session-store.js";

// Spike E — per-child session isolation under concurrency.
//
// Hermes spawns parallel subagents via `delegate_task` with a `tasks[]` array.
// Each child carries its OWN `hermes_session_id` (the child Hermes agent's
// session id), distinct from the orchestrator's and from its siblings'. These
// tests verify the proxy side of that contract:
//   - distinct hermes ids -> distinct proxy session keys (`hermes:<id>`)
//   - N concurrent distinct children each get their OWN agent, none reuses or
//     disposes another's session
//   - a SHARED id (per the documented AGENTS.md behavior) reuses ONE agent
// No live model is needed — `prepareChatSession` is driven directly.

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
  CURSOR_SESSION_MAX: 64,
};

// A fake SDK agent that records when it is asyncDisposed, so a test can prove
// no sibling/orchestrator agent was torn down during concurrent child turns.
function fakeAgent(agentId: string, disposed: Set<string>): SDKAgent {
  return {
    agentId,
    [Symbol.asyncDispose]: async () => {
      disposed.add(agentId);
    },
  } as unknown as SDKAgent;
}

function childRequest(hermesId: string): ChatCompletionRequest {
  return {
    messages: [{ role: "user", content: `delegated subtask for ${hermesId}` }],
    metadata: { hermes_session_id: hermesId },
  };
}

describe("session key isolation (hermes:<id>)", () => {
  test("distinct hermes_session_ids map to distinct keys", () => {
    const ids = ["child-1", "child-2", "child-3", "child-4"];
    const keys = ids.map((id) =>
      resolveSessionKey({
        messages: [{ role: "user", content: "x" }],
        metadata: { hermes_session_id: id },
      }),
    );
    expect(keys).toEqual([
      "hermes:child-1",
      "hermes:child-2",
      "hermes:child-3",
      "hermes:child-4",
    ]);
    // All distinct.
    expect(new Set(keys).size).toBe(ids.length);
  });

  test("a shared hermes_session_id maps to one stable key", () => {
    const a = resolveSessionKey({
      messages: [{ role: "user", content: "x" }],
      metadata: { hermes_session_id: "shared" },
    });
    const b = resolveSessionKey({
      messages: [{ role: "user", content: "y" }],
      metadata: { hermes_session_id: "shared" },
    });
    expect(a).toBe("hermes:shared");
    expect(b).toBe("hermes:shared");
  });
});

describe("concurrent distinct children are fully isolated", () => {
  test("4 children prepared+committed concurrently each get their own agent", async () => {
    const store = new SessionStore();
    const disposed = new Set<string>();
    const N = 4;
    const ids = Array.from({ length: N }, (_, i) => `child-${i + 1}`);

    // Pre-existing orchestrator session that must survive every child turn.
    store.registerTestSession("hermes:orchestrator", {
      agent: fakeAgent("agent-orchestrator", disposed),
      agentId: "agent-orchestrator",
      modelId: "composer-2.5",
      cwd: "/ws/symbiosis",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "orchestrator turn 1" }],
      lastAccess: Date.now(),
    });

    // Fire all N children concurrently. Each createAgent yields a distinct
    // agent id; if any child reused a sibling's session, fewer than N agents
    // would be created.
    const prepared = await Promise.all(
      ids.map((id) => {
        const request = childRequest(id);
        return store
          .prepareChatSession(
            async () => fakeAgent(`agent-${id}`, disposed),
            request,
            "composer-2.5",
            baseConfig,
            undefined,
            undefined,
            "/ws/symbiosis",
          )
          .then((session) => {
            store.commitChatSession(session, request, "composer-2.5", baseConfig);
            return session;
          });
      }),
    );

    // Every child created a fresh, distinctly-keyed agent.
    expect(prepared.every((p) => p.isNewAgent)).toBe(true);
    const childAgentIds = prepared.map((p) => p.agentId).sort();
    expect(childAgentIds).toEqual(ids.map((id) => `agent-${id}`).sort());
    expect(new Set(prepared.map((p) => p.sessionKey)).size).toBe(N);

    // Cache now holds the orchestrator + N children, each a distinct key/agent.
    const active = store.listActiveSessions();
    const childEntries = active.filter((s) => s.session_id !== "hermes:orchestrator");
    expect(childEntries).toHaveLength(N);
    expect(new Set(childEntries.map((s) => s.session_id))).toEqual(
      new Set(ids.map((id) => `hermes:${id}`)),
    );
    expect(new Set(childEntries.map((s) => s.agent_id)).size).toBe(N);

    // Nothing was disposed: no child tore down a sibling or the orchestrator.
    expect(disposed.size).toBe(0);
    expect(
      active.find((s) => s.session_id === "hermes:orchestrator")?.agent_id,
    ).toBe("agent-orchestrator");

    store.clearForTests();
  });

  test("a child never reuses a sibling's agent (createAgent invoked once per child)", async () => {
    const store = new SessionStore();
    const disposed = new Set<string>();
    const ids = ["a", "b", "c"];
    const createCounts = new Map<string, number>();

    await Promise.all(
      ids.map((id) => {
        const request = childRequest(id);
        return store
          .prepareChatSession(
            async () => {
              createCounts.set(id, (createCounts.get(id) ?? 0) + 1);
              return fakeAgent(`agent-${id}`, disposed);
            },
            request,
            "composer-2.5",
            baseConfig,
            undefined,
            undefined,
            "/ws/symbiosis",
          )
          .then((session) =>
            store.commitChatSession(session, request, "composer-2.5", baseConfig),
          );
      }),
    );

    for (const id of ids) expect(createCounts.get(id)).toBe(1);
    expect(disposed.size).toBe(0);

    store.clearForTests();
  });
});

describe("shared id reuses one session (documented behavior)", () => {
  test("a follow-up turn with the same hermes id reuses the cached agent", async () => {
    const store = new SessionStore();
    const disposed = new Set<string>();
    const history = [
      { role: "user" as const, content: "turn 1" },
      { role: "assistant" as const, content: "reply 1" },
    ];

    store.registerTestSession("hermes:loop", {
      agent: fakeAgent("agent-loop", disposed),
      agentId: "agent-loop",
      modelId: "composer-2.5",
      cwd: "/ws/symbiosis",
      messageCount: history.length,
      messagesSnapshot: history,
      lastAccess: Date.now(),
    });

    const prepared = await store.prepareChatSession(
      async () => {
        throw new Error("shared id must reuse the cached agent, not create");
      },
      {
        messages: [...history, { role: "user", content: "turn 2" }],
        metadata: { hermes_session_id: "loop" },
      },
      "composer-2.5",
      baseConfig,
      undefined,
      undefined,
      "/ws/symbiosis",
    );

    expect(prepared.agentId).toBe("agent-loop");
    expect(prepared.isNewAgent).toBe(false);
    expect(prepared.deltaMessages).toEqual([{ role: "user", content: "turn 2" }]);
    expect(disposed.size).toBe(0);

    store.clearForTests();
  });

  test("two concurrent reads of the same keyed session both reuse one agent", async () => {
    const store = new SessionStore();
    const disposed = new Set<string>();
    const history = [{ role: "user" as const, content: "turn 1" }];

    store.registerTestSession("hermes:shared", {
      agent: fakeAgent("agent-shared", disposed),
      agentId: "agent-shared",
      modelId: "composer-2.5",
      cwd: "/ws/symbiosis",
      messageCount: history.length,
      messagesSnapshot: history,
      lastAccess: Date.now(),
    });

    const followUp = [...history, { role: "user" as const, content: "turn 2" }];
    const makeReq = (): ChatCompletionRequest => ({
      messages: followUp,
      metadata: { hermes_session_id: "shared" },
    });

    const [first, second] = await Promise.all([
      store.prepareChatSession(
        async () => {
          throw new Error("should reuse, not create");
        },
        makeReq(),
        "composer-2.5",
        baseConfig,
        undefined,
        undefined,
        "/ws/symbiosis",
      ),
      store.prepareChatSession(
        async () => {
          throw new Error("should reuse, not create");
        },
        makeReq(),
        "composer-2.5",
        baseConfig,
        undefined,
        undefined,
        "/ws/symbiosis",
      ),
    ]);

    expect(first.agentId).toBe("agent-shared");
    expect(second.agentId).toBe("agent-shared");
    expect(first.sessionKey).toBe("hermes:shared");
    expect(second.sessionKey).toBe("hermes:shared");
    expect(disposed.size).toBe(0);

    store.clearForTests();
  });
});
