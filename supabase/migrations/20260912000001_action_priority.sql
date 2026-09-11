-- MOTION — Phase 10 · The Action Centre: priority comes from the rule, not from the caller.
-- Contract: SOW §17; FINANCIAL_ENGINE.md §8.2 (alert severity); RBAC_MATRIX.md §2.1; ADR-098.
--
-- WHAT WAS WRONG. `api.create_action_from_alert` copied the alert's title, its explanation and its
-- recommended next step, and then set priority to
-- `coalesce((p_input ->> 'priority')::action_priority_enum, 'medium')`. The alert's `severity` — the
-- thing the rule actually decided — was never read, and the one caller in the product
-- (`createFromAlert(ctx, alertId)`) sends no priority at all.
--
-- So EVERY action converted from an alert was `medium`. A `critical` cash-runway alert became a
-- medium task, and the Action Centre sorted it below something a person typed in by hand. The field
-- was there, the value was wrong, and nothing said so.
--
-- THE RULE. Severity maps to priority, identity across the four shared values, `info` → `low`. A
-- caller-supplied priority is ignored on this path; changing it afterwards is `api.update_action`,
-- which requires the permission and is audited. The derivation is recorded on the audit row, so
-- "why is this critical?" is answerable from the trail rather than from the code.
--
-- Deliberately NOT added: a proposed due date. Nothing in the alert rules carries one, and inventing
-- "seven days" would be a business deadline MOTION made up.

create or replace function api.create_action_from_alert(p_alert uuid, p_input jsonb DEFAULT '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $motion$
declare
  v_org      uuid;
  v_severity public.severity_enum;
  v_priority public.action_priority_enum;
  v_revision uuid;
  v_rev_no   integer;
  v_bundle   uuid;
  v_title    text;
  v_action   uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select a.organization_id, a.current_revision_id, a.severity into v_org, v_revision, v_severity
    from public.alerts a where a.id = p_alert;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'actions.create');

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
          nullif(p_input ->> 'owner_user_id', '')::uuid,
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
end $motion$;

alter function api.create_action_from_alert(uuid, jsonb) owner to motion_definer;
revoke all on function api.create_action_from_alert(uuid, jsonb) from public, anon;
grant execute on function api.create_action_from_alert(uuid, jsonb) to authenticated;
