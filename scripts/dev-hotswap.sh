#!/usr/bin/env bash
#
# Fast dev loop for the hub: build the changed package(s) locally (native, so no
# QEMU), swap just the built JS into the running panel container, then bake that
# into a local image and re-run the panel's Nomad job so the change persists.
# ~2 min vs the ~11 min GHCR CI + multi-GB image pull.
#
# Why this works: the build output (.next / dist) is portable JS — not
# arch-specific — so an arm64 Mac can produce exactly what the amd64 hub runs.
# Only native node_modules are arch-specific, and those are already baked into
# the container's image and never change unless package.json/lockfile change.
#
# IMPORTANT — the panel runs as a Nomad JOB, not `docker run`. A plain
# `docker restart` makes Nomad treat the task as failed and RESCHEDULE it,
# recreating the container from the image and discarding every `docker cp`'d
# file (you'd silently get the old code back). So instead we `docker commit` the
# hot-swapped container to a local `:hotswap` tag and re-register the job at that
# tag with force_pull=false — the new code is now baked into the image the alloc
# runs, and survives reschedules.
#
# CAVEAT: this repoints the panel job to the local `:hotswap` image. Clicking
# Reload/Update in the UI (or any re-submit of the job with the real image)
# reverts to ghcr.io/nomploy/nomploy:latest with force_pull — i.e. back to the
# released code. That's the intended release path; use the full CI build (push
# to main, or workflow_dispatch) when you actually want to ship.
#
# Usage:
#   scripts/dev-hotswap.sh              # build+swap both packages
#   scripts/dev-hotswap.sh server       # only @nomploy/server (packages/server)
#   scripts/dev-hotswap.sh dokploy      # only apps/dokploy (UI + app server)
#
# Env overrides:
#   HUB=root@host          ssh target (default root@2.29.43.0)
#   CONTAINER=name         panel container (default: auto-detected nomploy-<allocId>)
#   JOB=nomploy            Nomad job name (default nomploy)
#   HOTSWAP_TAG=…          local image tag to commit to (default :hotswap)
set -euo pipefail

HUB="${HUB:-root@2.29.43.0}"
JOB="${JOB:-nomploy}"
HOTSWAP_TAG="${HOTSWAP_TAG:-ghcr.io/nomploy/nomploy:hotswap}"
WHAT="${1:-all}"
cd "$(dirname "$0")/.."

sshh() { ssh -o BatchMode=yes -o ConnectTimeout=25 "$HUB" "$@"; }

# The panel container is nomploy-<allocId> (a Nomad alloc), not "nomploy".
# Auto-detect the running one unless the caller pinned CONTAINER explicitly.
CONTAINER="${CONTAINER:-}"
if [[ -z "$CONTAINER" ]]; then
  CONTAINER="$(sshh "docker ps --format '{{.Names}}' | grep -E '^nomploy-[0-9a-f]{8}' | head -1")"
  [[ -z "$CONTAINER" ]] && { echo "✖ no running nomploy-<allocId> container found on $HUB" >&2; exit 1; }
fi
echo "▶ panel container: $CONTAINER"

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
#   swap_dir <local-parent> <dir-name> <container-parent> [tar-excludes…]
# Streams a tar over ssh; removes the stale target first so deleted files don't
# linger (docker cp merges, it doesn't prune).
swap_dir() {
  local lparent="$1" name="$2" cparent="$3"
  shift 3
  local excludes=()
  local e
  for e in "$@"; do excludes+=(--exclude "$e"); done
  echo "  ↳ $name → $cparent/$name"
  sshh "docker exec '$CONTAINER' rm -rf '$cparent/$name'"
  # --no-xattrs / --no-mac-metadata: macOS bsdtar otherwise embeds the
  # com.apple.provenance xattr, which `docker cp -` rejects (lsetxattr … not
  # supported) on the Linux hub.
  tar --no-xattrs --no-mac-metadata "${excludes[@]}" -C "$lparent" -cf - "$name" \
    | sshh "docker cp - '$CONTAINER:$cparent/'"
}

# Resolve the (hashed) @nomploy/server package dir inside the container.
if [[ "$WHAT" == "all" || "$WHAT" == "server" ]]; then
  PKG="$(sshh "docker exec '$CONTAINER' readlink -f /app/node_modules/@nomploy/server")"
  echo "▶ swap server dist…"
  swap_dir packages/server dist "$PKG"
fi
if [[ "$WHAT" == "all" || "$WHAT" == "dokploy" ]]; then
  echo "▶ swap dokploy build…"
  # .next/cache (webpack/build cache) and .next/dev (dev-server artifacts left by
  # `pnpm dev`, can be 2+ GB) are NOT needed by the production server — only
  # .next/server, .next/static and the manifests are. Skipping them cuts the
  # upload from gigabytes to tens of MB (critical on a slow uplink / small hub).
  swap_dir apps/dokploy .next /app cache dev
  swap_dir apps/dokploy dist  /app
fi

# Re-point the panel Nomad job to an image with force_pull, bumping meta so a new
# alloc is forced. Used for both the hot-swap deploy and the safety rollback.
#   repoint_job <image> <force_pull true|false>
repoint_job() {
  sshh "JOB='$JOB' IMG='$1' FP='$2' python3 - <<'PY'
import json, os, time, urllib.request
base = os.environ.get('NOMAD_ADDR', 'http://127.0.0.1:4646') + '/v1'
job = json.load(urllib.request.urlopen(base + '/job/' + os.environ['JOB']))
task = job['TaskGroups'][0]['Tasks'][0]
task['Config']['image'] = os.environ['IMG']
task['Config']['force_pull'] = os.environ['FP'] == 'true'
job.setdefault('Meta', {})['deployed_at'] = 'hotswap-' + str(int(time.time()))
req = urllib.request.Request(base + '/jobs',
    data=json.dumps({'Job': job}).encode(),
    headers={'Content-Type': 'application/json'}, method='POST')
print('  eval', json.load(urllib.request.urlopen(req)).get('EvalID', '?'))
PY"
}

# Wait up to ~$1 seconds for the panel health endpoint to return 200.
wait_healthy() {
  sshh "for i in \$(seq 1 $(( $1 / 3 ))); do
    [ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/trpc/settings.health)\" = 200 ] && exit 0
    sleep 3
  done; exit 1"
}

echo "▶ commit $CONTAINER → $HOTSWAP_TAG + re-run Nomad job '$JOB'…"
sshh "docker commit '$CONTAINER' '$HOTSWAP_TAG' >/dev/null"
# Safety: verify the committed image is actually present before we point the job
# at it with force_pull=false — otherwise a failed commit + a missing local tag
# would make Nomad try to PULL a tag that only exists locally (→ panel down).
sshh "docker image inspect '$HOTSWAP_TAG' >/dev/null 2>&1" || {
  echo "✖ commit did not produce $HOTSWAP_TAG locally — aborting without touching the job" >&2
  exit 1
}
repoint_job "$HOTSWAP_TAG" false

echo "▶ wait for health (auto-rollback to :latest on failure)…"
if wait_healthy 120; then
  echo "  ✅ healthy on $HOTSWAP_TAG"
  echo "done in $(( $(date +%s) - t0 ))s"
  echo "note: panel now runs $HOTSWAP_TAG; UI Reload/Update reverts it to :latest."
else
  # The committed image can be reclaimed by Nomad's docker image GC / disk
  # pressure on a small hub; force_pull=false then fails to find the local tag.
  # Self-heal so a bad hot-swap never leaves the panel down.
  echo "✖ panel did not become healthy on $HOTSWAP_TAG — rolling back to :latest" >&2
  repoint_job "ghcr.io/nomploy/nomploy:latest" true
  wait_healthy 240 && echo "  ↩ rolled back, panel healthy on :latest" || \
    echo "  ✖ rollback also unhealthy — check 'nomad alloc status' on the hub" >&2
  exit 1
fi
