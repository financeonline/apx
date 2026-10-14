-- APX — Per-person switches that hold: never beyond the actor's own rights, on EVERY path that sets a
-- person's access (ADR-172 hardening; independent security review, 2026-10-14, finding HIGH 2).
--
-- ADR-172 enforced "never beyond your own rights" on the switch itself (`app.apply_member_permission`)
-- but not on the three other ways a person's access is set, and it let a role change wipe whatever an
-- owner had decided. The review reproduced each of these (probe p2):
--
--   A. An admin whose `financials.view` the owner had switched OFF changed their OWN role to
--      accountant: the role change cleared their switches, and they read the ledger again.
--   B. The owner switched a client's `financials.view` off. An admin who did not hold
--      `financials.view` themselves moved the client to accountant and back: the role change cleared
--      the owner's switch, and the client read the ledger again — given back by somebody who could
--      not have switched it on.
--   B2. The same admin moved a 3rd party to accountant: the accountant's defaults (the ledger, the
--      documents) arrived in full, though the admin held neither.
--   C. The same admin invited a new admin: the invitation's role defaults arrived in full on
--      acceptance.
--
-- What this file does (each function re-created from its LIVE definition, `pg_get_functiondef`,
-- 2026-10-14, with only the change described):
--
--   1. `member_permission_overrides` records WHO KIND of person set each switch, at the time it was
--      set: `set_by_owner` (an owner or the super admin) — stored, never derived later from whatever
--      the setter's role has since become — and `ceiling_withhold` (a switch-off written by the rules
--      below because the actor lacked the permission, not because anybody chose it). Existing rows
--      are backfilled once from their setter's role today: the only time it is derived.
--   2. `app.apply_member_permission`: an admin may neither change nor reset (nor, through
--      `api.decide_access_request`, approve over) a switch an owner set. The owner's decision about
--      a person is the owner's; an admin who disagrees asks the owner. It stamps `set_by_owner` on
--      every write and clears `ceiling_withhold` (whoever writes the switch now owns it).
--   3. `api.change_member_role`: never one's OWN role (A). Leaving stays `api.leave_organization`;
--      an owner steps down through the ownership transfer. Replaces the narrower "no self-elevation"
--      check, which this one contains.
--   4. `app.member_role_changed` (the trigger behind every role change): the switches an OWNER set
--      are CARRIED into the new role — dropped only when the new role takes no switches at all (an
--      owner) — and every other switch is cleared, as before (B). A carried switch is kept even where
--      it now repeats the new role's default: dropping it would let a LATER role change by somebody
--      else lose the owner's decision. Then the ceiling: every switchable permission the new role
--      gives by default that the ACTOR does not effectively hold is stored as a switch-off
--      (`ceiling_withhold`, set by the actor) unless an owner's switch for it was carried (B2). An
--      owner or the super admin holds everything, so they withhold nothing. Audited
--      `member.permissions_reset` with what there was, what is left, and what was carried, cleared
--      and withheld.
--   5. Invitations (C): `api.invite_member_with_token` works out, at invite time, the switchable
--      permissions the invited role gives by default that the INVITER does not hold, and stores them
--      on the invitation (`invitations.withheld_permissions`); `api.accept_invitation` creates those
--      switch-offs as the membership is created — together with any the inviter has lost SINCE
--      (acceptance already re-checks that the inviter can still grant the role, F-A-02; this is the
--      same re-check for their rights). An owner or the super admin inviting withholds nothing.
--      `api.invite_member` is a wrapper over `invite_member_with_token` and needs no change.
--   6. `api.org_member_permissions` (the team page) returns each switch's `set_by_owner` and
--      `ceiling_withhold`, so the page can lock an owner's switch for an admin rather than offer a
--      button the database will refuse.
--
-- pgTAP 31_member_access_hardening proves each of A, B, B2 and C closed, and the owner's lock.

-- ---------------------------------------------------------------------------------------------
-- 1. Who set the switch
-- ---------------------------------------------------------------------------------------------
alter table public.member_permission_overrides
  add column set_by_owner boolean not null default false,
  add column ceiling_withhold boolean not null default false;

-- A ceiling withhold is a switch-off by an actor who is not an owner (an owner withholds nothing).
alter table public.member_permission_overrides
  add constraint member_permission_overrides_withhold_is_off
  check (not ceiling_withhold or (granted = false and not set_by_owner));

comment on column public.member_permission_overrides.set_by_owner is
  'Set by an owner or the super admin, as they were AT THE TIME it was set (stored, never derived later). An admin may not change or reset it; a role change carries it into the new role.';
comment on column public.member_permission_overrides.ceiling_withhold is
  'A switch-off written by a role change or an invitation because the actor did not hold the permission (never beyond the actor''s own rights), not because anybody chose it.';

-- The one-time backfill: the setter's role today is the best evidence there is for rows written
-- before the column existed (ADR-172 landed the same day, so these are few).
update public.member_permission_overrides o
   set set_by_owner = true
 where exists (select 1 from public.organization_memberships m
                where m.organization_id = o.organization_id and m.user_id = o.set_by
                  and m.role = 'owner' and m.status = 'active')
    or exists (select 1 from public.platform_users p
                where p.user_id = o.set_by and p.platform_role = 'super_admin');

alter table public.invitations
  add column withheld_permissions text[] not null default '{}'::text[]
  constraint invitations_withheld_switchable check (withheld_permissions <@ app.switchable_permissions());
comment on column public.invitations.withheld_permissions is
  'ADR-172 hardening: the invited role''s default switchable permissions the inviter did not hold when inviting; switched off for the new member on acceptance.';

-- ---------------------------------------------------------------------------------------------
-- 2. app.apply_member_permission — an owner's switch is the owner's
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
 *   - never a switch an OWNER set, unless the caller is an owner or the super admin (2026-10-14);
 *   - never beyond the caller's own rights: switching ON needs the caller to hold that permission,
 *     and so does ANY change that leaves the person holding something they did not hold before (a
 *     reset to a default that grants it, after an owner had switched it off).
 *
 * The membership row is locked first, so a concurrent role change or removal serialises with this.
 * Audited `member.permission_changed` with the switch and the effective answer before and after.
 * Returns whether anything changed.
 */
CREATE OR REPLACE FUNCTION app.apply_member_permission(p_org uuid, p_user uuid, p_permission text, p_granted boolean, p_actor_role text, p_metadata jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor      uuid := app.uid();
  v_target     text;
  v_status     text;
  v_before     boolean;
  v_before_by_owner boolean;
  v_default    boolean;
  v_eff_before boolean;
  v_eff_after  boolean;
  -- An ALLOW-LIST (R2-A-07): the roles whose switches an admin may not touch.
  v_owner_actor constant boolean := coalesce(p_actor_role in ('owner', 'super_admin'), false);
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

  select o.granted, o.set_by_owner into v_before, v_before_by_owner
    from public.member_permission_overrides o
   where o.organization_id = p_org and o.user_id = p_user and o.permission = p_permission;

  -- 2026-10-14 (review HIGH 2): an owner's decision about a person is not an admin's to undo — not
  -- by a switch, not by a reset, not by approving a request over it. Checked before the "nothing to
  -- do" answer, so an admin never learns more by trying than the team page already shows.
  if coalesce(v_before_by_owner, false) and not v_owner_actor then
    raise exception 'PERMISSION_DENIED: the owner set this switch; only an owner can change it'
      using errcode = '42501';
  end if;

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
    -- Whoever writes the switch now owns it: its `set_by_owner` is theirs, and it is no longer a
    -- ceiling withhold but a decision.
    insert into public.member_permission_overrides as o
      (organization_id, user_id, permission, granted, set_by, set_at, set_by_owner, ceiling_withhold)
    values (p_org, p_user, p_permission, p_granted, v_actor, now(), v_owner_actor, false)
    on conflict (organization_id, user_id, permission)
      do update set granted = excluded.granted, set_by = excluded.set_by, set_at = excluded.set_at,
                    set_by_owner = excluded.set_by_owner, ceiling_withhold = false;
  end if;

  perform app.audit(p_org, 'member.permission_changed', 'organization_memberships', p_user,
                    jsonb_build_object('permission', p_permission, 'override', v_before, 'effective', v_eff_before),
                    jsonb_build_object('permission', p_permission, 'override', p_granted, 'effective', v_eff_after),
                    jsonb_build_object('role', v_target, 'set_by_owner', v_owner_actor) || coalesce(p_metadata, '{}'::jsonb));
  return true;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 3. api.change_member_role — never one's own role
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.change_member_role(p_org uuid, p_user uuid, p_role membership_role_enum)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role    text;
  v_current text;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  v_role := app.require_permission(p_org, 'users.manage');

  -- Never one's OWN role, in either direction (2026-10-14, review HIGH 2 "A"). A self-demotion was a
  -- way round the owner's switches — the role change cleared them — and there is no honest need for
  -- it: leaving is `api.leave_organization`, and an owner steps down through the ownership transfer.
  -- This contains the old "no self-elevation" rule (RBAC_MATRIX.md §3.3), which it replaces.
  if p_user = app.uid() then
    raise exception 'PERMISSION_DENIED: you cannot change your own role' using errcode = '42501';
  end if;

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

  -- The trigger `member_role_changed` carries the owner's switches, clears the rest and withholds
  -- what this caller does not hold (§4 of 20261018000032).
  update public.organization_memberships set role = p_role
   where organization_id = p_org and user_id = p_user;

  perform app.audit(p_org, 'member.role_changed', 'organization_memberships', p_user,
                    jsonb_build_object('role', v_current), jsonb_build_object('role', p_role), '{}'::jsonb);
  return p_user;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 4. app.member_role_changed — carry the owner's switches, clear the rest, withhold beyond the actor
-- ---------------------------------------------------------------------------------------------
/*
 * Fires for every path that changes a role: api.change_member_role, the ownership transfer, the
 * super admin's company-owner tools, and a superuser's hand edit.
 *
 *   1. CARRY: a switch an owner (or the super admin) set stays, unless the new role takes no switches
 *      (an owner holds everything, and a switch kept against an owner would silently come back on a
 *      later demotion). Every other switch was chosen against the OLD role by somebody whose choice
 *      the next role change may revisit, and is cleared — as ADR-172 always did.
 *   2. WITHHOLD: for every switchable permission the NEW role gives by default that the actor
 *      (`app.uid()`) does not effectively hold, a switch-off — `ceiling_withhold`, set by the actor —
 *      unless an owner's switch for it was carried. The actor's own role and switches decide
 *      (`app.has_permission`), so an owner or the super admin withholds nothing. No actor (a server or
 *      superuser path, which no user can reach) withholds nothing; nor does a person changing their
 *      own role, which only the ownership transfer does (to owner, which takes no switches).
 *   3. A waiting request was asked of the old role: closed, with a note the requester reads.
 *
 * Audited once, `member.permissions_reset`: before = the role and every switch there was; after = the
 * new role and every switch there is now; metadata = what was carried, cleared and withheld.
 */
CREATE OR REPLACE FUNCTION app.member_role_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := app.uid();
  v_takes    boolean := app.overridable_role(new.role::text);
  v_before   jsonb;
  v_cleared  jsonb;
  v_carried  jsonb;
  v_withheld jsonb;
  v_after    jsonb;
  v_closed   integer;
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  select jsonb_agg(jsonb_build_object('permission', o.permission, 'granted', o.granted,
                                      'set_by_owner', o.set_by_owner) order by o.permission)
    into v_before
    from public.member_permission_overrides o
   where o.organization_id = new.organization_id and o.user_id = new.user_id;

  -- 1. Carry the owner's switches; clear the rest.
  with gone as (
    delete from public.member_permission_overrides o
     where o.organization_id = new.organization_id and o.user_id = new.user_id
       and (not v_takes or not o.set_by_owner)
    returning o.permission, o.granted
  )
  select jsonb_agg(jsonb_build_object('permission', g.permission, 'granted', g.granted) order by g.permission)
    into v_cleared from gone g;

  select jsonb_agg(jsonb_build_object('permission', o.permission, 'granted', o.granted) order by o.permission)
    into v_carried
    from public.member_permission_overrides o
   where o.organization_id = new.organization_id and o.user_id = new.user_id;

  -- 2. Never beyond the actor's own rights.
  if v_takes and v_actor is not null and v_actor <> new.user_id then
    with withheld as (
      insert into public.member_permission_overrides as o
        (organization_id, user_id, permission, granted, set_by, set_at, set_by_owner, ceiling_withhold)
      select new.organization_id, new.user_id, rp.permission, false, v_actor, now(), false, true
        from public.role_permissions rp
       where rp.role = new.role::text
         and rp.permission = any (app.switchable_permissions())
         and not app.has_permission(new.organization_id, rp.permission)
         and not exists (select 1 from public.member_permission_overrides c
                          where c.organization_id = new.organization_id and c.user_id = new.user_id
                            and c.permission = rp.permission)
      returning o.permission
    )
    select jsonb_agg(to_jsonb(w.permission) order by w.permission) into v_withheld from withheld w;
  end if;

  -- 3. The waiting request was asked of the old role.
  update public.access_requests r
     set status = 'declined', decided_at = now(), decided_by = app.uid(),
         note = 'Closed because your role changed. Ask again if you still need more access.'
   where r.organization_id = new.organization_id and r.requester_id = new.user_id
     and r.status = 'pending';
  get diagnostics v_closed = row_count;

  select jsonb_agg(jsonb_build_object('permission', o.permission, 'granted', o.granted,
                                      'set_by_owner', o.set_by_owner,
                                      'ceiling_withhold', o.ceiling_withhold) order by o.permission)
    into v_after
    from public.member_permission_overrides o
   where o.organization_id = new.organization_id and o.user_id = new.user_id;

  if v_before is not null or v_withheld is not null or v_closed > 0 then
    perform app.audit(new.organization_id, 'member.permissions_reset', 'organization_memberships', new.user_id,
                      jsonb_build_object('role', old.role, 'overrides', coalesce(v_before, '[]'::jsonb)),
                      jsonb_build_object('role', new.role, 'overrides', coalesce(v_after, '[]'::jsonb)),
                      jsonb_build_object('reason', 'role_changed', 'requests_closed', v_closed,
                                         'carried', coalesce(v_carried, '[]'::jsonb),
                                         'cleared', coalesce(v_cleared, '[]'::jsonb),
                                         'withheld', coalesce(v_withheld, '[]'::jsonb)));
  end if;
  return new;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 5. Invitations — the inviter's ceiling travels with the invitation
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.invite_member_with_token(p_org uuid, p_email text, p_role membership_role_enum)
 RETURNS TABLE(invitation_id uuid, token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role  text;
  v_email extensions.citext := lower(trim(p_email))::extensions.citext;
  v_token text;
  v_id    uuid;
  v_withheld text[];
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
    raise exception 'CONFLICT: that address belongs to an APX platform account' using errcode = '23505';
  end if;

  -- 2026-10-14 (review HIGH 2 "C"): never beyond the inviter's own rights. The invited role's
  -- default switchable permissions the inviter does not hold travel with the invitation and are
  -- switched off when it is accepted. An owner or the super admin holds everything (none); an owner
  -- invitation takes no switches at all.
  v_withheld := case
    when app.overridable_role(p_role::text) then
      array(select rp.permission from public.role_permissions rp
             where rp.role = p_role::text
               and rp.permission = any (app.switchable_permissions())
               and not app.has_permission(p_org, rp.permission)
             order by 1)
    else '{}'::text[]
  end;

  -- The raw token is returned once to the caller and never stored; only its SHA-256 is persisted
  -- (SECURITY_MODEL.md §3).
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.invitations (organization_id, email, role, token_hash, invited_by, withheld_permissions)
  values (p_org, v_email, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), app.uid(), v_withheld)
  returning id into v_id;

  perform app.audit(p_org, 'member.invited', 'invitations', v_id, null,
                    jsonb_build_object('role', p_role, 'withheld', to_jsonb(v_withheld)),
                    jsonb_build_object('invitation_id', v_id));

  invitation_id := v_id;
  token := v_token;
  return next;
exception
  when unique_violation then
    raise exception 'CONFLICT: an invitation for that address is already pending' using errcode = '23505';
end $function$;

CREATE OR REPLACE FUNCTION api.accept_invitation(p_token text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor      uuid := app.uid();
  v_hash       text := encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  v_inv        public.invitations%rowtype;
  v_inviter    text;
  v_withheld   text[] := '{}'::text[];
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

  -- 2026-10-14 (review HIGH 2 "C"): never beyond the inviter's own rights — what they lacked when
  -- they invited (stored on the invitation) and, as F-A-02 re-checks their ROLE at acceptance, what
  -- they lack NOW. Each becomes a switch-off set by the inviter, marked as a ceiling withhold. An
  -- owner or the super admin holds everything; an owner invitation takes no switches.
  if app.overridable_role(v_inv.role::text) then
    v_withheld := array(
      select distinct w.permission
        from (select unnest(v_inv.withheld_permissions) as permission
              union
              select rp.permission from public.role_permissions rp
               where rp.role = v_inv.role::text
                 and rp.permission = any (app.switchable_permissions())
                 and not app.has_permission_of(v_inv.invited_by, v_inv.organization_id, rp.permission)) w
       where w.permission = any (app.switchable_permissions())
       order by 1);
    insert into public.member_permission_overrides
      (organization_id, user_id, permission, granted, set_by, set_at, set_by_owner, ceiling_withhold)
    select v_inv.organization_id, v_actor, w, false, v_inv.invited_by, now(), false, true
      from unnest(v_withheld) w;
  end if;

  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_actor
   where id = v_inv.id;

  update public.profiles set last_active_org_id = v_inv.organization_id where id = v_actor;

  perform app.audit(v_inv.organization_id, 'member.joined', 'organization_memberships', v_actor,
                    null, jsonb_build_object('role', v_inv.role, 'withheld', to_jsonb(v_withheld)), '{}'::jsonb);
  perform app.audit(v_inv.organization_id, 'member.invitation_accepted', 'invitations', v_inv.id,
                    null, null, '{}'::jsonb);

  perform set_config('app.bootstrap', 'off', true);
  return v_inv.organization_id;
exception
  when unique_violation then
    raise exception 'CONFLICT: you are already a member of that organization' using errcode = '23505';
end $function$;

-- ---------------------------------------------------------------------------------------------
-- 6. api.org_member_permissions — who set each switch
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.org_member_permissions(p_org uuid)
 RETURNS TABLE(user_id uuid, full_name text, email text, role text, status text, overrides jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform app.require_permission(p_org, 'users.view');
  return query
    select m.user_id, pr.full_name, pr.email::text, m.role::text, m.status::text,
           coalesce((select jsonb_agg(jsonb_build_object('permission', o.permission, 'granted', o.granted,
                                                         'set_by_owner', o.set_by_owner,
                                                         'ceiling_withhold', o.ceiling_withhold)
                                      order by o.permission)
                       from public.member_permission_overrides o
                      where o.organization_id = p_org and o.user_id = m.user_id), '[]'::jsonb)
      from public.organization_memberships m
      join public.profiles pr on pr.id = m.user_id
     where m.organization_id = p_org
     order by m.role, pr.full_name nulls last, pr.email;
end $function$;
