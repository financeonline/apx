#!/usr/bin/env bash
# Step 0–0C validation on a developer machine with Docker (Docker Desktop, OrbStack or Colima).
# The same gates as .github/workflows/validate-step0.yml, against LOCAL Supabase only.
#
#   scripts/validate-step0.sh            # clean database: every suite
#   scripts/validate-step0.sh upgrade    # baseline migrations, then the new ones as an upgrade
#   scripts/validate-step0.sh compare    # the 27-organisation engine comparison
#
# WARNING: `supabase db reset` / `stop --no-backup` wipe the LOCAL stack's data. Never point this at
# a hosted project; write-local-env.sh refuses any URL that is not 127.0.0.1/localhost.
set -euo pipefail
BASELINE="${BASELINE:-2783240}"
cd "$(dirname "$0")/.."
export SUPABASE="npx --no-install supabase"
command -v docker >/dev/null || { echo "Docker is required (Docker Desktop, OrbStack or Colima)." >&2; exit 1; }

case "${1:-clean}" in
  clean)
    npm run typecheck && npm run lint
    npx vitest run --project unit --coverage
    npm run ai:eval
    npx supabase start
    npx supabase db reset
    npx supabase test db
    npx tsx scripts/check-schema-drift.ts
    scripts/write-local-env.sh
    npm run test:integration
    npm run build
    npx playwright install chromium
    npx playwright test
    ;;
  upgrade)
    tmp="$(mktemp -d)"
    git diff --name-only --diff-filter=A "$BASELINE" -- supabase/migrations | xargs -I{} mv {} "$tmp/"
    trap 'mv "$tmp"/*.sql supabase/migrations/ 2>/dev/null || true' EXIT
    npx supabase start && npx supabase db reset          # the baseline's schema
    scripts/write-local-env.sh
    git worktree add -f "$tmp/baseline" "$BASELINE" && cp .env.local "$tmp/baseline/" && ln -s "$PWD/node_modules" "$tmp/baseline/node_modules"
    (cd "$tmp/baseline" && npx vitest run --project integration test/integration/engine-end-to-end.test.ts)
    git worktree remove --force "$tmp/baseline"
    mv "$tmp"/*.sql supabase/migrations/
    npx supabase migration up                            # the upgrade
    npx supabase test db
    npx tsx scripts/check-schema-drift.ts
    npm run test:integration
    ;;
  compare)
    out="$PWD/compare"; mkdir -p "$out"
    tmp="$(mktemp -d)"; git worktree add -f "$tmp/baseline" "$BASELINE"
    (cd "$tmp/baseline" && npm ci && npx supabase db reset && "$OLDPWD/scripts/write-local-env.sh" \
      && ENGINE_COMPARE_LABEL=baseline ENGINE_COMPARE_OUT="$out" npm run engine:compare)
    git worktree remove --force "$tmp/baseline"
    npx supabase db reset && scripts/write-local-env.sh
    ENGINE_COMPARE_LABEL=branch ENGINE_COMPARE_OUT="$out" npm run engine:compare
    npx tsx scripts/engine-compare.ts "$out/baseline.json" "$out/branch.json" > "$out/record.md"
    echo "record: $out/record.md"
    ;;
esac
