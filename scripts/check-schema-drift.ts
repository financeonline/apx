/**
 * Phase 4 exit gate: the migration set and DATABASE_ARCHITECTURE.md must describe the same database.
 *
 * Documentation that has drifted from the schema is worse than no documentation, because the next
 * engineer trusts it. This script is the mechanical check the implementation plan calls for: it
 * diffs the live table list and the live `api.*` / `api_server.*` catalogue against the document,
 * and exits non-zero on any difference. It runs in CI alongside the permission-matrix parity check.
 *
 * Usage: npx tsx scripts/check-schema-drift.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CONTAINER = process.env.MOTION_DB_CONTAINER ?? 'supabase_db_MOTION';
const DOC = 'docs/DATABASE_ARCHITECTURE.md';

/**
 * Tables the document deliberately does not give a heading to, with the reason. Anything else that
 * is undocumented is a failure, not an exception to be added here without thought.
 */
const DOCUMENTED_ELSEWHERE = new Set<string>([]);

/** Documented as explicitly post-MVP, so their absence from the database is correct. */
const POST_MVP = new Set(['action_comments']);

function sql(query: string): string[] {
  const out = execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-c', query],
    { encoding: 'utf8' },
  );
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function report(label: string, items: readonly string[]): boolean {
  if (items.length === 0) return true;
  console.error(`\n${label}:`);
  for (const item of items) console.error(`  - ${item}`);
  return false;
}

const doc = readFileSync(DOC, 'utf8');

// ---------------------------------------------------------------------------------------------
// Tables. Partitions are an implementation detail of their parent and are not documented separately.
// ---------------------------------------------------------------------------------------------
const liveTables = sql(`
  select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relispartition = false
   order by 1`);

const documentedTables = new Set(
  [...doc.matchAll(/^### `([a-z_]+)`/gm)].map((m) => m[1] as string),
);

const undocumented = liveTables.filter(
  (t) => !documentedTables.has(t) && !DOCUMENTED_ELSEWHERE.has(t),
);
const missing = [...documentedTables].filter(
  (t) => !liveTables.includes(t) && !POST_MVP.has(t),
);

// ---------------------------------------------------------------------------------------------
// The api.* / api_server.* catalogue against pg_proc.
// ---------------------------------------------------------------------------------------------
const liveFunctions = sql(`
  select n.nspname || '.' || p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('api', 'api_server')
   order by 1`);

// §14's tables name functions in backticks, with or without their argument list.
const catalogue = doc.slice(doc.indexOf('## 14. API function catalogue'));
const documentedFunctions = new Set(
  [...catalogue.matchAll(/`(?:api_server\.)?([a-z_]+)\s*\(/g)].map((m) => m[1] as string),
);

const undocumentedFunctions = liveFunctions.filter(
  (f) => !documentedFunctions.has(f.split('.')[1] as string),
);

// ---------------------------------------------------------------------------------------------
// Invariants that are cheap to assert here and expensive to discover in production.
// ---------------------------------------------------------------------------------------------
const unforced = sql(`
  select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and (not c.relrowsecurity or not c.relforcerowsecurity)`);

const writable = sql(`
  select distinct table_name || ' (' || privilege_type || ')'
    from information_schema.role_table_grants
   where grantee = 'authenticated' and table_schema = 'public'
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE')`);

// Owner and a pinned search_path are required of EVERY function in these schemas: an unpinned
// search_path resolves unqualified names against the caller's path (ADR-044.3).
//
// One named exception to the OWNER half, mirrored from 00_structure.test.sql (ADR-075):
// `api_server.revoke_user_sessions` deletes from `auth.sessions` / `auth.refresh_tokens`, and
// Supabase's `postgres` role holds grant option on SELECT only for the auth tables, so
// motion_definer can never be granted DELETE there. postgres owns that one function. Its
// search_path is still required to be pinned — the exception is the owner, not the hygiene.
const unpinned = sql(`
  select n.nspname || '.' || p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'api', 'api_server')
     and ((pg_get_userbyid(p.proowner) <> 'motion_definer'
           and not (n.nspname = 'api_server' and p.proname = 'revoke_user_sessions'))
          or not coalesce(p.proconfig::text like '%search_path=%', false))`);

// SECURITY DEFINER is required of every function that TOUCHES A TABLE. ADR-044.3 says "every
// function", but a handful of helpers are pure — `app.uid()` reads a GUC, `app.slugify()` and
// `app.fiscal_position()` are arithmetic on their arguments — and none of them reads a row. Making
// those SECURITY DEFINER would grant a privilege they have no use for, which is the opposite of what
// the ADR is protecting. The narrowing is deliberate and recorded in ADR-049; the test is whether
// the body references a table.
const unsafeDefiners = sql(`
  select n.nspname || '.' || p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'api', 'api_server')
     and p.prosrc ~* '\\mpublic\\.'
     and not p.prosecdef`);

const serverReachable = sql(`
  select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api_server' and has_function_privilege('authenticated', p.oid, 'execute')`);

const ok = [
  report('Tables in the database with no section in DATABASE_ARCHITECTURE.md', undocumented),
  report('Tables documented but absent from the database', missing),
  report('api.* functions with no entry in the §14 catalogue', undocumentedFunctions),
  report('Tables without ENABLE + FORCE row level security (ADR-026)', unforced),
  report('Write privileges held by `authenticated` (ADR-026)', writable),
  report('Functions not owned by motion_definer or without a pinned search_path (ADR-044.3)', unpinned),
  report('Table-touching functions that are not SECURITY DEFINER (ADR-044.3)', unsafeDefiners),
  report('api_server functions reachable by `authenticated` (ADR-043)', serverReachable),
].every(Boolean);

if (!ok) {
  console.error('\nSchema drift detected. Update the migration or the document so they agree.\n');
  process.exit(1);
}

console.log(
  `Schema and documentation agree: ${liveTables.length} tables, ${liveFunctions.length} api functions, ` +
  'RLS forced everywhere, no write grants, no reachable server functions.',
);
