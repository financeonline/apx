-- MOTION — Phase 1 · Schema `api`: read functions used to build request context.
-- Contract: TENANCY_MODEL.md §4, §7; SERVICE_ARCHITECTURE.md §3; ROUTE_ARCHITECTURE.md §8.
--
-- resolveAccess() calls api.my_context() rather than re-deriving the role in TypeScript, so the
-- application and the database can never disagree at runtime. The pure TypeScript twin in
-- modules/tenancy/domain/resolve.ts is still exercised by the shared fixture suite, which asserts
-- the two implement the same order (TEST_STRATEGY.md §3).

-- Effective role in one organization, addressed by slug. Returns no row when the caller has no
-- access, so the caller renders 404 without confirming that the organization exists
-- (SECURITY_MODEL.md §14).
create function api.my_context(p_slug text)
returns table (
  organization_id uuid,
  slug            text,
  name            text,
  status          text,
  role            text,
  actor_type      text
)
language sql stable security definer set search_path = '' as $$
  select o.id,
         o.slug::text,
         o.name,
         o.status::text,
         r.role,
         app.actor_type()::text
    from public.organizations o
    join app.accessible_org_roles() r on r.organization_id = o.id
   where o.slug = p_slug::extensions.citext
   limit 1;
$$;

-- Every organization the caller can reach, for the switcher, /select-organization and the
-- employee /portfolio. One statement regardless of how many organizations there are: the
-- aggregate projection permitted by TENANCY_MODEL.md §5.6 / ADR-038.13, still bounded by the
-- caller's accessible set.
create function api.my_organizations()
returns table (
  organization_id uuid,
  slug            text,
  name            text,
  status          text,
  role            text
)
language sql stable security definer set search_path = '' as $$
  select o.id, o.slug::text, o.name, o.status::text, r.role
    from app.accessible_org_roles() r
    join public.organizations o on o.id = r.organization_id
   order by o.name asc;
$$;

-- Platform role of the caller, for middleware route-family routing. Deliberately does NOT require
-- aal2: middleware needs to know a platform account exists so it can redirect an aal1 session to
-- /account/mfa (ROUTE_ARCHITECTURE.md §8.4a). Data access still requires aal2 through
-- app.is_platform_user().
create function api.my_platform_role()
returns table (platform_role text, status text, has_aal2 boolean)
language sql stable security definer set search_path = '' as $$
  select p.platform_role::text, p.status::text, app.aal() = 'aal2'
    from public.platform_users p
   where p.user_id = app.uid();
$$;

-- The signed-in user's own profile row plus the flags middleware and layouts need.
create function api.my_profile()
returns table (
  user_id            uuid,
  email              text,
  full_name          text,
  avatar_url         text,
  timezone           text,
  last_active_org_id uuid,
  onboarding_state   jsonb,
  disabled           boolean
)
language sql stable security definer set search_path = '' as $$
  select p.id, p.email::text, p.full_name, p.avatar_url, p.timezone,
         -- A stale or foreign last_active_org_id is ignored, never resolved to a slug
         -- (ROUTE_ARCHITECTURE.md §8.6).
         (select r.organization_id from app.accessible_org_roles() r
           where r.organization_id = p.last_active_org_id),
         p.onboarding_state,
         p.disabled_at is not null
    from public.profiles p
   where p.id = app.uid();
$$;

-- Members and pending invitations for Settings → Team. Governance permission required.
create function api.org_members(p_org uuid)
returns table (
  user_id   uuid,
  full_name text,
  email     text,
  role      text,
  status    text,
  joined_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_org, 'users.view');
  return query
    select m.user_id, pr.full_name, pr.email::text, m.role::text, m.status::text, m.joined_at
      from public.organization_memberships m
      join public.profiles pr on pr.id = m.user_id
     where m.organization_id = p_org
     order by m.role, pr.full_name nulls last;
end $$;

create function api.org_invitations(p_org uuid)
returns table (
  invitation_id uuid,
  email         text,
  role          text,
  status        text,
  expires_at    timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_org, 'users.view');
  return query
    select i.id, i.email::text, i.role::text, i.status::text, i.expires_at
      from public.invitations i
     where i.organization_id = p_org and i.status = 'pending'
     order by i.created_at desc;
end $$;

-- Assigned MOTION advisers, shown by name with a badge so the tenant can see and revoke them
-- (TENANCY_MODEL.md §5.3).
create function api.org_advisers(p_org uuid)
returns table (
  assignment_id uuid,
  employee_id   uuid,
  full_name     text,
  assigned_at   timestamptz,
  ends_at       timestamptz,
  status        text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_org, 'assignments.view');
  return query
    select a.id, a.employee_user_id, pr.full_name, a.created_at, a.ends_at, a.status::text
      from public.organization_assignments a
      join public.profiles pr on pr.id = a.employee_user_id
     where a.organization_id = p_org and a.status = 'active'
     order by pr.full_name nulls last;
end $$;

-- Organization-scoped audit log for Settings → Audit (audit.view).
create function api.org_audit_events(p_org uuid, p_limit integer default 100, p_offset integer default 0)
returns table (
  id          bigint,
  action      text,
  actor_type  text,
  actor_name  text,
  target_table text,
  target_id   uuid,
  metadata    jsonb,
  created_at  timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_org, 'audit.view');
  return query
    select e.id, e.action, e.actor_type::text, pr.full_name, e.target_table, e.target_id,
           e.metadata, e.created_at
      from public.audit_events e
      left join public.profiles pr on pr.id = e.actor_user_id
     where e.organization_id = p_org
     order by e.created_at desc
     limit least(coalesce(p_limit, 100), 500) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- Ownership and grants.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
