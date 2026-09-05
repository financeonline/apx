-- MOTION — Phase 1 · Privileges and Row Level Security.
-- Contract: DATABASE_ARCHITECTURE.md §11; TENANCY_MODEL.md §6; RBAC_MATRIX.md §4; ADR-026, ADR-044.4.
--
-- Two invariants this file establishes and the pgTAP suite asserts:
--   1. `authenticated` holds NO insert/update/delete privilege on ANY table in public (ADR-026).
--      There is therefore no write a permission bit alone can authorise; every mutation is an
--      api.* function.
--   2. Every table has ENABLE + FORCE row level security, and every role check in a policy is an
--      ALLOW-LIST, never `<> 'client'` — a negation would widen access for suspended_member
--      (ADR-044.4; R2-A-07).

-- ---------------------------------------------------------------------------
-- Ownership: motion_definer owns every table, so its SECURITY DEFINER functions can operate.
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select c.oid::regclass as rel
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('alter table %s owner to motion_definer', t.rel);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. No table writes for end users, ever (ADR-026).
-- ---------------------------------------------------------------------------
revoke insert, update, delete, truncate on all tables in schema public from authenticated, anon;
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from authenticated, anon;

revoke all on all tables in schema public from anon;
grant select on all tables in schema public to authenticated;
alter default privileges in schema public grant select on tables to authenticated;

-- Job workers hold the service role (ADR-013); it bypasses RLS by attribute, which is why its use
-- is confined to three files and every query is organization-scoped.
grant all on all tables in schema public to service_role;

-- ---------------------------------------------------------------------------
-- 2. RLS on every table, forced (owner included).
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select c.oid::regclass as rel
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('alter table %s enable row level security', t.rel);
    execute format('alter table %s force row level security', t.rel);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The definer role's reach, granted explicitly rather than by BYPASSRLS.
--    See the contract resolution in 20260905000001_foundation.sql.
--    audit_events is deliberately NOT given ALL: it is append-only.
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and c.relname not like 'audit_events%'
  loop
    execute format(
      'create policy definer_all on public.%I for all to motion_definer using (true) with check (true)',
      t.relname);
  end loop;
end $$;

-- audit_events: insert and read for the definer; update only inside org.purge redaction; never delete.
create policy definer_select on public.audit_events for select to motion_definer using (true);
create policy definer_insert on public.audit_events for insert to motion_definer with check (true);
create policy definer_purge_redact on public.audit_events for update to motion_definer
  using (coalesce(current_setting('app.purge', true), 'off') = 'on')
  with check (coalesce(current_setting('app.purge', true), 'off') = 'on');

-- ---------------------------------------------------------------------------
-- 4. Read policies for `authenticated`.
-- ---------------------------------------------------------------------------

-- profiles: own row only. Names of co-members are exposed through the definer view below.
create policy profiles_select_self on public.profiles for select to authenticated
  using (id = app.uid());

-- platform_users: super admin sees all; an employee sees only their own grant.
create policy platform_users_select on public.platform_users for select to authenticated
  using (app.is_super_admin() or user_id = app.uid());

-- organizations: the accessible set, including a suspended organization — it is one of the five
-- "frozen Home" tables that admit suspended_member (ADR-044.4).
create policy organizations_select on public.organizations for select to authenticated
  using (id in (select r.organization_id from app.accessible_org_roles() r));

-- organization_memberships: governance readers, plus a member's own row.
create policy memberships_select on public.organization_memberships for select to authenticated
  using (
    organization_id in (select r.organization_id from app.accessible_org_roles() r
                         where r.role in ('owner', 'admin', 'super_admin'))
    or user_id = app.uid()
  );

-- organization_assignments: governance readers, plus the assigned employee's own rows.
create policy assignments_select on public.organization_assignments for select to authenticated
  using (
    organization_id in (select r.organization_id from app.accessible_org_roles() r
                         where r.role in ('owner', 'admin', 'super_admin'))
    or employee_user_id = app.uid()
  );

-- invitations: governance readers only. The /invite/[token] page never reads this table; validity
-- is decided inside api.accept_invitation (DATABASE_ARCHITECTURE.md §1).
create policy invitations_select on public.invitations for select to authenticated
  using (organization_id in (select r.organization_id from app.accessible_org_roles() r
                              where r.role in ('owner', 'admin', 'super_admin')));

-- ownership_transfers: governance readers, plus the nominee's own row.
create policy ownership_transfers_select on public.ownership_transfers for select to authenticated
  using (
    organization_id in (select r.organization_id from app.accessible_org_roles() r
                         where r.role in ('owner', 'admin', 'super_admin'))
    or nominee_user_id = app.uid()
  );

-- audit_events: owner/admin for their organization (audit.view), super admin everywhere.
-- No insert path for authenticated: app.audit() is internal (F-A-05).
create policy audit_events_select on public.audit_events for select to authenticated
  using (
    (organization_id is not null
      and organization_id in (select r.organization_id from app.accessible_org_roles() r
                               where r.role in ('owner', 'admin', 'super_admin')))
    or (organization_id is null and app.is_super_admin())
  );

-- jobs, api_rate_limits, platform_settings, platform_org_settings: platform class.
create policy jobs_select on public.jobs for select to authenticated
  using (app.is_super_admin());
create policy api_rate_limits_select on public.api_rate_limits for select to authenticated
  using (app.is_super_admin());
create policy platform_settings_select on public.platform_settings for select to authenticated
  using (app.is_super_admin());
create policy platform_org_settings_select on public.platform_org_settings for select to authenticated
  using (app.is_super_admin());

-- role_permissions is the generated matrix mirror: world-readable to authenticated, writable by
-- nobody at runtime (ADR-003).
create policy role_permissions_select on public.role_permissions for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 5. org_member_profiles — co-member names for assignee pickers (DATABASE_ARCHITECTURE.md §1).
--    A definer view so a member can see a colleague's display name without SELECT on profiles.
-- ---------------------------------------------------------------------------
create view public.org_member_profiles
with (security_invoker = false) as
  select distinct
         m.organization_id,
         p.id as user_id,
         p.full_name,
         p.avatar_url
    from public.organization_memberships m
    join public.profiles p on p.id = m.user_id
   where m.status = 'active'
     and m.organization_id in (select r.organization_id from app.accessible_org_roles() r);

alter view public.org_member_profiles owner to motion_definer;
revoke all on public.org_member_profiles from public, anon;
grant select on public.org_member_profiles to authenticated;

comment on view public.org_member_profiles is
  'Display names of co-members, filtered to the caller''s accessible organizations. The only way a
   member sees another user''s name; profiles itself is own-row only (DATABASE_ARCHITECTURE.md §1).';
