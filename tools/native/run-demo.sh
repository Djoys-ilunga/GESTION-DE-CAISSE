#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /workspace/GESTION-DE-CAISSE
export HOME=/workspace/scratch/caissepro-demo/home
export DISPLAY=:99
mkdir -p "$HOME" native-test-results
# A stopped container can retain the socket/lock from its own previous display.
if ! xdotool getdisplaygeometry >/dev/null 2>&1; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
fi
Xvfb :99 -screen 0 1440x1100x24 -nolisten tcp >native-test-results/display.log 2>&1 &
display_pid=$!
CAISSEPRO_DEMO_DB_HOST=postgres node scripts/demo.mjs start >native-test-results/demo-api.log 2>&1 &
api_pid=$!
trap 'kill "$api_pid" "$display_pid" 2>/dev/null || true' EXIT
for attempt in {1..40}; do
  if node -e 'fetch("http://127.0.0.1:3001/api/v1/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then break; fi
  sleep 0.25
done
cc -Wall -Wextra -Werror tests/native/capture-window.c -o /workspace/scratch/caissepro-demo/capture-window $(pkg-config --cflags --libs gtk+-3.0) -lX11
# Use the native WebKit sandbox; no browser or IPC security is disabled.
dbus-run-session -- apps/desktop/src-tauri/target/debug/caissepro-desktop >native-test-results/demo-application.log 2>&1 &
app_pid=$!
/workspace/scratch/caissepro-demo/capture-window native-test-results/demo-login.png
wait "$app_pid"
