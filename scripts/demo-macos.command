#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  echo "Installez Node.js 24 LTS, puis relancez cette commande. Voir docs/demonstration-macos.md."
  exit 1
fi
exec node scripts/demo-macos.mjs "$@"
