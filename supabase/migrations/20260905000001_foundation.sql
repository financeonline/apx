-- MOTION — Phase 1 · Foundation: roles, schemas, extensions.
-- Contract: ARCHITECTURAL_DECISIONS.md ADR-026, ADR-043, ADR-044.3; DATABASE_ARCHITECTURE.md §11.
--
-- CONTRACT RESOLUTION (recorded in the Phase 1 report, finding #7):
-- DATABASE_ARCHITECTURE.md §11 requires BOTH
--   (a) `ENABLE` + `FORCE ROW LEVEL SECURITY` on every tenant table, and
--   (b) definer functions owned by `motion_definer` (NOBYPASSRLS) that "see rows because the
--       owner owns the tables, not because RLS is bypassed".
-- In PostgreSQL these are mutually exclusive: FORCE makes RLS apply to the table owner too, so a
-- NOBYPASSRLS owner would see nothing and every api.* function would fail.
-- Resolution, preserving the intent of both: keep FORCE (the property the pgTAP suite asserts) and
-- grant the definer role its access through an EXPLICIT, greppable, testable policy per table
-- rather than through the BYPASSRLS attribute. `motion_definer` therefore has no implicit power
-- anywhere in the cluster; its reach is exactly the set of policies written for it, and
-- `authenticated` remains bounded by the real predicates.

-- citext lives in Supabase's `extensions` schema; every reference is qualified.
create extension if not exists citext with schema extensions;

-- The definer role. NOLOGIN: nobody can connect as it. NOBYPASSRLS: it never silently bypasses RLS.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'motion_definer') then
    create role motion_definer nologin nobypassrls;
  end if;
end $$;

-- The migration runner must be a member of motion_definer to set ownership on schemas, tables and
-- functions. Membership is an administrative capability of the deploy role only; motion_definer
-- itself still cannot log in and still cannot bypass RLS.
do $$
begin
  execute format('grant motion_definer to %I with admin option', current_user);
exception when others then
  -- Already a member (or the grant is implicit for a superuser): nothing to do.
  null;
end $$;

-- Supabase's `postgres` role administers the project outside migrations.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres') then
    execute 'grant motion_definer to postgres';
  end if;
exception when others then
  null;
end $$;

-- `app` is internal: helper functions, never exposed to PostgREST.
create schema if not exists app authorization motion_definer;
-- `api` is the RPC surface for user intent (ADR-026).
create schema if not exists api authorization motion_definer;
-- `api_server` holds server-asserted functions, callable only by service_role (ADR-043).
create schema if not exists api_server authorization motion_definer;

revoke all on schema app from public, anon, authenticated;
revoke all on schema api from public, anon;
revoke all on schema api_server from public, anon, authenticated;

grant usage on schema api to authenticated;
grant usage on schema api_server to service_role;
grant usage on schema app to motion_definer;
-- RLS policies call app.uid()/app.accessible_org_roles()/app.has_permission(), so `authenticated`
-- needs USAGE on the schema. It is still not exposed to PostgREST, and EXECUTE is granted on
-- exactly the RLS helpers — app.audit() and the rest stay unreachable (verified by pgTAP).
grant usage on schema app to authenticated;

-- citext lives in `extensions`; the definer role resolves the type inside its functions.
do $$
begin
  execute 'grant usage on schema extensions to motion_definer, authenticated';
exception when others then
  null;
end $$;

-- NOTE (Phase 1 report, finding #9): MOTION deliberately does not depend on the `auth` schema.
-- Supabase's `auth` schema is owned by `supabase_auth_admin`; the migration role holds USAGE
-- WITHOUT grant option, so `grant usage on schema auth to motion_definer` silently grants nothing
-- (PostgreSQL warns rather than errors). Rather than run on a privilege that may or may not exist,
-- the helpers read the request JWT through `current_setting('request.jwt.claims')` — exactly what
-- app.uid()/app.jwt() do internally — and the two auth facts we need (email confirmation, TOTP
-- enrolment) are mirrored into public.profiles by a trigger and by api.confirm_mfa_enrolment(),
-- which can only succeed from a session GoTrue has already raised to aal2.

-- Postgres roles used by the app never get blanket privileges on public; every grant is explicit.
revoke all on schema public from public;
grant usage on schema public to authenticated, anon, service_role;
-- motion_definer owns and creates objects in public (audit partitions, tables).
grant usage, create on schema public to motion_definer;
-- Administrative roles keep full access to public so migrations and the Supabase tooling work.
do $$
declare r text;
begin
  foreach r in array array['postgres', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant usage, create on schema public to %I', r);
    end if;
  end loop;
end $$;

comment on schema app is 'Internal helpers. Never exposed to PostgREST. EXECUTE granted to authenticated only for the four RLS helpers.';
comment on schema api is 'User-intent RPC surface. SECURITY DEFINER functions, EXECUTE to authenticated (ADR-026).';
comment on schema api_server is 'Server-asserted functions. EXECUTE to service_role only, called from core/db/server-rpc.ts (ADR-043).';
