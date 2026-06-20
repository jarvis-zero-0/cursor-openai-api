#!/bin/bash
# Behavioral test for scripts/proxy-watchdog.sh with stubbed curl/launchctl/hermes.
# Asserts: a healthy probe never restarts; a body whose CONTENT contains "error"
# is still healthy; a single transient failure does NOT restart (two-probe
# confirm); two consecutive failures DO restart + alert; a persistent outage
# pages once on ok->down.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCHDOG="$SCRIPT_DIR/scripts/proxy-watchdog.sh"
PASS=0
FAIL=0

ok()  { echo "ok   - $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL - $1"; FAIL=$((FAIL+1)); }

# Run the watchdog once against a scripted sequence of curl responses.
# $1 = label, $2 = file with one "CODE<TAB>BODY" line per curl call,
# $3 = initial state ("ok"/"down"/"").
run_case() {
  local stubdir; stubdir="$(mktemp -d)"
  cp "$2" "$stubdir/curl_responses"
  : > "$stubdir/curl_n"
  : > "$stubdir/launchctl.calls"
  : > "$stubdir/hermes.calls"

  cat > "$stubdir/curl" <<'STUB'
#!/bin/bash
n_file="$STUB_STATE/curl_n"; n=0; [[ -s "$n_file" ]] && n=$(cat "$n_file")
n=$((n+1)); echo "$n" > "$n_file"
line=$(sed -n "${n}p" "$STUB_STATE/curl_responses")
code="${line%%	*}"; body="${line#*	}"
printf '%s\n%s' "$body" "$code"
STUB
  cat > "$stubdir/launchctl" <<'STUB'
#!/bin/bash
echo "$*" >> "$STUB_STATE/launchctl.calls"
STUB
  cat > "$stubdir/hermes" <<'STUB'
#!/bin/bash
echo "$*" >> "$STUB_STATE/hermes.calls"
STUB
  chmod +x "$stubdir/curl" "$stubdir/launchctl" "$stubdir/hermes"

  local statefile="$stubdir/state"
  [[ -n "$3" ]] && echo "$3" > "$statefile"

  STUB_STATE="$stubdir" \
  PATH="$stubdir:$PATH" \
  HERMES_BIN="$stubdir/hermes" \
  WATCHDOG_LOG="$stubdir/log" \
  WATCHDOG_STATE="$statefile" \
  WATCHDOG_PROBE_URL="http://stub/v1/chat/completions" \
  WATCHDOG_CONFIRM_DELAY=0 \
  WATCHDOG_KICKSTART_DELAY=0 \
    bash "$WATCHDOG" >/dev/null 2>&1
  echo $? > "$stubdir/exit"

  LAST_STUBDIR="$stubdir"
}

kickstarts() { wc -l < "$LAST_STUBDIR/launchctl.calls" | tr -d ' '; }
alerts()     { wc -l < "$LAST_STUBDIR/hermes.calls" | tr -d ' '; }
state()      { cat "$LAST_STUBDIR/state" 2>/dev/null; }

healthy_body='200	{"choices":[{"message":{"content":"ok"}}]}'
# Valid completion whose content text happens to contain the word "error".
errorword_body='200	{"choices":[{"message":{"content":"no error here, all good"}}]}'
fail_body='502	{"error":{"message":"Agent run failed"}}'

# 1. Healthy: one probe, no restart, no page.
printf '%s\n' "$healthy_body" > /tmp/wd_r1; run_case "healthy" /tmp/wd_r1 "ok"
[[ "$(kickstarts)" == "0" ]] && ok "healthy: no kickstart" || bad "healthy: kickstarted ($(kickstarts))"
[[ "$(alerts)" == "0" ]] && ok "healthy: no alert" || bad "healthy: alerted"
[[ "$(state)" == "ok" ]] && ok "healthy: state ok" || bad "healthy: state=$(state)"

# 2. Content contains "error" but is a valid 200 completion -> healthy.
printf '%s\n' "$errorword_body" > /tmp/wd_r2; run_case "errorword" /tmp/wd_r2 "ok"
[[ "$(kickstarts)" == "0" ]] && ok "error-word content: not misread as wedge" || bad "error-word content: false restart"

# 3. Transient blip: first probe fails, confirm probe succeeds -> NO restart.
printf '%s\n%s\n' "$fail_body" "$healthy_body" > /tmp/wd_r3; run_case "transient" /tmp/wd_r3 "ok"
[[ "$(kickstarts)" == "0" ]] && ok "transient: single failure does not restart" || bad "transient: restarted on one failure"
[[ "$(alerts)" == "0" ]] && ok "transient: no page" || bad "transient: paged on blip"
[[ "$(state)" == "ok" ]] && ok "transient: state stays ok" || bad "transient: state=$(state)"

# 4. Real wedge that recovers: probe fail, confirm fail -> kickstart -> probe ok.
printf '%s\n%s\n%s\n' "$fail_body" "$fail_body" "$healthy_body" > /tmp/wd_r4
run_case "wedge-recovers" /tmp/wd_r4 "ok"
[[ "$(kickstarts)" == "1" ]] && ok "wedge: kickstarted once" || bad "wedge: kickstarts=$(kickstarts)"
[[ "$(alerts)" == "1" ]] && ok "wedge: one recovery alert" || bad "wedge: alerts=$(alerts)"
[[ "$(state)" == "ok" ]] && ok "wedge: recovered to ok" || bad "wedge: state=$(state)"

# 5. Persistent outage from ok: fail, fail, (kickstart) fail -> down + one page.
printf '%s\n%s\n%s\n' "$fail_body" "$fail_body" "$fail_body" > /tmp/wd_r5
run_case "down" /tmp/wd_r5 "ok"
[[ "$(kickstarts)" == "1" ]] && ok "down: kickstarted once" || bad "down: kickstarts=$(kickstarts)"
[[ "$(alerts)" == "1" ]] && ok "down: paged once on ok->down" || bad "down: alerts=$(alerts)"
[[ "$(state)" == "down" ]] && ok "down: state down" || bad "down: state=$(state)"

echo "---"
echo "watchdog: $PASS passed, $FAIL failed"
[[ "$FAIL" == "0" ]]
