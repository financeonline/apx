-- MOTION — Phase 1 · Internal helpers in schema `app`.
-- Contract: TENANCY_MODEL.md §4; DATABASE_ARCHITECTURE.md §11, §14 (internal helper list);
--           ADR-026.5, ADR-038.10, ADR-043, ADR-044.1/3/5.
--
-- IMPLEMENTATION NOTE (Phase 1 report, finding #8): TENANCY_MODEL.md §4 writes the RLS role check as
-- the scalar `app.org_role(organization_id) in (…)`. Taking a column argument makes it a per-ROW
-- call. `app.accessible_org_roles()` below returns the same information as a set, so policies use an
-- uncorrelated sub-select evaluated ONCE per statement. The predicate is semantically identical to
-- the template (accessible set ∩ role allow-list); only the evaluation cost changes. `app.org_role()`
-- and `app.accessible_org_ids()` keep their documented signatures and are derived from the same
-- source, so the two can never disagree.

-- ---------------------------------------------------------------------------
-- Session facts
-- ---------------------------------------------------------------------------

-- MOTION reads the request JWT directly instead of calling auth.uid()/auth.jwt(), because the
-- migration role cannot grant USAGE on Supabase's `auth` schema to motion_definer (foundation
-- migration, finding #9). These are the same claims auth.uid()/auth.jwt() read.
create function app.jwt() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create function app.uid() returns uuid
language sql stable set search_path = '' as $$
  select nullif(app.jwt() ->> 'sub', '')::uuid;
$$;

create function app.role_claim() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(app.jwt() ->> 'role', ''), current_user::text);
$$;

-- The caller's email as asserted by the JWT — never profiles.email, which is not user-editable
-- but is also not the authentication fact (ADR-038.3; RBAC_MATRIX.md §3.10).
create function app.jwt_email() returns text
language sql stable security definer set search_path = '' as $$
  select nullif(app.jwt() ->> 'email', '');
$$;

-- True when the JWT's email is confirmed. Read from auth.users, not from a client-supplied claim.
-- Mirrored into profiles by the auth trigger, so no auth-schema read is needed.
create function app.jwt_email_confirmed() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = app.uid() and p.email_confirmed_at is not null
  );
$$;

-- Authenticator assurance level. Supabase issues `aal1` after a password/magic-link sign-in and
-- `aal2` after the TOTP challenge.
create function app.aal() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(app.jwt() ->> 'aal', 'aal1');
$$;

-- ADR-044.1 / R2-A-03: MFA is a database fact for EVERY platform user, not only super admins.
-- An employee holding only a password (aal1) reads nothing and can execute no data function.
create function app.is_platform_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_users p
     where p.user_id = app.uid() and p.status = 'active'
  ) and app.aal() = 'aal2';
$$;

create function app.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_platform_user() and exists (
    select 1 from public.platform_users p
     where p.user_id = app.uid() and p.platform_role = 'super_admin' and p.status = 'active'
  );
$$;

create function app.actor_type() returns public.actor_type_enum
language sql stable security definer set search_path = '' as $$
  select case
    when app.role_claim() = 'service_role' then 'system'::public.actor_type_enum
    when exists (select 1 from public.platform_users p
                  where p.user_id = app.uid() and p.platform_role = 'super_admin' and p.status = 'active')
      then 'platform_admin'::public.actor_type_enum
    when exists (select 1 from public.platform_users p
                  where p.user_id = app.uid() and p.platform_role = 'employee' and p.status = 'active')
      then 'employee'::public.actor_type_enum
    else 'user'::public.actor_type_enum
  end;
$$;

-- ADR-044.3: step-up re-authentication. Supabase access tokens carry `amr`, not `auth_time`
-- (the round-2 review found the `auth_time` claim does not exist — R2-A-06.6).
create function app.has_recent_auth(p_seconds integer default 600) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select max((e ->> 'timestamp')::numeric)
       from jsonb_array_elements(coalesce(app.jwt() -> 'amr', '[]'::jsonb)) e
      where e ->> 'method' in ('totp', 'password'))
    >= extract(epoch from now()) - p_seconds,
    false);
$$;

-- ---------------------------------------------------------------------------
-- Access resolution — one source of truth (TENANCY_MODEL.md §4, RBAC_MATRIX.md §1)
-- ---------------------------------------------------------------------------

-- Every organization the caller may read, with the effective role in that organization.
-- Resolution order is RBAC_MATRIX.md §1, first match wins.
create function app.accessible_org_roles()
returns table (organization_id uuid, role text)
language sql stable security definer set search_path = '' as $$
  -- 1. Super admin at aal2: every organization that is not deleted.
  select o.id, 'super_admin'::text
    from public.organizations o
   where app.is_super_admin() and o.status <> 'deleted'
  union all
  -- 2. Platform employee at aal2 with an active, in-window assignment.
  select a.organization_id,
         case when o.status = 'suspended' then 'suspended_member' else 'employee' end
    from public.organization_assignments a
    join public.organizations o on o.id = a.organization_id
    join public.platform_users p on p.user_id = a.employee_user_id
   where a.employee_user_id = app.uid()
     and a.status = 'active'
     and p.status = 'active'
     and p.platform_role = 'employee'
     and app.is_platform_user()
     and (a.starts_at is null or a.starts_at <= now())
     and (a.ends_at   is null or a.ends_at   >  now())
     and o.status in ('active', 'suspended', 'pending_deletion')
     and not app.is_super_admin()
  union all
  -- 3. Active membership. A suspended organization degrades the role to suspended_member
  --    (ADR-044.4); a suspended membership resolves to nothing at all.
  select m.organization_id,
         case when o.status = 'suspended' then 'suspended_member' else m.role::text end
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = app.uid()
     and m.status = 'active'
     and o.status in ('active', 'suspended', 'pending_deletion')
     and not app.is_super_admin()
     and not exists (
       select 1 from public.organization_assignments a
        where a.organization_id = m.organization_id and a.employee_user_id = app.uid()
          and a.status = 'active');
$$;

create function app.accessible_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select r.organization_id from app.accessible_org_roles() r;
$$;

create function app.org_role(org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select r.role from app.accessible_org_roles() r where r.organization_id = org limit 1;
$$;

create function app.has_permission(org uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_permissions rp
     where rp.role = app.org_role(org) and rp.permission = perm
  );
$$;

-- ---------------------------------------------------------------------------
-- Actor-parameterised twins for api_server.* (ADR-043)
-- The server passes the human actor explicitly; these re-validate that actor rather than the
-- session, because the session is service_role.
-- ---------------------------------------------------------------------------
-- An actor's MFA state cannot be read from the current JWT (under api_server the session is
-- service_role), so it is read from the auth schema: a verified factor means TOTP is enrolled.
create function app.actor_has_aal2(p_actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_actor and p.mfa_enrolled_at is not null
  );
$$;

create function app.org_role_of(p_actor uuid, org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.platform_users p
                  where p.user_id = p_actor and p.status = 'active' and p.platform_role = 'super_admin'
                    and app.actor_has_aal2(p_actor))
      then (select case when o.status <> 'deleted' then 'super_admin' end
              from public.organizations o where o.id = org)
    when exists (
      select 1 from public.organization_assignments a
        join public.platform_users p on p.user_id = a.employee_user_id
       where a.organization_id = org and a.employee_user_id = p_actor
         and a.status = 'active' and p.status = 'active' and p.platform_role = 'employee'
         and app.actor_has_aal2(p_actor)
         and (a.starts_at is null or a.starts_at <= now())
         and (a.ends_at   is null or a.ends_at   >  now()))
      then (select case when o.status = 'suspended' then 'suspended_member' else 'employee' end
              from public.organizations o
             where o.id = org and o.status in ('active','suspended','pending_deletion'))
    else (select case when o.status = 'suspended' then 'suspended_member' else m.role::text end
            from public.organization_memberships m
            join public.organizations o on o.id = m.organization_id
           where m.organization_id = org and m.user_id = p_actor and m.status = 'active'
             and o.status in ('active','suspended','pending_deletion'))
  end;
$$;

create function app.has_permission_of(p_actor uuid, org uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_permissions rp
     where rp.role = app.org_role_of(p_actor, org) and rp.permission = perm
  );
$$;

-- ---------------------------------------------------------------------------
-- Throttle (ADR-044.5; R2-A-08)
-- ---------------------------------------------------------------------------
create function app.throttle(p_actor uuid, p_bucket text, p_limit integer, p_window interval)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_secs         bigint      := greatest(extract(epoch from p_window)::bigint, 1);
  v_window_start timestamptz := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);
  v_count        integer;
begin
  if p_actor is null then return; end if;
  insert into public.api_rate_limits as arl (actor_user_id, bucket, window_start, count)
  values (p_actor, p_bucket, v_window_start, 1)
  on conflict (actor_user_id, bucket, window_start)
    do update set count = arl.count + 1
  returning arl.count into v_count;

  if v_count > p_limit then
    raise exception 'QUOTA: too many % requests', p_bucket using errcode = '53400';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Audit (ADR-015, ADR-026.5; F-A-05)
-- Internal only: `authenticated` cannot execute this, so a client can never forge an event.
-- Actor, actor_type and organization are DERIVED. An explicit actor is honoured only for
-- service_role callers whose app.current_org matches the row (ADR-043).
-- ---------------------------------------------------------------------------
create function app.audit(
  p_org          uuid,
  p_action       text,
  p_target_table text default null,
  p_target_id    uuid default null,
  p_before       jsonb default null,
  p_after        jsonb default null,
  p_metadata     jsonb default '{}'::jsonb,
  p_actor        uuid default null,
  p_request_id   text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_actor      uuid;
  v_actor_type public.actor_type_enum;
  v_headers    jsonb;
  v_ip         inet;
  v_ua         text;
  v_request_id text;
  v_id         bigint;
begin
  if app.role_claim() <> 'authenticated' then
    -- Non-user session: service_role (job workers, api_server) or an administrative connection.
    -- There is no session identity to derive, so the actor is whatever the caller passes; a NULL
    -- actor is a genuine system event. The accessible-set check below is a guard against a USER
    -- forging an event for another organization and is meaningless here — and app.audit is not
    -- executable by `authenticated` at all, which is the control that actually stops forgery.
    if p_org is not null
       and nullif(current_setting('app.current_org', true), '') is not null
       and current_setting('app.current_org', true)::uuid <> p_org then
      raise exception 'VALIDATION: audit organization does not match the scoped organization'
        using errcode = '22023';
    end if;
    v_actor := p_actor;
    v_actor_type := case
      when p_actor is null then 'system'::public.actor_type_enum
      when exists (select 1 from public.platform_users p
                    where p.user_id = p_actor and p.platform_role = 'super_admin' and p.status = 'active')
        then 'platform_admin'::public.actor_type_enum
      when exists (select 1 from public.platform_users p
                    where p.user_id = p_actor and p.platform_role = 'employee' and p.status = 'active')
        then 'employee'::public.actor_type_enum
      else 'user'::public.actor_type_enum
    end;
    v_request_id := p_request_id;
  else
    v_actor := app.uid();
    v_actor_type := app.actor_type();
    -- A user-path event must name an organization the caller can actually reach. The two
    -- bootstrap flows (api.create_organization, api.accept_invitation) legitimately audit an
    -- organization the caller is not yet a member of; they set the transaction-local flag below,
    -- which no client can set because app.audit is not executable by `authenticated` at all.
    if p_org is not null
       and coalesce(current_setting('app.bootstrap', true), 'off') <> 'on'
       and not exists (select 1 from app.accessible_org_roles() r where r.organization_id = p_org) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    v_request_id := null;
  end if;

  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;

  -- Caller-supplied and labelled as such (R2-A-06.3): the first x-forwarded-for hop is set by the
  -- Supabase edge; the user agent is truncated.
  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '')::inet;
  v_ua := left(coalesce(v_headers ->> 'user-agent', ''), 256);
  if v_request_id is null then
    v_request_id := coalesce(nullif(v_headers ->> 'x-request-id', ''), gen_random_uuid()::text);
  end if;

  insert into public.audit_events
    (organization_id, actor_user_id, actor_type, action, target_table, target_id,
     before, after, metadata, ip, user_agent, request_id)
  values
    (p_org, v_actor, v_actor_type, p_action, p_target_table, p_target_id,
     p_before, p_after, coalesce(p_metadata, '{}'::jsonb), v_ip, nullif(v_ua, ''), v_request_id)
  returning id into v_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Job queue maintenance (ADR-044.6). The worker itself arrives in Phase 4.
-- ---------------------------------------------------------------------------
create function app.job_max_runtime(p_type public.job_type_enum) returns interval
language sql immutable set search_path = '' as $$
  select case p_type
    when 'calculation.run'    then interval '5 minutes'
    when 'import.commit_large' then interval '5 minutes'
    when 'document.extract'   then interval '10 minutes'
    when 'org.purge'          then interval '30 minutes'
    else interval '2 minutes'
  end;
$$;

create function app.reclaim_stale_jobs() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.jobs j
     set status = 'queued', locked_at = null, locked_by = null, attempts = j.attempts + 1
   where j.status = 'running'
     and j.locked_at < now() - (app.job_max_runtime(j.job_type) * 3);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Grants. Only the four RLS helpers are executable by `authenticated`
-- (DATABASE_ARCHITECTURE.md §14 internal helper list; ADR-044.3 adds has_permission as the fourth).
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public', f.sig);
  end loop;
end $$;

grant execute on function app.accessible_org_ids() to authenticated;
grant execute on function app.accessible_org_roles() to authenticated;
grant execute on function app.org_role(uuid) to authenticated;
grant execute on function app.is_super_admin() to authenticated;
grant execute on function app.has_permission(uuid, text) to authenticated;
-- RLS policies call these, so `authenticated` must be able to execute them.
grant execute on function app.uid() to authenticated;
grant execute on function app.jwt() to authenticated;
grant execute on function app.role_claim() to authenticated;
grant execute on function app.aal() to authenticated;
