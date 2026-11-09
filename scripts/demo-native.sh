#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$PWD" == /workspace/GESTION-DE-CAISSE ]] || { echo 'Ce lanceur cible le checkout cloud /workspace/GESTION-DE-CAISSE.' >&2; exit 1; }
[[ "$(id -u)" == 1000 ]] || { echo 'Lancer sous le compte cloud agent (UID 1000).' >&2; exit 1; }
export CARGO_HOME=/workspace/.toolchains/caissepro/cargo
export RUSTUP_HOME=/workspace/.toolchains/caissepro/rustup
export PATH="$CARGO_HOME/bin:$PATH"
pnpm build
node scripts/demo.mjs prepare
docker build -t caissepro-native-demo:local tools/native
cargo fetch --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
docker run --rm --network none --user 1000:1000 \
 --mount type=bind,src=/workspace,dst=/workspace -w "$PWD" \
 -e CARGO_HOME -e RUSTUP_HOME \
 -e PATH=/workspace/.toolchains/caissepro/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
 -e CARGO_NET_OFFLINE=true -e CARGO_BUILD_JOBS=4 -e CARGO_PROFILE_DEV_DEBUG=0 \
 -e VITE_API_BASE_URL=http://127.0.0.1:3001 -e VITE_API_DEPLOYMENT_ID=caissepro-demo \
 caissepro-native-demo:local cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol
mkdir -p /workspace/scratch/caissepro-demo/home
if docker container inspect caissepro-demo-desktop >/dev/null 2>&1; then
 if [[ "$(docker inspect --format '{{.State.Running}}' caissepro-demo-desktop)" == true ]]; then
  echo 'Session native existante conservée.'
  exit 0
 fi
 exec docker start -a caissepro-demo-desktop
fi
node_path="$(readlink -f "$(command -v node)")"
exec docker run --rm --name caissepro-demo-desktop --network gestion-de-caisse_default --user 1000:1000 \
 --mount type=bind,src=/workspace,dst=/workspace \
 --mount "type=bind,src=$node_path,dst=/usr/local/bin/node,readonly" \
 -w "$PWD" -e LIBGL_ALWAYS_SOFTWARE=1 caissepro-native-demo:local bash tools/native/run-demo.sh
