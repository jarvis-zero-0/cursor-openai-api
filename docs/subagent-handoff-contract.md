# Subagent Handoff Contract (v1)

Specification for the structured self-report a **leaf subagent** returns to the **orchestrator** across the execution-plane → control-plane boundary.

Status: **implemented**. Live code: `src/client-tools/handoff.ts` (schema + `parseHandoff` + leaf directive, fully implemented) is wired into `src/agent-turn.ts` (parsed on the native success path and surfaced as `AgentTurnOutcome.handoff`), and exposed to clients on the chat-completion `cursor.handoff` response payload (set on the meta accumulator before `sink.complete()` so the final streamed chunk carries it too). The leaf-side directive ships via `src/prompt.ts` (`buildNativeToolDirective`). §7 below is retained as the implementation map / change log; the "(new)" / "edit" notes describe the work as it was carried out, not pending work.

---

## 1. Background: how a turn flows today (grounded in code)

The proxy is the seam between the two planes. The relevant code paths:

- **Tool-mode resolution** — `src/tool-mode.ts`
  - `resolveCursorToolMode(request, config)` (lines 32–42): request field `cursor_tool_mode` → `metadata.cursor_tool_mode` → `config.CURSOR_TOOL_MODE` → `"auto"`. Enum: `["auto","client","native"]` (line 6).
  - `resolveClientToolsEnabled(request, toolMode)`: `native` ⇒ no client tools; `client`/`auto` ⇒ client tools registered as native customTools iff request carries `tools`.
- **Turn policy** — `src/turn-policy.ts`
  - `resolveTurnPolicy` produces `TurnPolicy { toolMode, clientTools, ... }`.
- **Agent turn / orchestration loop** — `src/agent-turn.ts`
  - `createAgentOptions(config, sdkModel, cwd, toolMode)` (lines 61–78): native agents load project rules (`settingSources: ["project"]`); client/auto load none.
  - `runTurnBody(...)` (lines 80–218): builds payload (line 130), runs the Cursor SDK agent (`prepared.agent.send`, line 148), pumps the stream, then `const result = await run.wait()` (line 163).
  - **The leaf's return value is `result.result`**, surfaced as `AgentTurnOutcome.finalText` (line 206). On `result.status === "error"` it throws `ProxyError(..., "agent_run_error")` (lines 166–172); on `"cancelled"` throws 499 (lines 174–176).
- **Result → OpenAI response** — `src/completion-response.ts`
  - `buildCompletionResponse(state, meta, finalText)` (lines 10–51): `const text = finalText?.trim() || state.text.trim()` (line 16) becomes `choices[0].message.content`.
- **Handler entry** — `src/chat-handlers.ts`: `runChatCompletion` / `streamChatCompletion` pass `outcome.finalText` through (line 30).
- **Native leaf directive** — `src/prompt.ts`
  - `buildNativeToolDirective(ctx?)` (lines 14–59): the system preamble injected into a fresh native agent. The "COMPLETION / RETURNING CONTROL" block (lines 33–39), followed by `...buildHandoffDirectiveLines()` (line 40), tells the leaf to end with a final text response that is returned verbatim to the orchestrator and to terminate it with the structured self-report. Injected only on a fresh agent (`injectNativeDirective`, `agent-turn.ts` lines 105–112).
- **Orchestrator (client-mode) prompt** — `src/client-tools/prompt.ts`
  - `NATIVE_CLIENT_TOOL_STEER` — the one-paragraph steer prepended on client-tool turns. `delegate_task` is a normal client tool (catalog `DEFAULT_RESIDENT_TOOLS`, `catalog.ts`; toolset `delegation`, `toolsets.ts`).

**Key fact for implementers:** delegation is wired *at the Hermes client layer*, not in this repo. The orchestrator runs in client mode and calls `delegate_task` through Cursor's native tool channel (captured by the bridge and surfaced as an OpenAI `tool_call`); Hermes turns that into a **fresh chat-completion request to this proxy** with `cursor_tool_mode: "native"`. The leaf's `result.result` (its final assistant text) comes back to Hermes as the `delegate_task` tool result, which is fed to the orchestrator. **Therefore the contract is carried inside the leaf's final assistant text**, and this repo's job is: (a) instruct the leaf to emit it, and (b) optionally extract/validate it so `finalText` is well-formed before it leaves the proxy.

---

## 2. The contract: leaf emits a fenced JSON block as the LAST thing in its final text

The leaf's final assistant text MUST end with a single fenced block tagged `handoff`:

````
```handoff
{ ... contract JSON ... }
```
````

Rules:
- Exactly one `handoff` block per return. If multiple, the **last** one wins (earlier ones are treated as draft and ignored).
- Any prose before the block is the human-readable narrative; it is preserved as `summary` fallback (see §4) but is NOT authoritative.
- The block is the machine interface. The orchestrator parses this, not the prose.

Tagging with a fenced `handoff` block (rather than requiring the whole message to be JSON) keeps the return readable, survives the leaf adding chatter, and is trivially extractable with a regex anchored to the last fence.

---

## 3. Finalized schema (v1)

```json
{
  "schema_version": "1.0",
  "task_id": "string | null",
  "status": "done | partial | blocked | failed",
  "summary": "One-paragraph plain-text account of what was attempted and done.",
  "confidence": 0.0,
  "truncated": false,
  "artifacts": [
    {
      "id": "string",
      "kind": "file | dir | url | process | command | git_ref | stdout | other",
      "handle": "/abs/path | https://… | <pid> | <sha> | <git-rev> | <id>",
      "mutated": true,
      "description": "string (optional)",
      "verify": {
        "method": "stat | sha256 | http_get | exit_code | git_rev_parse | none",
        "expect": "string (optional; e.g. '0' for exit_code, a sha, an HTTP status)"
      }
    }
  ],
  "unresolved": [
    {
      "what": "string",
      "why": "string",
      "severity": "info | warn | error"
    }
  ],
  "recommended_next": [
    {
      "id": "string",
      "goal": "string",
      "rationale": "string",
      "suggested_tool_mode": "native | client",
      "toolsets": ["terminal", "file"],
      "priority": 1,
      "depends_on": ["artifact-or-rec-id"]
    }
  ],
  "metrics": {
    "tool_calls": 0,
    "elapsed_ms": 0,
    "model": "string (optional)"
  }
}
```

### Field reference

| Field | Type | Req? | Notes |
|---|---|---|---|
| `schema_version` | string | **required** | SemVer-ish. v1 = `"1.0"`. Orchestrator rejects unknown major versions (see §4). |
| `task_id` | string \| null | optional | Echo of the orchestrator-assigned id (if any) so results correlate to spawns. `null` if the leaf wasn't given one. |
| `status` | enum | **required** | `done` (fully complete, artifacts verifiable), `partial` (real progress but incomplete — truncated, hit `max_tokens`, ran out of time; resumable), `blocked` (cannot proceed without an external decision/input/dependency), `failed` (attempted and errored irrecoverably). |
| `summary` | string | **required** | Non-empty. Human-readable; the orchestrator owns final user-facing formatting (this is raw material, not the user message). |
| `confidence` | number 0–1 | optional | Leaf's self-assessed confidence that `status` is accurate. Default treated as `0.5` if absent. |
| `truncated` | boolean | optional | `true` if the leaf knows its own output/work was cut off. Default `false`. Pairs with `status:"partial"`. |
| `artifacts` | array | **required** (may be `[]`) | Verifiable side-effects. Empty array is valid (pure-analysis tasks). |
| `artifacts[].id` | string | **required** | Unique within the report; referenced by `recommended_next[].depends_on`. |
| `artifacts[].kind` | enum | **required** | See enum in schema. `other` is the escape hatch. |
| `artifacts[].handle` | string | **required** | The single verifiable identifier — absolute path, URL, PID, sha, git rev, exit-code-bearing id. NEVER a relative path. |
| `artifacts[].mutated` | boolean | **required** | `true` = created/modified, `false` = only read/inspected. Lets the orchestrator skip verifying read-only handles. |
| `artifacts[].description` | string | optional | |
| `artifacts[].verify` | object | optional | How the orchestrator cheaply confirms the handle. If omitted, orchestrator infers from `kind` (`file`→`stat`, `url`→`http_get`, …). |
| `artifacts[].verify.method` | enum | required-if-`verify`-present | `stat`, `sha256`, `http_get`, `exit_code`, `git_rev_parse`, `none`. |
| `artifacts[].verify.expect` | string | optional | Expected value (sha digest, `"0"`, `"200"`, a git rev). Absent ⇒ existence check only. |
| `unresolved` | array | optional | Things not finished. Objects, not bare strings, so severity is machine-readable. |
| `recommended_next` | array | optional | **Advisory only.** The leaf proposes; the orchestrator disposes. |
| `recommended_next[].suggested_tool_mode` | enum | optional | Hint; orchestrator decides. Defaults to `native` (execution plane) when absent. |
| `recommended_next[].priority` | integer | optional | Lower = sooner. Used to order, not to force. |
| `recommended_next[].depends_on` | string[] | optional | ids of artifacts or other recs that must exist/run first. |
| `metrics` | object | optional | Telemetry. Non-authoritative. |

### Streamed / partial / truncated handling
- A leaf that is being cut off SHOULD set `status:"partial"`, `truncated:true`, and put what remains into `unresolved` and/or `recommended_next` (one rec describing the resume step, ideally with `suggested_tool_mode:"native"`).
- Streaming (`streamChatCompletion`) does not change the contract: the `handoff` block still arrives as the tail of the streamed text and is parsed from the assembled final text, not mid-stream.
- If the model hits `max_tokens` before closing the fence, extraction fails → fallback path in §4 (treated as `status:"partial"` synthesized from prose).

---

## 4. Validation rules + orchestrator fallback

Validation lives in `parseHandoff(finalText): HandoffParseResult` (new, `src/client-tools/handoff.ts`). It returns either a validated object or a typed failure the orchestrator can branch on.

A return is **malformed** if ANY of:
1. No `handoff` fence found in the final text.
2. Fence content is not valid JSON.
3. `schema_version` missing, or its **major** version ≠ `1` (forward-incompatible).
4. `status` missing or not in the enum.
5. `summary` missing or empty/whitespace.
6. `artifacts` present but not an array, or any element missing required `id`/`kind`/`handle`/`mutated`.
7. Duplicate `artifacts[].id`.
8. Unknown enum value in a required enum field (`status`, `kind`, `verify.method`).

Severity tiers and behavior:
- **Hard-malformed** (rules 1–5): cannot trust the structure. Fallback → synthesize a minimal report from prose:
  ```json
  { "schema_version": "1.0", "status": "failed", "summary": "<entire final text, trimmed>",
    "artifacts": [], "unresolved": [{ "what": "structured handoff missing/invalid",
    "why": "<parse reason>", "severity": "error" }], "_degraded": true }
  ```
  The orchestrator MUST NOT treat a degraded report as `done` — it is forced to `status:"failed"` so artifacts are never trusted blind and auto-resume does not loop on format failures.
- **Soft-malformed** (rules 6–8): keep the valid top-level fields, drop the offending array elements, attach a `_warnings: string[]`. Status is preserved but downgraded from `done`→`partial` if any artifact was dropped.

Unknown/extra fields not in the schema are ignored (forward-compatible), never an error.

`parseHandoff` return type:
```ts
type HandoffParseResult =
  | { ok: true;  report: Handoff;  warnings: string[]; degraded: boolean }
  | { ok: false; report: Handoff;  /* degraded synthetic */ reason: string };
```
There is no "throw" path — the orchestrator always gets a usable `report`.

---

## 5. How the orchestrator consumes the contract

The orchestrator (client mode, Hermes side) runs this algorithm on each `delegate_task` result:

1. **Parse** the tool result text via `parseHandoff`.
2. **Branch on `status`:**
   - `done` → go to step 3 (verify before trusting).
   - `partial` → verify whatever artifacts exist (step 3), then arbitrate `recommended_next` to decide whether to spawn a resume leaf.
   - `blocked` → DO NOT spawn blindly. Surface the blocker to the user OR resolve the named dependency, then optionally re-delegate. Blocked means "I need a decision," not "try again."
   - `failed` → do not re-spawn the identical task. Inspect `unresolved`; either change approach, escalate to a client-mode leaf for step-level visibility, or report failure to the user.
3. **Verify artifacts before trusting `status:"done"`** (the return is a self-report, not truth). For each artifact with `mutated:true`:
   - `kind:file` / `verify.method:stat` → `stat <handle>`; if `expect` is a sha, `sha256 <handle>` and compare.
   - `kind:url` / `http_get` → HEAD/GET `<handle>`; compare status to `expect` (default 2xx).
   - `kind:command|process` / `exit_code` → confirm recorded exit code equals `expect` (default `"0"`).
   - `kind:git_ref` / `git_rev_parse` → `git rev-parse <handle>`.
   - If verification FAILS, treat the report as if `status:"partial"` regardless of what the leaf claimed, and record the discrepancy. **A claimed `done` with an unverifiable artifact is never reported to the user as done.**
   - `mutated:false` artifacts are not verified.
4. **Arbitrate `recommended_next`** (advisory):
   - The orchestrator is the SOLE spawn-decider. Recommendations are inputs, not commands.
   - Order by `priority` (asc), respecting `depends_on` (topological: don't spawn a rec whose deps are unverified).
   - De-duplicate against work already done / already queued.
   - Decide spawn vs. drop vs. defer-to-user per rec. For each spawned rec, pick tool mode: default `native` (execution plane); override to `client` only when the rec needs Hermes-only tools mid-task or step-level gating (matches the architecture rule).
5. **Format for the user.** The orchestrator owns ALL user-facing formatting; it never forwards raw `handoff` JSON. It composes the user message from `summary` + verified artifact handles + its own decisions.

### Conflicting recommendations
- Within one leaf: if two recs target the same goal/path, keep the higher `priority` (lower number); if equal, keep the first and fold the other into `unresolved`-style notes.
- Across parallel leaves: the orchestrator reconciles. Same artifact `handle` claimed by two leaves with different `verify.expect` (e.g. two shas for one file) ⇒ a real conflict: re-verify on disk, trust the filesystem, discard the losing claim, and (if mutated by both) flag a write-collision to the user. Conflicting recs never auto-spawn both; the orchestrator picks one or asks.

---

## 6. Edge cases (required behavior)

| Edge case | Detection | Orchestrator behavior |
|---|---|---|
| **Leaf crash / SDK error** | `agent-turn.ts` lines 166–172 throw `ProxyError("agent_run_error")`; Hermes sees a non-200 / error tool result, no `handoff` block. | Synthesize `status:"failed"`, `summary` = error text. Do not re-spawn identically; inspect or escalate. |
| **Timeout / cancelled** | `agent-turn.ts` lines 174–176 (499) or Hermes-side delegate timeout. | Synthesize `status:"partial"`, `truncated:true`. Eligible for a resume spawn. |
| **No structured output (prose only)** | `parseHandoff` rule 1. | Degraded synthetic report (§4), forced `status:"failed"`, `_degraded:true`. Never trusted as done; do not auto-resume identically. |
| **Truncated mid-fence** (`max_tokens`) | JSON parse fails (rule 2) on an unterminated block. | Same as prose-only degraded path; usually also `truncated`. |
| **Leaf tries to self-delegate** | Leaf runs in native mode with NO `delegate_task` tool available (it only has Cursor SDK built-ins). It cannot spawn. If it *recommends* delegation, that appears as a `recommended_next` entry. | Allowed as advice only. Orchestrator decides. The proxy enforces this structurally: native-mode requests carry no client `delegate_task` tool, and the native directive (`src/prompt.ts`) explicitly tells the leaf it is a delegated worker. Add a guard (see §7) so a `delegate_task` call emitted by a native leaf is dropped, not executed. |
| **Conflicting recommendations** | §5 arbitration. | Pick one, fold the rest into notes / user prompt; never auto-spawn conflicting work. |
| **Artifact handle is relative or missing** | Validation rule 6 / soft-malformed. | Drop that artifact, add `_warnings`, downgrade `done`→`partial`. |

---

## 7. Implementation map — exact files & functions to touch

**New file — `src/client-tools/handoff.ts`**
- `export const HANDOFF_SCHEMA_VERSION = "1.0"`.
- `export interface Handoff { … }` + sub-interfaces (`HandoffArtifact`, `HandoffUnresolved`, `HandoffRecommendation`, `HandoffMetrics`) mirroring §3.
- `export const handoffSchema = z.object({...})` (Zod; the repo already uses Zod throughout, e.g. `openai.ts`, `config.ts`). Enums via `z.enum`.
- `export function extractHandoffBlock(finalText: string): string | null` — regex for the **last** ` ```handoff … ``` ` fence.
- `export function parseHandoff(finalText: string): HandoffParseResult` — implements §4 (extract → JSON.parse → `handoffSchema.safeParse` → degrade/soft-fix). Pure, no I/O.
- `export function buildHandoffDirectiveLines(): string[]` — the instruction text appended to the native directive (§2 + §3 shape).

**Edit — `src/prompt.ts`**
- In `buildNativeToolDirective` (lines 13–52), append `...buildHandoffDirectiveLines()` to the "COMPLETION / RETURNING CONTROL" section so every fresh native leaf is told to end with a `handoff` block. This is the only change needed to make leaves *emit* the contract.

**Edit — `src/agent-turn.ts`**
- In `runTurnBody`, after `const result = await run.wait()` (line 141) and the status checks: call `parseHandoff(result.result ?? "")`. Add the parsed object to `AgentTurnOutcome` as a new optional field `handoff?: Handoff` (extend the interface at lines 49–54). Keep `finalText` as-is for backward compatibility / prose fallback.
- Map SDK error/cancel (lines 144–154) into synthetic `failed` / `partial` handoffs instead of (or in addition to) throwing, when the caller is a delegation leaf — gated so the public OpenAI error path is unchanged for normal requests. Simplest: leave the throws, and let Hermes synthesize on its side; document both.

**Edit — `src/agent-turn.ts` (self-delegation guard)**
- Native leaves never receive client tools, so `delegate_task` is structurally absent. Add a defensive note/guard where native payloads are built (`createAgentOptions` / `runTurnBody` payload, lines 56–115): ensure no client `delegate_task` schema leaks into a `native` turn. (Today client tools only render when `clientToolSpecs?.length`, which is the client path — so this is an assertion, not a behavior change.)

**Edit — `src/client-tools/types.ts`**
- Export the `Handoff` types here or re-export from `handoff.ts` for a single import site (matches existing `ClientToolSpec` / `ParsedToolCall` placement).

**Orchestrator consumption (Hermes side, outside this repo)**
- Lives in the Hermes `delegate_task` tool handler, not the proxy. It imports/duplicates `parseHandoff` semantics and runs §5. This repo provides the schema + parser + the leaf-side directive; Hermes provides verification (stat/curl) and the spawn loop.

**Edit — `src/cursor-meta.ts` / `src/openai.ts`**
- `CursorCompletionMeta` gains an optional `handoff?: Handoff` field (`openai.ts`); `CursorMetaAccumulator.setHandoff` stores it. `runTurnBody` calls `setHandoff` before `sink.complete()`, so the parsed report rides the `cursor.handoff` payload on both the non-stream body and the final stream chunk. This is additive — content is untouched.

**No change needed**
- `src/tool-mode.ts`, `src/turn-policy.ts` — mode plumbing already correct; orchestrator=client, leaf=native is already expressible via `cursor_tool_mode`.
- `src/completion-response.ts` — `finalText` (incl. the `handoff` fence) already flows into `content` (line 16); the fence travels verbatim to Hermes, and the parsed report is attached separately via the cursor meta (above), so this file is unchanged.

---

## 8. Versioning

`schema_version` is the single source of truth. Bump the **major** for any breaking change to required fields or enum removals (orchestrator rejects unknown majors → degraded path). Additive fields (new optional keys, new `kind`/`method` enum values) are **minor** bumps and require no orchestrator change because unknown fields are ignored and unknown enum values in *optional* positions degrade gracefully.

---

## 9. Current consumption status & known gaps (emit-only today)

As of now the handoff is **emit-only**: the proxy produces it, but Hermes does not yet run the §5 consumer (it returns the leaf's text — including the ```handoff fence — verbatim to the orchestrator model, which interprets it as prose). The parser, schema, leaf directive, and `cursor.handoff` surfacing all exist and are tested; wiring the programmatic consumer (verify/arbitrate) is deferred by design. Two consequences follow:

- **Responses API (`/v1/responses`) does not surface `cursor.handoff`.** `chatCompletionToResponse` / the stream translator map only message content + usage; the `cursor` meta (and thus `handoff`) is dropped. This is acceptable today because Hermes delegation uses **chat completions**, not the Responses API. If a Responses-API consumer ever needs the structured report, map `completion.cursor` into the response object.
- **Error / cancel paths throw without a contract-shaped handoff.** On SDK `error` (502) / `cancelled` (499) the proxy throws a plain OpenAI error (no `cursor.handoff`). Hermes has its own delegate-local status envelopes (`timeout` / `error` / `interrupted`) and does not expect a synthesized `failed`/`partial` handoff from the proxy. If the §5 consumer is built later, synthesize `status:"failed"` (error) / `status:"partial"`+`truncated` (cancel) at that point.
