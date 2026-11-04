#!/usr/bin/env bash
set -euo pipefail
umask 077

native_test_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
native_binary="$native_test_root/apps/desktop/src-tauri/target/debug/caissepro-desktop"
native_artifacts="${CAISSEPRO_NATIVE_ARTIFACTS:-$native_test_root/native-test-results}"
mkdir -p "$native_artifacts"

if [[ "${1:-}" != --inside-display ]]; then
  [[ -x "$native_binary" ]] || { echo 'Compiler le desktop avec custom-protocol avant ce contrôle.' >&2; exit 1; }
  # Les options proviennent exclusivement du pkg-config système, sans entrée utilisateur.
  cc -Wall -Wextra -Werror "$native_test_root/tests/native/capture-window.c" -o "$native_artifacts/capture-window" $(pkg-config --cflags --libs gtk+-3.0) -lX11
  exec xvfb-run -a -s '-screen 0 1440x1100x24' dbus-run-session -- bash "$0" --inside-display
fi

"$native_binary" >"$native_artifacts/application.log" 2>&1 &
native_app_pid=$!
native_cleanup() {
  if kill -0 "$native_app_pid" 2>/dev/null; then kill -TERM "$native_app_pid"; fi
  wait "$native_app_pid" 2>/dev/null || true
}
trap native_cleanup EXIT
"$native_artifacts/capture-window" "$native_artifacts/caissepro-native.png"
kill -0 "$native_app_pid"
echo 'CAISSEPRO_NATIVE_SMOKE_PASSED'
