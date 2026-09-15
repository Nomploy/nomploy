#!/usr/bin/env bash
# Cut a nomploy release: bump the panel version, commit, tag, and push.
#
# Channel model (see .github/workflows/nomploy.yml): pushing to `main` only
# rebuilds the `:edge` image (rolling dev). `:latest` — what the panel self-
# updates from — moves ONLY when a version tag `vX.Y.Z` is pushed, which this
# script does. So production changes exactly when you cut a release, and the
# version the panel shows (apps/dokploy/package.json) is always a real release.
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
pkg="apps/dokploy/package.json"

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

# Bump the version the panel reports (packageInfo.version).
node -e "const f='${pkg}';const p=require('./'+f);p.version='${tag}';require('fs').writeFileSync(f, JSON.stringify(p,null,'\t')+'\n');"
echo "bumped ${pkg} -> ${tag}"

git add "$pkg"
git commit -m "release: ${tag}"
git tag -a "${tag}" -m "nomploy ${tag}"
git push origin main
git push origin "${tag}"

echo
echo "✅ Released ${tag}."
echo "   CI is building ghcr.io/nomploy/nomploy:${tag} + :latest (multi-arch)."
echo "   Once green, click Reload/Update in the panel to roll production to ${tag}."
