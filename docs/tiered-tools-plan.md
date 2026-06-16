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

### Phase 1 — Brief catalog + describe meta-tool

Target: Hermes Agent orchestrator layer (may require upstream coordination).

1. Replace full schemas in the default orchestrator tool list with brief catalog entries.
2. Implement `describe_tool` / `expand_toolset` meta-tool.
3. Move heavy tools out of the orchestrator default set into toolsets that only workers load.
4. Define which tools stay resident in Tier 1 based on usage frequency.

### Phase 2 — Auto-routing to workers

1. Orchestrator selects toolset(s) from brief catalog.
2. Delegates to a worker pre-loaded with expanded toolset via `delegate_task`.
3. Worker executes with full schemas; orchestrator receives summary only.

### Phase 3 — Tune from real usage

1. Log which tools/toolsets are requested per session type.
2. Adjust resident vs lazy boundaries.
3. Trim long descriptions upstream: terse spec in schema, detailed guidance in skills/docs loaded on demand.

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
- Which tools must remain resident for the Cursor client-mode marker protocol to work reliably?
- Should filtering also apply to the native/`full-prompt` path's `## CLIENT_TOOLS` block, or stay scoped to the client marker inventory?
