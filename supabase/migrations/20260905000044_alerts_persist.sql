-- MOTION — Phase 7 (plan Phase 9) · Persisting alerts.
-- Contract: FINANCIAL_ENGINE.md §8.1/§8.3; DATABASE_ARCHITECTURE.md §6 (`alerts`, `alert_revisions`,
-- `evidence_bundles`, `evidence_items`); ADR-018, ADR-034, ADR-036, ADR-047.2/11, ADR-056.
--
-- ONE function, applying a whole run's planned changes in ONE transaction.
--
-- That is not a convenience. The alert list is what a person acts on, and a half-applied run would
-- show some alerts re-evaluated and others still describing last month, with no way for a reader to
-- tell which is which. Every insert, revision, status change and resolution of a run therefore lands
-- together or not at all.
--
-- The PLAN is computed in TypeScript (`alerts/domain/evaluate.ts`), which is where the rules, the
-- cap and the lifecycle live and where they can be tested without a database. This function does not
-- decide anything: it writes what it is given, and refuses what it must not write.

create function api_server.persist_alerts(
  p_org     uuid,
  p_run     uuid,
  p_changes jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_change      jsonb;
  v_alert       uuid;
  v_bundle      uuid;
  v_revision    integer;
  v_before      jsonb;
  v_inserted    integer := 0;
  v_revised     integer := 0;
  v_touched     integer := 0;
  v_resolved    integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  if not exists (select 1 from public.calculation_runs r
                  where r.organization_id = p_org and r.id = p_run) then
    raise exception 'NOT_FOUND: no such calculation run' using errcode = 'P0002';
  end if;

  for v_change in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb))
  loop
    case v_change->>'kind'

    -- ---------------------------------------------------------------------------------------
    when 'insert' then
    -- ---------------------------------------------------------------------------------------
      insert into public.alerts (
        organization_id, rule_key, rule_version, severity, metric_key, period_id,
        subject_type, subject_id, title, explanation, threshold_summary,
        recommended_next_step, status, status_reason_code, dedupe_key, key_kind,
        calculation_run_id, first_seen_at, last_evaluated_at)
      values (
        p_org,
        v_change->>'rule_key',
        v_change->>'rule_version',
        (v_change->>'severity')::public.severity_enum,
        nullif(v_change->>'metric_key', ''),
        (v_change->>'period_id')::uuid,
        (v_change->>'subject_type')::public.alert_subject_enum,
        nullif(v_change->>'subject_id', '')::uuid,
        v_change->>'title',
        v_change->>'explanation',
        coalesce(v_change->'threshold_summary', '{}'::jsonb),
        nullif(v_change->>'recommended_next_step', ''),
        'open', 'user',
        v_change->>'dedupe_key',
        (v_change->>'key_kind')::public.alert_key_kind_enum,
        p_run, now(), now())
      -- ADR-018: the unique dedupe key makes a re-run idempotent even if the planner and the
      -- database disagree about what already exists. Nothing is duplicated; the row simply stands.
      on conflict (organization_id, dedupe_key) do nothing
      returning id into v_alert;

      if v_alert is null then
        continue;
      end if;

      v_bundle := app.build_alert_bundle(p_org, p_run, v_alert, v_change->'evidence');

      insert into public.alert_revisions (
        organization_id, alert_id, revision_no, rule_version, severity, explanation,
        threshold_summary, evidence_bundle_id, calculation_run_id)
      values (p_org, v_alert, 1, v_change->>'rule_version',
              (v_change->>'severity')::public.severity_enum,
              v_change->>'explanation',
              coalesce(v_change->'threshold_summary', '{}'::jsonb),
              v_bundle, p_run);

      update public.alerts a
         set current_revision_id = (select r.id from public.alert_revisions r
                                     where r.organization_id = p_org and r.alert_id = v_alert
                                     order by r.revision_no desc limit 1)
       where a.organization_id = p_org and a.id = v_alert;

      perform app.audit(p_org, 'alert.created', 'alerts', v_alert, null,
                        jsonb_build_object('rule_key', v_change->>'rule_key',
                                           'severity', v_change->>'severity'),
                        jsonb_build_object('run_id', p_run));
      v_inserted := v_inserted + 1;

    -- ---------------------------------------------------------------------------------------
    when 'revision' then
    -- ---------------------------------------------------------------------------------------
      v_alert := (v_change->>'alert_id')::uuid;

      select jsonb_build_object('severity', a.severity, 'status', a.status)
        into v_before
        from public.alerts a
       where a.organization_id = p_org and a.id = v_alert;
      if v_before is null then
        continue;
      end if;

      select coalesce(max(r.revision_no), 0) + 1 into v_revision
        from public.alert_revisions r
       where r.organization_id = p_org and r.alert_id = v_alert;

      v_bundle := app.build_alert_bundle(p_org, p_run, v_alert, v_change->'evidence');

      insert into public.alert_revisions (
        organization_id, alert_id, revision_no, rule_version, severity, explanation,
        threshold_summary, evidence_bundle_id, calculation_run_id)
      values (p_org, v_alert, v_revision, v_change->>'rule_version',
              (v_change->>'severity')::public.severity_enum,
              v_change->>'explanation',
              coalesce(v_change->'threshold_summary', '{}'::jsonb),
              v_bundle, p_run);

      update public.alerts a
         set severity = (v_change->>'severity')::public.severity_enum,
             explanation = v_change->>'explanation',
             title = v_change->>'title',
             threshold_summary = coalesce(v_change->'threshold_summary', '{}'::jsonb),
             recommended_next_step = nullif(v_change->>'recommended_next_step', ''),
             -- §8.1: a state alert's period moves to the latest evaluated one; first_seen_at never does.
             period_id = (v_change->>'period_id')::uuid,
             status = (v_change->>'status')::public.alert_status_enum,
             status_reason_code = coalesce(
               nullif(v_change->>'status_reason_code', '')::public.alert_status_reason_enum,
               a.status_reason_code),
             status_changed_at = case
               when a.status <> (v_change->>'status')::public.alert_status_enum then now()
               else a.status_changed_at end,
             -- A status the ENGINE changed has no user behind it.
             status_changed_by = case
               when a.status <> (v_change->>'status')::public.alert_status_enum then null
               else a.status_changed_by end,
             reopened_at = case when (v_change->>'reopened')::boolean then now() else a.reopened_at end,
             current_revision_id = (select r.id from public.alert_revisions r
                                     where r.organization_id = p_org and r.alert_id = v_alert
                                     order by r.revision_no desc limit 1),
             calculation_run_id = p_run,
             last_evaluated_at = now()
       where a.organization_id = p_org and a.id = v_alert;

      perform app.audit(p_org, 'alert.reevaluated', 'alerts', v_alert, v_before,
                        jsonb_build_object('severity', v_change->>'severity',
                                           'status', v_change->>'status'),
                        jsonb_build_object('run_id', p_run, 'revision_no', v_revision));
      v_revised := v_revised + 1;

    -- ---------------------------------------------------------------------------------------
    when 'touch' then
    -- ---------------------------------------------------------------------------------------
      -- Nothing material changed (§8.1). No revision, no audit, no notification: only the fact that
      -- the engine looked again. This is the branch that keeps a nightly run silent.
      update public.alerts a
         set last_evaluated_at = now(),
             period_id = (v_change->>'period_id')::uuid
       where a.organization_id = p_org and a.id = (v_change->>'alert_id')::uuid;
      v_touched := v_touched + 1;

    -- ---------------------------------------------------------------------------------------
    when 'resolve' then
    -- ---------------------------------------------------------------------------------------
      update public.alerts a
         set status = 'resolved',
             status_reason_code = (v_change->>'status_reason_code')::public.alert_status_reason_enum,
             status_changed_at = now(),
             status_changed_by = null,
             last_evaluated_at = now()
       where a.organization_id = p_org and a.id = (v_change->>'alert_id')::uuid
         and a.status in ('open', 'acknowledged');

      if found then
        perform app.audit(p_org, 'alert.status_changed', 'alerts',
                          (v_change->>'alert_id')::uuid,
                          jsonb_build_object('status', 'open'),
                          jsonb_build_object('status', 'resolved',
                                             'reason', v_change->>'status_reason_code'),
                          jsonb_build_object('run_id', p_run));
        v_resolved := v_resolved + 1;
      end if;

    else
      raise exception 'INVALID: unknown change kind %', v_change->>'kind' using errcode = '23514';
    end case;
  end loop;

  perform app.audit(p_org, 'alerts.evaluated', null, null, null,
                    jsonb_build_object('inserted', v_inserted, 'revised', v_revised,
                                       'touched', v_touched, 'resolved', v_resolved),
                    jsonb_build_object('run_id', p_run));

  return jsonb_build_object('inserted', v_inserted, 'revised', v_revised,
                            'touched', v_touched, 'resolved', v_resolved);
end $$;

-- ---------------------------------------------------------------------------------------------
-- The evidence bundle for one alert revision (EVIDENCE_MODEL.md §5).
-- ---------------------------------------------------------------------------------------------
--
-- A bundle per REVISION, not per alert (ADR-034). When an alert is re-evaluated its numbers change,
-- and the evidence has to change with them — but the OLD revision must still resolve to the evidence
-- it was written with, or "what did this alert say in March" becomes unanswerable.
create function app.build_alert_bundle(
  p_org      uuid,
  p_run      uuid,
  p_alert    uuid,
  p_evidence jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_bundle uuid;
  v_item   jsonb;
  v_sort   integer := 0;
begin
  insert into public.evidence_bundles (organization_id, kind, origin_table, origin_id,
                                       calculation_run_id, created_by_type, created_by)
  values (p_org, 'alert', 'alerts', p_alert, p_run, 'system', null)
  returning id into v_bundle;

  for v_item in select * from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb))
  loop
    insert into public.evidence_items (organization_id, bundle_id, sort_order, item_type,
                                       ref_id, query_descriptor, descriptor_hash,
                                       label, claim, assurance_level)
    values (p_org, v_bundle, v_sort,
            (v_item->>'item_type')::public.evidence_item_enum,
            nullif(v_item->>'ref_id', '')::uuid,
            case when v_item->'query_descriptor' = 'null'::jsonb then null
                 else v_item->'query_descriptor' end,
            -- Computed in TypeScript through the one RFC 8785 implementation, never here: a second
            -- canonicalisation would eventually disagree with the first (EVIDENCE_MODEL.md §3).
            case when v_item->>'descriptor_hash' is null then null
                 else decode(v_item->>'descriptor_hash', 'hex') end,
            v_item->>'label',
            nullif(v_item->>'claim', ''),
            (v_item->>'assurance_level')::public.assurance_level_enum);
    v_sort := v_sort + 1;
  end loop;

  return v_bundle;
end $$;

alter function app.build_alert_bundle(uuid, uuid, uuid, jsonb) owner to motion_definer;
revoke all on function app.build_alert_bundle(uuid, uuid, uuid, jsonb) from public, authenticated, anon;

alter function api_server.persist_alerts(uuid, uuid, jsonb) owner to motion_definer;
revoke all on function api_server.persist_alerts(uuid, uuid, jsonb) from public, authenticated, anon;
grant execute on function api_server.persist_alerts(uuid, uuid, jsonb) to service_role;
