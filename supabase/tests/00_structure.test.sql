-- MOTION — pgTAP · Structural invariants of the Phase 1 database.
-- Contract: TEST_STRATEGY.md §3 ("Additional pgTAP assertions"), DATABASE_ARCHITECTURE.md §11,
--           ADR-026 (no table writes for end users), ADR-043 (api_server is service-role only),
--           ADR-003 (role_permissions is the generated matrix mirror), R2-A-06 (definer hygiene).
--
-- Nothing here needs fixtures: every assertion reads the catalogue.

begin;
create extension if not exists pgtap;

-- Five of the sections below emit ONE assertion per non-partition table in `public`, so the plan
-- cannot be a literal: it changes every time a migration adds a table, and a stale literal turns a
-- growing schema into a "Bad plan" parse error rather than a pass or a failure. Twenty-eight
-- assertions are fixed; the rest are 5 × the table count, read from the catalogue with the same
-- predicate the loops use.
select plan(
  5 * (select count(*)::int
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid))
  + 28);

-- ---------------------------------------------------------------------------
-- 1. Row Level Security: ENABLE **and** FORCE on every table in `public`.
-- ---------------------------------------------------------------------------
select ok(c.relrowsecurity and c.relforcerowsecurity,
          'RLS enabled + forced: public.' || c.relname)
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'p')
   and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
 order by c.relname;

-- The same statement as a whole-schema guard, so a NEW table without RLS fails the suite even
-- though it has no hand-written assertion above.
select is(
  (select count(*)::int
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not (c.relrowsecurity and c.relforcerowsecurity)),
  0,
  'no table in public (partitions included) is missing ENABLE + FORCE row level security');

-- ---------------------------------------------------------------------------
-- 2. `authenticated` holds NO insert/update/delete privilege anywhere (ADR-026).
-- ---------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', c.oid, 'INSERT'),
          'authenticated has no INSERT on public.' || c.relname)
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p')
   and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
 order by c.relname;

select ok(not has_table_privilege('authenticated', c.oid, 'UPDATE'),
          'authenticated has no UPDATE on public.' || c.relname)
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p')
   and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
 order by c.relname;

select ok(not has_table_privilege('authenticated', c.oid, 'DELETE'),
          'authenticated has no DELETE on public.' || c.relname)
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p')
   and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
 order by c.relname;

-- Whole-schema guard: a migration that grants a write fails the suite.
select is(
  (select count(*)::int
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and (has_table_privilege('authenticated', c.oid, 'INSERT')
        or has_table_privilege('authenticated', c.oid, 'UPDATE')
        or has_table_privilege('authenticated', c.oid, 'DELETE')
        or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))),
  0,
  'no table in public grants INSERT/UPDATE/DELETE/TRUNCATE to authenticated (ADR-026)');

-- ---------------------------------------------------------------------------
-- 3. Every non-partition table has a SELECT policy naming `authenticated`.
-- ---------------------------------------------------------------------------
select ok(
  exists (select 1 from pg_catalog.pg_policies pol
           where pol.schemaname = 'public' and pol.tablename = c.relname
             and pol.cmd in ('SELECT', 'ALL')
             and 'authenticated' = any (pol.roles)),
  'a SELECT policy names authenticated on public.' || c.relname)
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p')
   and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
 order by c.relname;

select is(
  (select count(*)::int
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
      and not exists (select 1 from pg_catalog.pg_policies pol
                       where pol.schemaname = 'public' and pol.tablename = c.relname
                         and pol.cmd in ('SELECT', 'ALL')
                         and 'authenticated' = any (pol.roles))),
  0,
  'every non-partition table in public has a SELECT policy for authenticated');

-- ---------------------------------------------------------------------------
-- 4. Definer hygiene (R2-A-06).
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and not p.prosecdef),
  0, 'every api.* function is SECURITY DEFINER');

select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_server' and not p.prosecdef),
  0, 'every api_server.* function is SECURITY DEFINER');

-- The only app.* functions that are not SECURITY DEFINER are the pure, catalogue-free helpers
-- (they read no table at all, so a definer context would buy nothing).
select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and not p.prosecdef
      -- The pure helpers: catalogue-free, table-free, deterministic. A definer context would buy
      -- them nothing. `fiscal_position`, `normalize_name` and `standard_category_label` joined the
      -- list with the Phase 4 financial schema and are pure in exactly the same sense; so do
      -- `invoice_net` and `invoice_net_is_vat_fallback`, which are arithmetic on three columns
      -- their callers already hold (ADR-103).
      -- `merged_calculation_payload` (ADR-132) is jsonb arithmetic on two payloads its callers hold.
      -- `held_name_key` (ADR-136) is string concatenation of a key and an id.
      -- `overridable_role` and `switchable_permissions` (ADR-172) are a constant allow-list and a
      -- constant array.
      and p.proname not in ('ceiling_allows', 'fiscal_position', 'held_name_key', 'invoice_net',
                            'invoice_net_is_vat_fallback', 'job_max_runtime', 'jwt',
                            'merged_calculation_payload',
                            'normalize_name', 'overridable_role', 'role_claim', 'role_rank', 'slugify',
                            'standard_category_label', 'switchable_permissions', 'uid')),
  0, 'every app.* function that touches a table is SECURITY DEFINER');

select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'api', 'api_server')
      and pg_catalog.pg_get_userbyid(p.proowner) <> 'motion_definer'
      -- The one exception, by name (ADR-075): revoking sessions deletes from auth.sessions and
      -- auth.refresh_tokens, and Supabase's postgres role holds grant option on SELECT only for the
      -- auth tables, so motion_definer can never be granted DELETE there. postgres owns that one
      -- function; it carries the service-role guard and touches nothing in public.
      and not (n.nspname = 'api_server' and p.proname = 'revoke_user_sessions')),
  0, 'every app/api/api_server function is owned by motion_definer (NOBYPASSRLS), bar the named exception');

select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'api', 'api_server')
      and not coalesce(p.proconfig, '{}') @> array['search_path=""']),
  0, 'every app/api/api_server function pins search_path = '''' in proconfig');

select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'api', 'api_server')
      and (p.proacl is null
        or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))),
  0, 'no app/api/api_server function is EXECUTE-able by PUBLIC');

-- ---------------------------------------------------------------------------
-- 5. The `app` schema surface exposed to `authenticated` (F-A-05, ADR-044.3).
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'audit'), 'EXECUTE'),
          'app.audit() is NOT executable by authenticated (F-A-05)');

select ok(has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'accessible_org_ids'), 'EXECUTE'),
          'app.accessible_org_ids() is executable by authenticated');
select ok(has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'accessible_org_roles'), 'EXECUTE'),
          'app.accessible_org_roles() is executable by authenticated');
select ok(has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'org_role'), 'EXECUTE'),
          'app.org_role() is executable by authenticated');
select ok(has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'is_super_admin'), 'EXECUTE'),
          'app.is_super_admin() is executable by authenticated');
select ok(has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'has_permission'), 'EXECUTE'),
          'app.has_permission() is executable by authenticated');

select ok(not has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'throttle'), 'EXECUTE'),
          'app.throttle() is NOT executable by authenticated');
select ok(not has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'has_permission_of'), 'EXECUTE'),
          'app.has_permission_of() is NOT executable by authenticated');
select ok(not has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'org_role_of'), 'EXECUTE'),
          'app.org_role_of() is NOT executable by authenticated');
select ok(not has_function_privilege('authenticated', (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'require_super_admin'), 'EXECUTE'),
          'app.require_super_admin() is NOT executable by authenticated');

-- ---------------------------------------------------------------------------
-- 6. api_server is service-role only (ADR-043).
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated',
            (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api_server' and p.proname = 'record_access_event'), 'EXECUTE'),
          'api_server.record_access_event is NOT executable by authenticated');
select ok(not has_function_privilege('authenticated',
            (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api_server' and p.proname = 'enqueue_job'), 'EXECUTE'),
          'api_server.enqueue_job is NOT executable by authenticated');

select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_server'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  0, 'no api_server function is executable by authenticated (ADR-043)');

select ok(has_function_privilege('service_role',
            (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api_server' and p.proname = 'record_access_event'), 'EXECUTE'),
          'api_server.record_access_event IS executable by service_role');
select ok(has_function_privilege('service_role',
            (select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api_server' and p.proname = 'enqueue_job'), 'EXECUTE'),
          'api_server.enqueue_job IS executable by service_role');

-- Every api.* function is reachable by authenticated: that is the whole point of the schema.
select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api'
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  0, 'every api.* function is executable by authenticated (ADR-026)');

-- ---------------------------------------------------------------------------
-- 7. role_permissions — the generated matrix mirror (ADR-003).
-- ---------------------------------------------------------------------------
-- ADR-172 added the accountant (18) and third_party (2) rows: 121 → 141 grants, six → eight roles.
-- ADR-174 took users.invite from the admin: 141 → 140.
select is((select count(*)::int from public.role_permissions), 140,
          'role_permissions holds exactly 140 grants');

select is((select count(distinct role)::int from public.role_permissions), 8,
          'role_permissions covers exactly eight roles');

select set_eq(
  $$ select permission from public.role_permissions where role = 'suspended_member' $$,
  $$ values ('dashboard.view') $$,
  'suspended_member maps to exactly {dashboard.view} (ADR-044.4)');

select * from finish();
rollback;
