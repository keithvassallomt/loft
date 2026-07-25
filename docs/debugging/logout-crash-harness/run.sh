#!/bin/bash
# Reproduce the Flatpak logout topology: the app's bus dies in the SAME signal delivery
# that terminates the app, not ~940ms later.
#   $1 = HARNESS_MODE (none | fastexit)
#   $2 = ms to wait after SIGTERM before killing the bus (0 = truly simultaneous)
MODE=$1; BUS_DELAY_MS=${2:-0}
cd "$(dirname "$0")"
EL=/home/keith/LocalCode/keithvassallomt/loft/node_modules/electron/dist/electron

# Private session bus, standing in for xdg-dbus-proxy.
eval "$(dbus-daemon --session --print-address=1 --print-pid=1 --fork | { read -r a; read -r p; echo "ADDR=$a; BUSPID=$p"; })"

env -u ELECTRON_RUN_AS_NODE DBUS_SESSION_BUS_ADDRESS="$ADDR" "$EL" . >out.log 2>&1 &
APP=$!

for _ in $(seq 1 100); do grep -q "ready pid=" out.log 2>/dev/null && break; sleep 0.1; done
grep -q "ready pid=" out.log || { echo "RESULT=$MODE: app never became ready"; kill -9 $APP $BUSPID 2>/dev/null; exit 1; }

# The teardown, as systemd does it: one signal to everything in the cgroup.
kill -TERM $APP 2>/dev/null
[ "$BUS_DELAY_MS" -gt 0 ] && sleep "$(echo "scale=3; $BUS_DELAY_MS/1000" | bc)"
kill -9 $BUSPID 2>/dev/null          # the proxy has no teardown work; it just goes

wait $APP; RC=$?
kill -9 $BUSPID 2>/dev/null
SIG=$((RC-128))
case $RC in
  0) VERDICT="CLEAN EXIT 0" ;;
  133) VERDICT="*** SIGTRAP (5) — Chromium abort, coredump, 'Electron crashed' ***" ;;
  *) VERDICT="exit rc=$RC (signal $SIG)" ;;
esac
echo "RESULT mode=$MODE busDelay=${BUS_DELAY_MS}ms -> $VERDICT"
grep -E "FATAL|SIGTERM handler" out.log | sed 's/^/    /'
