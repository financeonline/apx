-- APX — Server-asserted writes re-check the actor as narrowly as the reads they stand for (ADR-043;
-- ADR-172 hardening; independent security review, 2026-10-14, findings LOW 5 and LOW 6).
--
--   LOW 5  `api_server.finish_forecast` let a 3rd party's request store a forecast: it asked only
--          `dashboard.view` ("every role that resolves holds it"), which ADR-172 made untrue — a 3rd
--          party holds it and reads none of what a forecast is made of (probe p8). It now asks
--          `financials.view`: a forecast is computed from the whole metric history, and what it
--          writes (`forecast_runs`, `forecast_values`, its evidence bundle) is readable only with
--          `financials.view`. Not `intelligence.recompute`: that is the right to re-run the ENGINE;
--          a client, who reads forecasts, may regenerate one, and gaining or losing that would be a
--          change of product, not a fix. `generateForecast` (src/modules/forecast) asserts the same.
--   LOW 6  `api_server.record_access_event` for `report.downloaded` asked only `reports.view`, so it
--          recorded — and so let the signer mint a URL for — a report the actor's RLS hides: the
--          daily, weekly and adviser reports need `financials.view` too, and a custom AI report is its
--          author's (`reports_select`). It now applies `reports_select`'s per-kind rule and
--          `report_files_select`'s "not deleted" to the ACTOR, and a report they cannot read is
--          NOT FOUND, as the page shows it. A download with no file (Marketing and Investment,
--          rendered on request) keeps `reports.view`.
--
-- Note on `reports_select`: its `report_kind in ('monthly_management', 'funding_readiness')` branch
-- can only ever match `funding_readiness` — the `reports` CHECK keeps the Monthly Management Report
-- out of that table (it is a `report_files` row with no report). The rule below mirrors the policy
-- word for word so the two cannot drift; the dead branch is harmless and left alone.
--
-- Both functions re-created from their LIVE definitions (`pg_get_functiondef`, 2026-10-14) with only
-- the change described.

CREATE OR REPLACE FUNCTION api_server.finish_forecast(p_actor uuid, p_org uuid, p_input jsonb, p_values jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run    uuid;
  v_bundle uuid;
  v_value  jsonb;
  v_sort   integer := 0;
  v_snap   uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'PERMISSION_DENIED: an actor is required' using errcode = '42501';
  end if;
  -- The actor must be able to read what a forecast is made of and what it writes: the metric history
  -- and `forecast_runs`/`forecast_values`, all `financials.view` (ADR-172 hardening, 2026-10-14; it
  -- was `dashboard.view`, which a 3rd party holds). NOT FOUND, as the page would be.
  if not app.has_permission_of(p_actor, p_org, 'financials.view') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.forecast_runs
         (organization_id, method, config_version, calculation_run_id,
          basis_from_period, basis_to_period, periods_used, horizon_months, basis,
          breakdown, unavailable, generated_by)
  values (p_org,
          p_input ->> 'method',
          p_input ->> 'config_version',
          nullif(p_input ->> 'calculation_run_id', '')::uuid,
          nullif(p_input ->> 'basis_from_period', '')::uuid,
          nullif(p_input ->> 'basis_to_period', '')::uuid,
          coalesce((p_input ->> 'periods_used')::integer, 0),
          (p_input ->> 'horizon_months')::integer,
          nullif(p_input ->> 'basis', '')::public.forecast_basis_enum,
          coalesce(p_input -> 'breakdown', '[]'::jsonb),
          coalesce(p_input -> 'unavailable', '[]'::jsonb),
          p_actor)
  returning id into v_run;

  for v_value in select * from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) loop
    insert into public.forecast_values
           (organization_id, forecast_run_id, period_id, metric_key, value, currency,
            derivation, derived_from)
    values (p_org, v_run,
            (v_value ->> 'period_id')::uuid,
            v_value ->> 'metric_key',
            (v_value ->> 'value')::numeric,
            nullif(v_value ->> 'currency', ''),
            v_value ->> 'derivation',
            coalesce((select array_agg(x) from jsonb_array_elements_text(v_value -> 'derived_from') x), '{}'));
  end loop;

  /*
   * The evidence bundle (§5, ADR-099). Its items are the SNAPSHOTS the baseline read — the actual
   * figures, each already its own evidence root — plus the calculation run they came from. Nothing
   * about the future is cited as evidence, because there is nothing about the future to cite: the
   * evidence for a forecast is the history it was computed from, and saying so is the difference
   * between explaining a forecast and dressing it up as a fact.
   */
  insert into public.evidence_bundles
         (organization_id, kind, origin_table, origin_id, calculation_run_id, created_by_type, created_by)
  values (p_org, 'forecast', 'forecast_runs', v_run,
          nullif(p_input ->> 'calculation_run_id', '')::uuid, 'system', p_actor)
  returning id into v_bundle;

  if nullif(p_input ->> 'calculation_run_id', '') is not null then
    insert into public.evidence_items
           (organization_id, bundle_id, sort_order, item_type, ref_id, label, assurance_level)
    values (p_org, v_bundle, v_sort, 'calculation_run',
            (p_input ->> 'calculation_run_id')::uuid,
            coalesce(p_input ->> 'run_label', 'The calculation this rests on'), 'verified');
    v_sort := v_sort + 1;
  end if;

  for v_snap in
    select distinct (x ->> 'snapshot_id')::uuid
      from jsonb_array_elements(coalesce(p_input -> 'basis_snapshots', '[]'::jsonb)) x
     where nullif(x ->> 'snapshot_id', '') is not null
  loop
    insert into public.evidence_items
           (organization_id, bundle_id, sort_order, item_type, ref_id, label, assurance_level)
    select p_org, v_bundle, v_sort, 'metric_snapshot', v_snap,
           coalesce((select x ->> 'label'
                       from jsonb_array_elements(p_input -> 'basis_snapshots') x
                      where (x ->> 'snapshot_id')::uuid = v_snap limit 1), 'A figure this rests on'),
           -- The ITEM keeps the history's own assurance; the forecast VALUES are `estimated`. A
           -- verified past is not evidence that the future is verified, and the two must not be
           -- flattened into one word (§7, REQ-FC-05).
           coalesce((select (x ->> 'assurance')::public.assurance_level_enum
                       from jsonb_array_elements(p_input -> 'basis_snapshots') x
                      where (x ->> 'snapshot_id')::uuid = v_snap limit 1), 'calculated');
    v_sort := v_sort + 1;
  end loop;

  perform app.audit(p_org, 'forecast.generated', 'forecast_runs', v_run, null,
                    jsonb_build_object('method', p_input ->> 'method',
                                       'periods_used', p_input ->> 'periods_used',
                                       'basis', p_input ->> 'basis',
                                       'evidence_bundle_id', v_bundle),
                    '{}'::jsonb, p_actor);
  return v_run;
end $function$;

CREATE OR REPLACE FUNCTION api_server.record_access_event(p_actor uuid, p_org uuid, p_action access_event_enum, p_target_table text DEFAULT NULL::text, p_target_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb, p_request_id text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id bigint;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'VALIDATION: an actor is required' using errcode = '22023';
  end if;

  -- Per-action authorisation of the ACTOR (not the session), DATABASE_ARCHITECTURE.md §14.2.
  case p_action
    when 'document.downloaded' then
      if not app.has_permission_of(p_actor, p_org, 'documents.view') then
        raise exception 'PERMISSION_DENIED: documents.view required' using errcode = '42501';
      end if;
      -- NOT_FOUND, never PERMISSION_DENIED: a 403 would confirm the document exists for somebody
      -- (SECURITY_MODEL.md §14).
      if p_target_id is not null and not exists (
        select 1 from public.source_documents d
         where d.organization_id = p_org and d.id = p_target_id
      ) then
        raise exception 'NOT_FOUND' using errcode = 'P0002';
      end if;
    when 'report.downloaded' then
      if not app.has_permission_of(p_actor, p_org, 'reports.view') then
        raise exception 'PERMISSION_DENIED: reports.view required' using errcode = '42501';
      end if;
      -- The file must be one the ACTOR may read: `report_files_select` (not deleted; its report
      -- readable) and `reports_select`'s rule per kind, word for word — a custom AI report is its
      -- author's, Funding Readiness needs Funding on, and every kind but the Monthly Management Report
      -- and Funding Readiness (the daily, weekly and adviser reports) needs `financials.view` as well
      -- (ADR-172 hardening, 2026-10-14). A report they cannot read does not exist for them.
      if p_target_id is not null and not exists (
        select 1
          from public.report_files f
          left join public.reports r on r.organization_id = f.organization_id and r.id = f.report_id
         where f.organization_id = p_org and f.id = p_target_id
           and f.deleted_at is null
           and (f.report_id is null
                or (r.id is not null
                    and (r.report_kind <> 'custom_ai'::public.report_kind_enum or r.requested_by = p_actor)
                    and (r.report_kind <> 'funding_readiness'::public.report_kind_enum or app.funding_enabled(p_org))
                    and (r.report_kind in ('monthly_management'::public.report_kind_enum, 'funding_readiness'::public.report_kind_enum)
                         or app.has_permission_of(p_actor, p_org, 'financials.view'))))
      ) then
        raise exception 'NOT_FOUND' using errcode = 'P0002';
      end if;
    when 'export.created' then
      if not app.has_permission_of(p_actor, p_org, 'data.export') then
        raise exception 'PERMISSION_DENIED: data.export required' using errcode = '42501';
      end if;
    when 'evidence.viewed' then
      if not app.has_permission_of(p_actor, p_org, 'financials.view') then
        raise exception 'PERMISSION_DENIED: financials.view required' using errcode = '42501';
      end if;
    when 'org.data_viewed' then
      -- CD-13: only a super admin generates this event, and the organization's owner sees it.
      if app.org_role_of(p_actor, p_org) is distinct from 'super_admin' then
        raise exception 'PERMISSION_DENIED: org.data_viewed is a super-admin event' using errcode = '42501';
      end if;
    else
      -- document.quarantined, document.sent_to_ai, auth.*, member.invitation_failed are system
      -- events written by server code with no per-actor permission of their own.
      null;
  end case;

  -- metadata keys are ids only: never emails, filenames or free text (ADR-038.9).
  if exists (
    select 1 from jsonb_object_keys(coalesce(p_metadata, '{}'::jsonb)) k
     where k not in ('document_id','report_id','batch_id','bundle_id','period_id','surface',
                     'route','pages','export_kind','invitation_id','job_id')
  ) then
    raise exception 'VALIDATION: metadata key not in the allow-list' using errcode = '22023';
  end if;

  v_id := app.audit(p_org, p_action::text, p_target_table, p_target_id, null, null,
                    coalesce(p_metadata, '{}'::jsonb), p_actor, p_request_id);
  return v_id;
end $function$;
