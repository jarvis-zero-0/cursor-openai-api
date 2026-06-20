# cursor-openai-api — agent guide

OpenAI-compatible proxy that spawns Cursor SDK agents. Part of the Hermes execution plane.

## Read first

1. [`README.md`](./README.md) — install, env vars, streaming, sessions
2. [`../.hermes/AGENTS.md`](../.hermes/AGENTS.md) — Hermes methodology (SOUL, diary, kanban, session boundaries)
3. [`~/hermes/.hermes/SOUL.md`](../.hermes/SOUL.md) — persona & orchestration (authoritative)

## This repo

| Concern | Where |
|---------|-------|
| Proxy source | `src/` (Bun/TypeScript) |
| Hermes consumer | `~/hermes/.hermes/hermes-agent` → [`../.hermes/hermes-agent/`](../.hermes/hermes-agent/) |
| Default listen | `:8080` |
| Workspace cwd | `CURSOR_CWD` env (set by Hermes or launchd) |

## Agent posture here

- Prefer **minimal diffs** — this bridge is load-bearing for all Cursor-backed turns.
- Do not commit secrets (`CURSOR_API_KEY`, `AUTH_KEY`).
- After config changes, verify proxy health (`curl` `/v1/models` or check launchd logs) before declaring done.
- For Hermes-wide journal/kanban rules, follow [`../.hermes/AGENTS.md`](../.hermes/AGENTS.md); do not duplicate SOUL.md routing policy here.
