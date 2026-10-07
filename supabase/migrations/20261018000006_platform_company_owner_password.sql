-- MOTION — The super admin can set a new company's owner login with a password (ADR-160).
--
-- Owner, 2026-10-07: "add option to set password" on Create a company.
--
-- 1. api.accept_invitation: an invitation sent by the active super admin counts. Until now the
--    inviter had to be an active owner/admin MEMBER, which the super admin never is, so the owner
--    invitation of every company made through api.platform_create_organization (ADR-158) was refused.
-- 2. api.platform_set_company_owner: the super admin (recent sign-in) makes a login the OWNER of a
--    company that has no active owner yet — used right after the server has created that login with
--    the password the super admin chose. The owner invitation for that email is marked accepted.
--    A platform account is still refused (exclusivity trigger), and a company that already has an
--    owner is never changed this way.

create or replace function api.accept_invitation(p_token text)
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
  -- ADR-160: a company created by the super admin has no members yet; its owner's invitation was
  -- sent by the super admin, who is never a member. That inviter counts while still the active
  -- super admin.
  if v_inviter is null and exists (select 1 from public.platform_users p
                                    where p.user_id = v_inv.invited_by and p.platform_role = 'super_admin'
                                      and p.status = 'active') then
    v_inviter := 'owner';
  end if;
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

create function api.platform_set_company_owner(p_org uuid, p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  if not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.organization_memberships m
              where m.organization_id = p_org and m.role = 'owner' and m.status = 'active') then
    raise exception 'CONFLICT: this company already has an owner' using errcode = '23505';
  end if;
  select p.email::text into v_email from public.profiles p where p.id = p_user;
  if v_email is null then
    raise exception 'NOT_FOUND: no such login' using errcode = 'P0002';
  end if;

  insert into public.organization_memberships (organization_id, user_id, role, status, invited_by)
  values (p_org, p_user, 'owner', 'active', app.uid());

  update public.invitations i
     set status = 'accepted', accepted_at = now(), accepted_user_id = p_user
   where i.organization_id = p_org and i.status = 'pending' and i.role = 'owner'
     and lower(i.email::text) = lower(v_email);

  update public.profiles set last_active_org_id = p_org where id = p_user and last_active_org_id is null;

  perform app.audit(p_org, 'member.joined', 'organization_memberships', p_user, null,
                    jsonb_build_object('role', 'owner', 'by', 'platform'), '{}'::jsonb);
  return p_org;
exception
  when unique_violation then
    raise exception 'CONFLICT: that login is already a member of this company' using errcode = '23505';
end $$;

alter function api.platform_set_company_owner(uuid, uuid) owner to motion_definer;
revoke all on function api.platform_set_company_owner(uuid, uuid) from public, anon;
grant execute on function api.platform_set_company_owner(uuid, uuid) to authenticated;
