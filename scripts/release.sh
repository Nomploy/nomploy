#!/usr/bin/env bash
# Cut a nomploy release: tag the current main and push (no version-file bump).
#
# Channel model (see .github/workflows/nomploy.yml): pushing to `main` only
# rebuilds the `:edge` image (rolling dev). `:latest` — what the panel self-
# updates from — moves ONLY when a version tag `vX.Y.Z` is pushed, which this
# script does. So production changes exactly when you cut a release, and the
# version the panel reports is baked from this tag by CI (NOMPLOY_VERSION build
# arg), not stored in package.json — see the commit step below for why.
#
# Usage:  scripts/release.sh 0.30.0        # -> tag v0.30.0, image :v0.30.0 + :latest
#         scripts/release.sh v0.30.0       # 'v' optional
set -euo pipefail

raw="${1:-}"
if [[ -z "$raw" ]]; then
  echo "usage: scripts/release.sh <version>   e.g. scripts/release.sh 0.30.0" >&2
  exit 1
fi
ver="${raw#v}"                     # strip a leading v if present
if [[ ! "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]]; then
  echo "error: '$ver' is not a semver (e.g. 0.30.0)" >&2
  exit 1
fi
tag="v${ver}"

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# Must be on main with a clean tree — releases come off the curated main branch.
branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" ]]; then
  echo "error: releases are cut from 'main' (you are on '$branch'). Checkout main first." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree not clean — commit or stash first." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  echo "error: tag ${tag} already exists." >&2
  exit 1
fi

# No version bump: the panel version is baked from this tag by CI
# (--build-arg NOMPLOY_VERSION, see nomploy.yml + server/nomploy-version.ts).
# Bumping package.json used to change the file COPY'd before `pnpm install`,
# busting that Docker cache layer and forcing a near-cold build every release.
#
# Instead push an EMPTY "release:" marker commit: CI's `setup` guard skips the
# redundant main/:edge build for "release:" commits, so the tag build (:latest +
# :vX.Y.Z) is the ONLY build that runs — one build per release. The empty commit
# shares its parent's tree, so it doesn't invalidate any Docker layer either.
git commit --allow-empty -m "release: ${tag}"
git tag -a "${tag}" -m "nomploy ${tag}"
git push origin main
git push origin "${tag}"

echo
echo "✅ Released ${tag}."
echo "   CI is building ghcr.io/nomploy/nomploy:${tag} + :latest (amd64)."
echo "   Once green, click Reload/Update in the panel to roll production to ${tag}."
