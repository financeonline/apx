-- MOTION — An action is given only to someone who can see the Action Centre (ADR-172 follow-up).
--
-- ADR-172 made `actions.view` a per-person permission and gave the 3rd party role none of it: a
-- lender or investor reads the overview and the reports, not the company's to-do list. But
-- `api.assign_action` only asked whether the assignee had ANY access to the organisation
-- (`app.org_role_of(...) is not null`), so an owner could hand an action to a 3rd party — or to a
-- client whose Action Centre switch is off — who would then be "responsible" for work they cannot
-- open, read or move, and whose name would sit on it while they never saw it.
--
--   1. `api.assign_action` — re-created from its LIVE definition (`pg_get_functiondef`, 2026-10-14)
--      with ONE added check: the assignee must hold `actions.view` in the organisation, through
--      `app.has_permission_of` (switch-aware, the same helper `app.notify` uses for every recipient).
--      Clearing the owner (`p_owner` NULL) is unchanged. Everything else — the throttle, NOT FOUND for
--      another organisation's action, `actions.assign`, the audit row — is exactly as it stood.
--
--   2. `api.action_assignees(p_org)` — NEW: the people an action may be given to, for the assignee
--      picker: the organisation's active members and active assigned Financial Analysts
--      (`app.org_people`, as the notifications use) who hold `actions.view`, with their names. It asks
--      `actions.assign`, the permission the picker exists for. Until now the picker read
--      `api.org_members`, which needs `users.view` — a permission the Financial Analyst does not hold
--      (ADR-037), so the action page failed for the very person most likely to assign work — and it
--      listed people the function above now refuses. Names only, never e-mail addresses: an analyst
--      or an admin assigning work learns no more than `org_member_profiles` already shows an
--      `actions.view` holder.
--
-- Nothing here reads or writes a tenant table outside those two functions.

-- ---------------------------------------------------------------------------------------------
-- 1. api.assign_action, with the assignee's `actions.view` checked
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.assign_action(p_action uuid, p_owner uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid; v_before uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.owner_user_id into v_org, v_before
    from public.actions a where a.id = p_action;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.assign');

  if p_owner is not null and app.org_role_of(p_owner, v_org) is null then
    raise exception 'VALIDATION: that person has no access to this organization' using errcode = '22023';
  end if;
  -- ADR-172: an action goes only to someone who can open it (`actions.view`, switches included).
  if p_owner is not null and not app.has_permission_of(p_owner, v_org, 'actions.view') then
    raise exception 'VALIDATION: that person cannot see the Action Centre, so an action cannot be given to them'
      using errcode = '22023';
  end if;

  update public.actions set owner_user_id = p_owner
   where organization_id = v_org and id = p_action;

  perform app.audit(v_org, 'action.assigned', 'actions', p_action,
                    jsonb_build_object('owner_user_id', v_before),
                    jsonb_build_object('owner_user_id', p_owner), '{}'::jsonb);
  return p_action;
end $function$;
alter function api.assign_action(uuid, uuid) owner to motion_definer;
revoke all on function api.assign_action(uuid, uuid) from public, anon;
grant execute on function api.assign_action(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. api.action_assignees — who the picker may offer
-- ---------------------------------------------------------------------------------------------
create function api.action_assignees(p_org uuid)
returns table (user_id uuid, full_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_org, 'actions.assign');
  return query
    select pr.id, nullif(btrim(pr.full_name), '')::text
      from app.org_people(p_org) as person(id)
      join public.profiles pr on pr.id = person.id
     where app.has_permission_of(person.id, p_org, 'actions.view')
     order by pr.full_name nulls last, pr.id;
end $$;
alter function api.action_assignees(uuid) owner to motion_definer;
revoke all on function api.action_assignees(uuid) from public, anon;
grant execute on function api.action_assignees(uuid) to authenticated;
