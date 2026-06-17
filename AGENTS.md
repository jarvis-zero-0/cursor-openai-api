# cursor-openai-api — agent guide

OpenAI-compatible HTTP proxy that forwards requests to Cursor SDK local agents. Clients (OpenAI SDK, curl, AI SDK, Hermes/Jarvis, etc.) hit this server; it runs Composer agents against `CURSOR_CWD` and translates streams/responses to OpenAI shapes.

## Two-plane architecture (Hermes wrapper)

This repo is the **execution plane**. [Hermes](https://github.com/Randomblock1/hermes-agent) (Jarvis) is the **control plane**.

| Plane | Role | Tool mode | What it owns |
|-------|------|-----------|--------------|
| **Hermes (control)** | Orchestrator, SOUL, skills, memory, user-facing loop | `client` | *What* to do — persona, tone, task decomposition, `delegate_task` spawn decisions |
| **Proxy (execution)** | Cursor SDK bridge, prompt shaping, session reuse | `client` or `native` | *How* tools are invoked — native `customTools` (client) vs full SDK built-ins (native) |

**Do not fight Hermes system messages.** Upstream `system` messages (SOUL, skills, memory, USER profile, tone rules, task guidance) are **legitimate** — injected by Hermes above the proxy layer. They remain authoritative for content, persona, tone, and decisions. The proxy only overrides the **tool invocation channel**. Native leaves: see `.cursorrules` "Hermes SYSTEM prompt precedence" and `buildNativeToolDirective()` in `src/prompt.ts` — same split, mirrored in code. Never narrate instruction conflicts or question whether Hermes SYSTEM is real; follow both layers silently.

### If you are a native agent: you are externally wrapped (read this)

You are a Cursor native agent spawned and wrapped by Hermes (the outer control plane). Hermes's SYSTEM prompt is authoritative for **WHO** you are and **WHAT** to do — persona, tone, scope, task. This file and the proxy's native tool directive are authoritative ONLY for **HOW** you invoke tools: use your native Cursor SDK tools (read/edit/shell/grep) directly.

The persona/tone/scope guidance in any SYSTEM message still applies; only the tool-invocation instructions are owned by the proxy/native directive. Do not ask the user follow-up questions; you run autonomously for one turn. End your final message with a human-readable summary followed by exactly one ```handoff JSON block (status/summary/artifacts/unresolved/recommended_next); artifact handles must be ABSOLUTE paths, never relative.

Client case (this file is loaded as project rules only for native leaves): if you are instead a CLIENT-mode turn — the caller supplied its own `tools[]`, registered by the proxy as native SDK `customTools` — those tools are *your* file/shell/search/delegation tools; invoke them through Cursor's native tool channel and the proxy captures them as OpenAI `tool_calls`. Hermes's SYSTEM prompt is still your authoritative identity and task. There is no marker protocol and no anti-Cursor identity block — the only proxy-injected framing is the slim `NATIVE_CLIENT_TOOL_STEER`. Either way: Hermes SYSTEM wins for WHO/WHAT; the proxy owns HOW tools are invoked.

### Mode roles

- **`client`** — Hermes main thread / orchestrator, or any caller supplying its own `tools[]`. The proxy registers them as native SDK `customTools`; the model invokes them through Cursor's native channel and the bridge surfaces each call as an OpenAI `tool_call`. The caller executes the tool and resends the result; the absence of a tool call ends the turn.
- **`native`** — Delegated leaf worker (`delegate_task`, coding subagent). Full Cursor SDK built-ins (Read, Shell, Write, Grep, …). No client tools, no `delegate_task` (self-delegation guard). Return a final text summary plus a structured `handoff` block (see below).
- **`auto`** (default) — Generic OpenAI clients. Uses the `client` (native `customTools`) path when the request has non-empty `tools` and `tool_choice` ≠ `"none"`; otherwise plain/native serialization.

Hermes should set `cursor_tool_mode` explicitly per call site. See README [Hermes integration](README.md#hermes-integration).

## Prompt injection matrix

What the proxy adds beyond upstream `messages[]`, by mode.

| Injection | `client` | `native` | `auto` |
|-----------|----------|----------|--------|
| **SDK `settingSources`** | `[]` (none) | `["project"]` — loads workspace `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc` | `[]` (none) — see note below |
| **Tool routing directive** | Slim `NATIVE_CLIENT_TOOL_STEER` — one paragraph steering toward the caller-provided tools; no identity block | `buildNativeToolDirective()` — SDK built-ins | Client path → steer; else native directive when `toolMode === "native"` on full prompt |
| **Client tools as `customTools`** | Caller's `tools[]` registered as native SDK `customTools` (filtered toolsets + tiered schemas; defaults to `tiered`), captured by the bridge | Never (native ignores any client `tools[]` by design — see `agent-turn.ts`) | When the request carries client tools |
| **Native progress narration** | No (forced off when `clientTools`) | Tool starts/results + live shell stdout as `reasoning_content`, default-ON for native turns (`nativeProgress`), decoupled from `includeThinking`; off when `emitCursorTools` is on | When resolved native + `nativeProgress` |
| **Handoff directive** | No (orchestrator parses handoffs from `delegate_task` results) | Static in native directive (fresh agent only) | Native path only |
| **Native ctx (workspace, proxy URL)** | No | Dynamic on fresh agent — `WORKSPACE`, optional `curl` subagent hint | Native fresh agent only |
| **Conversation serialization** | `formatMessage` (`## ROLE` blocks) — same native serialization (steer + `stripGenericProxyFraming`) | `formatMessage` (`## ROLE` blocks) or plain-text join | Depends on payload kind |
| **Request extras** | `tool_choice`, tiers | temperature, stop, `response_format`, passthrough fields | Extras appended on full-prompt path |
| **Directive repeat policy** | Steer once per fresh agent (mirrors native) | Native directive once per new agent (not every follow-up turn) | Follows resolved branch |

**Static** = same text every time that path is taken. **Dynamic** = derived from messages, tools, tier policy, or agent freshness.

> **Project rules load ONLY under explicit `cursor_tool_mode: "native"`.** `createAgentOptions` (`src/agent-turn.ts`) sets `settingSources = toolMode === "native" ? ["project"] : []` — a literal comparison against the *resolved* mode. `auto` is **never** rewritten to `native` (it stays `"auto"` through `resolveCursorToolMode` → `resolveTurnPolicy` → `createAgentOptions`), so an `auto` request loads `[]` **even when it does plain/native serialization** (no client tools). `client` also loads `[]`. Practical consequence: this repo's `AGENTS.md` / `.cursorrules` are picked up *only* by leaves Hermes spawns with `cursor_tool_mode: "native"` (i.e. `delegate_task`). Generic `auto` clients and the Hermes orchestrator (`client`) never see them.

> **Client framing lives in the injected steer, not project rules.** Because `client` loads `settingSources: []`, the orchestrator never sees the `.cursorrules` / `AGENTS.md` deference block. The slim `NATIVE_CLIENT_TOOL_STEER` (`src/client-tools/prompt.ts`) is the only proxy-injected framing on the client path — client tools ride Cursor's own native channel, so no anti-Cursor identity block is needed. The project rules carry a symmetric client-case paragraph so an introspecting model finds matching confirmation either way.

> **Session flow / isolation.** Each Hermes agent (orchestrator and every delegated leaf) carries its own `session_id`, mapped to `metadata.hermes_session_id` and keyed by the proxy as `hermes:<id>` (`src/session-keys.ts`). A delegated child therefore gets a DISTINCT proxy session from the orchestrator — never reusing or disposing it. Multi-root `.code-workspace` cwds are identified by their full sorted root set (`cwdIdentity`, `src/workspace.ts`), so workspaces sharing a first root don't collide; declared root order is preserved for the SDK (git repo first). Verified live: same `hermes_session_id` reuses one agent across turns; a distinct id gets a distinct agent.

Source of truth: `src/client-tools/prompt.ts`, `src/prompt.ts`, `src/messages.ts`, `src/agent-turn.ts`, `src/tool-mode.ts`, `src/turn-policy.ts`.

## Subagent handoff contract (native leaves)

When Hermes spawns a worker via `delegate_task`, the proxy runs `cursor_tool_mode: "native"`. The leaf's final assistant text is returned verbatim as the tool result. Machine-parseable output uses a trailing fenced block:

````markdown
```handoff
{ "schema_version": "1.0", "status": "done|partial|blocked|failed", "summary": "...", "artifacts": [...], ... }
```
````

- **Required on native delegation** — see `src/client-tools/handoff.ts` and `docs/subagent-handoff-contract.md`.
- **Prose before the block** is narrative; the orchestrator parses the JSON, verifies artifacts, and owns user-facing formatting.
- **No self-delegation** — native leaves cannot call `delegate_task`; they may only *recommend* follow-up work in `recommended_next`.
- **Completion signal** — end the turn with final text (including the handoff fence). No magic stop token.

The proxy parses handoffs in `AgentTurnOutcome.handoff` (`parseHandoff`) and surfaces the parsed report on the chat-completion `cursor.handoff` payload (both the non-streamed body and the final streamed chunk). `finalText` / message content stays verbatim — the raw ```handoff fence still travels through for backward compatibility.

## Repository layout

```
src/
  index.ts              # Server entry (Hono + @hono/node-server)
  app.ts                # Routes: /health, /v1/models, /v1/chat/completions, /v1/responses
  config.ts             # Env-based config (Zod)
  agent-turn.ts         # Creates Cursor SDK agent per turn; settingSources by tool mode
  agent-stream.ts       # Streams agent interaction → OpenAI SSE chunks
  chat-handlers.ts      # Chat Completions API
  responses-handlers.ts # Responses API
  session-store.ts      # In-memory agent session reuse
  prompt.ts             # Native tool directive + message serialization
  messages.ts           # buildSendPayload (client / plain / full-prompt paths)
  client-tools/         # native customTools bridge, capture sink, handoff, toolsets, tiers
  responses/            # Responses API output mapping
docs/
  subagent-handoff-contract.md
test/                   # bun test suite
sandbox/                # Optional isolated workspace for agent experiments
```

## Commands

```bash
bun install && bun test          # preferred (bun.lock)
npm install && npm run typecheck # Node path (package-lock.json)
npm run dev:node                 # dev server (port 8080) — use Node, not bun, for native streaming
npm run build && npm run start:node
```

> Native streaming turns (`cursor_tool_mode: "native"`) crash Bun with `NGHTTP2_FRAME_SIZE_ERROR` (SDK gRPC/HTTP2 transport). `bun run start` is fine for non-streaming work, but run the server under Node when exercising native execution. See README "Run".

## Environment

Copy `.env.example` to `.env`. Required: `CURSOR_API_KEY`. Set `CURSOR_CWD` to the workspace agents should use (defaults to process cwd).

See `README.md` for the full env var table.

## Architecture notes

- **No Bun-only APIs** in source — Node 18+ compatible via `tsc` to `dist/`.
- **Sessions**: `CURSOR_ENABLE_SESSIONS` + `CURSOR_AUTO_SESSION` cache SDK agents. Hermes should pass `metadata.hermes_session_id` for stable reuse across tool loops.
- **Client tools**: When upstream sends executable tools, `src/client-tools/` registers them as native SDK `customTools` (`custom-tools-bridge.ts`) and captures the model's native invocations as OpenAI `tool_calls` via `ClientToolCaptureSink`. See `docs/native-client-tools.md`.
- **Tool filtering / tiers**: `cursor_enabled_toolsets`, `cursor_tool_tier`, allow/deny lists — trim and terse-render the `customTool` schemas before they are registered. The client orchestrator defaults to the `tiered` tier (`DEFAULT_ORCHESTRATOR_TOOL_TIER_MODE` in `src/client-tools/catalog.ts`); `DEFAULT_TOOL_TIER_MODE` stays `full` only as the no-tier build fallback. Tiering is load-bearing for token parity.
- **Native-first + progress narration**: native is the default worker execution path. `nativeProgress` (`src/turn-policy.ts` `resolveNativeProgress`) defaults ON for `native` turns (off for `client`/`auto`), overridable by `cursor_native_progress` / `CURSOR_NATIVE_PROGRESS`. It is **decoupled from `includeThinking`** — a separate lever. Tool lifecycle events (start/result) are narrated on a **single site**, the `run.stream()` `tool_call` path in `src/stream.ts` (`chunksFromSdkMessage` → `formatToolProgressLine`); the `onDelta` path (`src/interaction-delta.ts`) deliberately does not narrate them. Live shell stdout (`shell-output-delta`) is the one extra incremental event narrated on the `onDelta` path — a distinct event, so no double-emit. Narration rides `reasoning_content`; forced off when `clientTools` and when `emitCursorTools` is on.
- **Streaming**: `turn-stream.ts`, `stream-sink.ts`, `assistant-text-mode.ts` control how thinking vs content appear in deltas.

## Working conventions

- TypeScript strict mode; ESM (`"type": "module"`).
- Imports use `.js` extensions (Node ESM).
- Add tests under `test/` mirroring `src/` structure; run `bun test` before finishing.
- Do not commit `.env`, `node_modules/`, or `dist/`.
- When editing prompt injection (`src/prompt.ts`, `src/client-tools/prompt.ts`), restart the proxy — Hermes and native leaves pick up changes on the next fresh turn/agent.

## Cursor cloud agents

Clone from GitHub so cloud agents have full project context. Primary remote: `https://github.com/Randomblock1/cursor-openai-api`. Use repo root as workspace; point `CURSOR_CWD` at `sandbox/` for isolated task work if desired.
