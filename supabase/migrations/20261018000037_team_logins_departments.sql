-- APX — A company creates its team members' logins, and chooses their departments (ADR-173).
--
-- Owner, 2026-10-14: "once the organization is created, the organization can create their
-- employees' ID and password directly … add an option once we create a user there: which
-- permissions we can give and which department access to give. Each org administration can have
-- their own team." Decisions: Owner + team members ("can manage the team" is the admin role, shown as
-- a tick); the password the admin types is the person's password; invitations by email stay; a
-- person sees only the departments ticked for them.
--
-- 1. `organization_memberships.departments`: the departments (ADR-158's systems) a member may open.
--    NULL = all of the company's. Only a member whose access takes switches (not an owner) is ever
--    narrowed; `api.my_access` returns it, and the application intersects it with the company's
--    systems, so a department that is not ticked is ABSENT for that person exactly as a system the
--    super admin switched off is absent for the company: no menu item, no tile, its pages answer
--    "not found", the AI Analyst neither offers nor runs its tools. `departments_set_by_owner`
--    follows ADR-172's hardening: an owner's choice is not an admin's to undo.
-- 2. Creating a login, in two steps around the Auth admin call the server makes:
--    `api.begin_member_login` checks everything and records a claim; the server then creates the
--    login (email confirmed, the password the admin chose); `api.finish_member_login` makes that
--    login a member — only a login created AFTER the claim, for the claim's email, by the same
--    person, within ten minutes, belonging to no company. An existing account can therefore never be
--    pulled into a company this way (Auth refuses an existing email, and the timing refuses an old
--    profile), and nobody's password is ever set for them except on a login made just now.
-- 3. The new member's permissions are set switch by switch through `app.apply_member_permission`, so
--    every ADR-172 rule holds: never beyond the creator's own rights, recorded as theirs.
-- 4. `api.set_member_departments` and `api.org_member_departments` for the team page.

-- 1. -------------------------------------------------------------------------------------------------

create or replace function app.department_keys() returns text[]
language sql immutable set search_path = '' as $$
  select array['banking', 'customers', 'actions', 'reports', 'analyst', 'planning', 'tax', 'funding',
               'marketing', 'investment']::text[];
$$;
alter function app.department_keys() owner to motion_definer;

alter table public.organization_memberships
  add column departments text[],
  add column departments_set_by_owner boolean not null default false,
  add constraint organization_memberships_departments_known
    check (departments is null or departments <@ app.department_keys());

comment on column public.organization_memberships.departments is
  'ADR-173: the departments this member may open; NULL = all of the company''s. Ignored for an owner.';

drop function api.my_access(text);

create function api.my_access(p_slug text)
returns table(organization_id uuid, slug text, name text, status text, role text, actor_type text,
              features jsonb, overrides jsonb, permissions text[], departments text[])
language sql stable security definer set search_path = '' as $$
  select o.id,
         o.slug::text,
         o.name,
         o.status::text,
         r.role,
         app.actor_type()::text,
         o.features,
         coalesce((select jsonb_agg(jsonb_build_object('permission', mpo.permission, 'granted', mpo.granted)
                                    order by mpo.permission)
                     from public.member_permission_overrides mpo
                    where app.overridable_role(r.role)
                      and mpo.organization_id = o.id and mpo.user_id = app.uid()), '[]'::jsonb),
         array(select k.permission
                 from (select rp.permission from public.role_permissions rp where rp.role = r.role
                       union
                       select unnest(app.switchable_permissions())) k
                where app.effective_permission(app.uid(), o.id, r.role, k.permission)
                order by 1),
         (select m.departments from public.organization_memberships m
           where app.overridable_role(r.role)
             and m.organization_id = o.id and m.user_id = app.uid() and m.status = 'active')
    from public.organizations o
    join app.accessible_org_roles() r on r.organization_id = o.id
   where o.slug = p_slug::extensions.citext
   limit 1;
$$;
alter function api.my_access(text) owner to motion_definer;
revoke all on function api.my_access(text) from public, anon;
grant execute on function api.my_access(text) to authenticated;

/** The departments the caller may hand on: NULL (all) for an owner, the super admin or an unnarrowed member. */
create or replace function app.actor_departments(p_org uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select m.departments from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = app.uid() and m.status = 'active'
     and app.overridable_role(m.role::text);
$$;
alter function app.actor_departments(uuid) owner to motion_definer;
revoke all on function app.actor_departments(uuid) from public, anon, authenticated;

/**
 * Validates a departments choice against the keys and the actor's own reach. NULL (all) only from an
 * actor who has all; otherwise every department must be one the actor has.
 */
create or replace function app.check_departments(p_org uuid, p_departments text[]) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_mine text[] := app.actor_departments(p_org);
  v_clean text[];
begin
  if p_departments is null then
    if v_mine is not null then
      raise exception 'PERMISSION_DENIED: you can only give the departments you have yourself'
        using errcode = '42501';
    end if;
    return null;
  end if;
  if not (p_departments <@ app.department_keys()) then
    raise exception 'VALIDATION: unknown department' using errcode = '22023';
  end if;
  if v_mine is not null and not (p_departments <@ v_mine) then
    raise exception 'PERMISSION_DENIED: you can only give the departments you have yourself'
      using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct d order by d), '{}'::text[]) into v_clean from unnest(p_departments) d;
  return v_clean;
end $$;
alter function app.check_departments(uuid, text[]) owner to motion_definer;
revoke all on function app.check_departments(uuid, text[]) from public, anon, authenticated;

-- 2. -------------------------------------------------------------------------------------------------

create table public.member_login_claims (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email           extensions.citext not null,
  role            public.membership_role_enum not null,
  permissions     text[] not null,
  departments     text[],
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  used_at         timestamptz,
  used_user_id    uuid
);
alter table public.member_login_claims owner to motion_definer;
alter table public.member_login_claims enable row level security;
-- No policies and no grants: only the definer functions below read or write it.
revoke all on public.member_login_claims from public, anon, authenticated;
grant all on public.member_login_claims to service_role;
create index member_login_claims_org on public.member_login_claims (organization_id, created_at desc);

/** Who may create a login of which role — the ceiling, and never an owner (ownership is a transfer). */
create or replace function app.check_member_login_role(p_actor_role text, p_role text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_role is null or p_role not in ('admin', 'accountant', 'client', 'third_party') then
    raise exception 'VALIDATION: a login can be created for a team member, an accountant or a 3rd party'
      using errcode = '22023';
  end if;
  if not app.ceiling_allows(p_actor_role, p_role) then
    raise exception 'PERMISSION_DENIED: you cannot create a login with that access' using errcode = '42501';
  end if;
end $$;
alter function app.check_member_login_role(text, text) owner to motion_definer;
revoke all on function app.check_member_login_role(text, text) from public, anon, authenticated;

create or replace function api.begin_member_login(
  p_org uuid, p_email text, p_role public.membership_role_enum, p_permissions text[], p_departments text[]
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor  uuid := app.uid();
  v_role   text;
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_perms  text[];
  v_depts  text[];
  v_id     uuid;
begin
  perform app.throttle(v_actor, 'rpc', 120, interval '1 minute');
  perform app.throttle(v_actor, 'member_login', 30, interval '1 hour');
  v_role := app.require_permission(p_org, 'users.invite');
  perform app.check_member_login_role(v_role, p_role::text);

  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'VALIDATION: enter a valid email address' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles p where lower(p.email::text) = v_email) then
    raise exception 'CONFLICT: that email already has an APX login; use a different email'
      using errcode = '23505';
  end if;

  select coalesce(array_agg(distinct x order by x), '{}'::text[]) into v_perms from unnest(coalesce(p_permissions, '{}')) x;
  if not (v_perms <@ app.switchable_permissions()) then
    raise exception 'VALIDATION: one of those permissions cannot be given to one person' using errcode = '22023';
  end if;
  -- Never beyond the creator's own rights (ADR-172); `app.apply_member_permission` re-checks each.
  if exists (select 1 from unnest(v_perms) x where not app.has_permission(p_org, x)) then
    raise exception 'PERMISSION_DENIED: you can only give what you hold yourself' using errcode = '42501';
  end if;
  v_depts := app.check_departments(p_org, p_departments);

  insert into public.member_login_claims (organization_id, email, role, permissions, departments, created_by)
  values (p_org, v_email, p_role, v_perms, v_depts, v_actor)
  returning id into v_id;
  return v_id;
end $$;
alter function api.begin_member_login(uuid, text, public.membership_role_enum, text[], text[]) owner to motion_definer;
revoke all on function api.begin_member_login(uuid, text, public.membership_role_enum, text[], text[]) from public, anon;
grant execute on function api.begin_member_login(uuid, text, public.membership_role_enum, text[], text[]) to authenticated;

create or replace function api.finish_member_login(p_claim uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor   uuid := app.uid();
  v_claim   public.member_login_claims%rowtype;
  v_role    text;
  v_profile public.profiles%rowtype;
  v_key     text;
  v_want    boolean;
  v_default boolean;
begin
  perform app.throttle(v_actor, 'rpc', 120, interval '1 minute');

  select * into v_claim from public.member_login_claims c where c.id = p_claim for update;
  if v_claim.id is null or v_claim.created_by is distinct from v_actor or v_claim.used_at is not null
     or v_claim.created_at < now() - interval '10 minutes' then
    raise exception 'NOT_FOUND: start again' using errcode = 'P0002';
  end if;

  -- The creator must STILL hold the right, and the ceiling still cover the role.
  v_role := app.require_permission(v_claim.organization_id, 'users.invite');
  perform app.check_member_login_role(v_role, v_claim.role::text);

  select * into v_profile from public.profiles p where p.id = p_user;
  if v_profile.id is null or lower(v_profile.email::text) <> lower(v_claim.email::text)
     or v_profile.created_at < v_claim.created_at then
    raise exception 'PERMISSION_DENIED: only a login made just now can be added this way' using errcode = '42501';
  end if;
  if exists (select 1 from public.organization_memberships m where m.user_id = p_user)
     or exists (select 1 from public.platform_users pu where pu.user_id = p_user) then
    raise exception 'PERMISSION_DENIED: only a login made just now can be added this way' using errcode = '42501';
  end if;

  insert into public.organization_memberships
    (organization_id, user_id, role, status, invited_by, departments, departments_set_by_owner)
  values (v_claim.organization_id, p_user, v_claim.role, 'active', v_actor, v_claim.departments,
          v_role in ('owner', 'super_admin'));

  -- Exactly what was ticked: every switchable permission whose choice differs from the role's default
  -- becomes that person's switch, through the one function every switch goes through.
  foreach v_key in array app.switchable_permissions() loop
    v_want := v_key = any (v_claim.permissions);
    v_default := exists (select 1 from public.role_permissions rp where rp.role = v_claim.role::text and rp.permission = v_key);
    if v_want <> v_default then
      perform app.apply_member_permission(v_claim.organization_id, p_user, v_key, v_want, v_role,
                                          jsonb_build_object('source', 'create'));
    end if;
  end loop;

  update public.member_login_claims set used_at = now(), used_user_id = p_user where id = v_claim.id;
  update public.profiles set last_active_org_id = v_claim.organization_id
   where id = p_user and last_active_org_id is null;

  perform app.audit(v_claim.organization_id, 'member.created', 'organization_memberships', p_user, null,
                    jsonb_build_object('role', v_claim.role, 'departments', v_claim.departments,
                                       'permissions', v_claim.permissions),
                    jsonb_build_object('by', 'login_created'));
  return p_user;
exception
  when unique_violation then
    raise exception 'CONFLICT: that login is already a member of this company' using errcode = '23505';
end $$;
alter function api.finish_member_login(uuid, uuid) owner to motion_definer;
revoke all on function api.finish_member_login(uuid, uuid) from public, anon;
grant execute on function api.finish_member_login(uuid, uuid) to authenticated;

-- 4. -------------------------------------------------------------------------------------------------

create or replace function api.set_member_departments(p_org uuid, p_user uuid, p_departments text[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor   uuid := app.uid();
  v_role    text;
  v_target  text;
  v_before  text[];
  v_by_owner boolean;
  v_owner_actor boolean;
  v_depts   text[];
begin
  perform app.throttle(v_actor, 'rpc', 120, interval '1 minute');
  v_role := app.require_permission(p_org, 'users.manage');
  v_owner_actor := v_role in ('owner', 'super_admin');
  if p_user is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_user = v_actor then
    raise exception 'PERMISSION_DENIED: you cannot change your own access' using errcode = '42501';
  end if;

  select m.role::text, m.departments, m.departments_set_by_owner into v_target, v_before, v_by_owner
    from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = p_user
   for update;
  if v_target is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not app.overridable_role(v_target) then
    raise exception 'PERMISSION_DENIED: an owner sees every department' using errcode = '42501';
  end if;
  if not app.ceiling_allows(v_role, v_target) then
    raise exception 'PERMISSION_DENIED: you cannot act on a %', v_target using errcode = '42501';
  end if;
  if v_by_owner and not v_owner_actor then
    raise exception 'PERMISSION_DENIED: the owner chose this person''s departments; only an owner can change them'
      using errcode = '42501';
  end if;

  v_depts := app.check_departments(p_org, p_departments);
  if v_depts is not distinct from v_before then
    return p_user;
  end if;

  update public.organization_memberships
     set departments = v_depts, departments_set_by_owner = v_owner_actor
   where organization_id = p_org and user_id = p_user;

  perform app.audit(p_org, 'member.departments_changed', 'organization_memberships', p_user,
                    jsonb_build_object('departments', v_before),
                    jsonb_build_object('departments', v_depts),
                    jsonb_build_object('role', v_target, 'set_by_owner', v_owner_actor));
  return p_user;
end $$;
alter function api.set_member_departments(uuid, uuid, text[]) owner to motion_definer;
revoke all on function api.set_member_departments(uuid, uuid, text[]) from public, anon;
grant execute on function api.set_member_departments(uuid, uuid, text[]) to authenticated;

create or replace function api.org_member_departments(p_org uuid)
returns table(user_id uuid, departments text[], set_by_owner boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_org, 'users.view');
  return query
    select m.user_id, m.departments, m.departments_set_by_owner
      from public.organization_memberships m
     where m.organization_id = p_org and app.overridable_role(m.role::text);
end $$;
alter function api.org_member_departments(uuid) owner to motion_definer;
revoke all on function api.org_member_departments(uuid) from public, anon;
grant execute on function api.org_member_departments(uuid) to authenticated;

-- A promotion to owner leaves nothing narrowed behind (an owner sees every department anyway; this
-- keeps the row honest for a later step down).
create or replace function app.clear_owner_departments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'owner' and (new.departments is not null or new.departments_set_by_owner) then
    new.departments := null;
    new.departments_set_by_owner := false;
  end if;
  return new;
end $$;
alter function app.clear_owner_departments() owner to motion_definer;
create trigger clear_owner_departments before insert or update of role on public.organization_memberships
  for each row execute function app.clear_owner_departments();
-- 5. House rules (00_structure): every app.* function a definer, none executable by PUBLIC; every
--    public table forces RLS and has a SELECT policy for authenticated.
alter function app.department_keys() security definer;
alter function app.check_member_login_role(text, text) security definer;
revoke all on function app.department_keys() from public, anon, authenticated;
revoke all on function app.check_member_login_role(text, text) from public, anon, authenticated;
revoke all on function app.clear_owner_departments() from public, anon, authenticated;
alter table public.member_login_claims force row level security;
-- A creator may read their own claims (an email, a role and ticks they chose); nobody else's.
grant select on public.member_login_claims to authenticated;
create policy member_login_claims_select on public.member_login_claims
  for select to authenticated using (created_by = app.uid());
-- The definer functions above write it (RLS is forced, so the owner needs its policy too).
create policy definer_all on public.member_login_claims for all to motion_definer using (true) with check (true);
