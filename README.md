# cursor-openai-api

OpenAI-compatible HTTP proxy for [Cursor SDK](https://cursor.com/docs/sdk/typescript) local agents. Point OpenAI clients at this server to use Cursor models (for example `composer-2` or `composer-2.5`) with your Cursor plan usage via `CURSOR_API_KEY`.

<img width="1600" height="924" alt="Screenshot_20260523_032144" src="https://github.com/user-attachments/assets/19988b4e-e58e-45cb-a1a9-d41fc6915a1f" />

## Requirements

- [Bun](https://bun.sh) (recommended) for the default install, dev, and test scripts
- Node.js 18+ to run the server via the npm/Node scripts (`build`, `start:node`, `dev:node`)
- A Cursor API key from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)

## Install

With Bun (recommended):

```bash
bun install
```

With npm:

```bash
npm install
```

## Configure

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CURSOR_API_KEY` | yes | — | Cursor user or team service account key |
| `CURSOR_CWD` | no | `process.cwd()` | Local workspace directory for the agent |
| `PORT` | no | `8080` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP listen host |
| `DEFAULT_MODEL` | no | `composer-2.5` | Model when the client omits `model` |
| `AUTH_KEY` | no | — | If set, clients must send `Authorization: Bearer <value>` |
| `CURSOR_INCLUDE_THINKING` | no | `true` | Stream thinking as `reasoning_content` / `reasoning` on deltas and the final message |
| `CURSOR_ASSISTANT_TEXT_MODE` | no | `live` | How assistant `content` is streamed when text and thinking interleave: `live`, `final-content`, or `preamble-as-reasoning` (see [Assistant text modes](#assistant-text-modes)) |
| `CURSOR_EMIT_TOOL_CALLS` | no | `false` | Surface Cursor's internal tool use as OpenAI `tool_calls` (see [Tool calls](#tool-calls) below) |
| `CURSOR_NATIVE_PROGRESS` | no | on for `native`, off otherwise | Narrate a native worker's tool starts/results (and live shell stdout) as `reasoning_content` (`→ read(...)` / `✓ read → ...`). Unset = default-on for `native` turns, off for `client`/`auto`. Independent of `CURSOR_INCLUDE_THINKING`. Per-request override: `cursor_native_progress`. Forced off in the client loop and when `cursor_emit_tool_calls` is on |
| `CURSOR_TOOL_MODE` | no | `auto` | Default tool routing: `auto`, `client` (client tools registered as native SDK `customTools`, calls captured as OpenAI `tool_calls`), or `native` (full Cursor SDK tools, the default worker path). Per-request override: `cursor_tool_mode` (see [Hermes integration](#hermes-integration)) |
| `CURSOR_ENABLED_TOOLSETS` | no | — | Comma-separated toolset names; only matching client tools are registered as `customTools`. Per-request override: `cursor_enabled_toolsets` (see [Tool filtering](#tool-filtering)) |
| `CURSOR_TOOL_ALLOWLIST` | no | — | Comma-separated tool-name patterns to keep (`*` suffix = prefix match). Per-request override: `cursor_tools_allow` |
| `CURSOR_TOOL_DENYLIST` | no | — | Comma-separated tool-name patterns to drop (e.g. `browser_*,computer_use,cronjob`). Per-request override: `cursor_tools_deny` |
| `CURSOR_TOOLSETS_KEEP_UNMAPPED` | no | `true` | When toolset filtering is active, keep tools with no known toolset. Per-request override: `cursor_toolsets_keep_unmapped` |
| `CURSOR_TOOL_TIER` | no | `tiered` | Progressive disclosure of the native `customTool` schemas: `full`, `tiered`, or `brief` (see [Tool tiers](#tool-tiers-progressive-disclosure)). The client orchestrator defaults to `tiered` to cut prompt cost. Per-request override: `cursor_tool_tier` |
| `CURSOR_TOOL_RESIDENT` | no | curated set | Comma-separated tool names kept at full schema in `tiered` mode. Per-request override: `cursor_tool_resident` |
| `CURSOR_TOOL_USAGE_LOG` | no | — | Path to append a JSONL record of every client tool call, for tuning tiers |
| `CURSOR_EMIT_SPEED_ALIASES` | no | `true` | List synthetic `*-slow` / `*-fast` rows on `GET /v1/models` (requests still resolve when `false`) |
| `CURSOR_MODEL_ALLOWLIST` | no | curated latest set | Comma-separated catalog ids for `GET /v1/models`. Omit for the built-in latest-only list; set `*` for the full Cursor catalog |
| `CURSOR_ENABLE_SESSIONS` | no | `true` | Reuse Cursor SDK agents when the client supplies a session id |
| `CURSOR_AUTO_SESSION` | no | `true` | Reuse agents when a request extends a prior in-memory conversation (for clients like AI SDK that resend full `messages[]`) |
| `CURSOR_SESSION_TTL_MS` | no | `1800000` | Evict idle cached agents after this many ms |
| `CURSOR_SESSION_MAX` | no | `64` | Max concurrent cached agents |
| `DEBUG_STREAM` | no | `false` | Include agent status events as annotated `content` in streams |

## Run

With Bun (recommended):

```bash
export CURSOR_API_KEY="cursor_..."
export CURSOR_CWD="$(pwd)"
bun run start
```

With npm and Node:

```bash
export CURSOR_API_KEY="cursor_..."
export CURSOR_CWD="$(pwd)"
npm run start:node
```

`start:node` compiles TypeScript to `dist/` and runs `node dist/index.js`. For development without a build step:

```bash
npm run dev:node
```

The server source uses Node-compatible APIs (`process.env`, `@hono/node-server`) and no `Bun.*` runtime APIs. Bun runs TypeScript directly; the Node scripts compile with `tsc` or use `tsx` for watch mode.

> **Native streaming turns require Node, not Bun.** Bun is fine for install, tests, and non-streaming use, but `cursor_tool_mode: "native"` turns drive the `@cursor/sdk` agent over its gRPC/HTTP2 transport, which crashes Bun with `NGHTTP2_FRAME_SIZE_ERROR` mid-stream. Run the server under Node (`npm run start:node` or `npm run dev:node`) whenever native execution is the primary path (the Hermes-delegated worker case). Re-probe under Bun when bumping `@cursor/sdk`; drop this note if a release fixes the transport.

## Usage

### curl

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2",
    "messages": [{"role": "user", "content": "Summarize this repo in one paragraph."}]
  }'
```

Streaming:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2",
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello."}]
  }'
```

List models (includes `display_name`, `description`, `cursor_aliases`, `cursor_parameters`, `cursor_variants`, and proxy speed aliases when available):

```bash
curl http://localhost:8080/v1/models
```

### Model catalog filter

By default, `GET /v1/models` exposes only the latest Cursor catalog skus (legacy models like `composer-2` or `claude-opus-4-7` are hidden). Both `id` and `display_name` are the catalog sku string — the same value you pass in chat `model` (e.g. `claude-opus-4-8`, not Cursor's UI label "Opus 4.8").

| Model id | Notes |
|----------|-------|
| `default` | Cursor "Auto" — server picks the best model per request (at worst Composer 2.5). Alias: `auto` |
| `composer-2.5` | Fast tier |
| `composer-2.5-slow` | Standard (non-fast) tier — cheaper |
| `composer-2.5-fast` | Explicit fast alias |
| `claude-opus-4-8` | |
| `claude-sonnet-4-6` | |
| `claude-haiku-4-5` | |
| `gemini-3.5-flash` | |
| `gemini-3.1-pro` | |
| `gpt-5.5` | |

Cursor also publishes stable alias ids (`opus-latest`, `gemini-flash-latest`, etc.) — those still work on chat requests but are not listed by default.

The `*-slow` / `*-fast` rows are synthetic proxy aliases (see [Speed aliases](#speed-aliases--slow--fast)); only base catalog sku ids appear in `CURSOR_MODEL_ALLOWLIST`.

Override with `CURSOR_MODEL_ALLOWLIST=composer-2.5,claude-opus-4-8` or set `CURSOR_MODEL_ALLOWLIST=*` for the full Cursor catalog.

### Composer fast mode

On Cursor's catalog, **Composer 2 / 2.5 default to fast mode** (`fast=true`) — higher throughput, different pricing than the standard tier. That is the SDK/product default when you pass `model: "composer-2.5"` with no extra params.

To use the **standard (non-fast) tier** via the SDK or this proxy:

```json
"cursor_model_params": [{ "id": "fast", "value": "false" }]
```

Or use the proxy aliases (see below): `"model": "composer-2.5-slow"`.

Other families (GPT, Opus, Codex, etc.) expose the same `fast` parameter when supported; their **defaults vary** (for example Opus and GPT-5.5 often default to `fast=false`). Call `GET /v1/models` or `Cursor.models.list()` to see `cursor_parameters` and preset `cursor_variants` for your account.

### Speed aliases (`*-slow` / `*-fast`)

For every catalog model that advertises both `fast=false` and `fast=true`, this proxy also lists and accepts:

| Request model | Effect |
|---------------|--------|
| `<base>-slow` | Sets `fast=false` on `<base>` (standard tier for Composer) |
| `<base>-fast` | Sets `fast=true` on `<base>` |

Examples: `composer-2.5-slow`, `claude-opus-4-8-fast`, `gpt-5.5-slow`.

Explicit `cursor_model_params` with `id: "fast"` must agree with the alias; conflicting values are rejected. Aliases are not sent to Cursor as model ids — the proxy resolves to the base id plus params. Each request passes the resolved model (id + params) on `agent.send()`, so you can switch between `*-slow` and `*-fast` on a reused session without creating a new agent.

Model parameters and thinking effort:

```bash
# Standard (non-fast) Composer tier — alias or explicit param
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5-slow",
    "messages": [{"role": "user", "content": "Summarize this repo."}]
  }'

curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "reasoning_effort": "high",
    "cursor_model_params": [{"id": "thinking_effort", "value": "high"}],
    "stream": true,
    "messages": [{"role": "user", "content": "Explain your plan briefly."}]
  }'
```

Disable thinking in the response:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "cursor_include_thinking": false,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### OpenAI Responses API

```bash
curl http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "instructions": "You are a helpful assistant.",
    "input": "Say hello in one sentence."
  }'
```

Streaming uses Responses SSE events (`response.created`, `response.output_text.delta`, `response.completed`):

```bash
curl -N http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "input": "Say hello.",
    "stream": true
  }'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-auth-key",  # or any value if AUTH_KEY is unset
)

response = client.chat.completions.create(
    model="composer-2",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

Responses API (recommended for newer SDKs):

```python
response = client.responses.create(
    model="composer-2.5",
    instructions="You are a helpful assistant.",
    input="Hello!",
)
print(response.output_text)
```

## Assistant text modes

`CURSOR_ASSISTANT_TEXT_MODE` (or per-request `cursor_assistant_text_mode`) controls how assistant `content` is delivered when a turn alternates between thinking and text. It is independent of `CURSOR_INCLUDE_THINKING`: thinking is on/off via that flag; the mode only affects `content` routing.

| Mode | Behavior | Best for |
|------|----------|----------|
| `live` (default) | Stream every `content` delta immediately | Generic OpenAI clients, lowest latency |
| `final-content` | Buffer all assistant text; emit one `content` chunk at turn-end | Clients that need the response part after thinking, OK with early+final text merged |
| `preamble-as-reasoning` | Buffer text; if a later thinking or tool-call boundary arrives, emit buffered text as `reasoning_content`; final text segment as `content` at turn-end | OpenCode via `@ai-sdk/openai-compatible` |

**Why multiple response blocks are not possible over chat completions:** `@ai-sdk/openai-compatible` maps every `delta.content` into a single AI SDK text part (`txt-0`) and only closes it when the HTTP stream ends. OpenCode can render multiple text parts, but this provider never emits mid-stream `text-end` boundaries. The proxy cannot fix that without patching the SDK; modes above are the supported workarounds.

Per-request override: `cursor_assistant_text_mode` on `POST /v1/chat/completions` bodies.

## OpenCode

OpenCode uses `@ai-sdk/openai-compatible`, which collapses all `content` into one text block per stream. For correct **Thought → Response** ordering when the model interleaves thinking and text, set:

```bash
export CURSOR_INCLUDE_THINKING=true
export CURSOR_ASSISTANT_TEXT_MODE=preamble-as-reasoning
export CURSOR_EMIT_TOOL_CALLS=false
```

Client tool turns (OpenCode's own `tools` array, registered as native `customTools`) use the **same** assistant text mode for visible text from the stream — set `preamble-as-reasoning` there too if you want ordering fixes during tool turns.

### Recommended setup

**API:**

```bash
export CURSOR_API_KEY="cursor_..."
export CURSOR_CWD="$(pwd)"
export CURSOR_ASSISTANT_TEXT_MODE=preamble-as-reasoning
bun run start
```

Per-request overrides: `cursor_include_thinking`, `cursor_assistant_text_mode`, `cursor_emit_tool_calls`.

**OpenCode** (`opencode.json`) — point at the proxy and declare interleaved reasoning on the model:

```json
{
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "cursor-openai-api",
      "options": {
        "baseURL": "http://localhost:8080/v1"
      },
      "models": {
        "composer-2.5": {
          "name": "Composer 2.5 (Fast)",
          "interleaved": { "field": "reasoning_content" },
          "cost": { "input": 0.5, "output": 2.5, "cache_read": 0.2 },
          "limit": { "context": 200000, "output": 65536 }
        }
      }
    }
  }
}
```

`interleaved.field` must be `reasoning_content` so OpenCode maps streamed thinking into separate **Thought** parts. The model-level `reasoning` flag in OpenCode config is separate from proxy thinking; you can leave `reasoning: false` there as long as the proxy keeps `CURSOR_INCLUDE_THINKING` enabled.

### What you see in the UI (`preamble-as-reasoning`)

| Stream | When it updates |
|--------|-----------------|
| Thinking (`reasoning_content`) | Live — includes preamble text re-routed when the model goes back to thinking or reaches a tool-call boundary |
| Tool calls (`CURSOR_EMIT_TOOL_CALLS=true` or client tools) | Live |
| Assistant response (`content`) | **Once**, when the turn ends (final text segment only) |

### Choosing a mode by app

| If you need… | Set |
|-------------|-----|
| OpenCode: best interleaved order + visible thinking | `CURSOR_ASSISTANT_TEXT_MODE=preamble-as-reasoning`, `CURSOR_INCLUDE_THINKING=true` |
| Any client: token-by-token assistant text | `CURSOR_ASSISTANT_TEXT_MODE=live` (default) |
| Response after thinking, all assistant text kept as `content` | `CURSOR_ASSISTANT_TEXT_MODE=final-content` |
| No thinking stream | `CURSOR_INCLUDE_THINKING=false` |
| Cursor internal tools as `tool_calls` | `CURSOR_EMIT_TOOL_CALLS=true` (usually **not** for OpenCode) |

## API surface

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness |
| `GET /v1/sessions` | List active in-memory Cursor agent sessions (debug/observability) |
| `GET /v1/models` | Cursor models via `Cursor.models.list()` |
| `POST /v1/chat/completions` | Chat completions (JSON or SSE stream) |
| `POST /v1/responses` | Responses API (JSON or typed SSE stream) |

## Compatibility notes

- **Runtime**: Local Cursor SDK agents only (`local: { cwd }`). Cloud agents are not exposed in this version.
- **Messages**: OpenAI `messages[]` (chat) or `input` / `instructions` (responses) are serialized into one Cursor prompt per request; there is no server-side OpenAI thread store.
- **Responses API**: `POST /v1/responses` accepts string or message-array `input`, maps to the same Cursor agent path as chat completions, and returns typed output items (`message`, `reasoning`, `function_call`). Streaming emits Responses lifecycle events.
- **Sessions**: When `CURSOR_ENABLE_SESSIONS` is on (default), reuse a Cursor SDK agent by sending the same session id on each request (`X-Session-ID` header or `metadata.session_id` / `metadata.sessionId`), or rely on **auto-session** (`CURSOR_AUTO_SESSION`, default on): if a new request's `messages[]` extends a cached conversation prefix (same base catalog model id), the proxy reuses the agent without an explicit session header. Gateways like Hermes should pass `metadata.hermes_session_id` (mapped to a stable `hermes:<id>` cache key) so agent reuse survives tool loops and system-prompt changes that break prefix matching. List active sessions with `GET /v1/sessions`. Session matching uses the SDK catalog id (e.g. `composer-2.5`), not `*-slow` / `*-fast` aliases.
- **Multi-turn history**: Prior assistant `reasoning_content` / `reasoning` in chat `messages[]` is preserved when serializing to the Cursor prompt. Chat-only request fields such as `response_format` and unknown passthrough JSON fields are included in the prompt.
- **Finish reasons**: Emits `length` when `max_tokens` is set and reported completion tokens reach that cap; emits `tool_calls` only when Cursor tool calls are surfaced in the OpenAI response.
- **Stream errors**: Errors are sent as standard OpenAI-style JSON in SSE `data:` lines (no separate `event: error`), matching `@ai-sdk/openai-compatible` parsers.
- **Cursor metadata**: Chat completion responses and chat stream chunks include `cursor` with `agent_id`, `run_id`, `session_id`, and when available `request_id`, `actual_model`, `thinking_duration_ms`, `cache_write_tokens`. All endpoints also return available `X-Cursor-*` headers for agent, run, session, request, and actual model ids.
- **Multimodal**: User messages with `image_url` / data URLs are sent as `SDKUserMessage` with `images` when possible (not only `[image: …]` text).
- **Streaming**: Text, thinking, and tool deltas come from `onDelta` (`text-delta`, `thinking-delta`, tool events). `run.stream()` only updates Cursor metadata (`actual_model`, `request_id`, `thinking_duration_ms`) and optional `DEBUG_STREAM` status lines; duplicate thinking messages from `run.stream()` are intentionally ignored.
- **Assistant text modes**: `CURSOR_ASSISTANT_TEXT_MODE` / `cursor_assistant_text_mode` control `live`, `final-content`, and `preamble-as-reasoning` routing. Applies to SDK text deltas and client-tool turn visible text. See [Assistant text modes](#assistant-text-modes) and [OpenCode](#opencode).
- **Client abort**: Dropping the HTTP request aborts the in-flight run via `run.cancel()` when supported.
- **Model parameters**: Pass Cursor SDK params via `cursor_model_params` (`[{ "id", "value" }]`). Chat completions also accept the convenience alias `reasoning_effort`; Responses requests use `reasoning.effort`. These aliases map only when the model catalog defines a thinking-effort param. Explicit `cursor_model_params` win on duplicate ids.
- **Fast mode**: Composer defaults to `fast=true` in Cursor's catalog; disable with `cursor_model_params: [{ "id": "fast", "value": "false" }]` or model id `composer-2.5-slow`. Use `*-fast` / `*-slow` proxy aliases for any model that advertises both `fast` param values (see [Speed aliases](#speed-aliases--slow--fast)).
- **Thinking**: When enabled (default), thinking text is exposed as `reasoning_content` (and `reasoning`) on stream deltas and on the final assistant message. Models with a thinking-effort parameter get a default effort automatically so Cursor actually emits thinking. Set `cursor_include_thinking: false` per request or `CURSOR_INCLUDE_THINKING=false` globally to disable.

### Tool calls

Three routing modes, controlled by `cursor_tool_mode` (`auto` | `client` | `native`) or env `CURSOR_TOOL_MODE`. There is no marker protocol — client tools are always bridged as native SDK `customTools` (see [`docs/native-client-tools.md`](docs/native-client-tools.md)):

| Mode | When to use | Tool behavior |
|------|-------------|---------------|
| **`client`** | Hermes main thread, any caller supplying its own `tools[]` | Client tools registered as native SDK `customTools`; the model calls them through Cursor's native channel, captured by the bridge and surfaced as OpenAI `tool_calls`. The proxy injects only the one-paragraph `NATIVE_CLIENT_TOOL_STEER` (no CLIENT TOOL INVENTORY, no anti-Cursor identity block); Hermes WHO/WHAT content is preserved. The caller executes tools locally and resends results |
| **`native`** | `delegate_task` / standalone Cursor worker with no upstream tools | Full Cursor SDK tools (Read, Shell, Write, …); the default worker path |
| **`auto`** (default) | Generic OpenAI clients | `client` behavior when request has non-empty `tools` and `tool_choice` ≠ `"none"`; otherwise plain/native |

Captured native calls map to `tool_calls` with `finish_reason: "tool_calls"`. Parallel calls (N≥3) share one `ClientToolCaptureSink`. **Built-in tool containment:** the SDK cannot disable/allowlist Cursor's always-live built-in Read/Shell/Grep/Write, so `client` mode ships only a minimal prompt steer toward the caller-provided tools; the heavier opt-in levers (isolated sandbox `CURSOR_CWD`, `mode:"plan"`) are documented but left unwired — see [`docs/native-client-tools.md`](docs/native-client-tools.md).

Set explicitly on each request (recommended for Hermes):

```json
{ "cursor_tool_mode": "client", "tools": [ ... ] }
```

```json
{ "cursor_tool_mode": "native", "tool_choice": "none" }
```

Also accepted via `metadata.cursor_tool_mode` or `metadata.cursorToolMode`.

Three HTTP-level behaviors:

1. **Plain chat** (default) — `CURSOR_EMIT_TOOL_CALLS=false` and no `tools` on the request. Cursor may use its own tools in `CURSOR_CWD`, but the proxy does not surface them; `finish_reason` stays `stop` and only assistant text/reasoning is returned.

2. **Client tools** (OpenCode / AI SDK / Hermes) — When the request includes a non-empty `tools` array and `tool_choice` is not `"none"`, the proxy registers them as native SDK `customTools`:
   - The tools are exposed via the synthetic `custom-user-tools` MCP server, and the model invokes them through Cursor's native tool channel. The call lands in the bridge's `execute`, the run is cancelled, and the call is surfaced as an OpenAI `tool_call` with `finish_reason: "tool_calls"`. See `src/client-tools/custom-tools-bridge.ts`.
   - The proxy injects only the slim `NATIVE_CLIENT_TOOL_STEER` paragraph (no CLIENT TOOL INVENTORY, no marker directive); upstream persona/skills/task content is preserved.
   - Supports function tools only; non-function tool definitions are rejected.
   - Your client executes tools locally and resends `tool` / `assistant.tool_calls` messages; the proxy does not run client tool handlers.
   - `CURSOR_EMIT_TOOL_CALLS` is ignored for these requests (Cursor-internal tool events are not forwarded).
   - `POST /v1/responses` with `tools` is rejected (use chat completions).

3. **Cursor tool visibility** — `CURSOR_EMIT_TOOL_CALLS=true` (or `cursor_emit_tool_calls: true`) only when the request carries **no** client tools. Surfaces Cursor SDK `tool-call-*` deltas as best-effort OpenAI `tool_calls` (Read, Shell, etc.). Usually **not** what you want alongside OpenCode's own `tools` array.

**Note:** The SDK's *built-in* tools (Read, Shell, Grep, WebSearch, …) are always live and cannot be disabled or allowlisted — those are not part of your `tools[]`, so the HTTP response only exposes **client** `tool_calls`. The bridge captures native invocations of your *client* tool names (so a Hermes-only tool like `session_search` / `delegate_task` no longer hard-fails with "Tool not found"). If you see unexpected file changes from built-in tools, that residual leak remains until a stricter SDK guard exists — see [`docs/native-client-tools.md`](docs/native-client-tools.md).

**Identity (Hermes / OpenCode):** Client tools are bridged through Cursor's own native channel, so the model keeps its real Cursor agent identity — there is no anti-Cursor identity block and no marker directive. The proxy injects only the one-paragraph `NATIVE_CLIENT_TOOL_STEER` toward the caller-provided tools; upstream Hermes SYSTEM content supplies persona/task. Restart the proxy after updating `src/client-tools/prompt.ts`.

### Tool filtering

Each client tool ships a prose-heavy JSON schema, and registering all ~28 Hermes tools as `customTools` every turn is the dominant fixed prompt cost on the client path. The proxy can drop tools a turn cannot use **before** they are registered, with no upstream Hermes change.

Three independent levers, resolvable per request (field), via `metadata` (comma-separated string), or as an env default:

| Lever | Request field | Env default | Meaning |
|-------|---------------|-------------|---------|
| Toolsets | `cursor_enabled_toolsets: ["file","terminal"]` | `CURSOR_ENABLED_TOOLSETS` | Keep only tools in these toolsets |
| Allowlist | `cursor_tools_allow: ["read_file","patch"]` | `CURSOR_TOOL_ALLOWLIST` | Keep only matching tool names |
| Denylist | `cursor_tools_deny: ["browser_*","cronjob"]` | `CURSOR_TOOL_DENYLIST` | Drop matching tool names (highest priority) |

Patterns are exact, or a trailing `*` for a prefix match. `deny` always wins; `allow` and `toolsets` union. Precedence: request field → `metadata` → env. When toolset filtering is active, tools with no known toolset are kept unless `cursor_toolsets_keep_unmapped` / `CURSOR_TOOLSETS_KEEP_UNMAPPED` is `false` (fail-open so a stale map never strips a needed tool).

```json
{
  "model": "composer-2.5",
  "cursor_tool_mode": "client",
  "cursor_enabled_toolsets": ["file", "terminal"],
  "tools": [ ... ]
}
```

Toolset names mirror Hermes (`file`, `terminal`, `coding`, `browser`, `delegation`, `cronjob`, `memory`, `session_search`, `skills`, `messaging`, `interaction`, `todo`, `tts`, `computer_use`); the name→toolset map lives in `src/client-tools/toolsets.ts`.

> Note: filtering trims the set of client tools registered as `customTools`. The kept set is registered **once** per turn, so the lever here is reducing the schema map, not de-duplicating it.

### Tool tiers (progressive disclosure)

Filtering removes tools entirely. Tiering keeps **every tool callable** but renders the rarely-used ones with a terse `inputSchema`. The insight: the model only needs a tool's **name + argument names** to issue a correct native call — Hermes (the executor) already holds the full schema — so the verbose prose schema can be replaced with a one-line signature on the long-tail `customTools`.

Set `cursor_tool_tier` (request), `metadata.cursor_tool_tier`, or `CURSOR_TOOL_TIER`:

| Mode | `customTool` schema rendering | Sample size |
|------|-------------------------------|-------------|
| `full` | Every tool gets its full JSON schema | baseline |
| `tiered` (default) | Resident tools full; the rest as `name(arg1, arg2?) — summary` | −41% |
| `brief` | Every tool as a signature line | −86% |

The client orchestrator defaults to `tiered` (set `CURSOR_TOOL_TIER=full` to restore full schemas everywhere). A direct build with no tier resolved still renders `full`. Tiering is load-bearing for token parity with the old marker inventory — see [`docs/native-client-tools.md`](docs/native-client-tools.md).

In `tiered` mode the resident set (full-schema tools) defaults to `read_file, write_file, patch, search_files, terminal, delegate_task` and is overridable via `cursor_tool_resident` / `CURSOR_TOOL_RESIDENT`. Brief entries mark optional args with `?`.

```json
{ "model": "composer-2.5", "cursor_tool_mode": "client", "cursor_tool_tier": "brief", "tools": [ ... ] }
```

To choose a resident set from real usage, set `CURSOR_TOOL_USAGE_LOG=/path/to/tool-usage.jsonl`; every client tool call is appended as `{"ts","tool"}`.

## Hermes integration

Jarvis/Hermes uses Composer via this proxy in two distinct shapes:

### Main thread (orchestrator + client tools)

Hermes sends its tool schemas (`read_file`, `terminal`, `patch`, …) on every agent turn. Tell the proxy explicitly:

```json
{
  "model": "composer-2.5",
  "cursor_tool_mode": "client",
  "tools": [ ... ],
  "metadata": { "hermes_session_id": "<stable-id>" }
}
```

- Proxy registers the tools as native SDK `customTools`; the model invokes them through Cursor's native channel and the bridge surfaces them as OpenAI `tool_calls`. Hermes executes the tools locally and resends results.
- Hermes SOUL/skills/memory still apply to *what* to do; the proxy controls *how* tools are invoked.
- `cursor_tool_mode: "client"` makes the routing unambiguous even if auto-detection would have worked.
- The injected framing is intentionally **lean** — only the one-paragraph `NATIVE_CLIENT_TOOL_STEER` (no CLIENT TOOL INVENTORY, no anti-Cursor identity block), and the `customTool` schemas default to the `tiered` tool tier to cut prompt cost.

### Standalone delegation (full Cursor SDK)

Native is the **default worker execution path**: a delegated worker runs Cursor's tools in-agent and (by default) narrates its progress back to the caller. When Hermes spawns a powerful standalone worker (`delegate_task`, coding agent, etc.) that should use Cursor's native tools directly:

```json
{
  "model": "composer-2.5",
  "cursor_tool_mode": "native",
  "tool_choice": "none",
  "messages": [{ "role": "user", "content": "Implement feature X in repo Y" }]
}
```

- Omit `tools` (or set `tool_choice: "none"`). Native mode ignores any client `tools[]` by design (it drives SDK tools), so a delegated child that still carries Hermes schemas is fine.
- Proxy injects a **native SDK directive** — use Read/Shell/Write/Grep directly.
- **Progress narration is on by default for native turns**: tool starts/results (and live shell stdout) stream as `reasoning_content` (`→ read(...)` / `✓ read → ...`), so the caller sees live progress instead of a silent worker. This is decoupled from `CURSOR_INCLUDE_THINKING` — it has its own lever, `cursor_native_progress` / `CURSOR_NATIVE_PROGRESS`. Set `cursor_native_progress: false` to silence it. (Caveat: narration rides the reasoning channel, so a platform that strips reasoning won't show it.)
- Optionally set `cursor_emit_tool_calls: true` to surface SDK tool use as OpenAI `tool_calls` instead — this turns native progress narration off (one channel per tool event).
- Point `cursor_cwd` at the target workspace; each delegated leaf carries its own `hermes_session_id`, so it gets a distinct proxy session from the orchestrator (no cross-bind).

**Workspace, allowlist, and `.env`.** The canonical multi-root workspace is `~/hermes-cursor-symbiosis.code-workspace` (git repo `cursor-openai-api` first so it is the SDK's primary/git root, then `~/.hermes`). A `.code-workspace` `cursor_cwd` expands to its declared roots; the session cache keys on the full sorted root set so workspaces sharing a first root don't collide. Per-request `cursor_cwd` overrides are gated by `CURSOR_CWD_ALLOWLIST` (an out-of-allowlist path returns `400 cwd_not_allowed`); an empty/unset allowlist is unrestricted, so set it in production. The proxy loads `.env` at startup (`src/load-env.ts`) with `process.env` taking precedence — important because under launchd (`node dist/index.js`) `.env` is not auto-loaded.

### Lifecycle: completion & calling other models

Both modes carry an explicit, symmetric contract so the model always knows how to signal it is done and how to reach another model:

| Concern | `client` (main thread) | `native` (delegated worker) |
|---------|------------------------|------------------------------|
| Identity | Main agent / orchestrator — no upstream to hand back to | Delegated worker — returns to the orchestrator that called it |
| Signal "done" | Stop invoking tools and write a final text answer. The absence of a tool call ends the turn (`finish_reason: stop`) and returns control. No special done token. | End the turn with a final text response. That text is returned verbatim to the orchestrator. No special done token. |
| Loop | Invoke a tool → the run is captured + cancelled → caller runs it and resends the result → continue | Use Cursor SDK tools directly across the single turn |
| Call another model / subagent | Call a delegation tool (e.g. `delegate_task`) as a client tool; the call returns as an OpenAI `tool_call` that Hermes executes. Don't curl the proxy. | `curl` the proxy at `proxyBaseUrl` (`/v1/chat/completions`); injected when the native worker is given the proxy base URL. |

The key compatibility guarantee: in **neither** mode does the model emit a magic stop token — ending the turn (no tool call in `client`, final text in `native`) is the completion signal, and each mode has exactly one sanctioned channel for invoking other models.

### Quick reference

| Call site | `cursor_tool_mode` | `tools` | Result |
|-----------|-------------------|---------|--------|
| Hermes main / thinking | `client` | Hermes schemas | Native `customTools` → captured `tool_calls` |
| `delegate_task` coding worker | `native` | omit / `tool_choice: none` | Full Cursor SDK |
| Generic OpenAI client | `auto` (default) | as needed | Auto-detect |

See `~/.hermes/jarvis-diary/learnings/2026-06-15-cursor-proxy-tool-routing.md` for troubleshooting identity confusion.

- **Usage fields**: Mapped from Cursor `turn-ended` deltas (`onDelta` on `agent.send()`). `prompt_tokens` is total input-side tokens (input + cache read + cache write); `prompt_tokens_details.cached_tokens` reports cache reads per the OpenAI usage schema. Omitted when the SDK does not report usage for a turn.
- **DEBUG_STREAM**: Status events only (`[status] ...` in `content`). Thinking uses `reasoning_content`, not `DEBUG_STREAM`.
- **Unknown fields**: Extra JSON fields on chat completion requests are accepted and included in the prompt passthrough. Responses requests accept unknown fields for client compatibility, but only the supported fields listed above are mapped to the Cursor turn.

## Development

With Bun:

```bash
bun test
bun run typecheck
```

With npm:

```bash
npm run typecheck
npm run build
```

Tests use Bun's test runner (`bun:test`); run them with `bun test` even when you use npm for install and Node for the server.

Integration tests against a real agent require a valid `CURSOR_API_KEY` and are not run in CI by default.
