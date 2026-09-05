/**
 * Generates the `role_permissions` mirror migration from ROLE_MATRIX (ADR-003).
 *
 *   npm run permissions:sync    # (re)writes the migration
 *   npm run permissions:print   # prints the matrix as JSON for the pgTAP parity test
 *
 * The pgTAP parity test compares the table content with `--print`, so editing the TypeScript matrix
 * without re-running this script fails CI.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { matrixRows } from '../src/core/permissions/matrix';

const MIGRATION = resolve(
  process.cwd(),
  'supabase/migrations/20260905000011_role_permissions.sql',
);

function render(): string {
  const rows = matrixRows();
  const values = rows
    .map((r) => `  ('${r.role}', '${r.permission}')`)
    .join(',\n');

  return `-- MOTION — Phase 1 · GENERATED FILE. Do not edit by hand.
-- Source: src/core/permissions/matrix.ts (ADR-003).
-- Regenerate with: npm run permissions:sync
--
-- This is the read-only mirror of ROLE_MATRIX used by app.has_permission() inside every api.*
-- mutation function. The pgTAP parity test fails CI if this table and the TypeScript matrix differ.

delete from public.role_permissions;

insert into public.role_permissions (role, permission) values
${values};

-- Writable by nobody at runtime.
revoke insert, update, delete on public.role_permissions from authenticated, anon;

-- ${rows.length} grants across ${new Set(rows.map((r) => r.role)).size} roles.
`;
}

function main(): void {
  if (process.argv.includes('--print')) {
    process.stdout.write(JSON.stringify(matrixRows()));
    return;
  }

  const next = render();
  const changed = !existsSync(MIGRATION) || readFileSync(MIGRATION, 'utf8') !== next;
  writeFileSync(MIGRATION, next, 'utf8');
  console.warn(
    changed
      ? `sync-permission-matrix: wrote ${MIGRATION} (${matrixRows().length} grants)`
      : `sync-permission-matrix: up to date (${matrixRows().length} grants)`,
  );
}

main();
