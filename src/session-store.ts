import { Agent, type SDKAgent } from "@cursor/sdk";
import type { AppConfig } from "./config.js";
import type { ChatCompletionRequest, ChatMessage } from "./openai.js";
import {
  deltaMessagesFromSession,
  messagesPrefixMatches,
  SessionCache,
  type MatchedSession,
  type SessionEntry,
  type SessionRegistration,
} from "./session-cache.js";
import {
  resolveResumeAgentId,
  resolveSessionKey,
  type SessionRequestHeaders,
} from "./session-keys.js";
import { AgentTurnQueue } from "./turn-queue.js";

export interface PreparedChatSession {
  agent: SDKAgent;
  agentId: string;
  deltaMessages: ChatMessage[];
  sessionKey: string | undefined;
  retainAgent: boolean;
  // True when this turn created a brand-new agent; false when it reused a cached
  // (keyed/auto/resumed) one. The self-heal retry in agent-turn.ts only evicts
  // and retries reused agents — a fresh agent hitting an active-run error is a
  // genuine failure, not a stale-cache artifact.
  isNewAgent: boolean;
  // Signature of the local-agent scope (cwd + settingSources) this agent was
  // created with. Folded into the cache match so a cached agent with a different
  // scope is never reused. "" == legacy/orchestrator scope.
  scopeSig: string;
}

/**
 * Stable signature of the local-agent scope (cwd + settingSources) so cached
 * agents are partitioned by scope. Derived from the `Agent.create` options the
 * turn will use, so the orchestrator (`settingSources: []`) and a native worker
 * leaf (`settingSources: ["project"]` at its repo cwd) never share an agent.
 */
function agentScopeSignature(
  opts?: Parameters<typeof Agent.create>[0],
): string {
  const local = opts?.local;
  if (!local) return "";
  const cwd = local.cwd;
  const cwdStr = Array.isArray(cwd) ? cwd.join("|") : (cwd ?? "");
  const settingSources = local.settingSources ?? [];
  return `${cwdStr}\u0000${settingSources.join(",")}`;
}

export class SessionStore {
  private readonly cache = new SessionCache();
  private readonly turnQueue = new AgentTurnQueue();

  findMatchingSessionEntry(
    modelId: string,
    messages: ChatMessage[],
    scopeSig = "",
  ): { key: string; entry: SessionEntry } | undefined {
    return this.cache.findAutoMatch(modelId, messages, scopeSig);
  }

  async withAgentTurn<T>(
    agentId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.turnQueue.run(agentId, fn);
  }

  async prepareChatSession(
    createAgent: () => Promise<SDKAgent>,
    request: ChatCompletionRequest,
    sdkModelId: string,
    config: AppConfig,
    headers?: SessionRequestHeaders,
    createAgentOptions?: Parameters<typeof Agent.create>[0],
  ): Promise<PreparedChatSession> {
    const scopeSig = agentScopeSignature(createAgentOptions);

    if (!config.CURSOR_ENABLE_SESSIONS) {
      const agent = await createAgent();
      return {
        agent,
        agentId: agent.agentId,
        deltaMessages: request.messages,
        sessionKey: undefined,
        retainAgent: false,
        isNewAgent: true,
        scopeSig,
      };
    }

    this.pruneCache(config);

    const sessionKey = resolveSessionKey(request, headers);

    if (sessionKey) {
      const keyed = this.tryKeyedSession(
        sessionKey,
        request,
        sdkModelId,
        scopeSig,
      );
      if (keyed) return keyed;
    }

    if (config.CURSOR_AUTO_SESSION !== false) {
      const matched = this.tryAutoMatchedSession(
        sdkModelId,
        request.messages,
        scopeSig,
      );
      if (matched) return matched;
    }

    const resumeAgentId = resolveResumeAgentId(request);
    if (resumeAgentId && createAgentOptions) {
      const resumed = await this.tryResumeAgent(
        resumeAgentId,
        createAgentOptions,
        request,
        sessionKey,
        scopeSig,
      );
      if (resumed) return resumed;
    }

    const agent = await createAgent();
    const autoSession =
      config.CURSOR_ENABLE_SESSIONS && config.CURSOR_AUTO_SESSION !== false;
    return {
      agent,
      agentId: agent.agentId,
      deltaMessages: request.messages,
      sessionKey,
      retainAgent: Boolean(sessionKey) || autoSession,
      isNewAgent: true,
      scopeSig,
    };
  }

  commitChatSession(
    prepared: PreparedChatSession,
    request: ChatCompletionRequest,
    modelId: string,
    config: AppConfig,
  ): string | undefined {
    if (!config.CURSOR_ENABLE_SESSIONS || !prepared.retainAgent) {
      return prepared.sessionKey;
    }

    const key =
      prepared.sessionKey ??
      (config.CURSOR_AUTO_SESSION !== false
        ? `auto:${crypto.randomUUID()}`
        : undefined);
    if (!key) return undefined;

    this.cache.saveTurn(key, {
      agent: prepared.agent,
      agentId: prepared.agentId,
      modelId,
      messages: request.messages,
      lastAccess: Date.now(),
      scopeSig: prepared.scopeSig,
    });
    this.pruneCache(config);
    return key;
  }

  async releaseChatAgent(prepared: PreparedChatSession): Promise<void> {
    if (prepared.retainAgent) return;
    await prepared.agent[Symbol.asyncDispose]();
  }

  /**
   * Drop and dispose a cached agent so the next turn for this key creates a
   * fresh one. Used to recover from a poisoned agent (lingering active run); see
   * `isActiveRunError`.
   */
  evictSession(sessionKey: string): void {
    this.cache.invalidate(sessionKey);
  }

  listActiveSessions(): Array<{
    session_id: string;
    agent_id: string;
    model_id: string;
    message_count: number;
    last_access: number;
  }> {
    return this.cache.listEntries();
  }

  registerTestSession(key: string, entry: SessionRegistration): void {
    this.cache.registerForTests(key, entry);
  }

  clearForTests(): void {
    this.cache.clear();
    this.turnQueue.clear();
  }

  private tryKeyedSession(
    sessionKey: string,
    request: ChatCompletionRequest,
    modelId: string,
    scopeSig: string,
  ): PreparedChatSession | undefined {
    const matched = this.cache.matchKeyedSession(
      sessionKey,
      modelId,
      request.messages,
      scopeSig,
    );
    return matched
      ? this.prepareFromMatchedSession(matched, request.messages)
      : undefined;
  }

  private tryAutoMatchedSession(
    modelId: string,
    messages: ChatMessage[],
    scopeSig: string,
  ): PreparedChatSession | undefined {
    const matched = this.findMatchingSessionEntry(modelId, messages, scopeSig);
    if (!matched) return undefined;
    return this.prepareFromMatchedSession(matched, messages);
  }

  private async tryResumeAgent(
    resumeAgentId: string,
    createAgentOptions: Parameters<typeof Agent.create>[0],
    request: ChatCompletionRequest,
    sessionKey: string | undefined,
    scopeSig: string,
  ): Promise<PreparedChatSession | undefined> {
    try {
      const agent = await Agent.resume(resumeAgentId, createAgentOptions);
      const entry = sessionKey ? this.cache.get(sessionKey) : undefined;
      const deltaMessages =
        entry &&
        entry.agentId === agent.agentId &&
        entry.scopeSig === scopeSig &&
        messagesPrefixMatches(request.messages, entry)
          ? deltaMessagesFromSession(request.messages, entry)
          : request.messages;
      return {
        agent,
        agentId: agent.agentId,
        deltaMessages,
        sessionKey,
        retainAgent: Boolean(sessionKey),
        isNewAgent: false,
        scopeSig,
      };
    } catch (err) {
      console.warn(
        `[cursor-openai-api] Agent.resume(${resumeAgentId}) failed; creating a new agent.`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  private prepareFromMatchedSession(
    matched: MatchedSession,
    messages: ChatMessage[],
  ): PreparedChatSession {
    return {
      agent: matched.entry.agent,
      agentId: matched.entry.agentId,
      deltaMessages: deltaMessagesFromSession(messages, matched.entry),
      sessionKey: matched.key,
      retainAgent: true,
      isNewAgent: false,
      scopeSig: matched.entry.scopeSig,
    };
  }

  private pruneCache(config: AppConfig): void {
    this.cache.prune({
      ttlMs: config.CURSOR_SESSION_TTL_MS,
      maxEntries: config.CURSOR_SESSION_MAX,
    });
  }
}
