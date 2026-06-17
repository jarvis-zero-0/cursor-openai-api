# Handoff Recovery - Hermes x Cursor Proxy (2026-06-16)

This refreshes the orchestration handoff with facts verified directly from disk in this harness.

## Verified now

- Multi-root workspace exists at `/Users/jarvis/code/hermes.code-workspace` and includes:
  - `/Users/jarvis/.hermes`
  - `/Users/jarvis/cursor-openai-api`
- Proxy env currently pins workspace indexing:
  - `CURSOR_CWD=/Users/jarvis/code/hermes.code-workspace`
  - `CURSOR_CWD_ALLOWLIST=/Users/jarvis/.hermes,/Users/jarvis/cursor-openai-api,/Users/jarvis/code`
- Hermes provider config is still client-mode on main thread:
  - `providers.cursor.extra_body.cursor_tool_mode: client` in `/Users/jarvis/.hermes/config.yaml`
- Delegated leaves are wired to flip into native mode with workspace cwd:
  - `/Users/jarvis/.hermes/hermes-agent/tools/delegate_tool.py` sets `cursor_tool_mode` to `native`
  - same block sets default `cursor_cwd` to `_CURSOR_NATIVE_WORKSPACE`
  - `_CURSOR_NATIVE_WORKSPACE` defaults to `/Users/jarvis/code/hermes.code-workspace` (overridable by `HERMES_CURSOR_NATIVE_CWD`)
- Conditional deference rules are present in both roots:
  - `/Users/jarvis/.hermes/AGENTS.md`
  - `/Users/jarvis/.hermes/.cursorrules`
  - `/Users/jarvis/cursor-openai-api/AGENTS.md`
  - `/Users/jarvis/cursor-openai-api/.cursorrules`
- Proxy handoff contract artifacts exist:
  - `/Users/jarvis/cursor-openai-api/src/client-tools/handoff.ts`
  - `/Users/jarvis/cursor-openai-api/docs/subagent-handoff-contract.md`
- Backlog items still open:
  - `/Users/jarvis/.hermes/jarvis-diary/todos/backlog.md` includes:
    - restart proxy after local changes
    - wire Hermes `cursor_tool_mode` client/native (likely stale, needs e2e verification)

## Not verifiable from this harness (important)

- Top-level git metadata is missing at `/Users/jarvis/cursor-openai-api` in this environment:
  - no top-level `.git` directory/file
  - `git status` / `git log` / `git diff` all fail with "not a git repository"
- Because of that, these claims cannot be re-verified here and must be treated as unconfirmed until run in a checkout with git metadata:
  - "10 commits ahead of origin/master"
  - "617 lines across 12 tracked files"
  - exact committed/uncommitted split relative to upstream

## Delta vs previous draft

- Core architecture and wiring claims are still consistent with the code and config on disk.
- The one material mismatch is git-state certainty: previous commit-ahead numbers are not currently reproducible from this harness.

## Replacement orchestrator task list

### Phase 0 - context + transcript recovery

- [ ] Pull prior orchestration session context from transcript store and session search.
- [ ] Reconcile this handoff with latest operator notes in:
  - `/Users/jarvis/.hermes/jarvis-diary/INDEX.md`
  - `/Users/jarvis/.hermes/jarvis-diary/learnings/2026-06-15-cursor-proxy-tool-routing.md`

### Phase 1 - re-establish git truth in a real checkout

- [ ] In a checkout that has `.git`, run:
  - `git status --short --branch`
  - `git log --oneline origin/master..HEAD`
  - `git diff --stat origin/master...HEAD`
  - `git diff --stat HEAD`
- [ ] Confirm base SHA and actual ahead/dirty counts before any new edits.

### Phase 2 - orchestration cleanup

- [ ] Audit for duplicate/conflicting prompt directives across:
  - `src/client-tools/prompt.ts`
  - `src/prompt.ts`
  - root `AGENTS.md` + `.cursorrules` in both workspace roots
- [ ] Validate handoff schema behavior in live delegated native leaves.
- [ ] Resolve stale backlog item if wiring is already complete.

### Phase 3 - verification

- [ ] Restart proxy and verify startup behavior with workspace cwd.
- [ ] Run proxy tests.
- [ ] Live e2e: Hermes main (client) -> delegate_task -> native leaf, then validate:
  - native SDK tools are used
  - workspace indexing spans both roots
  - exactly one trailing handoff JSON block is returned and parsable

## Worker template

Use one focused objective per delegated worker. Keep fresh context per worker and require structured handoff output.

```python
delegate_task(
  goal="<single objective>",
  context="""
Workspace: /Users/jarvis/code/hermes.code-workspace
Proxy repo: /Users/jarvis/cursor-openai-api
Hermes home: /Users/jarvis/.hermes

You are a native leaf (cursor_tool_mode=native).
Ignore client marker-protocol channels; use Cursor SDK native tools.
End with human summary + exactly one handoff JSON block.
  """,
  model="claude-opus-4-8",
  reasoning_effort="high",
  toolsets=["terminal", "file"],
)
```

## Transcript anchors

- Current handoff request: `6c441cfe-6b2d-4874-aeb5-cef61b090a50`
- Native workspace-root probe run: `agent-1c279563-7df1-4ae9-bc59-d834f198cc13`

