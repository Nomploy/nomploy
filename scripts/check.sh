#!/usr/bin/env bash
# Local equivalent of the CI Docker build's type-check — the ONLY reliable way to
# catch CI-only failures before pushing a release.
#
# Why `tsc --noEmit -p tsconfig.json` is NOT enough (bit us on v0.30.133/.135):
#   • CI builds via `pnpm --filter @nomploy/server build` = switch:prod (flips
#     package.json exports to dist) + rimraf dist + `tsc -p tsconfig.server.json`.
#   • tsc's incremental .tsbuildinfo cache hides errors in files it deems
#     unchanged; CI's `rimraf dist` is always cold.
#   • `noUncheckedIndexedAccess` (base tsconfig) makes `arr[i]` possibly-undefined
#     in the prod build — a common CI-only failure.
# So this runs the real cold prod build + the app type-check.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail=0

# ── GATE: the server prod build is the real CI enforcement (a hard `tsc` in the
# Docker build). This is what fails a release image build.
echo "▶ server prod build (switch:prod + cold tsc -p tsconfig.server.json)…"
if pnpm --filter @nomploy/server build >/tmp/nomploy-check-server.log 2>&1; then
  echo "  ✓ server prod build ok"
else
  echo "  ✗ server prod build FAILED:"
  grep -iE "error TS|error:" /tmp/nomploy-check-server.log | head -20
  fail=1
fi
# Always restore dev exports, even if the build failed (switch:prod left dist mode).
pnpm --filter @nomploy/server switch:dev >/dev/null 2>&1 || true

# ── GATE: the vitest suite (486+ tests; ~15s). Run with --config explicitly —
# there's no root vitest config, so a bare `vitest run` would skip the
# @nomploy/server alias and fail to resolve. Tests use src (dev exports), so run
# after switch:dev above.
echo "▶ tests (vitest run)…"
if (cd "$root/apps/dokploy" && pnpm exec vitest run --config __test__/vitest.config.ts) >/tmp/nomploy-check-test.log 2>&1; then
  echo "  ✓ tests passed ($(sed -E 's/\x1b\[[0-9;]*m//g' /tmp/nomploy-check-test.log | grep -oE 'Tests +[0-9]+ passed' | tail -1))"
else
  echo "  ✗ tests FAILED:"
  grep -iE "✗|×|FAIL |AssertionError|Error:|Tests +.*failed" /tmp/nomploy-check-test.log | head -20
  fail=1
fi

# ── INFO: the app (Next.js) build has `typescript.ignoreBuildErrors: true`, so CI
# does NOT type-check the app — these never fail a release. We still surface them
# (use `pnpm exec tsc`, NOT `npx tsc`: from the repo root npx resolves a stray
# placeholder "tsc" package that prints a joke and exits 0 → false "0 errors").
echo "▶ app type-check (informational — Next ignoreBuildErrors, not a release gate)…"
app_errs=$(cd "$root/apps/dokploy" && pnpm exec tsc --noEmit -p tsconfig.json 2>/dev/null | grep -c "error TS" || true)
if [ "${app_errs:-0}" = 0 ]; then
  echo "  ✓ app type-check clean"
else
  echo "  ⚠ app has ${app_errs} type error(s) (not blocking; run 'cd apps/dokploy && pnpm exec tsc --noEmit' to see them)"
fi

if [ "$fail" = 0 ]; then
  echo "✅ checks passed — safe to release"
else
  echo "❌ checks failed (server build or tests) — fix before releasing (CI would fail too)"
  exit 1
fi
