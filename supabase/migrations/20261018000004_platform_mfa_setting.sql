-- MOTION — Whether platform staff need two-step sign-in is a platform setting (ADR-159).
--
-- Owner, 2026-10-07: "remove the two-step verification and the authenticator app". Until now every
-- platform user (super admin or staff) counted only at aal2 (ADR-044.1, R2-A-03). That rule now reads
-- `platform_settings.platform_mfa_required`:
--
--   - ABSENT or true  → as before: aal2 required. This is the default, so a deployment that never sets
--                       it keeps the protection the security model was written around.
--   - false           → a platform user counts with a password sign-in.
--
-- Recent sign-in (`app.has_recent_auth`, ten minutes) is still required for the sensitive super-admin
-- actions (`app.require_super_admin(true)`): changing the AI key, creating companies, switching
-- systems, granting roles. The setting is changed only through `api.update_platform_settings`
-- (super admin, recent sign-in, audited).

create function app.platform_mfa_required() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.value)::text <> 'false' from public.platform_settings s
                    where s.key = 'platform_mfa_required'), true);
$$;
alter function app.platform_mfa_required() owner to motion_definer;
revoke all on function app.platform_mfa_required() from public;

create or replace function app.is_platform_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_users p
     where p.user_id = app.uid() and p.status = 'active'
  ) and (app.aal() = 'aal2' or not app.platform_mfa_required());
$$;

create or replace function app.actor_has_aal2(p_actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not app.platform_mfa_required() or exists (
    select 1 from public.profiles p
     where p.id = p_actor and p.mfa_enrolled_at is not null
  );
$$;

create or replace function api.my_platform_role()
returns table (platform_role text, status text, has_aal2 boolean)
language sql stable security definer set search_path = '' as $$
  select p.platform_role::text, p.status::text, (app.aal() = 'aal2' or not app.platform_mfa_required())
    from public.platform_users p
   where p.user_id = app.uid();
$$;
