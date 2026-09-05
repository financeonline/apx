-- MOTION — Phase 1 · Schema `api`: user-intent mutation functions.
-- Contract: DATABASE_ARCHITECTURE.md §14.1; RBAC_MATRIX.md §2, §3; ADR-026, ADR-044.
--
-- Common contract for every function here:
--   SECURITY DEFINER · owned by motion_definer · SET search_path = '' · fully schema-qualified ·
--   REVOKE ALL FROM public · GRANT EXECUTE TO authenticated · first statement app.throttle() ·
--   actor is app.uid() and is NEVER a parameter · the organization is an argument (or derived from
--   a row id) and is validated against the accessible set · permission via app.has_permission() ·
--   invariants in SQL · audit written in the same transaction · typed errors that core/errors maps.
-- Errors: NOT_FOUND P0002 · PERMISSION_DENIED 42501 · VALIDATION 22023 · CONFLICT 23505/23514 ·
--         QUOTA 53400.

-- ---------------------------------------------------------------------------
-- Shared guards
-- ---------------------------------------------------------------------------

create function app.role_rank(p_role text) returns integer
language sql immutable set search_path = '' as $$
  select case p_role
    when 'super_admin' then 4
    when 'owner'       then 3
    when 'admin'       then 2
    when 'client'      then 1
    else 0
  end;
$$;

-- RBAC_MATRIX.md §3.2: a user may never grant a role above their own, nor act on a member whose
-- CURRENT role is above their own. Admin ceiling is admin.
create function app.ceiling_allows(p_actor_role text, p_subject_role text) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_actor_role = 'super_admin' then true
    when p_actor_role = 'owner'       then app.role_rank(p_subject_role) between 1 and 3
    when p_actor_role = 'admin'       then app.role_rank(p_subject_role) between 1 and 2
    else false
  end;
$$;

create function app.require_org(p_org uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_role text;
begin
  v_role := app.org_role(p_org);
  if v_role is null then
    -- Never PERMISSION_DENIED: that would confirm the organization exists (SECURITY_MODEL.md §14).
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return v_role;
end $$;

create function app.require_permission(p_org uuid, p_perm text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_role text;
begin
  v_role := app.require_org(p_org);
  if not app.has_permission(p_org, p_perm) then
    raise exception 'PERMISSION_DENIED: % is required', p_perm using errcode = '42501';
  end if;
  return v_role;
end $$;

create function app.require_super_admin(p_reauth boolean default false) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_super_admin() then
    raise exception 'PERMISSION_DENIED: platform administration requires a super admin at aal2'
      using errcode = '42501';
  end if;
  if p_reauth and not app.has_recent_auth(600) then
    raise exception 'PERMISSION_DENIED: re-authenticate within the last 10 minutes to continue'
      using errcode = '42501';
  end if;
end $$;

create function app.slugify(p_text text) returns text
language sql immutable set search_path = '' as $$
  select left(
    trim(both '-' from regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g')),
    40);
$$;

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------

create function api.create_organization(
  p_name text,
  p_country_code char(2) default 'GB',
  p_base_currency char(3) default 'GBP',
  p_fiscal_year_start_month smallint default 1,
  p_timezone text default 'Europe/London'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := app.uid();
  v_base  text;
  v_slug  text;
  v_n     integer := 0;
  v_org   uuid;
  v_owned integer;
begin
  perform app.throttle(v_actor, 'create_organization', 3, interval '1 day');

  if v_actor is null then
    raise exception 'PERMISSION_DENIED: sign in required' using errcode = '42501';
  end if;
  -- Platform staff are never members of a customer organization (RBAC_MATRIX.md §3.5); a super
  -- admin creating an organization for a customer uses the platform path and invites the owner.
  if exists (select 1 from public.platform_users p where p.user_id = v_actor) then
    raise exception 'PERMISSION_DENIED: platform accounts cannot own customer organizations'
      using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'VALIDATION: a name is required' using errcode = '22023';
  end if;
  if p_fiscal_year_start_month not between 1 and 12 then
    raise exception 'VALIDATION: fiscal year start month must be 1-12' using errcode = '22023';
  end if;

  -- ADR-044.5: at most five owned organizations on the trial plan.
  select count(*) into v_owned
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = v_actor and m.role = 'owner' and m.status = 'active'
     and o.status <> 'deleted' and o.plan = 'trial';
  if v_owned >= 5 then
    raise exception 'QUOTA: trial accounts may own at most five organizations'
      using errcode = '53400';
  end if;

  v_base := app.slugify(p_name);
  if length(v_base) < 3 then v_base := v_base || '-org'; end if;
  v_slug := v_base;
  while exists (select 1 from public.organizations o where o.slug = v_slug::extensions.citext) loop
    v_n := v_n + 1;
    v_slug := left(v_base, 34) || '-' || v_n::text;
  end loop;

  -- The creator is not yet a member, so the audit guard is told this is a bootstrap (see app.audit).
  perform set_config('app.bootstrap', 'on', true);

  insert into public.organizations
    (slug, name, country_code, base_currency, fiscal_year_start_month, timezone, created_by)
  values
    (v_slug::extensions.citext, trim(p_name), p_country_code, p_base_currency,
     p_fiscal_year_start_month, p_timezone, v_actor)
  returning id into v_org;

  insert into public.organization_memberships (organization_id, user_id, role, status)
  values (v_org, v_actor, 'owner', 'active');

  update public.profiles set last_active_org_id = v_org where id = v_actor;

  perform app.audit(v_org, 'org.created', 'organizations', v_org, null,
                    jsonb_build_object('slug', v_slug, 'name', trim(p_name)), '{}'::jsonb);

  -- PHASE 4 (deliberate deferral, recorded in the Phase 1 report, finding #3):
  -- DATABASE_ARCHITECTURE.md §14.1 also has this function seed the 26 standard accounts and 12
  -- forward fiscal periods. Those tables arrive in Phase 4 slice 1; the seeding is added to this
  -- function by that migration. Nothing silently depends on them in Phase 1.

  perform set_config('app.bootstrap', 'off', true);
  return v_org;
exception
  when unique_violation then
    raise exception 'CONFLICT: that organization already exists' using errcode = '23505';
end $$;

create function api.update_organization(p_org uuid, p_patch jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_role     text;
  v_before   jsonb;
  v_keys     text[] := array(select jsonb_object_keys(p_patch));
  v_tenant   text[] := array['name','legal_name','fiscal_year_start_month','timezone','industry','settings'];
  v_platform text[] := array['plan','features','kind','industry','status'];
  v_allowed  text[];
  v_k        text;
  v_status   text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  v_role := app.require_org(p_org);

  if app.is_super_admin() then
    v_allowed := v_tenant || v_platform;
  else
    perform app.require_permission(p_org, 'settings.manage');
    v_allowed := v_tenant;
  end if;

  foreach v_k in array v_keys loop
    if not (v_k = any (v_allowed)) then
      -- slug, created_by, deletion_requested_at, id and the deletion statuses are never patchable
      -- (ADR-044.6; R2-A-10).
      raise exception 'VALIDATION: % cannot be changed here', v_k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'status' then
    v_status := p_patch ->> 'status';
    if v_status not in ('active', 'suspended') then
      raise exception 'VALIDATION: status may only move between active and suspended; deletion goes through api.request_deletion'
        using errcode = '22023';
    end if;
  end if;

  -- Quota keys live in platform_org_settings and are not tenant-editable (ADR-038.5; F-A-09).
  if p_patch ? 'settings' then
    if (p_patch -> 'settings') ?| array['ai_quota_daily','ai_token_ceiling_monthly',
                                        'ai_extraction_pages_per_day','model_overrides'] then
      raise exception 'VALIDATION: quota settings are platform-controlled' using errcode = '22023';
    end if;
  end if;

  select to_jsonb(o) into v_before from public.organizations o where o.id = p_org;

  update public.organizations o set
    name                    = coalesce(p_patch ->> 'name', o.name),
    legal_name              = coalesce(p_patch ->> 'legal_name', o.legal_name),
    fiscal_year_start_month = coalesce((p_patch ->> 'fiscal_year_start_month')::smallint, o.fiscal_year_start_month),
    timezone                = coalesce(p_patch ->> 'timezone', o.timezone),
    industry                = coalesce(p_patch ->> 'industry', o.industry),
    settings                = coalesce(p_patch -> 'settings', o.settings),
    plan                    = coalesce((p_patch ->> 'plan')::public.org_plan_enum, o.plan),
    features                = coalesce(p_patch -> 'features', o.features),
    kind                    = coalesce((p_patch ->> 'kind')::public.org_kind_enum, o.kind),
    status                  = coalesce((p_patch ->> 'status')::public.org_status_enum, o.status)
  where o.id = p_org;

  perform app.audit(p_org, 'org.updated', 'organizations', p_org, v_before, p_patch, '{}'::jsonb);
  return p_org;
end $$;

create function api.request_deletion(p_org uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'org.delete');

  update public.organizations
     set status = 'pending_deletion', deletion_requested_at = now()
   where id = p_org and status = 'active';

  if not found then
    raise exception 'CONFLICT: only an active organization can be scheduled for deletion'
      using errcode = '23514';
  end if;

  perform app.audit(p_org, 'org.deletion_requested', 'organizations', p_org, null, null, '{}'::jsonb);
  return p_org;
end $$;

create function api.cancel_deletion(p_org uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'org.delete');

  update public.organizations
     set status = 'active', deletion_requested_at = null
   where id = p_org and status = 'pending_deletion';

  if not found then
    raise exception 'CONFLICT: this organization is not scheduled for deletion' using errcode = '23514';
  end if;

  update public.jobs
     set status = 'cancelled', finished_at = now()
   where organization_id = p_org and job_type = 'org.purge' and status = 'queued';

  perform app.audit(p_org, 'org.deletion_cancelled', 'organizations', p_org, null, null, '{}'::jsonb);
  return p_org;
end $$;

-- ---------------------------------------------------------------------------
-- Invitations and membership
-- ---------------------------------------------------------------------------

-- The token-returning form is the implementation; the plain form delegates to it so the security
-- checks (ceiling, existing member, platform account, throttle) exist in exactly ONE place.
create function api.invite_member_with_token(p_org uuid, p_email text, p_role public.membership_role_enum)
returns table (invitation_id uuid, token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_role  text;
  v_email extensions.citext := lower(trim(p_email))::extensions.citext;
  v_token text;
  v_id    uuid;
begin
  perform app.throttle(app.uid(), 'invite_member', 20, interval '1 hour');
  v_role := app.require_permission(p_org, 'users.invite');

  if not app.ceiling_allows(v_role, p_role::text) then
    raise exception 'PERMISSION_DENIED: you cannot invite someone as %', p_role using errcode = '42501';
  end if;
  if position('@' in v_email::text) = 0 then
    raise exception 'VALIDATION: a valid email address is required' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_memberships m
      join public.profiles pr on pr.id = m.user_id
     where m.organization_id = p_org and pr.email = v_email
  ) then
    raise exception 'CONFLICT: that person is already a member' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.platform_users p
      join public.profiles pr on pr.id = p.user_id
     where pr.email = v_email
  ) then
    raise exception 'CONFLICT: that address belongs to a MOTION platform account' using errcode = '23505';
  end if;

  -- The raw token is returned once to the caller and never stored; only its SHA-256 is persisted
  -- (SECURITY_MODEL.md §3).
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.invitations (organization_id, email, role, token_hash, invited_by)
  values (p_org, v_email, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), app.uid())
  returning id into v_id;

  perform app.audit(p_org, 'member.invited', 'invitations', v_id, null,
                    jsonb_build_object('role', p_role), jsonb_build_object('invitation_id', v_id));

  invitation_id := v_id;
  token := v_token;
  return next;
exception
  when unique_violation then
    raise exception 'CONFLICT: an invitation for that address is already pending' using errcode = '23505';
end $$;

create function api.invite_member(p_org uuid, p_email text, p_role public.membership_role_enum)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select t.invitation_id into v_id from api.invite_member_with_token(p_org, p_email, p_role) t;
  return v_id;
end $$;

create function api.revoke_invitation(p_invitation uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  select organization_id into v_org from public.invitations where id = p_invitation;
  if v_org is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform app.require_permission(v_org, 'users.invite');

  update public.invitations set status = 'revoked'
   where id = p_invitation and status = 'pending';
  if not found then
    raise exception 'CONFLICT: that invitation is no longer pending' using errcode = '23514';
  end if;

  perform app.audit(v_org, 'member.invitation_revoked', 'invitations', p_invitation, null, null, '{}'::jsonb);
  return p_invitation;
end $$;

create function api.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor      uuid := app.uid();
  v_hash       text := encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  v_inv        public.invitations%rowtype;
  v_inviter    text;
begin
  perform app.throttle(v_actor, 'accept_invitation', 10, interval '1 hour');
  if v_actor is null then
    raise exception 'PERMISSION_DENIED: sign in required' using errcode = '42501';
  end if;

  select * into v_inv from public.invitations
   where token_hash = v_hash and status = 'pending' and expires_at > now();
  if v_inv.id is null then
    raise exception 'NOT_FOUND: this invitation is no longer valid' using errcode = 'P0002';
  end if;

  -- ADR-038.3 / RBAC_MATRIX.md §3.10: bind to the JWT email, never profiles.email, and require it
  -- to be confirmed.
  if app.jwt_email() is null or lower(app.jwt_email()) <> lower(v_inv.email::text) then
    raise exception 'PERMISSION_DENIED: this invitation was sent to a different address'
      using errcode = '42501';
  end if;
  if not app.jwt_email_confirmed() then
    raise exception 'PERMISSION_DENIED: confirm your email address first' using errcode = '42501';
  end if;
  if exists (select 1 from public.platform_users p where p.user_id = v_actor) then
    raise exception 'CONFLICT: platform accounts cannot join customer organizations'
      using errcode = '23514';
  end if;

  -- F-A-02: the inviter must STILL be an active owner/admin whose ceiling covers the invited role.
  select m.role::text into v_inviter
    from public.organization_memberships m
   where m.organization_id = v_inv.organization_id
     and m.user_id = v_inv.invited_by and m.status = 'active';
  if v_inviter is null or not app.ceiling_allows(v_inviter, v_inv.role::text) then
    raise exception 'PERMISSION_DENIED: the person who invited you can no longer grant this role'
      using errcode = '42501';
  end if;

  perform set_config('app.bootstrap', 'on', true);

  insert into public.organization_memberships (organization_id, user_id, role, status, invited_by)
  values (v_inv.organization_id, v_actor, v_inv.role, 'active', v_inv.invited_by);

  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_actor
   where id = v_inv.id;

  update public.profiles set last_active_org_id = v_inv.organization_id where id = v_actor;

  perform app.audit(v_inv.organization_id, 'member.joined', 'organization_memberships', v_actor,
                    null, jsonb_build_object('role', v_inv.role), '{}'::jsonb);
  perform app.audit(v_inv.organization_id, 'member.invitation_accepted', 'invitations', v_inv.id,
                    null, null, '{}'::jsonb);

  perform set_config('app.bootstrap', 'off', true);
  return v_inv.organization_id;
exception
  when unique_violation then
    raise exception 'CONFLICT: you are already a member of that organization' using errcode = '23505';
end $$;

create function api.change_member_role(p_org uuid, p_user uuid, p_role public.membership_role_enum)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_role    text;
  v_current text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  v_role := app.require_permission(p_org, 'users.manage');

  select m.role::text into v_current from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = p_user;
  if v_current is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  -- Ceiling on the CURRENT role and on the TARGET role (F-A-02).
  if not app.ceiling_allows(v_role, v_current) then
    raise exception 'PERMISSION_DENIED: you cannot act on a % ', v_current using errcode = '42501';
  end if;
  if not app.ceiling_allows(v_role, p_role::text) then
    raise exception 'PERMISSION_DENIED: you cannot grant the role %', p_role using errcode = '42501';
  end if;
  -- No self-elevation (RBAC_MATRIX.md §3.3).
  if p_user = app.uid() and app.role_rank(p_role::text) > app.role_rank(v_current) then
    raise exception 'PERMISSION_DENIED: you cannot raise your own role' using errcode = '42501';
  end if;

  update public.organization_memberships set role = p_role
   where organization_id = p_org and user_id = p_user;

  perform app.audit(p_org, 'member.role_changed', 'organization_memberships', p_user,
                    jsonb_build_object('role', v_current), jsonb_build_object('role', p_role), '{}'::jsonb);
  return p_user;
end $$;

create function api.set_member_status(p_org uuid, p_user uuid, p_status public.membership_status_enum)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_role    text;
  v_current text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  v_role := app.require_permission(p_org, 'users.manage');

  select m.role::text into v_current from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = p_user;
  if v_current is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not app.ceiling_allows(v_role, v_current) then
    raise exception 'PERMISSION_DENIED: you cannot act on a %', v_current using errcode = '42501';
  end if;

  update public.organization_memberships set status = p_status
   where organization_id = p_org and user_id = p_user;

  perform app.audit(p_org, 'member.status_changed', 'organization_memberships', p_user,
                    null, jsonb_build_object('status', p_status), '{}'::jsonb);
  return p_user;
end $$;

create function api.remove_member(p_org uuid, p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_role    text;
  v_current text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  v_role := app.require_permission(p_org, 'users.manage');

  select m.role::text into v_current from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = p_user;
  if v_current is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not app.ceiling_allows(v_role, v_current) then
    raise exception 'PERMISSION_DENIED: you cannot remove a %', v_current using errcode = '42501';
  end if;

  -- The last-owner guard is a trigger, so it holds even if this check is ever wrong.
  delete from public.organization_memberships
   where organization_id = p_org and user_id = p_user;

  perform app.audit(p_org, 'member.removed', 'organization_memberships', p_user,
                    jsonb_build_object('role', v_current), null, '{}'::jsonb);
  -- Session revocation is performed by tenancy.removeMember in application code after this returns:
  -- SQL cannot call the Auth admin API (DATABASE_ARCHITECTURE.md §14.1).
  return p_user;
end $$;

create function api.leave_organization(p_org uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_current text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_org(p_org);

  select m.role::text into v_current from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = app.uid();
  if v_current is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  delete from public.organization_memberships
   where organization_id = p_org and user_id = app.uid();

  perform app.audit(p_org, 'member.left', 'organization_memberships', app.uid(),
                    jsonb_build_object('role', v_current), null, '{}'::jsonb);
  return p_org;
end $$;

-- ---------------------------------------------------------------------------
-- Ownership transfer (ADR-044.7; R2-A-11)
-- ---------------------------------------------------------------------------

create function api.initiate_ownership_transfer(p_org uuid, p_nominee uuid, p_demote boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_role    text;
  v_nominee text;
  v_id      uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  v_role := app.require_permission(p_org, 'users.manage');
  if v_role not in ('owner', 'super_admin') then
    raise exception 'PERMISSION_DENIED: only an owner can transfer ownership' using errcode = '42501';
  end if;

  select m.role::text into v_nominee from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = p_nominee and m.status = 'active';
  if v_nominee is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_nominee <> 'admin' then
    raise exception 'VALIDATION: ownership can only be transferred to an active admin'
      using errcode = '22023';
  end if;

  insert into public.ownership_transfers
    (organization_id, initiator_user_id, nominee_user_id, demote_initiator)
  values (p_org, app.uid(), p_nominee, coalesce(p_demote, false))
  returning id into v_id;

  perform app.audit(p_org, 'ownership.transfer_initiated', 'ownership_transfers', v_id, null,
                    jsonb_build_object('nominee', p_nominee, 'demote_initiator', p_demote), '{}'::jsonb);
  return v_id;
exception
  when unique_violation then
    raise exception 'CONFLICT: a transfer is already pending for this organization' using errcode = '23505';
end $$;

create function api.accept_ownership_transfer(p_transfer uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_t         public.ownership_transfers%rowtype;
  v_initiator text;
  v_nominee   text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select * into v_t from public.ownership_transfers where id = p_transfer;
  if v_t.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  -- Serialise against concurrent membership changes for this organization (R2-A-06.5).
  perform pg_advisory_xact_lock(hashtext('org:' || v_t.organization_id::text));

  if v_t.nominee_user_id <> app.uid() then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_t.status <> 'pending' then
    raise exception 'CONFLICT: this transfer is no longer pending' using errcode = '23514';
  end if;
  if v_t.expires_at <= now() then
    update public.ownership_transfers set status = 'expired' where id = p_transfer;
    raise exception 'CONFLICT: this transfer has expired' using errcode = '23514';
  end if;

  -- Both parties re-checked at ACCEPTANCE time, not at initiation (R2-A-11).
  select m.role::text into v_nominee from public.organization_memberships m
   where m.organization_id = v_t.organization_id and m.user_id = v_t.nominee_user_id
     and m.status = 'active';
  select m.role::text into v_initiator from public.organization_memberships m
   where m.organization_id = v_t.organization_id and m.user_id = v_t.initiator_user_id
     and m.status = 'active';

  if v_nominee is distinct from 'admin' then
    raise exception 'CONFLICT: you are no longer an admin of this organization' using errcode = '23514';
  end if;
  if v_initiator is distinct from 'owner' then
    raise exception 'CONFLICT: the person who offered the transfer is no longer an owner'
      using errcode = '23514';
  end if;

  update public.organization_memberships set role = 'owner'
   where organization_id = v_t.organization_id and user_id = v_t.nominee_user_id;

  if v_t.demote_initiator then
    update public.organization_memberships set role = 'admin'
     where organization_id = v_t.organization_id and user_id = v_t.initiator_user_id;
  end if;

  update public.ownership_transfers set status = 'accepted', accepted_at = now()
   where id = p_transfer;

  perform app.audit(v_t.organization_id, 'ownership.transferred', 'ownership_transfers', p_transfer,
                    jsonb_build_object('initiator', v_t.initiator_user_id),
                    jsonb_build_object('nominee', v_t.nominee_user_id,
                                       'initiator_demoted', v_t.demote_initiator), '{}'::jsonb);
  return v_t.organization_id;
end $$;

create function api.cancel_ownership_transfer(p_transfer uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_t    public.ownership_transfers%rowtype;
  v_role text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  select * into v_t from public.ownership_transfers where id = p_transfer;
  if v_t.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  v_role := app.require_org(v_t.organization_id);
  if v_t.initiator_user_id <> app.uid() and v_role not in ('owner', 'super_admin') then
    raise exception 'PERMISSION_DENIED: only the initiator or an owner can cancel' using errcode = '42501';
  end if;

  update public.ownership_transfers
     set status = 'cancelled', cancelled_by = app.uid()
   where id = p_transfer and status = 'pending';
  if not found then
    raise exception 'CONFLICT: this transfer is no longer pending' using errcode = '23514';
  end if;

  perform app.audit(v_t.organization_id, 'ownership.transfer_cancelled', 'ownership_transfers',
                    p_transfer, null, null, '{}'::jsonb);
  return p_transfer;
end $$;

-- ---------------------------------------------------------------------------
-- Employee assignments (TENANCY_MODEL.md §5)
-- ---------------------------------------------------------------------------

create function api.create_assignment(p_org uuid, p_employee uuid, p_ends_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);   -- re-auth (ADR-044.3)

  if not exists (select 1 from public.platform_users p
                  where p.user_id = p_employee and p.platform_role = 'employee' and p.status = 'active') then
    raise exception 'VALIDATION: assignments are only for active platform employees' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org and o.status <> 'deleted') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.organization_assignments (organization_id, employee_user_id, assigned_by, ends_at)
  values (p_org, p_employee, app.uid(), coalesce(p_ends_at, now() + interval '12 months'))
  returning id into v_id;

  perform app.audit(p_org, 'assignment.created', 'organization_assignments', v_id, null,
                    jsonb_build_object('employee_user_id', p_employee), '{}'::jsonb);
  perform app.audit(null, 'assignment.created', 'organization_assignments', v_id, null,
                    jsonb_build_object('organization_id', p_org, 'employee_user_id', p_employee), '{}'::jsonb);
  return v_id;
exception
  when unique_violation then
    raise exception 'CONFLICT: that employee is already assigned to this organization' using errcode = '23505';
end $$;

create function api.revoke_assignment(p_assignment uuid, p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_a    public.organization_assignments%rowtype;
  v_role text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  select * into v_a from public.organization_assignments where id = p_assignment;
  if v_a.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  -- Super admin, or an OWNER of that organization: the tenant can always revoke adviser access
  -- (TENANCY_MODEL.md §5.4).
  if not app.is_super_admin() then
    v_role := app.require_org(v_a.organization_id);
    if v_role <> 'owner' then
      raise exception 'PERMISSION_DENIED: only an owner or a super admin can revoke adviser access'
        using errcode = '42501';
    end if;
  end if;

  update public.organization_assignments
     set status = 'revoked', revoked_by = app.uid(), revoked_reason = p_reason
   where id = p_assignment and status = 'active';
  if not found then
    raise exception 'CONFLICT: that assignment is not active' using errcode = '23514';
  end if;

  perform app.audit(v_a.organization_id, 'assignment.revoked', 'organization_assignments',
                    p_assignment, null, jsonb_build_object('reason', p_reason), '{}'::jsonb);
  perform app.audit(null, 'assignment.revoked', 'organization_assignments', p_assignment, null,
                    jsonb_build_object('organization_id', v_a.organization_id), '{}'::jsonb);
  -- Phase 5: archiving the employee's conversations for this organization happens through
  -- api_server.set_conversation_archived once ai_conversations exists.
  return p_assignment;
end $$;

-- ---------------------------------------------------------------------------
-- Platform roles and users
-- ---------------------------------------------------------------------------

create function api.grant_platform_role(p_user uuid, p_role public.platform_role_enum)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  insert into public.platform_users (user_id, platform_role, granted_by)
  values (p_user, p_role, app.uid())
  on conflict (user_id) do update set platform_role = excluded.platform_role, status = 'active';

  perform app.audit(null, 'platform.role_granted', 'platform_users', p_user, null,
                    jsonb_build_object('platform_role', p_role), '{}'::jsonb);
  return p_user;
end $$;

create function api.revoke_platform_role(p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  update public.organization_assignments set status = 'revoked', revoked_by = app.uid()
   where employee_user_id = p_user and status = 'active';
  delete from public.platform_users where user_id = p_user;

  perform app.audit(null, 'platform.role_revoked', 'platform_users', p_user, null, null, '{}'::jsonb);
  -- Session invalidation is performed by the caller through the Auth admin API.
  return p_user;
end $$;

create function api.disable_user(p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_orphaned integer;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  -- ADR-038.12 / F-D-14: never leave an organization without an owner.
  select count(*) into v_orphaned
    from public.organization_memberships m
   where m.user_id = p_user and m.role = 'owner' and m.status = 'active'
     and not exists (
       select 1 from public.organization_memberships o2
        where o2.organization_id = m.organization_id and o2.user_id <> p_user
          and o2.role = 'owner' and o2.status = 'active');
  if v_orphaned > 0 then
    raise exception 'CONFLICT: this user is the only owner of % organization(s); transfer ownership first',
      v_orphaned using errcode = '23514';
  end if;

  update public.profiles set disabled_at = now() where id = p_user;
  perform app.audit(null, 'user.disabled', 'profiles', p_user, null, null, '{}'::jsonb);
  return p_user;
end $$;

create function api.enable_user(p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);
  update public.profiles set disabled_at = null where id = p_user;
  perform app.audit(null, 'user.enabled', 'profiles', p_user, null, null, '{}'::jsonb);
  return p_user;
end $$;

-- ---------------------------------------------------------------------------
-- Profile
-- ---------------------------------------------------------------------------

create function api.update_profile(p_patch jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor   uuid := app.uid();
  v_allowed text[] := array['full_name','avatar_url','timezone','onboarding_state','last_active_org_id'];
  v_k       text;
  v_org     uuid;
begin
  perform app.throttle(v_actor, 'rpc', 120, interval '1 minute');
  if v_actor is null then
    raise exception 'PERMISSION_DENIED: sign in required' using errcode = '42501';
  end if;

  foreach v_k in array array(select jsonb_object_keys(p_patch)) loop
    if not (v_k = any (v_allowed)) then
      -- email is written only by the auth-sync trigger; disabled_at only by api.disable_user
      -- (ADR-038.3; F-A-07).
      raise exception 'VALIDATION: % cannot be changed here', v_k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'last_active_org_id' and (p_patch ->> 'last_active_org_id') is not null then
    v_org := (p_patch ->> 'last_active_org_id')::uuid;
    if not exists (select 1 from app.accessible_org_roles() r where r.organization_id = v_org) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  update public.profiles p set
    full_name          = coalesce(p_patch ->> 'full_name', p.full_name),
    avatar_url         = coalesce(p_patch ->> 'avatar_url', p.avatar_url),
    timezone           = coalesce(p_patch ->> 'timezone', p.timezone),
    onboarding_state   = coalesce(p_patch -> 'onboarding_state', p.onboarding_state),
    last_active_org_id = case when p_patch ? 'last_active_org_id'
                              then (p_patch ->> 'last_active_org_id')::uuid
                              else p.last_active_org_id end
  where p.id = v_actor;

  perform app.audit(null, 'profile.updated', 'profiles', v_actor, null, p_patch, '{}'::jsonb);
  return v_actor;
end $$;

-- Stamps TOTP enrolment onto the profile. Cannot be forged: it requires the CALLER's own session
-- to already be at aal2, which only GoTrue issues after a real TOTP verification. The stamp is what
-- app.actor_has_aal2() reads when api_server.* re-validates an actor out of session (ADR-043).
create function api.confirm_mfa_enrolment()
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  if app.uid() is null then
    raise exception 'PERMISSION_DENIED: sign in required' using errcode = '42501';
  end if;
  if app.aal() <> 'aal2' then
    raise exception 'PERMISSION_DENIED: complete the authenticator challenge first'
      using errcode = '42501';
  end if;
  update public.profiles set mfa_enrolled_at = coalesce(mfa_enrolled_at, now())
   where id = app.uid();
  perform app.audit(null, 'auth.mfa_enrolled', 'profiles', app.uid(), null, null, '{}'::jsonb);
  return app.uid();
end $$;

create function api.set_last_active_org(p_org uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_org(p_org);
  update public.profiles set last_active_org_id = p_org where id = app.uid();
  return p_org;
end $$;

-- ---------------------------------------------------------------------------
-- Jobs (ADR-043.3; R2-A-05)
-- ---------------------------------------------------------------------------

create function api.enqueue_job(p_org uuid, p_job_type public.job_type_enum, p_payload jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id      uuid;
  v_payload jsonb;
  v_key     text;
begin
  perform app.throttle(app.uid(), 'enqueue_job:' || p_job_type::text, 30, interval '1 hour');
  perform app.require_org(p_org);

  -- Only two job types are user-intent. Everything else is server-originated and goes through
  -- api_server.enqueue_job; org.purge is trigger-only.
  if p_job_type = 'calculation.run' then
    perform app.require_permission(p_org, 'intelligence.recompute');
    v_payload := jsonb_build_object(
      'trigger', 'recalc_manual',                                   -- derived, never accepted
      'periodFrom', p_payload ->> 'periodFrom',
      'periodTo',   p_payload ->> 'periodTo');
    v_key := 'calculation.run:' || p_org::text;
  elsif p_job_type = 'report.render' then
    perform app.require_permission(p_org, 'reports.generate');
    v_payload := jsonb_build_object('periodId', p_payload ->> 'periodId');
    v_key := 'report.render:' || p_org::text || ':' || coalesce(p_payload ->> 'periodId', '');
  else
    raise exception 'PERMISSION_DENIED: % is not a user-requestable job', p_job_type
      using errcode = '42501';
  end if;

  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
  values (p_org, p_job_type, v_payload, app.uid(), v_key)
  on conflict (job_type, idempotency_key) where (status = 'queued' and idempotency_key is not null)
    do update set payload = public.jobs.payload || v_payload
  returning id into v_id;

  perform app.audit(p_org, 'job.enqueued', 'jobs', v_id, null,
                    jsonb_build_object('job_type', p_job_type), '{}'::jsonb);
  return v_id;
end $$;

create function api.cancel_job(p_job uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_type public.job_type_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  select organization_id, job_type into v_org, v_type from public.jobs where id = p_job;
  if v_org is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform app.require_permission(v_org, 'intelligence.recompute');

  update public.jobs set status = 'cancelled', finished_at = now()
   where id = p_job and status = 'queued';
  if not found then
    raise exception 'CONFLICT: only a queued job can be cancelled' using errcode = '23514';
  end if;

  perform app.audit(v_org, 'job.cancelled', 'jobs', p_job, null, null, '{}'::jsonb);
  return p_job;
end $$;

create function api.requeue_job(p_job uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_j public.jobs%rowtype; v_org_status public.org_status_enum; v_req timestamptz;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(false);

  select * into v_j from public.jobs where id = p_job;
  if v_j.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  -- ADR-044.6 / R2-A-10: a cancelled purge is never revived unless the organization is genuinely
  -- pending deletion.
  if v_j.job_type = 'org.purge' then
    select o.status, o.deletion_requested_at into v_org_status, v_req
      from public.organizations o where o.id = v_j.organization_id;
    if v_org_status is distinct from 'pending_deletion' or v_req is null then
      raise exception 'CONFLICT: this organization is not scheduled for deletion' using errcode = '23514';
    end if;
  end if;

  update public.jobs
     set status = 'queued', attempts = 0, locked_at = null, locked_by = null,
         finished_at = null, run_after = now()
   where id = p_job;

  perform app.audit(v_j.organization_id, 'job.requeued', 'jobs', p_job, null,
                    jsonb_build_object('job_type', v_j.job_type), '{}'::jsonb);
  return p_job;
end $$;

-- ---------------------------------------------------------------------------
-- Platform settings
-- ---------------------------------------------------------------------------

create function api.update_platform_settings(p_key text, p_value jsonb)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  insert into public.platform_settings (key, value, updated_by)
  values (p_key, p_value, app.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;

  perform app.audit(null, 'platform.settings_changed', 'platform_settings', null, null,
                    jsonb_build_object('key', p_key), '{}'::jsonb);
  return p_key;
end $$;

create function api.update_platform_org_settings(p_org uuid, p_patch jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  insert into public.platform_org_settings
    (organization_id, ai_quota_daily, ai_token_ceiling_monthly, ai_extraction_pages_per_day,
     model_overrides, notes, updated_by)
  values (
    p_org,
    (p_patch ->> 'ai_quota_daily')::integer,
    (p_patch ->> 'ai_token_ceiling_monthly')::bigint,
    (p_patch ->> 'ai_extraction_pages_per_day')::integer,
    coalesce(p_patch -> 'model_overrides', '{}'::jsonb),
    p_patch ->> 'notes',
    app.uid())
  on conflict (organization_id) do update set
    ai_quota_daily              = coalesce(excluded.ai_quota_daily, public.platform_org_settings.ai_quota_daily),
    ai_token_ceiling_monthly    = coalesce(excluded.ai_token_ceiling_monthly, public.platform_org_settings.ai_token_ceiling_monthly),
    ai_extraction_pages_per_day = coalesce(excluded.ai_extraction_pages_per_day, public.platform_org_settings.ai_extraction_pages_per_day),
    model_overrides             = excluded.model_overrides,
    notes                       = coalesce(excluded.notes, public.platform_org_settings.notes),
    updated_by                  = excluded.updated_by;

  perform app.audit(p_org, 'platform.org_settings_changed', 'platform_org_settings', p_org,
                    null, p_patch, '{}'::jsonb);
  return p_org;
end $$;

-- ---------------------------------------------------------------------------
-- Ownership and grants for everything in `api`.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('api', 'app')
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public', f.sig);
  end loop;

  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api'
  loop
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

-- The four RLS helpers stay executable by authenticated; nothing else in `app` does.
grant execute on function app.accessible_org_ids() to authenticated;
grant execute on function app.accessible_org_roles() to authenticated;
grant execute on function app.org_role(uuid) to authenticated;
grant execute on function app.is_super_admin() to authenticated;
grant execute on function app.has_permission(uuid, text) to authenticated;
