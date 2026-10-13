-- APX — Per-person permissions, "Request more information", and permission-based reads (ADR-172,
-- part 3 of 3; part 1 added the roles, part 2 their `role_permissions` rows).
--
-- The contract is src/modules/tenancy/domain/member-access.ts. In one line: every company role has
-- defaults (`role_permissions`); the owner or an admin switches individual permissions on or off for
-- each member of their company — only the SWITCHABLE ones, never beyond their own rights, never for
-- an owner, never for themselves; and a member may ask for more ("Request more information"), which
-- the owner or an admin approves (switching the chosen permissions on) or declines.
--
-- What this file does, in order:
--
--   1. The ceiling ranks the new roles (`app.role_rank`): accountant and third_party sit with client
--      at 1, so an owner or an admin may invite, move and remove them (`app.ceiling_allows`), and the
--      existing `api.invite_member_with_token` / `api.change_member_role` / `api.remove_member` /
--      `api.accept_invitation` accept them unchanged.
--   2. `app.switchable_permissions()` — the contract's SWITCHABLE_PERMISSIONS, the one list the table
--      constraints and the functions below share. A unit test pins it to the TypeScript list.
--   3. `member_permission_overrides` — one row per switched permission: (organisation, person,
--      permission) → granted true/false. RLS forced; no table writes; rows go with the membership.
--   4. EFFECTIVE permissions at the database. `app.has_permission`, `app.has_permission_of` and
--      `app.org_ids_with_permission` now answer "role default, then this person's switch": the switch
--      counts only for the four switchable company roles (admin, accountant, client, third_party) —
--      never for an owner, never for platform staff (super_admin, employee), never for
--      `suspended_member` (a suspended organisation freezes everyone to the Home page, ADR-044.4,
--      whatever their switches say). Every `api.*` function that calls `app.require_permission`, every
--      `app.notify` recipient check, the definer views and every policy below therefore see the same
--      answer. `app.org_ids_with_any_permission(variadic)` is the OR of several, in one pass.
--   5. A role change clears the person's switches and closes their waiting request (audited
--      `member.permissions_reset`); a removal deletes both (the foreign keys cascade). Switches are
--      KEPT through a deactivation (`status = 'suspended'`), which resolves to no access at all anyway,
--      so switching someone back on restores exactly what they had.
--   6. `access_requests` — "Request more information": what was asked (switchable permissions and/or
--      a message ≤ 1,000 characters), and the answer. One waiting request per person per company.
--   7. The api surface: `api.set_member_permission`, `api.request_access`,
--      `api.decide_access_request`, `api.withdraw_access_request`, and the reads
--      `api.org_member_permissions`, `api.access_requests_list`, `api.my_access` (the resolver's one
--      round trip: role, switches, effective permissions and the company's systems) and
--      `api.has_accepted_records` (Home's "does this company hold any records?" for a person who may
--      not read the records themselves).
--   8. Two notification kinds: `access_request` (to every owner and admin) and `access_decision` (to
--      the person who asked).
--   9. RLS: the policies that granted SELECT to a LIST OF ROLES ("the five roles") now ask for the
--      PERMISSION that page needs, so a switch opens or closes the table for that one person and the
--      3rd party's two defaults (dashboard.view, reports.view) read the overview and the reports and
--      nothing beneath them. The full before → after list is in docs/RBAC_MATRIX.md §8. Policies that
--      were already permission-based (imports.*, reports.view, actions.view) need no change: they
--      call `app.org_ids_with_permission`, which is now switch-aware.
--  10. `api.set_alert_status` — the acknowledge-only rule becomes an allow-list (owner, admin,
--      employee, super admin decide; everyone else may acknowledge), so it covers the accountant and a
--      3rd party with the switch on. `app.notify_report_ready` tells only the people who may open the
--      weekly or adviser report. `public.org_member_profiles` (member names) narrows to people who see
--      the team or the actions. `api_server.purge_organization` deletes the two new tables. Each of
--      these is re-created from its LIVE definition (`pg_get_functiondef` / `pg_get_viewdef`) with only
--      the change described.
--
-- Performance (ADR-065): every policy keeps the SET form — `organization_id in (select app.…())` —
-- which the planner evaluates once per statement; the switch lookup is one primary-key probe per
-- accessible organisation, not per row. pgTAP 30_member_access asserts the shape.

-- ---------------------------------------------------------------------------------------------
-- 1. The ceiling ranks (mirrors `RANK` in src/core/permissions/guards.ts).
--    Re-created from the live definition with the two new roles added at 1.
-- ---------------------------------------------------------------------------------------------
create or replace function app.role_rank(p_role text)
returns integer language sql immutable set search_path = '' as $$
  select case p_role
    when 'super_admin' then 4
    when 'owner'       then 3
    when 'admin'       then 2
    when 'accountant'  then 1
    when 'client'      then 1
    when 'third_party' then 1
    else 0
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The switchable permissions and the roles a switch applies to.
-- ---------------------------------------------------------------------------------------------

-- SWITCHABLE_PERMISSIONS in src/modules/tenancy/domain/member-access.ts, in the same order. Everything
-- else is fixed by the role: platform keys, deleting the company, billing, analyst assignments and
-- the team keys (`users.*`) — granting someone the right to manage the team is a ROLE change.
-- test/unit/member-access-permissions.test.ts reads this body and fails if the lists differ.
create function app.switchable_permissions() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'dashboard.view', 'financials.view', 'financials.edit', 'imports.create', 'imports.review',
    'banking.view', 'banking.reconcile', 'customers.view', 'customers.edit', 'reports.view',
    'reports.generate', 'ai.use', 'actions.view', 'actions.create', 'actions.assign',
    'actions.update_own', 'alerts.manage', 'intelligence.recompute', 'documents.view',
    'data.export', 'audit.view'
  ]::text[];
$$;
alter function app.switchable_permissions() owner to motion_definer;
revoke all on function app.switchable_permissions() from public, anon, authenticated;

-- The company roles a switch applies to. An ALLOW-LIST (R2-A-07): `owner` holds everything and is
-- never switched; `super_admin` and `employee` are APX staff, governed by the super admin;
-- `suspended_member` is a frozen organisation. A role nobody thought of gets no switch.
create function app.overridable_role(p_role text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_role in ('admin', 'accountant', 'client', 'third_party'), false);
$$;
alter function app.overridable_role(text) owner to motion_definer;
revoke all on function app.overridable_role(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. The switches
-- ---------------------------------------------------------------------------------------------
create table public.member_permission_overrides (
  organization_id uuid not null,
  user_id         uuid not null,
  permission      text not null
                  constraint member_permission_overrides_switchable
                  check (permission = any (app.switchable_permissions())),
  -- true: switched on for this person; false: switched off. No row: the role's default.
  granted         boolean not null,
  set_by          uuid references public.profiles (id) on delete set null,
  set_at          timestamptz not null default now(),
  constraint member_permission_overrides_pkey primary key (organization_id, user_id, permission),
  -- A switch belongs to a MEMBERSHIP: removing the member removes their switches, and nothing can be
  -- switched for somebody who is not a member of that organisation.
  constraint member_permission_overrides_membership_fk foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete cascade
);
comment on table public.member_permission_overrides is
  'ADR-172: per-person switches over the role defaults. Applied by app.has_permission for admin, accountant, client and third_party only. Written only by api.set_member_permission and api.decide_access_request.';

alter table public.member_permission_overrides owner to motion_definer;
alter table public.member_permission_overrides enable row level security;
alter table public.member_permission_overrides force row level security;
revoke insert, update, delete, truncate on public.member_permission_overrides from authenticated, anon;
revoke select on public.member_permission_overrides from anon;
grant select on public.member_permission_overrides to authenticated;
grant all on public.member_permission_overrides to service_role;
create policy definer_all on public.member_permission_overrides for all to motion_definer
  using (true) with check (true);
-- A person sees their own switches; whoever sees the team (`users.view`) sees everyone's.
create policy member_permission_overrides_select on public.member_permission_overrides
  for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
         and (user_id = (select app.uid())
              or organization_id in (select app.org_ids_with_permission('users.view'))));

-- ---------------------------------------------------------------------------------------------
-- 4. Effective permissions at the database
-- ---------------------------------------------------------------------------------------------

/*
 * The one rule, for one person, one organisation, one permission:
 *
 *   the person's switch, when their role takes switches and they have one;
 *   otherwise the role's default (`role_permissions`);
 *   and nothing at all without a role.
 *
 * Internal: not executable by `authenticated`. The callers below pass the role they resolved through
 * `app.accessible_org_roles()` / `app.org_role_of()`, so suspension, aal and assignment windows are
 * decided exactly where they always were.
 */
create function app.effective_permission(p_user uuid, p_org uuid, p_role text, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_role is null or p_user is null or p_org is null or p_perm is null then false
    else coalesce(
      (select o.granted
         from public.member_permission_overrides o
        where app.overridable_role(p_role)
          and o.organization_id = p_org and o.user_id = p_user and o.permission = p_perm),
      exists (select 1 from public.role_permissions rp
               where rp.role = p_role and rp.permission = p_perm))
  end;
$$;
alter function app.effective_permission(uuid, uuid, text, text) owner to motion_definer;
revoke all on function app.effective_permission(uuid, uuid, text, text) from public, anon, authenticated;

-- The caller's effective permission. Same signature, owner and grants as before (re-created in place).
create or replace function app.has_permission(org uuid, perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.effective_permission(app.uid(), org, app.org_role(org), perm);
$$;

-- Another person's (server paths and `app.notify`). Same signature, owner and grants as before.
create or replace function app.has_permission_of(p_actor uuid, org uuid, perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.effective_permission(p_actor, org, app.org_role_of(p_actor, org), perm);
$$;

/*
 * The SET form of has_permission for RLS (ADR-065): the organisations where the caller effectively
 * holds the permission. One pass over the caller's accessible roles, one primary-key probe into the
 * switches per organisation — computed once per statement, never per row.
 */
create or replace function app.org_ids_with_permission(p_perm text)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.organization_id
    from app.accessible_org_roles() r
    left join public.member_permission_overrides o
      on app.overridable_role(r.role)
     and o.organization_id = r.organization_id
     and o.user_id = app.uid()
     and o.permission = p_perm
   where coalesce(o.granted,
                  exists (select 1 from public.role_permissions rp
                           where rp.role = r.role and rp.permission = p_perm));
$$;

-- The organisations where the caller holds ANY of the permissions — the OR a page shared by several
-- sections needs (counterparties: the money, banking and customer pages all name them).
create function app.org_ids_with_any_permission(variadic p_perms text[])
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.organization_id
    from app.accessible_org_roles() r
   where exists (
     select 1 from unnest(p_perms) p(perm)
      where coalesce(
        (select o.granted
           from public.member_permission_overrides o
          where app.overridable_role(r.role)
            and o.organization_id = r.organization_id
            and o.user_id = app.uid()
            and o.permission = p.perm),
        exists (select 1 from public.role_permissions rp
                 where rp.role = r.role and rp.permission = p.perm)));
$$;
alter function app.org_ids_with_any_permission(text[]) owner to motion_definer;
revoke all on function app.org_ids_with_any_permission(text[]) from public, anon;
grant execute on function app.org_ids_with_any_permission(text[]) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. "Request more information" (the table comes before §5's trigger, which closes requests)
-- ---------------------------------------------------------------------------------------------
create table public.access_requests (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  requester_id    uuid not null,
  -- What was asked for: switchable permissions, sorted and without repeats (the function normalises).
  permissions     text[] not null default '{}'::text[]
                  constraint access_requests_permissions check (
                    permissions <@ app.switchable_permissions()
                    and cardinality(permissions) <= cardinality(app.switchable_permissions())),
  message         text constraint access_requests_message
                  check (message is null or length(message) between 1 and 1000),
  status          text not null default 'pending'
                  constraint access_requests_status
                  check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  -- The owner or admin who answered; the requester for a withdrawal; NULL when a role change closed it.
  decided_by      uuid references public.profiles (id) on delete set null,
  decided_at      timestamptz,
  -- On approval, what was actually switched on (a subset of what was asked).
  granted         text[] not null default '{}'::text[]
                  constraint access_requests_granted check (granted <@ permissions),
  -- The decider's note, shown to the requester.
  note            text constraint access_requests_note
                  check (note is null or length(note) between 1 and 1000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint access_requests_asks_something check (cardinality(permissions) > 0 or message is not null),
  constraint access_requests_decided check ((status = 'pending') = (decided_at is null)),
  constraint access_requests_granted_only_approved check (status = 'approved' or cardinality(granted) = 0),
  constraint access_requests_org_id_unique unique (organization_id, id),
  -- A request belongs to a membership: removing the member removes their requests.
  constraint access_requests_membership_fk foreign key (organization_id, requester_id)
    references public.organization_memberships (organization_id, user_id) on delete cascade
);
comment on table public.access_requests is
  'ADR-172: "Request more information". One waiting request per person per organisation; answered by an owner or admin (api.decide_access_request), or withdrawn by the requester.';

-- One waiting request per person per company: a second ask while one waits is refused (CONFLICT),
-- never merged into the first under the decider's eyes.
create unique index access_requests_one_pending on public.access_requests (organization_id, requester_id)
  where status = 'pending';
create index access_requests_by_org on public.access_requests (organization_id, created_at desc);
create index access_requests_by_requester on public.access_requests (requester_id, created_at desc);

alter table public.access_requests owner to motion_definer;
alter table public.access_requests enable row level security;
alter table public.access_requests force row level security;
revoke insert, update, delete, truncate on public.access_requests from authenticated, anon;
revoke select on public.access_requests from anon;
grant select on public.access_requests to authenticated;
grant all on public.access_requests to service_role;
create policy definer_all on public.access_requests for all to motion_definer using (true) with check (true);
-- The requester sees their own; whoever manages the team (`users.manage`) sees every one.
create policy access_requests_select on public.access_requests for select to authenticated
  using (organization_id in (select app.accessible_org_ids())
         and (requester_id = (select app.uid())
              or organization_id in (select app.org_ids_with_permission('users.manage'))));
create trigger set_updated_at before update on public.access_requests
  for each row execute function app.set_updated_at();

/*
 * What was asked, by whom and when never changes; an answered request never changes at all — the
 * one exception being its decider's link CLEARED by `on delete set null` when that person's account
 * goes (refusing that would make deleting a user fail because they once answered a request).
 */
create function app.access_request_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_links constant text[] := array['decided_by', 'updated_at'];
begin
  if coalesce(current_setting('app.purge', true), 'off') = 'on' then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.requester_id is distinct from old.requester_id
     or new.permissions is distinct from old.permissions
     or new.message is distinct from old.message
     or new.created_at is distinct from old.created_at then
    raise exception 'IMMUTABLE: what was asked, by whom and when, is not changed' using errcode = '23514';
  end if;
  if old.status <> 'pending'
     and ((to_jsonb(new) - v_links) is distinct from (to_jsonb(old) - v_links)
          or (new.decided_by is distinct from old.decided_by and new.decided_by is not null)) then
    raise exception 'IMMUTABLE: an answered request is not changed' using errcode = '23514';
  end if;
  return new;
end $$;
alter function app.access_request_guard() owner to motion_definer;
revoke all on function app.access_request_guard() from public, anon, authenticated;
create trigger access_request_guard before update on public.access_requests
  for each row execute function app.access_request_guard();

-- ---------------------------------------------------------------------------------------------
-- 5. A role change starts the person again from the new role's defaults
-- ---------------------------------------------------------------------------------------------
/*
 * Switches were set for the OLD role, by someone judging what that role lacked or had too much of;
 * carried into a new role they would mean something nobody chose (an accountant's "AI on" surviving a
 * move to 3rd party; worse, switches surviving a promotion to owner, where they are ignored but would
 * silently return on a demotion). So a role change clears them, and closes a waiting request — it
 * was asked of the old role — with a note the requester reads. Audited once, with what was cleared.
 *
 * Fires for every path that changes a role: api.change_member_role, the ownership transfer, the
 * super admin's company-owner tools.
 */
create function app.member_role_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cleared jsonb;
  v_closed  integer;
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  with gone as (
    delete from public.member_permission_overrides o
     where o.organization_id = new.organization_id and o.user_id = new.user_id
    returning o.permission, o.granted
  )
  select jsonb_agg(jsonb_build_object('permission', g.permission, 'granted', g.granted) order by g.permission)
    into v_cleared from gone g;

  update public.access_requests r
     set status = 'declined', decided_at = now(), decided_by = app.uid(),
         note = 'Closed because your role changed. Ask again if you still need more access.'
   where r.organization_id = new.organization_id and r.requester_id = new.user_id
     and r.status = 'pending';
  get diagnostics v_closed = row_count;

  if v_cleared is not null or v_closed > 0 then
    perform app.audit(new.organization_id, 'member.permissions_reset', 'organization_memberships', new.user_id,
                      jsonb_build_object('role', old.role, 'overrides', coalesce(v_cleared, '[]'::jsonb)),
                      jsonb_build_object('role', new.role, 'overrides', '[]'::jsonb),
                      jsonb_build_object('reason', 'role_changed', 'requests_closed', v_closed));
  end if;
  return new;
end $$;
alter function app.member_role_changed() owner to motion_definer;
revoke all on function app.member_role_changed() from public, anon, authenticated;
create trigger member_role_changed after update of role on public.organization_memberships
  for each row execute function app.member_role_changed();

-- ---------------------------------------------------------------------------------------------
-- 8. Notification kinds (re-created with the two new kinds added to the live list)
-- ---------------------------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_kind;
alter table public.notifications add constraint notifications_kind check (kind = any (array[
  'data_added', 'report_ready', 'engagement_created', 'engagement_status', 'engagement_comment',
  'action_comment', 'access_request', 'access_decision'
]::text[]));

-- ---------------------------------------------------------------------------------------------
-- 7. The api surface
-- ---------------------------------------------------------------------------------------------

/*
 * Set (true / false) or clear (NULL) ONE switch for ONE member, as the caller. Internal: the two
 * api functions below decide who the caller is allowed to be (`users.manage`) and pass their role.
 *
 *   - only a switchable permission;
 *   - never the caller themselves (no self-service widening, no locking oneself out);
 *   - only an ACTIVE member — a deactivated one resolves to nothing and is switched back on first;
 *   - never an owner (owners hold everything), and only within the caller's ceiling: an admin may
 *     switch another admin, an accountant, a client or a 3rd party — as an admin may change or remove
 *     them — and a super admin anyone but an owner;
 *   - never beyond the caller's own rights: switching ON needs the caller to hold that permission,
 *     and so does ANY change that leaves the person holding something they did not hold before (a
 *     reset to a default that grants it, after an owner had switched it off).
 *
 * The membership row is locked first, so a concurrent role change or removal serialises with this.
 * Audited `member.permission_changed` with the switch and the effective answer before and after.
 * Returns whether anything changed.
 */
create function app.apply_member_permission(
  p_org uuid, p_user uuid, p_permission text, p_granted boolean, p_actor_role text, p_metadata jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_actor      uuid := app.uid();
  v_target     text;
  v_status     text;
  v_before     boolean;
  v_default    boolean;
  v_eff_before boolean;
  v_eff_after  boolean;
begin
  if p_permission is null or not (p_permission = any (app.switchable_permissions())) then
    raise exception 'VALIDATION: % cannot be switched for one person', coalesce(p_permission, 'that permission')
      using errcode = '22023';
  end if;
  if p_user is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_user = v_actor then
    raise exception 'PERMISSION_DENIED: you cannot change your own access' using errcode = '42501';
  end if;

  select m.role::text, m.status::text into v_target, v_status
    from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = p_user
   for update;
  if v_target is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'CONFLICT: that person''s access is switched off; switch it back on first'
      using errcode = '23514';
  end if;
  if not app.overridable_role(v_target) then
    raise exception 'PERMISSION_DENIED: an owner''s access cannot be switched; an owner holds everything'
      using errcode = '42501';
  end if;
  if not app.ceiling_allows(p_actor_role, v_target) then
    raise exception 'PERMISSION_DENIED: you cannot act on a %', v_target using errcode = '42501';
  end if;

  select o.granted into v_before
    from public.member_permission_overrides o
   where o.organization_id = p_org and o.user_id = p_user and o.permission = p_permission;
  v_default := exists (select 1 from public.role_permissions rp
                        where rp.role = v_target and rp.permission = p_permission);
  v_eff_before := coalesce(v_before, v_default);
  v_eff_after  := coalesce(p_granted, v_default);

  if (p_granted is true or (v_eff_after and not v_eff_before))
     and not app.has_permission(p_org, p_permission) then
    raise exception 'PERMISSION_DENIED: you can only switch on what you hold yourself (%)', p_permission
      using errcode = '42501';
  end if;

  if p_granted is not distinct from v_before then
    return false;
  end if;

  if p_granted is null then
    delete from public.member_permission_overrides o
     where o.organization_id = p_org and o.user_id = p_user and o.permission = p_permission;
  else
    insert into public.member_permission_overrides as o
      (organization_id, user_id, permission, granted, set_by, set_at)
    values (p_org, p_user, p_permission, p_granted, v_actor, now())
    on conflict (organization_id, user_id, permission)
      do update set granted = excluded.granted, set_by = excluded.set_by, set_at = excluded.set_at;
  end if;

  perform app.audit(p_org, 'member.permission_changed', 'organization_memberships', p_user,
                    jsonb_build_object('permission', p_permission, 'override', v_before, 'effective', v_eff_before),
                    jsonb_build_object('permission', p_permission, 'override', p_granted, 'effective', v_eff_after),
                    jsonb_build_object('role', v_target) || coalesce(p_metadata, '{}'::jsonb));
  return true;
end $$;
alter function app.apply_member_permission(uuid, uuid, text, boolean, text, jsonb) owner to motion_definer;
revoke all on function app.apply_member_permission(uuid, uuid, text, boolean, text, jsonb) from public, anon, authenticated;

-- 7a. A switch, from the team page. NULL puts the permission back to the role's default.
create function api.set_member_permission(
  p_org uuid, p_user uuid, p_permission text, p_granted boolean default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  -- "Reset all" walks every switch of one person; 300 an hour is far above any honest page.
  perform app.throttle(app.uid(), 'member_permission', 300, interval '1 hour');
  v_role := app.require_permission(p_org, 'users.manage');
  perform app.apply_member_permission(p_org, p_user, p_permission, p_granted, v_role,
                                      jsonb_build_object('source', 'switch'));
  return p_user;
end $$;
alter function api.set_member_permission(uuid, uuid, text, boolean) owner to motion_definer;
revoke all on function api.set_member_permission(uuid, uuid, text, boolean) from public, anon;
grant execute on function api.set_member_permission(uuid, uuid, text, boolean) to authenticated;

/*
 * 7b. "Request more information". Any active company member except an owner (who already holds
 * everything) — so not APX staff, and not anyone in a suspended organisation. At least one
 * permission or a message. Permissions the person already holds are dropped (the request is for what
 * they lack); asking only for those is refused with a plain answer. Five a day (a calendar day,
 * UTC) per person; one waiting at a time. Every owner and admin is told in their inbox.
 */
create function api.request_access(
  p_org uuid, p_permissions text[] default '{}'::text[], p_message text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor   uuid := app.uid();
  v_role    text;
  v_asked   text[] := coalesce(p_permissions, '{}'::text[]);
  v_perms   text[];
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_id      uuid;
  v_slug    text;
  v_who     text;
  v_person  uuid;
begin
  perform app.throttle(v_actor, 'rpc', 120, interval '1 minute');
  v_role := app.require_org(p_org);
  if not app.overridable_role(v_role) then
    raise exception 'PERMISSION_DENIED: asking for more access is for company members other than owners'
      using errcode = '42501';
  end if;
  perform app.throttle(v_actor, 'access_request', 5, interval '1 day');

  if v_message is not null and length(v_message) > 1000 then
    raise exception 'VALIDATION: keep the message to 1,000 characters' using errcode = '22023';
  end if;
  if cardinality(v_asked) > cardinality(app.switchable_permissions()) * 2
     or exists (select 1 from unnest(v_asked) p where p is null or not (p = any (app.switchable_permissions()))) then
    raise exception 'VALIDATION: one of those permissions cannot be asked for' using errcode = '22023';
  end if;

  v_perms := array(select distinct p from unnest(v_asked) p
                    where not app.has_permission(p_org, p) order by 1);
  if cardinality(v_perms) = 0 and v_message is null then
    if cardinality(v_asked) > 0 then
      raise exception 'VALIDATION: you already have the access you asked for' using errcode = '22023';
    end if;
    raise exception 'VALIDATION: choose what you need, or say what you need in a message' using errcode = '22023';
  end if;

  insert into public.access_requests (organization_id, requester_id, permissions, message)
  values (p_org, v_actor, v_perms, v_message)
  returning id into v_id;

  perform app.audit(p_org, 'member.access_requested', 'access_requests', v_id, null,
                    jsonb_build_object('permissions', to_jsonb(v_perms), 'has_message', v_message is not null),
                    jsonb_build_object('role', v_role));

  select o.slug::text into v_slug from public.organizations o where o.id = p_org;
  select coalesce(nullif(btrim(pr.full_name), ''), pr.email::text) into v_who
    from public.profiles pr where pr.id = v_actor;
  for v_person in select * from app.org_people(p_org) loop
    perform app.notify(p_org, v_person, v_actor, 'users.manage', 'access_request',
      coalesce(v_who, 'A member') || ' asked for more access',
      case when cardinality(v_perms) = 0 then 'They left a message.'
           else 'They asked for ' || cardinality(v_perms) || ' permission'
                || case when cardinality(v_perms) = 1 then '' else 's' end
                || case when v_message is null then '.' else ', with a message.' end
      end,
      '/app/' || v_slug || '/settings/team#requests');
  end loop;

  return v_id;
exception
  when unique_violation then
    raise exception 'CONFLICT: you already have a request waiting; withdraw it or wait for an answer'
      using errcode = '23505';
end $$;
alter function api.request_access(uuid, text[], text) owner to motion_definer;
revoke all on function api.request_access(uuid, text[], text) from public, anon;
grant execute on function api.request_access(uuid, text[], text) to authenticated;

/*
 * 7c. Answer a request. `users.manage`, within the ceiling (an admin never answers for an owner — no
 * owner can ask — and may answer an admin, as an admin may switch an admin), never one's own. On
 * approval the chosen permissions — a subset of those asked; all of them when none are named — are
 * switched ON through the same rule as a switch, so each must be one the decider holds; any refusal
 * refuses the whole answer. Approving a message-only request switches nothing on. The requester is
 * told, with the note.
 */
create function api.decide_access_request(
  p_id uuid, p_approve boolean, p_permissions text[] default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor  uuid := app.uid();
  v_org    uuid;
  v_req    public.access_requests%rowtype;
  v_role   text;
  v_target text;
  v_grant  text[];
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_slug   text;
  v_p      text;
begin
  perform app.throttle(v_actor, 'rpc', 120, interval '1 minute');
  if p_approve is null then
    raise exception 'VALIDATION: choose approve or decline' using errcode = '22023';
  end if;

  select r.organization_id into v_org from public.access_requests r where r.id = p_id;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_role := app.require_permission(v_org, 'users.manage');

  select * into v_req from public.access_requests r
   where r.organization_id = v_org and r.id = p_id
   for update;
  if v_req.status <> 'pending' then
    raise exception 'CONFLICT: that request has already been answered' using errcode = '23514';
  end if;
  if v_req.requester_id = v_actor then
    raise exception 'PERMISSION_DENIED: you cannot answer your own request' using errcode = '42501';
  end if;
  select m.role::text into v_target from public.organization_memberships m
   where m.organization_id = v_org and m.user_id = v_req.requester_id and m.status = 'active';
  if v_target is null then
    raise exception 'CONFLICT: that person''s access is switched off' using errcode = '23514';
  end if;
  if not app.ceiling_allows(v_role, v_target) then
    raise exception 'PERMISSION_DENIED: you cannot act on a %', v_target using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'VALIDATION: keep the note to 1,000 characters' using errcode = '22023';
  end if;

  if p_approve then
    v_grant := array(select distinct p from unnest(coalesce(p_permissions, v_req.permissions)) p order by 1);
    if exists (select 1 from unnest(v_grant) p where p is null or not (p = any (v_req.permissions))) then
      raise exception 'VALIDATION: you can only switch on what was asked for' using errcode = '22023';
    end if;
    foreach v_p in array v_grant loop
      perform app.apply_member_permission(v_org, v_req.requester_id, v_p, true, v_role,
                                          jsonb_build_object('source', 'access_request', 'access_request_id', p_id));
    end loop;
  else
    v_grant := '{}'::text[];
  end if;

  update public.access_requests r
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_by = v_actor, decided_at = now(), granted = v_grant, note = v_note
   where r.organization_id = v_org and r.id = p_id;

  perform app.audit(v_org, 'member.access_request_decided', 'access_requests', p_id,
                    jsonb_build_object('status', 'pending', 'permissions', to_jsonb(v_req.permissions)),
                    jsonb_build_object('status', case when p_approve then 'approved' else 'declined' end,
                                       'granted', to_jsonb(v_grant), 'has_note', v_note is not null),
                    jsonb_build_object('requester_id', v_req.requester_id));

  select o.slug::text into v_slug from public.organizations o where o.id = v_org;
  insert into public.notifications (organization_id, user_id, kind, title, body, href)
  values (v_org, v_req.requester_id, 'access_decision',
          case when p_approve then 'Your request for more access was approved'
               else 'Your request for more access was declined' end,
          left(v_note, 1000),
          '/app/' || v_slug || '/home');

  return p_id;
end $$;
alter function api.decide_access_request(uuid, boolean, text[], text) owner to motion_definer;
revoke all on function api.decide_access_request(uuid, boolean, text[], text) from public, anon;
grant execute on function api.decide_access_request(uuid, boolean, text[], text) to authenticated;

-- 7d. The requester takes back a waiting request. Anybody else's id is NOT FOUND.
create function api.withdraw_access_request(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := app.uid();
  v_org   uuid;
  v_req   public.access_requests%rowtype;
begin
  perform app.throttle(v_actor, 'rpc', 120, interval '1 minute');
  select r.organization_id into v_org from public.access_requests r
   where r.id = p_id and r.requester_id = v_actor;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_req from public.access_requests r
   where r.organization_id = v_org and r.id = p_id
   for update;
  if v_req.status <> 'pending' then
    raise exception 'CONFLICT: that request has already been answered' using errcode = '23514';
  end if;

  update public.access_requests r
     set status = 'withdrawn', decided_by = v_actor, decided_at = now()
   where r.organization_id = v_org and r.id = p_id;

  perform app.audit(v_org, 'member.access_request_withdrawn', 'access_requests', p_id,
                    jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'withdrawn'),
                    '{}'::jsonb);
  return p_id;
end $$;
alter function api.withdraw_access_request(uuid) owner to motion_definer;
revoke all on function api.withdraw_access_request(uuid) from public, anon;
grant execute on function api.withdraw_access_request(uuid) to authenticated;

-- 7e. The team page: every member with their role and switches (`users.view`, as api.org_members).
-- Defaults, the effective set, what the viewer may change and grant are worked out in TypeScript
-- from these rows and the viewer's own context (modules/tenancy/services/member-access.ts).
create function api.org_member_permissions(p_org uuid)
returns table (user_id uuid, full_name text, email text, role text, status text, overrides jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_org, 'users.view');
  return query
    select m.user_id, pr.full_name, pr.email::text, m.role::text, m.status::text,
           coalesce((select jsonb_agg(jsonb_build_object('permission', o.permission, 'granted', o.granted)
                                      order by o.permission)
                       from public.member_permission_overrides o
                      where o.organization_id = p_org and o.user_id = m.user_id), '[]'::jsonb)
      from public.organization_memberships m
      join public.profiles pr on pr.id = m.user_id
     where m.organization_id = p_org
     order by m.role, pr.full_name nulls last, pr.email;
end $$;
alter function api.org_member_permissions(uuid) owner to motion_definer;
revoke all on function api.org_member_permissions(uuid) from public, anon;
grant execute on function api.org_member_permissions(uuid) to authenticated;

-- 7f. Requests: a `users.manage` holder reads the organisation's; anyone else only their own.
create function api.access_requests_list(p_org uuid, p_status text default 'pending')
returns table (
  id uuid, requester_id uuid, requester_name text, requester_email text, requester_role text,
  permissions text[], message text, status text, created_at timestamptz,
  decided_by uuid, decided_at timestamptz, granted text[], note text
)
language plpgsql stable security definer set search_path = '' as $$
declare v_all boolean;
begin
  perform app.require_org(p_org);
  if p_status is null or p_status not in ('pending', 'approved', 'declined', 'withdrawn', 'all') then
    raise exception 'VALIDATION: unknown request status' using errcode = '22023';
  end if;
  v_all := app.has_permission(p_org, 'users.manage');
  return query
    select r.id, r.requester_id, pr.full_name, pr.email::text, m.role::text,
           r.permissions, r.message, r.status, r.created_at,
           r.decided_by, r.decided_at, r.granted, r.note
      from public.access_requests r
      join public.profiles pr on pr.id = r.requester_id
      join public.organization_memberships m
        on m.organization_id = r.organization_id and m.user_id = r.requester_id
     where r.organization_id = p_org
       and (v_all or r.requester_id = app.uid())
       and (p_status = 'all' or r.status = p_status)
     order by r.created_at desc
     limit 200;
end $$;
alter function api.access_requests_list(uuid, text) owner to motion_definer;
revoke all on function api.access_requests_list(uuid, text) from public, anon;
grant execute on function api.access_requests_list(uuid, text) to authenticated;

/*
 * 7g. The access resolver's ONE round trip (src/modules/tenancy/services/resolve-access.ts): what
 * api.my_context returns, plus the organisation's systems (`features`, ADR-158), the caller's own
 * switches and the EFFECTIVE permissions computed here by the same rule every policy uses. The
 * resolver computes the same set in TypeScript and keeps only what both agree on.
 */
create function api.my_access(p_slug text)
returns table (
  organization_id uuid, slug text, name text, status text, role text, actor_type text,
  features jsonb, overrides jsonb, permissions text[]
)
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
                order by 1)
    from public.organizations o
    join app.accessible_org_roles() r on r.organization_id = o.id
   where o.slug = p_slug::extensions.citext
   limit 1;
$$;
alter function api.my_access(text) owner to motion_definer;
revoke all on function api.my_access(text) from public, anon;
grant execute on function api.my_access(text) to authenticated;

/*
 * 7h. Does this organisation hold any accepted record of its own? Home's first-run test (ADR-058.8),
 * answered for anyone with `dashboard.view` — one boolean, nothing else — because a 3rd party (who
 * reads none of the record tables) would otherwise be told to upload their first file. The same four
 * tables, the same "accepted and not superseded", as `hasAcceptedRecords` in modules/dashboard.
 */
create function api.has_accepted_records(p_org uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_org, 'dashboard.view');
  return exists (select 1 from public.ledger_entries t
                  where t.organization_id = p_org and t.record_status = 'accepted' and t.superseded_by is null)
      or exists (select 1 from public.bank_transactions t
                  where t.organization_id = p_org and t.record_status = 'accepted' and t.superseded_by is null)
      or exists (select 1 from public.invoices t
                  where t.organization_id = p_org and t.record_status = 'accepted' and t.superseded_by is null)
      or exists (select 1 from public.period_balances t
                  where t.organization_id = p_org and t.record_status = 'accepted' and t.superseded_by is null);
end $$;
alter function api.has_accepted_records(uuid) owner to motion_definer;
revoke all on function api.has_accepted_records(uuid) from public, anon;
grant execute on function api.has_accepted_records(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 9. Reads: permissions, not role lists (before → after in docs/RBAC_MATRIX.md §8)
-- ---------------------------------------------------------------------------------------------

-- The ledger and everything only the money pages read: `financials.view`.
alter policy ledger_entries_select on public.ledger_entries
  using (organization_id in (select app.org_ids_with_permission('financials.view')));
alter policy period_balances_select on public.period_balances
  using (organization_id in (select app.org_ids_with_permission('financials.view')));
alter policy account_category_history_select on public.account_category_history
  using (organization_id in (select app.org_ids_with_permission('financials.view')));
alter policy record_status_events_select on public.record_status_events
  using (organization_id in (select app.org_ids_with_permission('financials.view')));
alter policy budget_lines_select on public.budget_lines
  using (organization_id in (select app.org_ids_with_permission('financials.view')));
alter policy forecast_runs_select on public.forecast_runs
  using (organization_id in (select app.org_ids_with_permission('financials.view')));
alter policy forecast_values_select on public.forecast_values
  using (organization_id in (select app.org_ids_with_permission('financials.view')));
alter policy scenario_runs_select on public.scenario_runs
  using (organization_id in (select app.org_ids_with_permission('financials.view')));
alter policy scenario_values_select on public.scenario_values
  using (organization_id in (select app.org_ids_with_permission('financials.view')));

-- The chart of accounts: the money pages, and the banking pages that show each line's category.
alter policy accounts_select on public.accounts
  using (organization_id in (select app.org_ids_with_any_permission('financials.view', 'banking.view')));

-- Bank accounts and lines: the banking pages, and the cash pages under `financials.view` ("cash and
-- the records behind it").
alter policy bank_accounts_select on public.bank_accounts
  using (organization_id in (select app.org_ids_with_any_permission('banking.view', 'financials.view')));
alter policy bank_transactions_select on public.bank_transactions
  using (organization_id in (select app.org_ids_with_any_permission('banking.view', 'financials.view')));
alter policy recurring_payment_groups_select on public.recurring_payment_groups
  using (organization_id in (select app.org_ids_with_any_permission('banking.view', 'financials.view')));
alter policy category_history_select on public.category_history
  using (organization_id in (select app.org_ids_with_any_permission('banking.view', 'financials.view')));

-- Invoices and their lines: the receivables/payables pages and the customer and sales pages.
alter policy invoices_select on public.invoices
  using (organization_id in (select app.org_ids_with_any_permission('financials.view', 'customers.view')));
alter policy invoice_lines_select on public.invoice_lines
  using (organization_id in (select app.org_ids_with_any_permission('financials.view', 'customers.view')));

-- Counterparties are named on the money, banking and customer pages alike.
alter policy counterparties_select on public.counterparties
  using (organization_id in (select app.org_ids_with_any_permission('financials.view', 'banking.view', 'customers.view')));

-- The commercial records (ADR-102): the customer pages, and the money pages' marketing spend.
alter policy products_select on public.products
  using (organization_id in (select app.org_ids_with_any_permission('customers.view', 'financials.view')));
alter policy campaigns_select on public.campaigns
  using (organization_id in (select app.org_ids_with_any_permission('customers.view', 'financials.view')));
alter policy campaign_spend_select on public.campaign_spend
  using (organization_id in (select app.org_ids_with_any_permission('customers.view', 'financials.view')));
alter policy marketing_channels_select on public.marketing_channels
  using (organization_id in (select app.org_ids_with_any_permission('customers.view', 'financials.view')));
alter policy opportunities_select on public.opportunities
  using (organization_id in (select app.org_ids_with_any_permission('customers.view', 'financials.view')));

-- Source documents: `documents.view` — or `imports.review`, whose review pages name the file being
-- reviewed (opening the file itself is a signed URL the server mints only after `documents.view`).
alter policy source_documents_select on public.source_documents
  using (organization_id in (select app.org_ids_with_any_permission('documents.view', 'imports.review')));

-- Evidence ("Why?") is the detail behind a figure: `financials.view`, with the AI-answer rule kept.
alter policy evidence_bundles_select on public.evidence_bundles
  using (organization_id in (select app.org_ids_with_permission('financials.view'))
         and (kind <> 'ai_response'::public.evidence_kind_enum
              or organization_id in (select app.org_ids_with_role('owner', 'admin', 'super_admin'))
              or exists (select 1
                           from public.ai_messages m
                           join public.ai_conversations c
                             on c.organization_id = m.organization_id and c.id = m.conversation_id
                          where m.organization_id = evidence_bundles.organization_id
                            and m.id = evidence_bundles.origin_id
                            and c.user_id = app.uid())));

-- Alerts name customers and suppliers in their sentences: whoever reads the figures behind them
-- (`financials.view`) or handles them (`alerts.manage`) — and the frozen Home (ADR-044.4), which has
-- always shown a suspended organisation's alerts.
alter policy alerts_select on public.alerts
  using (organization_id in (select app.org_ids_with_any_permission('financials.view', 'alerts.manage'))
         or organization_id in (select app.org_ids_with_role('suspended_member')));
alter policy alert_revisions_select on public.alert_revisions
  using (organization_id in (select app.org_ids_with_any_permission('financials.view', 'alerts.manage')));

-- The Action Centre.
alter policy actions_select on public.actions
  using (organization_id in (select app.org_ids_with_permission('actions.view')));

-- The overview: the Business Health Score (`dashboard.view`; `suspended_member` holds it, so the
-- frozen Home keeps it).
alter policy health_current_select on public.health_current
  using (organization_id in (select app.org_ids_with_permission('dashboard.view')));
alter policy health_scores_select on public.health_scores
  using (organization_id in (select app.org_ids_with_permission('dashboard.view')));

-- Months hold no figures; every role that resolves reads them (the frozen Home included, ADR-068).
alter policy fiscal_periods_select on public.fiscal_periods
  using (organization_id in (select app.accessible_org_ids()));

-- Which run produced the figures on screen: the overview and the reports (a suspended organisation,
-- holding only dashboard.view, does not read runs, as before).
alter policy calculation_runs_select on public.calculation_runs
  using (organization_id in (select app.org_ids_with_any_permission('financials.view', 'reports.view')));

/*
 * The figures. `financials.view` reads every snapshot, history included. Without it:
 *   - `customers.view` reads the per-customer figures (customer revenue and share) the customer
 *     pages show;
 *   - `dashboard.view` reads the CURRENT snapshots (those `metric_current` points at) of the
 *     undimensioned figures and the standard-category breakdowns — the headline figures, the trend,
 *     spending by category — and nothing per account or per counterparty;
 *   - a suspended organisation's frozen Home reads every current snapshot, as before (ADR-068).
 */
alter policy metric_snapshots_select on public.metric_snapshots
  using (organization_id in (select app.org_ids_with_permission('financials.view'))
         or (dimension_type = 'counterparty'::public.metric_dimension_enum
             and organization_id in (select app.org_ids_with_permission('customers.view')))
         or (organization_id in (select app.org_ids_with_permission('dashboard.view'))
             and (dimension_type in ('none'::public.metric_dimension_enum, 'standard_category'::public.metric_dimension_enum)
                  or organization_id in (select app.org_ids_with_role('suspended_member')))
             and exists (select 1 from public.metric_current c
                          where c.organization_id = metric_snapshots.organization_id
                            and c.snapshot_id = metric_snapshots.id)));

-- The company profile (website, products and services, description) is shown on Marketing and
-- Investment (`reports.view`) and kept under Customers (`customers.view`).
alter policy organization_profiles_select on public.organization_profiles
  using (organization_id in (select app.org_ids_with_any_permission('reports.view', 'customers.view')));

-- Funding Readiness is a report: `reports.view`, while Funding is on.
alter policy funding_assessments_select on public.funding_assessments
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and app.funding_enabled(organization_id));
alter policy funding_current_select on public.funding_current
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and app.funding_enabled(organization_id));

/*
 * Stored reports. `reports.view` reads the Monthly Management Report and Funding Readiness — the
 * reports a lender or investor is shown. The Daily Brief, the Weekly Intelligence Report and the
 * Accountant/CFO (adviser) report are internal: lists of the day's alerts and overdue actions,
 * movements by account and customer, bank account names — so they also need `financials.view`.
 * A custom AI report stays its author's own. `report_files` follows through its EXISTS on reports
 * (a monthly PDF has no report row and is a Monthly Management Report).
 */
alter policy reports_select on public.reports
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and (report_kind <> 'custom_ai'::public.report_kind_enum or requested_by = (select app.uid()))
         and (report_kind <> 'funding_readiness'::public.report_kind_enum or app.funding_enabled(organization_id))
         and (report_kind in ('monthly_management'::public.report_kind_enum, 'funding_readiness'::public.report_kind_enum)
              or organization_id in (select app.org_ids_with_permission('financials.view'))));

-- The audit log: `audit.view` (switchable), and the super admin for platform events.
alter policy audit_events_select on public.audit_events
  using ((organization_id is not null and organization_id in (select app.org_ids_with_permission('audit.view')))
         or (organization_id is null and app.is_super_admin()));

-- AI: a person's own conversations while they may use the AI; the organisation's staff (owner,
-- admin, Financial Analyst, super admin) everyone's, while THEY may use it.
alter policy ai_conversations_select on public.ai_conversations
  using (organization_id in (select app.org_ids_with_permission('ai.use'))
         and (user_id = app.uid()
              or organization_id in (select app.org_ids_with_role('owner', 'admin', 'employee', 'super_admin'))));
alter policy ai_feedback_select on public.ai_feedback
  using (organization_id in (select app.org_ids_with_permission('ai.use'))
         and (user_id = app.uid()
              or organization_id in (select app.org_ids_with_role('owner', 'admin', 'employee', 'super_admin'))));
alter policy ai_tool_calls_select on public.ai_tool_calls
  using (organization_id in (select app.org_ids_with_permission('ai.use'))
         and organization_id in (select app.org_ids_with_role('owner', 'admin', 'employee', 'super_admin')));

-- ---------------------------------------------------------------------------------------------
-- 10. Re-created from their live definitions, each with only the change described
-- ---------------------------------------------------------------------------------------------

-- Member names for pickers: only for people who see the team or the actions (a 3rd party sees
-- neither, so learns nobody's name). Was: every member of the organisation.
create or replace view public.org_member_profiles as
 SELECT DISTINCT m.organization_id,
    p.id AS user_id,
    p.full_name,
    p.avatar_url
   FROM (organization_memberships m
     JOIN profiles p ON ((p.id = m.user_id)))
  WHERE ((m.status = 'active'::membership_status_enum) AND (m.organization_id IN ( SELECT r.organization_id
           FROM app.accessible_org_roles() r(organization_id, role)))
         AND (m.organization_id IN ( SELECT app.org_ids_with_any_permission('users.view', 'actions.view'))));

-- The acknowledge-only rule as an ALLOW-LIST: the owner, admins, the Financial Analyst and the super
-- admin decide; everyone else holding alerts.manage (client, accountant, a switched-on 3rd party) may
-- acknowledge only. Was: `v_role = 'client'`, which an accountant would have walked past.
CREATE OR REPLACE FUNCTION api.set_alert_status(p_alert uuid, p_status alert_status_enum, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid; v_role text; v_before public.alert_status_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.status into v_org, v_before
    from public.alerts a where a.id = p_alert;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_role := app.require_permission(v_org, 'alerts.manage');

  -- RBAC_MATRIX §2.1: a client's alerts.manage is partial — they may acknowledge that they have seen
  -- something, but resolving or dismissing it is a judgement the organization's staff make.
  -- ADR-172: an allow-list, so the accountant and a switched-on 3rd party are partial too.
  if v_role not in ('owner', 'admin', 'employee', 'super_admin') and p_status <> 'acknowledged' then
    raise exception 'PERMISSION_DENIED: acknowledging is the only status change available to you'
      using errcode = '42501';
  end if;

  update public.alerts
     set status = p_status,
         status_changed_by = app.uid(),
         status_changed_at = now(),
         status_reason_code = 'user',
         status_reason = p_reason,
         -- ADR-047.2: the dismissal instant starts the 90-day cooldown after which the alert may
         -- re-open by itself.
         dismissed_at = case when p_status = 'dismissed' then now() else dismissed_at end
   where organization_id = v_org and id = p_alert;

  perform app.audit(v_org, 'alert.status_changed', 'alerts', p_alert,
                    jsonb_build_object('status', v_before),
                    jsonb_build_object('status', p_status, 'reason', p_reason), '{}'::jsonb);
  return p_alert;
end $function$;

-- The weekly and adviser reports now also need `financials.view` to be opened (reports_select
-- above), so only the people who can open one are told it is ready.
CREATE OR REPLACE FUNCTION app.notify_report_ready()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_person uuid; v_slug text;
begin
  -- The weekly and adviser reports only: a notification every morning for the daily brief would be
  -- noise, and a custom report is its author's own.
  if new.report_kind not in ('weekly_intelligence', 'adviser') then return new; end if;
  select o.slug into v_slug from public.organizations o where o.id = new.organization_id;
  for v_person in select * from app.org_people(new.organization_id) loop
    -- ADR-172: these two kinds are internal reports, readable with financials.view as well.
    continue when not app.has_permission_of(v_person, new.organization_id, 'financials.view');
    perform app.notify(new.organization_id, v_person, new.requested_by, 'reports.view', 'report_ready',
      case new.report_kind when 'weekly_intelligence' then 'Your weekly report is ready' else 'An Accountant/CFO Report is ready' end,
      'Covering ' || new.window_start::text || ' to ' || new.window_end::text || '.',
      '/app/' || v_slug || '/reports/r/' || new.id::text);
  end loop;
  return new;
end $function$;

-- The purge deletes the two new tables (children of organization_memberships) before the memberships.
CREATE OR REPLACE FUNCTION api_server.purge_organization(p_org uuid, p_job uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status    public.org_status_enum;
  v_requested timestamptz;
  v_running   integer;
  v_table     text;
  v_n         integer;
  v_counts    jsonb := '{}'::jsonb;
  v_redacted  integer;
  v_left      integer;
  v_offender  text;
  -- Children before parents, from the FK graph (NO ACTION constraints make the order matter).
  v_order     text[] := array[
    -- Tables added after this list was last written (Phases 11, 12, 14 and Step 0F). The guard
    -- below refused every purge of an organisation holding a row in any of them.
    'scenario_values', 'scenario_runs', 'forecast_values', 'forecast_runs',
    'invoice_lines', 'opportunities', 'campaign_spend', 'campaigns', 'marketing_channels', 'products',
    'report_completeness_attestations',
    -- Funding Readiness (ADR-145): the pointer before the assessments it points at.
    'funding_current', 'funding_assessments',
    -- Marketing (ADR-170): the reports and the company profile.
    'marketing_reports', 'organization_profiles',
    -- Investment (ADR-171): the packs.
    'investment_reports',
    -- Per-person permissions and access requests (ADR-172), children of the memberships.
    'member_permission_overrides', 'access_requests',
    -- Team/Client engagement (ADR-144).
    'notifications', 'engagement_events', 'engagement_items', 'action_comments',
    'evidence_items', 'ai_feedback', 'ai_tool_calls', 'ai_messages', 'ai_conversations',
    'alert_revisions', 'alerts', 'actions', 'report_files', 'reports', 'evidence_bundles',
    'health_current', 'health_scores', 'metric_current', 'metric_snapshots',
    'category_history', 'account_category_history', 'record_status_events',
    'budget_lines', 'bank_transactions', 'recurring_payment_groups', 'ledger_entries', 'invoices',
    'period_balances', 'import_rows', 'calculation_runs', 'import_batches', 'import_mappings',
    'source_documents', 'counterparties', 'bank_accounts', 'accounts', 'fiscal_periods',
    'ownership_transfers', 'invitations', 'organization_assignments', 'organization_memberships',
    'platform_org_settings'
  ];
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));

  select o.status, o.deletion_requested_at into v_status, v_requested
    from public.organizations o where o.id = p_org;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotent: a retry after the rows went (the handler died before the objects did) has nothing
  -- to re-verify and nothing to delete here.
  if v_status = 'deleted' then
    return jsonb_build_object('status', 'already_deleted');
  end if;

  -- The two facts the trigger relied on thirty days ago, re-verified now (§2). A purge running for
  -- an organisation in any other state — cancelled, requeued by hand, a trigger bug — is refused,
  -- and the refusal is a CONFLICT the worker records, not a silent no-op.
  if v_status <> 'pending_deletion' or v_requested is null then
    raise exception 'CONFLICT: % is not scheduled for deletion', p_org using errcode = '23514';
  end if;
  if v_requested > now() - interval '30 days' then
    raise exception 'CONFLICT: % was scheduled for deletion less than 30 days ago (%)', p_org, v_requested
      using errcode = '23514';
  end if;

  -- Zero running jobs of the organisation other than this one. Waiting is not failing: the caller
  -- defers and comes back.
  select count(*) into v_running
    from public.jobs j
   where j.organization_id = p_org and j.status = 'running' and j.id is distinct from p_job;
  if v_running > 0 then
    return jsonb_build_object('status', 'waiting', 'running_jobs', v_running);
  end if;

  -- The append-only guards and the audit redaction policy open for this transaction only.
  perform set_config('app.purge', 'on', true);

  foreach v_table in array v_order loop
    execute format('delete from public.%I where organization_id = $1', v_table) using p_org;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_counts := v_counts || jsonb_build_object(v_table, v_n);
    end if;
  end loop;

  -- Every other job of the organisation goes; this one stays so the worker can record its outcome.
  delete from public.jobs j where j.organization_id = p_org and j.id is distinct from p_job;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    v_counts := v_counts || jsonb_build_object('jobs', v_n);
  end if;

  -- The guard: no base table carrying organization_id may still hold a row for this organisation.
  -- This is what turns "a table was added and this list was not updated" into a loud failure.
  for v_table in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'organization_id'
       and t.table_type = 'BASE TABLE'
       and c.table_name not in ('organizations', 'audit_events', 'jobs')
       and c.table_name not like 'audit_events_%'
       and c.table_name not like 'metric_snapshots_p%'
  loop
    execute format('select count(*) from public.%I where organization_id = $1', v_table)
       into v_left using p_org;
    if v_left > 0 then
      v_offender := v_table;
      exit;
    end if;
  end loop;
  if v_offender is not null then
    raise exception 'CONFLICT: purge left % row(s) in %; the deletion order in api_server.purge_organization needs that table',
      v_left, v_offender using errcode = '23514';
  end if;

  -- The organisation row survives, marked. `profiles.last_active_org_id` would have been nulled by
  -- its FK had the row gone; it has not, so it is nulled here.
  update public.organizations
     set status = 'deleted', deleted_at = now()
   where id = p_org;
  update public.profiles set last_active_org_id = null where last_active_org_id = p_org;

  -- Redaction (ADR-038.9): the events survive as the record that things happened; what they
  -- carried of the customer's data does not. This runs AFTER the status update so that update's
  -- own audit diff is redacted with the rest.
  update public.audit_events
     set before = null, after = null, metadata = '{}'::jsonb, ip = null, user_agent = null
   where organization_id = p_org;
  get diagnostics v_redacted = row_count;

  perform set_config('app.purge', 'off', true);

  -- Written last, so it is the one event about this organisation that keeps a payload — `after`
  -- holds counts, and nothing that was in the rows.
  perform app.audit(p_org, 'org.purged', 'organizations', p_org, null,
                    jsonb_build_object('rows', v_counts, 'audit_events_redacted', v_redacted,
                                       'job_id', p_job),
                    '{}'::jsonb, null);

  return jsonb_build_object('status', 'purged', 'rows', v_counts,
                            'audit_events_redacted', v_redacted);
end $function$;
