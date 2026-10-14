-- APX — An action created with an owner obeys the same rule as an action assigned to one (ADR-172
-- follow-up to 20261018000031; security review, 2026-10-14).
--
-- 20261018000031 made `api.assign_action` refuse an assignee who cannot open the Action Centre
-- (`actions.view`). The three functions that CREATE an action also accept an owner, and were left
-- behind:
--
--   - `api.create_action` asked only that the owner resolve to SOME role in the organisation
--     (`app.org_role_of(...) is not null`) — a 3rd party, a client whose Action Centre switch is off,
--     or the super admin qualified;
--   - `api.create_action_from_alert` and `api.create_action_from_recommendation` checked the owner
--     not at all: ANY uuid, a stranger's or another company's member's, was written as the owner.
--
-- And none asked whether the CALLER may give work to somebody: `actions.assign` is what
-- `api.assign_action` requires, but naming somebody else as the owner at creation needed only
-- `actions.create` — which the accountant holds without `actions.assign`. Nothing in the interface
-- sets an owner on creation; these were reachable by calling the database directly.
--
-- Now, in all three (each re-created from its LIVE definition, `pg_get_functiondef`, 2026-10-14, with
-- only this added), through one helper so they cannot disagree:
--
--   `app.check_action_owner(org, owner)`: NULL (nobody yet) is fine. Otherwise the owner must be an
--   active member or an assigned Financial Analyst of the organisation (`app.org_people`, the set the
--   assignee picker `api.action_assignees` offers) who holds `actions.view` (`app.has_permission_of`,
--   switches included) — else VALIDATION, worded as `api.assign_action` words it; and naming somebody
--   OTHER than oneself is assigning, so it needs the caller's `actions.assign` — else
--   PERMISSION_DENIED. Taking an action on oneself needs only `actions.create`, as before.

create function app.check_action_owner(p_org uuid, p_owner uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_owner is null then
    return;
  end if;
  if not exists (select 1 from app.org_people(p_org) as person(id) where person.id = p_owner) then
    raise exception 'VALIDATION: that person has no access to this organization' using errcode = '22023';
  end if;
  if not app.has_permission_of(p_owner, p_org, 'actions.view') then
    raise exception 'VALIDATION: that person cannot see the Action Centre, so an action cannot be given to them'
      using errcode = '22023';
  end if;
  if p_owner is distinct from app.uid() and not app.has_permission(p_org, 'actions.assign') then
    raise exception 'PERMISSION_DENIED: actions.assign is required to give an action to somebody else'
      using errcode = '42501';
  end if;
end $$;
alter function app.check_action_owner(uuid, uuid) owner to motion_definer;
revoke all on function app.check_action_owner(uuid, uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION api.create_action(p_org uuid, p_input jsonb, p_source jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id       uuid;
  v_owner    uuid := (p_input ->> 'owner_user_id')::uuid;
  v_src_type public.action_source_enum := coalesce((p_source ->> 'type')::public.action_source_enum, 'user');
  v_src_id   uuid := (p_source ->> 'id')::uuid;
  v_grounded public.grounding_status_enum;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'actions.create');

  if coalesce(trim(p_input ->> 'title'), '') = '' then
    raise exception 'VALIDATION: a title is required' using errcode = '22023';
  end if;

  -- ADR-032.5: an action may be created from an AI answer only if that answer passed grounding.
  -- Without this, a failed or degraded answer could be laundered into a task that looks authoritative.
  if v_src_type = 'ai' then
    select m.grounding_status into v_grounded
      from public.ai_messages m where m.organization_id = p_org and m.id = v_src_id;
    if v_grounded is null then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_grounded <> 'passed' then
      raise exception 'VALIDATION: an action cannot be created from an ungrounded answer'
        using errcode = '22023';
    end if;
  end if;

  -- The owner must be somebody who can open the action — an active member or an assigned Financial
  -- Analyst holding `actions.view` — and naming somebody else is assigning (`actions.assign`), as in
  -- `api.assign_action` (20261018000035; was: any role in the organisation).
  perform app.check_action_owner(p_org, v_owner);

  insert into public.actions
         (organization_id, title, issue, recommendation, priority, owner_user_id, due_date,
          source_type, source_id, created_by)
  values (p_org, trim(p_input ->> 'title'), p_input ->> 'issue', p_input ->> 'recommendation',
          coalesce((p_input ->> 'priority')::public.action_priority_enum, 'medium'),
          v_owner, (p_input ->> 'due_date')::date, v_src_type, v_src_id, app.uid())
  returning id into v_id;

  perform app.audit(p_org, 'action.created', 'actions', v_id, null,
                    jsonb_build_object('title', trim(p_input ->> 'title'),
                                       'source_type', v_src_type), '{}'::jsonb);
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION api.create_action_from_alert(p_alert uuid, p_input jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org      uuid;
  v_severity public.severity_enum;
  v_priority public.action_priority_enum;
  v_revision uuid;
  v_rev_no   integer;
  v_bundle   uuid;
  v_title    text;
  v_action   uuid;
  v_owner    uuid := nullif(p_input ->> 'owner_user_id', '')::uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.current_revision_id, a.severity into v_org, v_revision, v_severity
    from public.alerts a where a.id = p_alert;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.create');

  -- 20261018000035: the owner, if one is named, as `api.assign_action` would accept them (was: any id).
  perform app.check_action_owner(v_org, v_owner);

  select r.revision_no, r.evidence_bundle_id into v_rev_no, v_bundle
    from public.alert_revisions r
   where r.organization_id = v_org and r.id = v_revision;

  /*
   * ADR-098: the priority of an action made from an alert is the ALERT'S severity, and nothing
   * else. It used to be `coalesce(p_input->>'priority', 'medium')`, and the caller never sent one —
   * so every action converted from an alert was `medium`, a critical one included, and the Action
   * Centre sorted a critical finding below a task somebody typed in by hand.
   *
   * A caller-supplied priority is IGNORED here rather than rejected: the conversion is one click on
   * an alert, and failing it over a field the interface does not offer would be a worse answer than
   * using the severity the rule already decided. Changing it afterwards is `api.update_action`,
   * which needs the permission and is audited — so a considered change is possible and an
   * unconsidered one cannot happen.
   *
   * `info` has no counterpart in the four priorities and maps to `low`: an informational alert is
   * the least urgent thing that could still be worth doing.
   */
  v_priority := case v_severity
    when 'critical' then 'critical'::public.action_priority_enum
    when 'high'     then 'high'::public.action_priority_enum
    when 'medium'   then 'medium'::public.action_priority_enum
    when 'low'      then 'low'::public.action_priority_enum
    when 'info'     then 'low'::public.action_priority_enum
  end;

  v_title := coalesce(nullif(trim(p_input ->> 'title'), ''),
                      (select a.title from public.alerts a where a.id = p_alert));

  insert into public.actions
         (organization_id, title, issue, recommendation, priority, owner_user_id, due_date,
          source_type, source_id, created_by)
  values (v_org, v_title,
          coalesce(p_input ->> 'issue',
                   (select r.explanation from public.alert_revisions r where r.id = v_revision)),
          coalesce(p_input ->> 'recommendation',
                   (select a.recommended_next_step from public.alerts a where a.id = p_alert)),
          v_priority,
          v_owner,
          (p_input ->> 'due_date')::date,
          'alert', p_alert, app.uid())
  returning id into v_action;

  update public.actions
     set evidence_bundle_id = app.clone_bundle_for_action(v_org, v_bundle, v_action)
   where organization_id = v_org and id = v_action;

  -- The alert points back, so the list can show "converted" rather than offering the button twice.
  update public.alerts set action_id = v_action
   where organization_id = v_org and id = p_alert;

  perform app.audit(v_org, 'alert.converted_to_action', 'alerts', p_alert, null,
                    jsonb_build_object('action_id', v_action, 'revision_no', v_rev_no,
                                       'severity', v_severity, 'priority', v_priority), '{}'::jsonb);
  perform app.audit(v_org, 'action.created', 'actions', v_action, null,
                    jsonb_build_object('title', v_title, 'source_type', 'alert'), '{}'::jsonb);
  return v_action;
end $function$;

CREATE OR REPLACE FUNCTION api.create_action_from_recommendation(p_message uuid, p_index integer, p_input jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org      uuid;
  v_status   public.grounding_status_enum;
  v_response jsonb;
  v_bundle   uuid;
  v_rec      jsonb;
  v_action   uuid;
  v_title    text;
  v_owner    uuid := nullif(p_input ->> 'owner_user_id', '')::uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select m.organization_id, m.grounding_status, m.structured_response, m.evidence_bundle_id
    into v_org, v_status, v_response, v_bundle
    from public.ai_messages m where m.id = p_message;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.create');

  if v_status <> 'passed' then
    raise exception 'VALIDATION: an action cannot be created from an ungrounded answer'
      using errcode = '22023';
  end if;

  -- 20261018000035: the owner, if one is named, as `api.assign_action` would accept them (was: any id).
  perform app.check_action_owner(v_org, v_owner);

  v_rec := v_response -> 'recommended_actions' -> p_index;
  if v_rec is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The three Statement texts, copied verbatim (§4.13). The model wrote them and grounding passed
  -- them; re-writing them here would put words in the analyst's mouth that nothing checked.
  v_title := coalesce(nullif(trim(p_input ->> 'title'), ''), v_rec -> 'title' ->> 'statement');
  if coalesce(trim(v_title), '') = '' then
    raise exception 'VALIDATION: a title is required' using errcode = '22023';
  end if;

  insert into public.actions
         (organization_id, title, issue, recommendation, priority, owner_user_id, due_date,
          source_type, source_id, created_by)
  values (v_org, v_title,
          v_rec -> 'issue' ->> 'statement',
          v_rec -> 'recommendation' ->> 'statement',
          coalesce((v_rec ->> 'priority')::public.action_priority_enum, 'medium'),
          v_owner,
          (p_input ->> 'due_date')::date,
          'ai', p_message, app.uid())
  returning id into v_action;

  update public.actions
     set evidence_bundle_id = app.clone_bundle_for_action(v_org, v_bundle, v_action)
   where organization_id = v_org and id = v_action;

  perform app.audit(v_org, 'action.created', 'actions', v_action, null,
                    jsonb_build_object('title', v_title, 'source_type', 'ai',
                                       'message_id', p_message), '{}'::jsonb);
  return v_action;
end $function$;
