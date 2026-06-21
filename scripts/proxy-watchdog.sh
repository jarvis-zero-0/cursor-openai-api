#!/bin/bash
# composer-proxy readiness watchdog
#
# Why this exists: launchd KeepAlive only restarts the proxy when the PROCESS
# exits. It cannot detect a "wedge" — a live process that holds port 8080 open
# but fails every completion (e.g. stale Cursor auth -> 502 "Agent run failed").
# This probe does a REAL completion request and recycles the proxy on failure,
# then alerts via `hermes send` (no gateway required for bot-token platforms).
#
# Scheduled by launchd unit ai.hermes.proxy.watchdog (StartInterval=300).
# Legacy label com.composer-proxy.watchdog is retired — unload if still loaded.
# A watchdog must live OUTSIDE the thing it watches, so this is host-level
# (launchd), not a Hermes cron job (which runs inside the gateway).

set -uo pipefail

# Externals are env-overridable (with the production defaults below) purely so
# the logic can be exercised by test/proxy-watchdog.test.sh with stubbed
# curl/launchctl/hermes; unset, the behavior is identical to before.
HERMES_HOME="${HERMES_HOME:-/Users/jarvis/hermes/.hermes}"
HERMES_BIN="${HERMES_BIN:-${HERMES_HOME}/hermes-agent/venv/bin/hermes}"
LOG="${WATCHDOG_LOG:-${HERMES_HOME}/logs/composer-proxy-watchdog.log}"
STATE="${WATCHDOG_STATE:-${HERMES_HOME}/cache/composer-proxy-watchdog.state}"
SERVICE="${WATCHDOG_SERVICE:-ai.hermes.proxy.server}"
# Migration fallback: hosts still on the old label (without WATCHDOG_SERVICE set)
# would otherwise hit the same `Could not find service … 501` kickstart failure
# that caused the 2026-06-21 outage. If the configured SERVICE isn't loaded we
# retry the kickstart against this legacy label before declaring DOWN.
LEGACY_SERVICE="${WATCHDOG_LEGACY_SERVICE:-com.composer-proxy.server}"
UID_NUM="$(id -u)"
PROBE_URL="${WATCHDOG_PROBE_URL:-http://127.0.0.1:8080/v1/chat/completions}"
CONFIRM_DELAY="${WATCHDOG_CONFIRM_DELAY:-5}"
KICKSTART_DELAY="${WATCHDOG_KICKSTART_DELAY:-10}"
PROBE_BODY='{"model":"composer-2.5-fast","messages":[{"role":"user","content":"healthcheck: reply ok"}],"max_tokens":16}'

ts() { date "+%Y-%m-%dT%H:%M:%S%z"; }
log() { echo "$(ts) $*" >> "$LOG"; }

# Healthy = HTTP 200 AND the body carries a non-empty assistant message.
# We parse the response (jq when present, substring fallback otherwise) instead
# of a naive `!= *'"error"'*` substring so a completion whose CONTENT merely
# contains the word "error" isn't misread as a failure.
probe() {
  local raw http_code body
  raw="$(curl -s -m 45 -w '\n%{http_code}' "$PROBE_URL" \
    -H 'Content-Type: application/json' -d "$PROBE_BODY" 2>/dev/null)"
  http_code="${raw##*$'\n'}"
  body="${raw%$'\n'*}"
  [[ "$http_code" == "200" ]] || return 1
  if command -v jq >/dev/null 2>&1; then
    local content
    content="$(printf '%s' "$body" | jq -r '.choices[0].message.content // empty' 2>/dev/null)"
    [[ -n "$content" ]]
  else
    [[ "$body" == *'"choices"'* && "$body" != *'"error"'* ]]
  fi
}

# Confirm a wedge with a second probe after a brief pause: returns success
# (unhealthy confirmed) only when this follow-up probe ALSO fails, so it takes
# two consecutive failures to declare a wedge. A single transient blip (one
# slow/timed-out completion on an otherwise healthy proxy) must not trigger a
# restart that nukes every cached session and pages a human.
confirm_unhealthy() {
  sleep "$CONFIRM_DELAY"
  probe && return 1
  return 0
}

alert() {
  "$HERMES_BIN" send --quiet --to telegram --subject "[proxy-watchdog]" "$1" \
    >> "$LOG" 2>&1 || log "WARN alert delivery failed"
}

prev_state="ok"
[[ -f "$STATE" ]] && prev_state="$(cat "$STATE" 2>/dev/null || echo ok)"

if probe; then
  [[ "$prev_state" != "ok" ]] && { log "RECOVERED proxy healthy again"; alert "Proxy recovered — completions healthy on :8080."; }
  log "OK proxy healthy"
  echo "ok" > "$STATE"
  exit 0
fi

# First probe failed — confirm with a second probe before recycling, so a single
# transient failure doesn't cause a needless restart + page.
if ! confirm_unhealthy; then
  log "OK proxy healthy on confirm probe (first probe was a transient blip)"
  echo "ok" > "$STATE"
  exit 0
fi

# Kickstart one launchd label; logs and returns launchctl's exit code so the
# caller can fall back to the legacy label when the service isn't loaded.
kickstart_service() {
  local svc="$1" out rc
  out="$(launchctl kickstart -k "gui/${UID_NUM}/${svc}" 2>&1)"; rc=$?
  [[ -n "$out" ]] && log "kickstart $svc: $out"
  return "$rc"
}

# Confirmed unhealthy: recycle and re-probe once. Try the configured SERVICE
# first; if that label isn't loaded (the 501 "Could not find service" case from a
# mid-rename host), fall back to the legacy label before giving up.
log "UNHEALTHY two consecutive probes failed — kickstarting $SERVICE"
if ! kickstart_service "$SERVICE" && [[ "$LEGACY_SERVICE" != "$SERVICE" ]]; then
  log "kickstart of $SERVICE failed — falling back to legacy label $LEGACY_SERVICE"
  kickstart_service "$LEGACY_SERVICE"
fi
sleep "$KICKSTART_DELAY"

if probe; then
  log "RESTARTED proxy recovered after kickstart"
  alert "Proxy was wedged (failing completions) and was auto-restarted. Healthy again now."
  echo "ok" > "$STATE"
  exit 0
fi

log "DOWN proxy still failing after kickstart"
# Only page once per outage (on the ok->down transition), not every 5 min.
[[ "$prev_state" != "down" ]] && alert "Proxy STILL DOWN after auto-restart — needs a human. Check /tmp/composer-proxy.log."
echo "down" > "$STATE"
exit 1
