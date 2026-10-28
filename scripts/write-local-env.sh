#!/usr/bin/env bash
# Writes the LOCAL settings into .env.local for the dev server, the integration, regression and
# Playwright suites: the Firebase emulators (FIRESTORE_DATA_MODEL.md §1). It never points at a
# hosted project.
#
# Every other line already in .env.local (an API key, a model choice, CRON_SECRET …) is kept as it
# is and never printed: only the keys this script manages are replaced.
set -euo pipefail

file=".env.local"
managed=(
  NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN NEXT_PUBLIC_FIREBASE_PROJECT_ID
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST
  FIREBASE_PROJECT_ID FIREBASE_STORAGE_BUCKET FIRESTORE_EMULATOR_HOST FIREBASE_AUTH_EMULATOR_HOST
  FIREBASE_STORAGE_EMULATOR_HOST
  # No longer used (APX left Supabase, ADR-178): listed so an old .env.local loses them.
  NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL
  SUPABASE_JWT_SECRET
)

# A `demo-` project can never reach Google's servers, so these defaults are safe by construction.
project="${FIREBASE_PROJECT_ID:-demo-apx}"
case "$project" in
  demo-*) ;;
  *) echo "refusing: $project is not a demo- (emulator-only) Firebase project" >&2; exit 1 ;;
esac

new="$(mktemp)"
trap 'rm -f "$new"' EXIT

# Keep every line whose key this script does not manage.
if [[ -f "$file" ]]; then
  pattern="^($(IFS='|'; echo "${managed[*]}"))="
  grep -Ev "$pattern|^# Firebase emulators \(npm run db:start\)" "$file" > "$new" || true
fi

{
  echo "# Firebase emulators (npm run db:start) — written by scripts/write-local-env.sh"
  echo "NEXT_PUBLIC_FIREBASE_API_KEY=demo-api-key"
  echo "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${project}.firebaseapp.com"
  echo "NEXT_PUBLIC_FIREBASE_PROJECT_ID=${project}"
  echo "NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099"
  echo "FIREBASE_PROJECT_ID=${project}"
  echo "FIREBASE_STORAGE_BUCKET=${project}.appspot.com"
  echo "FIRESTORE_EMULATOR_HOST=127.0.0.1:8080"
  echo "FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099"
  echo "FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199"
} >> "$new"

grep -q '^CRON_SECRET=' "$new" || echo "CRON_SECRET=${CRON_SECRET:-local-cron-secret}" >> "$new"

mv "$new" "$file"
trap - EXIT
echo "wrote $file for the Firebase emulators (project $project); other settings kept"
