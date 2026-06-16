# Tiered tools and context reduction plan

Plan for reducing fixed prompt overhead in the cursor-openai-api + Hermes Agent stack. Written 2026-06-15.

## Problem

Tool injection dominates fixed context cost on the Hermes client-mode proxy path:

- Each Hermes tool ships a full JSON Schema where `description` fields are prose manuals (usage guidance, pitfalls, safety rules).
- Heavy tools alone (`delegate_task`, `cronjob`, `computer_use`, `session_search`) account for several thousand tokens each.
- All ~28 tools load eagerly every turn, even when the task is conversational.
- In `cursor_tool_mode=client`, the inventory appears twice: once in the OpenAI `tools` array and again as JSON inside the system prompt for the marker protocol.

Rough estimate: ~8–12K tokens per turn for tool schemas alone; client mode can approach double that.

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

### Phase 0 — Proxy overhead (cheapest win, no architecture change)

Target: cursor-openai-api + per-request toolset filtering.

1. **Eliminate client-mode duplication**
   - Stop re-serializing the full CLIENT TOOL INVENTORY JSON into the system prompt when the same schemas are already in the OpenAI `tools` array.
   - Keep marker protocol routing instructions; drop redundant schema blobs.
   - Measure token savings before/after on a representative Hermes turn.

2. **Wire `enabled_toolsets` per request**
   - Accept toolset restriction from the client (header or request field — TBD).
   - Filter the injected tool list to only matching toolsets before building prompt + tools array.
   - Document supported toolset names and defaults.

Expected impact: likely halves proxy-path tool cost for typical code-only or file-only sessions.

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

- Exact request field for `enabled_toolsets` in the proxy (header vs JSON body extension)?
- Can cursor-openai-api filter tools without Hermes upstream changes, or is catalog generation server-side only?
- Which tools must remain resident for the Cursor client-mode marker protocol to work reliably?
- Token measurement harness: add a dev script that counts prompt tokens for a sample Hermes inventory?
