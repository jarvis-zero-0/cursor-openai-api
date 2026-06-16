# cursor-openai-api — agent guide

OpenAI-compatible HTTP proxy that forwards requests to Cursor SDK local agents. Clients (OpenAI SDK, curl, AI SDK, etc.) hit this server; it runs Composer agents against `CURSOR_CWD` and translates streams/responses to OpenAI shapes.

## Repository layout

```
src/
  index.ts              # Server entry (Hono + @hono/node-server)
  app.ts                # Routes: /health, /v1/models, /v1/chat/completions, /v1/responses
  config.ts             # Env-based config (Zod)
  agent-turn.ts         # Creates Cursor SDK agent per turn
  agent-stream.ts       # Streams agent interaction → OpenAI SSE chunks
  chat-handlers.ts      # Chat Completions API
  responses-handlers.ts # Responses API
  session-store.ts      # In-memory agent session reuse
  client-tools/         # Hermes/client tool marker protocol → OpenAI tool_calls
  responses/            # Responses API output mapping
test/                   # bun test suite
sandbox/                # Optional isolated workspace for agent experiments
```

## Commands

```bash
bun install && bun test          # preferred (bun.lock)
npm install && npm run typecheck # Node path (package-lock.json)
bun run start                    # dev server (port 8080)
npm run build && npm run start:node
```

## Environment

Copy `.env.example` to `.env`. Required: `CURSOR_API_KEY`. Set `CURSOR_CWD` to the workspace agents should use (defaults to process cwd).

See `README.md` for the full env var table.

## Architecture notes

- **No Bun-only APIs** in source — Node 18+ compatible via `tsc` to `dist/`.
- **Sessions**: `CURSOR_ENABLE_SESSIONS` + `CURSOR_AUTO_SESSION` cache SDK agents by session id or message fingerprint.
- **Client tools**: When upstream sends executable tools (Hermes marker protocol), `src/client-tools/` maps them to OpenAI `tools` and parses tool-call markers from assistant output.
- **Tool mode** (`cursor_tool_mode` / `CURSOR_TOOL_MODE`): `client` = Hermes marker protocol; `native` = full Cursor SDK for standalone delegation; `auto` = detect from `tools` array. See README [Hermes integration](#hermes-integration).
- **Tool routing for Hermes**: In client-tool loop mode, the proxy's marker protocol is authoritative for tool execution. Hermes SOUL/persona still applies to tone and decisions; Composer must not use Cursor built-in Read/Shell/Write tools. See README [Tool calls](#tool-calls) and jarvis-diary learning `2026-06-15-cursor-proxy-tool-routing.md`.
- **Streaming**: `turn-stream.ts`, `stream-sink.ts`, `assistant-text-mode.ts` control how thinking vs content appear in deltas.

## Working conventions

- TypeScript strict mode; ESM (`"type": "module"`).
- Imports use `.js` extensions (Node ESM).
- Add tests under `test/` mirroring `src/` structure; run `bun test` before finishing.
- Do not commit `.env`, `node_modules/`, or `dist/`.

## Cursor cloud agents

Clone from GitHub so cloud agents have full project context. Primary remote: `https://github.com/Randomblock1/cursor-openai-api`. Use repo root as workspace; point `CURSOR_CWD` at `sandbox/` for isolated task work if desired.
