-- MOTION — The super admin changes a company owner's sign-in email and password (ADR-167).
--
-- Owner, 2026-10-07: "let me change the password" and "and username" (the Edit dialog of a company in
-- the list). In MOTION the username is the sign-in email.
--
-- api.platform_company_owners(p_orgs) — the owner login of each listed company (email and name), so
--   the dialog says whose login it changes. The super admin; a read, no recent sign-in.
-- api.platform_owner_login_change(p_org, p_new_email, p_password) — authorises and records a change;
--   the server then makes it through the Auth admin API and ends the owner's sessions. Rules:
--     - the super admin with a sign-in from the last ten minutes;
--     - only the company's single active OWNER, never an admin, client or employee, and never a
--       platform account (a platform user cannot be a member, so it cannot be returned here);
--     - a new email must look like one and must not be another person's login;
--     - audited as platform.owner_login_changed with the old and new email, never the password.

create function api.platform_company_owners(p_orgs uuid[])
returns table (organization_id uuid, user_id uuid, email text, full_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_super_admin();
  return query
    select m.organization_id, m.user_id, p.email::text, p.full_name
      from public.organization_memberships m
      join public.profiles p on p.id = m.user_id
     where m.organization_id = any (p_orgs) and m.role = 'owner' and m.status = 'active'
     order by m.organization_id, p.email;
end $$;

alter function api.platform_company_owners(uuid[]) owner to motion_definer;
revoke all on function api.platform_company_owners(uuid[]) from public, anon;
grant execute on function api.platform_company_owners(uuid[]) to authenticated;

create function api.platform_owner_login_change(p_org uuid, p_new_email text, p_password boolean)
returns table (user_id uuid, email text)
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_user  uuid;
  v_email text;
  v_new   text := nullif(lower(btrim(coalesce(p_new_email, ''))), '');
begin
  perform app.throttle(app.uid(), 'platform_owner_login', 20, interval '1 hour');
  perform app.require_super_admin(true);

  select count(*) into v_count
    from public.organization_memberships m
   where m.organization_id = p_org and m.role = 'owner' and m.status = 'active';
  if v_count = 0 then
    raise exception 'CONFLICT: this company has no owner login yet; set a password when it is created, or send the invitation' using errcode = '23514';
  end if;
  if v_count > 1 then
    raise exception 'CONFLICT: this company has more than one owner, so their login is not changed from here' using errcode = '23514';
  end if;

  select m.user_id, p.email::text into v_user, v_email
    from public.organization_memberships m
    join public.profiles p on p.id = m.user_id
   where m.organization_id = p_org and m.role = 'owner' and m.status = 'active';

  if v_new = lower(v_email) then
    v_new := null;
  end if;
  if v_new is not null then
    if v_new !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'VALIDATION: enter a valid email address' using errcode = '22023';
    end if;
    if exists (select 1 from public.profiles p where lower(p.email::text) = v_new and p.id <> v_user) then
      raise exception 'CONFLICT: another login already uses that email' using errcode = '23505';
    end if;
  end if;
  if v_new is null and not coalesce(p_password, false) then
    raise exception 'VALIDATION: nothing to change' using errcode = '22023';
  end if;

  perform app.audit(p_org, 'platform.owner_login_changed', 'profiles', v_user,
                    jsonb_build_object('email', v_email),
                    jsonb_build_object('email', coalesce(v_new, v_email), 'password_changed', coalesce(p_password, false)),
                    '{}'::jsonb);
  return query select v_user, coalesce(v_new, v_email);
end $$;

alter function api.platform_owner_login_change(uuid, text, boolean) owner to motion_definer;
revoke all on function api.platform_owner_login_change(uuid, text, boolean) from public, anon;
grant execute on function api.platform_owner_login_change(uuid, text, boolean) to authenticated;
