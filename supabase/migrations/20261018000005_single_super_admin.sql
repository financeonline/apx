-- MOTION — There is one super admin (ADR-159; owner, 2026-10-07: "there will be only one super admin").
--
-- Enforced where roles are given: api.grant_platform_role and api.revoke_platform_role are the only
-- paths a user has to platform_users (no table write privilege, ADR-026). They now refuse to make a
-- second active super admin, to demote the super admin, and to remove the super admin — so the
-- platform is never left with none and never has two. Platform staff (employees) are unaffected.

create or replace function api.grant_platform_role(p_user uuid, p_role public.platform_role_enum)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_current public.platform_role_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  select p.platform_role into v_current from public.platform_users p where p.user_id = p_user;

  if p_role = 'super_admin' and v_current is distinct from 'super_admin' and exists (
       select 1 from public.platform_users p where p.platform_role = 'super_admin' and p.status = 'active') then
    raise exception 'CONFLICT: there is one super admin; add this person as staff' using errcode = '23505';
  end if;
  if v_current = 'super_admin' and p_role <> 'super_admin' then
    raise exception 'CONFLICT: the super admin cannot be changed to staff' using errcode = '23505';
  end if;

  insert into public.platform_users (user_id, platform_role, granted_by)
  values (p_user, p_role, app.uid())
  on conflict (user_id) do update set platform_role = excluded.platform_role, status = 'active';

  perform app.audit(null, 'platform.role_granted', 'platform_users', p_user, null,
                    jsonb_build_object('platform_role', p_role), '{}'::jsonb);
  return p_user;
end $$;

create or replace function api.revoke_platform_role(p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_super_admin(true);

  if exists (select 1 from public.platform_users p where p.user_id = p_user and p.platform_role = 'super_admin') then
    raise exception 'CONFLICT: the super admin cannot be removed' using errcode = '23505';
  end if;

  update public.organization_assignments set status = 'revoked', revoked_by = app.uid()
   where employee_user_id = p_user and status = 'active';
  delete from public.platform_users where user_id = p_user;

  perform app.audit(null, 'platform.role_revoked', 'platform_users', p_user, null, null, '{}'::jsonb);
  -- Session invalidation is performed by the caller through the Auth admin API.
  return p_user;
end $$;
