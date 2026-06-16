# Tiered tools and context reduction plan

Plan for reducing fixed prompt overhead in the cursor-openai-api + Hermes Agent stack. Written 2026-06-15.

## Problem

Tool injection dominates fixed context cost on the Hermes client-mode proxy path:

- Each Hermes tool ships a full JSON Schema where `description` fields are prose manuals (usage guidance, pitfalls, safety rules).
- Heavy tools alone (`delegate_task`, `cronjob`, `computer_use`, `session_search`) account for several thousand tokens each.
- All ~28 tools load eagerly every turn, even when the task is conversational.

Rough estimate: ~8–12K tokens per turn for tool schemas alone.

> **Verified 2026-06-15 (Phase 0):** The earlier "inventory appears twice in client mode" assumption does **not** hold for the current code. `serializeMessagesToPrompt` builds the client path with `skipTools: true`, so the OpenAI `tools` JSON block (`## CLIENT_TOOLS`) is not emitted alongside `CLIENT TOOL INVENTORY`, and `buildSendOptions` forwards no `tools` array to the Cursor SDK. Tools are serialized exactly once. The real lever is therefore **trimming the set** (filtering) and, later, **description verbosity** — not de-duplication.

Embeddings and semantic retrieval do **not** shrink this cost — it is structural. Fixes must target eager injection, duplication, and description verbosity.

## Design: three-tier progressive disclosure

Instead of two tiers (brief menu → full worker), use three:

### Tier 1 — Orchestrator (cheap, always loaded)

- Brief catalog: tool or toolset name + one-line description (~15–25 tokens each → ~600 tokens for 28 tools vs ~10K today).
- Keep a small resident set the orchestrator can call directly without delegation: e.g. `read_file`, `terminal`, `search_files`, `patch`.
- Keep `delegate_task` in brief form so the orchestrator can spawn workers.

One-liners alone are too thin to route well (e.g. knowing `cronjob` requires `schedule`). The orchestrator needs enough to pick the right toolset, not full schemas.

### Tier 2 — On-demand schema expansion

- Add a meta-tool (`describe_tool` / `expand_toolset`) that returns the full JSON Schema for a named tool or toolset.
- Orchestrator pulls full schema only when it is about to use a tool directly (rare for heavy tools) or when deciding between similar options.
- Avoids paying full schema cost for tools that are never touched on a turn.

### Tier 3 — Worker subagent (full schemas, scoped)

- Spin up via existing `delegate_task` with explicit `toolsets`.
- Worker is the only context that carries heavy schemas (`browser`, `computer_use`, `cronjob`, etc.).
- Hermes already supports this: `delegate_task.toolsets` and `enabled_toolsets` on cron jobs.

## Tradeoffs

| Benefit | Cost |
|---------|------|
| ~90% reduction in orchestrator fixed tool overhead | Extra latency on tool-using turns (subagent hop) |
| Heavy tools isolated to workers | Second model context per delegated turn |
| Better scaling as tool count grows | Routing errors if brief catalog is too terse |

**When it wins:** long multi-turn chats where tool use is occasional — orchestrator context is reused across many turns.

**When it loses:** one-shot "run this command" — strictly more expensive than keeping `terminal` loaded with full schema.

**Mitigation:** keep cheap/high-frequency tools resident in Tier 1; push rare/heavy tools behind Tier 2/3.

## Implementation phases

### Phase 0 — Proxy overhead (cheapest win, no architecture change) — DONE

Target: cursor-openai-api + per-request toolset filtering.

1. **Client-mode duplication — verified non-issue.**
   - Confirmed the client path already serializes the inventory once (`skipTools: true`; no `tools` array forwarded to the SDK). No fix needed; documented in Problem above.

2. **Per-request tool filtering — implemented.**
   - `src/client-tools/toolsets.ts`: static Hermes tool→toolset map (`file`, `terminal`, `coding`, `browser`, `delegation`, `cronjob`, `memory`, `session_search`, `skills`, `messaging`, `interaction`, `todo`, `tts`, `computer_use`).
   - `src/client-tools/filter.ts`: `resolveToolFilter` + `applyToolFilter` supporting allowlist, denylist, and `enabled_toolsets`, with `*`-suffix prefix matching and a fail-open `keepUnmapped` default.
   - Resolution precedence: request field → `metadata` → env (`CURSOR_ENABLED_TOOLSETS`, `CURSOR_TOOL_ALLOWLIST`, `CURSOR_TOOL_DENYLIST`, `CURSOR_TOOLSETS_KEEP_UNMAPPED`). Wired into `resolveTurnStreamContext` so the inventory is trimmed before serialization.
   - `scripts/measure-tool-tokens.ts` + `scripts/fixtures/hermes-tools.sample.json`: chars/4 token estimator with per-toolset breakdown and filter-scenario savings.
   - Tests: `test/client-tools/filter.test.ts`, `test/turn-stream.test.ts`.

Measured impact (bundled representative sample, schemas partially trimmed so absolute numbers are a lower bound; relative savings are real):

| Filter | Result |
|--------|--------|
| `deny browser_*,computer_use,cronjob` | −27% |
| `toolsets=file,terminal,coding` | −64% |
| `toolsets=file,terminal` (keep unmapped) | −67% |
| `allow=read_file,write_file,patch,terminal` | −78% |

Next within Phase 0 (optional): trim description verbosity (terse spec in inventory, guidance in skills/docs).

### Phase 1 — Brief catalog (progressive disclosure) — DONE (proxy-side)

> **Discovery 2026-06-15 (runtime trace):** In client mode the proxy is **not** a
> cross-turn executor. The marker parser turns any tool-call marker into an OpenAI
> `tool_call` and ends the turn (`finish_reason: tool_calls`); Hermes executes it
> and re-sends. So a synthetic `describe_tool` / `expand_tools` meta-tool (the
> original Tier 2) would be returned to Hermes, which has no handler — making it
> require either an internal SDK re-send sub-loop (not verifiable without a live
> Cursor key) or upstream Hermes work.
>
> **The cleaner realization that needs neither:** the model does not need a tool's
> full prose JSON schema to emit a correct marker call — it only needs the tool
> **name + argument names**. Hermes (the executor) already holds the real schemas.
> So rarely-used tools can be rendered as a compact **signature**
> (`name(arg1, arg2?) — first sentence`) instead of full JSON, fully end-to-end,
> no upstream change, no meta-tool round trip. This makes the brief catalog the
> shippable core of Phase 1 and the `expand_tools` meta-tool unnecessary for the
> common case.

Implemented in cursor-openai-api:

- `src/client-tools/catalog.ts`: `toolSignature`, `briefToolLine`, `firstSentence`, `splitToolTiers`, `resolveToolTier`, and the default resident set.
- Three render modes via `cursor_tool_tier` / `CURSOR_TOOL_TIER`: `full` (default, legacy), `tiered` (resident full + rest brief), `brief` (all signatures). Resident set via `cursor_tool_resident` / `CURSOR_TOOL_RESIDENT`.
- Wired through `PromptExtras.toolTier` → `serializeMessagesToPrompt` → `buildClientToolPromptSections` → `appendChatTools`. Default `full` keeps existing behavior byte-for-byte.
- Tests: `test/client-tools/catalog.test.ts`, tiered/brief cases in `test/prompt.test.ts`.

Measured impact (same representative sample; **all tools remain callable**):

| Mode | Result |
|------|--------|
| `tiered` (resident full + rest brief) | −54% |
| `brief` (all signatures) | −86% |

The `expand_tools` meta-tool (full-schema-on-demand) is deferred: it needs the
runtime sub-loop below and only matters when the model wants detailed guidance,
which the brief signature already covers for calling.

### Phase 2 — Auto-routing to workers — reframed (mostly Hermes-side)

Worker delegation is executed by Hermes via the existing `delegate_task`
(`toolsets` arg) — the proxy cannot auto-delegate because it does not execute
tools. The proxy's contribution is making heavy tools cheap to *advertise* so an
orchestrator can see and route to them without paying full-schema cost: that is
exactly the Phase 1 brief tier. No further proxy change is required for routing;
true auto-routing (orchestrator → worker) lives in Hermes.

Optional future proxy work: an internal **meta-tool sub-loop** — intercept an
`expand_tools` marker, resolve the full schema in-proxy, re-send to the Cursor
agent, and surface only the final client tool call. Designed but not wired,
because it changes streaming-turn semantics and needs live Cursor verification.

### Phase 3 — Tune from real usage — DONE (telemetry shipped)

- `src/client-tools/usage-log.ts`: in-memory per-tool call counter (always on, cheap) plus an optional JSONL audit trail via `CURSOR_TOOL_USAGE_LOG`. Hooked into `text-handler` at the point markers become OpenAI tool calls. Telemetry never throws into a turn.
- `getToolUsage()` returns counts highest-first → use it to choose the resident set (`CURSOR_TOOL_RESIDENT`) from real calls instead of guesses.
- Tests: `test/client-tools/usage-log.test.ts`.

Remaining (upstream, lower priority): trim long descriptions at the Hermes source (terse spec in schema, detailed guidance in skills/docs loaded on demand).

## Related: embeddings (separate track)

Local embeddings help only when they **replace** eager injection with selective retrieval (memory, past sessions, skill selection). They do not reduce tool schema or proxy duplication overhead.

For Jarvis at current scale (MEMORY.md ~29%, USER profile ~51%), embedding infra is premature. Priority order:

1. Phase 0 (this doc) — fixed prompt overhead
2. `session_search` + context compressor — already available
3. Hindsight / semantic memory — when diary and sessions outgrow keyword recall (verify against live Hermes docs before implementing)

## Checkpoint

Local commits before this plan was added sit at `6851c02` (pre-plan baseline). Do not push until GitHub access is configured for Jarvis.

## Open questions

- ~~Exact request field for `enabled_toolsets` in the proxy (header vs JSON body extension)?~~ Resolved: JSON body field `cursor_enabled_toolsets` (+ `cursor_tools_allow` / `cursor_tools_deny`), also via `metadata` and env.
- ~~Can cursor-openai-api filter tools without Hermes upstream changes?~~ Resolved: yes — the proxy filters the inbound `tools` array before serializing, no upstream change required.
- ~~Token measurement harness?~~ Resolved: `scripts/measure-tool-tokens.ts`. Still want a real tokenizer (currently chars/4) and a captured full-inventory fixture for exact figures.
- ~~Which tools must remain resident?~~ Partially resolved: the brief signature keeps *every* tool callable, so "resident" is now about routing comfort, not capability. `usage-log` data drives the resident set; default is read_file/write_file/patch/search_files/terminal/delegate_task.
- Should filtering also apply to the native/`full-prompt` path's `## CLIENT_TOOLS` block, or stay scoped to the client marker inventory?
- Is the `expand_tools` runtime sub-loop worth building, given brief signatures already make tools callable? Only if models routinely need full per-tool guidance — measure with `usage-log` first.
- Validate `brief` mode call accuracy against real Composer turns (does name+arg-names suffice, or do some tools need a one-line arg hint)?
