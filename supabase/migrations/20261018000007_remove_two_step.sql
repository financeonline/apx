-- MOTION — Two-step sign-in is removed (ADR-161).
--
-- Owner, 2026-10-07: "remove this completely from the entire code" (the two-step sign-in column,
-- after "remove the two-step verification and the authenticator app"). ADR-159 made it a setting;
-- this removes it. A platform account (super admin or staff) counts with a password sign-in. What
-- still protects the sensitive super-admin actions is the recent sign-in (`app.has_recent_auth`,
-- ten minutes; "Confirm it is you", ADR-160) and the single super admin (ADR-159).
--
-- Removed: the platform_mfa_required setting and its function, the authenticator level check
-- (`app.aal`, `app.actor_has_aal2`), the enrolment function and the profile's enrolment date, and the
-- has_aal2 / two_step columns of the two read functions.

-- 1. A platform user is an active platform account — nothing more.
create or replace function app.is_platform_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_users p
     where p.user_id = app.uid() and p.status = 'active'
  );
$$;

-- 2. The out-of-session role (ADR-043), without the authenticator check.
create or replace function app.org_role_of(p_actor uuid, org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.platform_users p
                  where p.user_id = p_actor and p.status = 'active' and p.platform_role = 'super_admin')
      then (select case when o.status <> 'deleted' then 'super_admin' end
              from public.organizations o where o.id = org)
    when exists (
      select 1 from public.organization_assignments a
        join public.platform_users p on p.user_id = a.employee_user_id
       where a.organization_id = org and a.employee_user_id = p_actor
         and a.status = 'active' and p.status = 'active' and p.platform_role = 'employee'
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

create or replace function app.require_super_admin(p_reauth boolean default false) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_super_admin() then
    raise exception 'PERMISSION_DENIED: platform administration requires the super admin'
      using errcode = '42501';
  end if;
  if p_reauth and not app.has_recent_auth(600) then
    raise exception 'PERMISSION_DENIED: re-authenticate within the last 10 minutes to continue'
      using errcode = '42501';
  end if;
end $$;

-- 3. The two read functions lose their two-step columns.
drop function api.my_platform_role();
create function api.my_platform_role()
returns table (platform_role text, status text)
language sql stable security definer set search_path = '' as $$
  select p.platform_role::text, p.status::text
    from public.platform_users p
   where p.user_id = app.uid();
$$;
alter function api.my_platform_role() owner to motion_definer;
revoke all on function api.my_platform_role() from public, anon;
grant execute on function api.my_platform_role() to authenticated;

drop function api.platform_users_list();
create function api.platform_users_list()
returns table (user_id uuid, email text, full_name text, platform_role text, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_super_admin();
  return query
    select p.user_id, pr.email::text, pr.full_name, p.platform_role::text, p.status::text, p.created_at
      from public.platform_users p
      left join public.profiles pr on pr.id = p.user_id
     order by p.platform_role, pr.email;
end $$;
alter function api.platform_users_list() owner to motion_definer;
revoke all on function api.platform_users_list() from public, anon;
grant execute on function api.platform_users_list() to authenticated;

-- 4. Everything else two-step.
drop function api.confirm_mfa_enrolment();
drop function app.actor_has_aal2(uuid);
drop function app.platform_mfa_required();
drop function app.aal();
alter table public.profiles drop column mfa_enrolled_at;
delete from public.platform_settings where key = 'platform_mfa_required';
