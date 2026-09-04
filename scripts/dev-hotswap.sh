#!/usr/bin/env bash
#
# Fast dev loop for the hub: build the changed package(s) locally (native, so no
# QEMU), then swap just the built JS into the already-running container and
# restart it. ~1-2 min vs the ~11 min GHCR CI + 4.7 GB image pull.
#
# Why this works: the build output (.next / dist) is portable JS — not
# arch-specific — so an arm64 Mac can produce exactly what the amd64 hub runs.
# Only native node_modules are arch-specific, and those are already baked into
# the container's image and never change unless package.json/lockfile change.
#
# Use the full CI image build (push to nomad -> :latest, or workflow_dispatch)
# when: dependencies changed, or you're cutting a real release.
#
# Usage:
#   scripts/dev-hotswap.sh              # build+swap both packages
#   scripts/dev-hotswap.sh server       # only @nomploy/server (packages/server)
#   scripts/dev-hotswap.sh dokploy      # only apps/dokploy (UI + app server)
#
# Env overrides: HUB=root@host  CONTAINER=nomploy
set -euo pipefail

HUB="${HUB:-root@2.29.43.0}"
CONTAINER="${CONTAINER:-nomploy}"
WHAT="${1:-all}"
cd "$(dirname "$0")/.."

sshh() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$HUB" "$@"; }

# The build script flips @nomploy/server's exports to ./dist (switch:prod);
# always flip them back to ./src so local typecheck/dev keeps working.
restore_dev_exports() { pnpm --filter=@nomploy/server switch:dev >/dev/null 2>&1 || true; }
trap restore_dev_exports EXIT

t0=$(date +%s)

if [[ "$WHAT" == "all" || "$WHAT" == "server" ]]; then
  echo "▶ build @nomploy/server (native)…"
  pnpm --filter=@nomploy/server build >/dev/null
fi
if [[ "$WHAT" == "all" || "$WHAT" == "dokploy" ]]; then
  echo "▶ build apps/dokploy (native)…"
  pnpm --filter=./apps/dokploy build >/dev/null
fi

# Replace a directory inside the container with a fresh local copy.
#   swap_dir <local-parent> <dir-name> <container-parent>
# Streams a tar over ssh; removes the stale target first so deleted files don't
# linger (docker cp merges, it doesn't prune).
swap_dir() {
  local lparent="$1" name="$2" cparent="$3"
  echo "  ↳ $name → $cparent/$name"
  sshh "docker exec '$CONTAINER' rm -rf '$cparent/$name'"
  tar -C "$lparent" -cf - "$name" | sshh "docker cp - '$CONTAINER:$cparent/'"
}

# Resolve the (hashed) @nomploy/server package dir inside the container.
if [[ "$WHAT" == "all" || "$WHAT" == "server" ]]; then
  PKG="$(sshh "docker exec '$CONTAINER' readlink -f /app/node_modules/@nomploy/server")"
  echo "▶ swap server dist…"
  swap_dir packages/server dist "$PKG"
fi
if [[ "$WHAT" == "all" || "$WHAT" == "dokploy" ]]; then
  echo "▶ swap dokploy build…"
  swap_dir apps/dokploy .next /app
  swap_dir apps/dokploy dist  /app
fi

echo "▶ restart + wait for health…"
sshh "docker restart '$CONTAINER' >/dev/null
  until [ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/trpc/settings.health)\" = 200 ]; do sleep 3; done
  echo '  ✅ healthy'"

echo "done in $(( $(date +%s) - t0 ))s"
