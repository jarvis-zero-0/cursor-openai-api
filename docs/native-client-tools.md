# Native client tools

Status: **shipped** (2026-06-16). The marker protocol is gone; native SDK `customTools` are the
only client-tool path. This doc records the durable architecture + findings.

## Flow

Tool modes are `auto | client | native`.

- **`client`** — the request carries `tools[]`; the proxy registers them as Cursor SDK
  `customTools` and captures the model's native invocations as OpenAI `tool_calls`. No markers, no
  CLIENT TOOL INVENTORY, no anti-Cursor identity block — just the slim `NATIVE_CLIENT_TOOL_STEER`
  paragraph plus the verbatim conversation. The caller (e.g. Hermes) executes tools locally and
  resends `tool` / `assistant.tool_calls` messages, exactly as before.
- **`native`** — delegated worker with no client tools; full Cursor SDK built-ins (Read, Shell,
  Write, Grep, …) run in `CURSOR_CWD`. Default worker path; progress narration on by default.
- **`auto`** (default) — `client` behavior when the request has non-empty `tools` and
  `tool_choice != "none"`; otherwise plain/native serialization.

```
request with tools[]  ──►  register customTools  ──►  custom-user-tools MCP bridge
                                                          │  model invokes natively
                                                          ▼
                                       ClientToolCaptureSink  ──►  OpenAI tool_calls
                                                                   finish_reason: "tool_calls"
```

The capture bridge (`src/client-tools/custom-tools-bridge.ts`) surfaces the synthetic
`custom-user-tools` MCP server. A native invocation lands in the tool's `execute`, the run is
cancelled, and the call is emitted as an OpenAI `tool_call` — identical shape to the old marker
path, so upstream consumers need no change. Parallel calls (N≥3) share one `ClientToolCaptureSink`.

## Built-in containment (Spike D finding)

The Cursor SDK exposes **no** allowlist, denylist, permission map, or per-tool disable switch for
its built-in tools. `customTools` is purely **additive** — it adds the `custom-user-tools` MCP
server, it cannot subtract the native Read/Shell/Grep/Write, which are always live and execute on
the proxy host against `CURSOR_CWD`. "Only my customTools are callable" is not achievable today.

So containment is steer-first, not enforcement:

- **Default (shipped):** a minimal prompt steer (`NATIVE_CLIENT_TOOL_STEER`) toward the
  caller-provided tools. Going-with-the-grain + a single coherent tool list is what reduces
  wrong-channel picks.
- **Heavier levers (documented, unwired, opt-in):** point `CURSOR_CWD` at an isolated throwaway
  sandbox so a leaked built-in write/shell is harmless; run orchestrator turns with `mode: "plan"`
  to suppress the mutation tools. Neither is a real per-tool gate.
- **Upstream ask:** an `allowedTools` / `disabledTools` field on `LocalAgentOptions` (the
  `ToolType` union already exists in the SDK). Until then a residual, now-contained leak remains.

Coding workers (`native`) *want* built-in Read/Shell/Write against the target repo — for them the
built-ins are the correct executor, not a leak. The policy is role-dependent.

## Tiering (token parity)

Tiering applies to the native `customTool` schemas. Resident tools keep their full JSON schema; the
long tail is registered with a terse `inputSchema` (`name(arg1, arg2?) — summary`). Modes:
`full` | `tiered` (default) | `brief`; resident set and tier are overridable per request / env
(`cursor_tool_tier`, `CURSOR_TOOL_RESIDENT`, `CURSOR_TOOL_TIER`). Filtering (toolsets / allow /
deny) still trims the set before schemas are built.

Tiering is load-bearing: on the 24-tool Hermes catalog the customTools map drops ~41% (≈4,849 →
≈2,857 est-tok). Untiered, native would be a ~59% regression vs the old tiered-marker inventory.

## A/B verdict

Live A/B (native customTools vs the old marker protocol): native is **token-cheaper** (~3.9% across
fixtures, never worse on any single one; tiering saving ~35–41% on the schema map), produced **zero
wrong-channel** events, and **did not regress capture** (including parallel N≥3). That cleared the
gate to delete the marker machinery and make native the only client-tool path.
