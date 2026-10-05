#!/usr/bin/env bash
# Writes .env.local for the integration, regression and Playwright suites from the LOCAL Supabase
# stack (`supabase start`). It only ever reads `supabase status` — never a hosted project.
set -euo pipefail
# The project's pinned CLI (package.json) unless the caller names one.
SUPABASE="${SUPABASE:-npx --no-install supabase}"
status="$($SUPABASE status -o json)"
url="$(jq -r .API_URL <<<"$status")"
case "$url" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refusing: $url is not a local Supabase" >&2; exit 1 ;;
esac
{
  echo "NEXT_PUBLIC_SUPABASE_URL=$url"
  echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$(jq -r .ANON_KEY <<<"$status")"
  echo "SUPABASE_SERVICE_ROLE_KEY=$(jq -r .SERVICE_ROLE_KEY <<<"$status")"
  echo "SUPABASE_DB_URL=$(jq -r .DB_URL <<<"$status")"
  echo "SUPABASE_JWT_SECRET=$(jq -r .JWT_SECRET <<<"$status")"
  echo "CRON_SECRET=${CRON_SECRET:-local-cron-secret}"
} > .env.local
echo "wrote .env.local for $url"
