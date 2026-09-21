-- MOTION — Phase 12 · What-If Scenarios.
-- Contract: PRODUCT_REQUIREMENTS.md REQ-SC-01…10; SOW §14; EVIDENCE_MODEL.md §5;
--           ADR-016, ADR-026, ADR-043, ADR-092, ADR-099, ADR-100.
--
-- WHAT THIS IS. Two tables and two functions. A scenario RUN records the assumptions somebody made,
-- the forecast they were made against, and what the method and its config version were; scenario
-- VALUES hold BOTH sides of the comparison — the baseline figure and the scenario figure — for one
-- future period and one metric.
--
-- WHY BOTH SIDES ARE STORED. §13 requires that reopening a saved scenario shows what it showed. A
-- row holding only the scenario figure would be compared, on reopening, against whatever the
-- forecast says THEN — so regenerating a forecast would silently rewrite the history of every saved
-- scenario. Storing the pair makes a saved scenario a fixed statement about a fixed baseline.
--
-- WHY NOT `forecast_values`. A forecast is what the finished months suggest; a scenario is what
-- would follow IF assumptions held. They are different claims about the same months, and a reader
-- of `forecast_values` must never pick up a scenario by accident — the same reasoning that kept
-- forecasts out of `metric_snapshots` (ADR-099).
--
-- Every scenario figure is `estimated` by DEFAULT and by CHECK: there is no way to write one that
-- claims more, exactly as REQ-FC-05 is enforced for forecasts.

create table public.scenario_runs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  -- What the person called it, so they can find it again ("Revenue +10% / Payroll +5%").
  name                text not null,
  -- The forecast this scenario moves. A scenario with no baseline is not a scenario.
  forecast_run_id     uuid not null,
  method              text not null,
  config_version      text not null,
  -- The assumptions, exactly as the server validated them. Stored rather than re-derived so a
  -- saved scenario can still explain itself after the rules have moved on (ADR-017's discipline).
  assumptions         jsonb not null default '[]'::jsonb,
  horizon_months      integer not null,
  -- Inherited from the forecast: how much to lean on the baseline the assumptions moved.
  basis               public.forecast_basis_enum,
  -- Inherited warnings and refusals, so §12's data-quality states survive into the scenario.
  data_quality        jsonb not null default '{}'::jsonb,
  unavailable         jsonb not null default '[]'::jsonb,
  -- §13: a saved scenario is put away, never rewritten. Nothing updates a figure on it.
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  constraint scenario_runs_org_id_unique unique (organization_id, id),
  constraint scenario_runs_name_length check (char_length(name) between 1 and 120),
  constraint scenario_runs_horizon check (horizon_months between 1 and 12),
  constraint scenario_runs_forecast_fk
    foreign key (organization_id, forecast_run_id)
    references public.forecast_runs (organization_id, id) on delete cascade
);

-- The list a person reads: newest first, archived ones out of the way.
create index scenario_runs_recent on public.scenario_runs (organization_id, created_at desc);

create table public.scenario_values (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  scenario_run_id   uuid not null,
  period_id         uuid not null,
  metric_key        text not null,
  -- BOTH sides, in the same shape as `metric_snapshots.value` and `forecast_values.value`, so the
  -- difference between them is exact rather than a rounding of two differently-typed numbers.
  baseline_value    numeric(20,6) not null,
  scenario_value    numeric(20,6) not null,
  currency          char(3),
  -- §16: a scenario result is not an actual and not a forecast. It is an estimate, always.
  assurance_level   public.assurance_level_enum not null default 'estimated',
  derivation        text not null,
  derived_from      text[] not null default '{}',
  created_at        timestamptz not null default now(),
  constraint scenario_values_org_id_unique unique (organization_id, id),
  constraint scenario_values_run_fk
    foreign key (organization_id, scenario_run_id)
    references public.scenario_runs (organization_id, id) on delete cascade,
  constraint scenario_values_period_fk
    foreign key (organization_id, period_id)
    references public.fiscal_periods (organization_id, id),
  constraint scenario_values_cell_unique
    unique (organization_id, scenario_run_id, period_id, metric_key),
  constraint scenario_values_estimated check (assurance_level = 'estimated'),
  constraint scenario_values_derivation check (derivation in ('baseline', 'identity'))
);

create index scenario_values_lookup
  on public.scenario_values (organization_id, scenario_run_id, period_id);

-- ---------------------------------------------------------------------------
-- Evidence (EVIDENCE_MODEL.md §5; ADR-092)
-- ---------------------------------------------------------------------------
-- A scenario bundle's origin is the RUN. Its ITEMS are copied from the forecast's bundle — the same
-- clone-on-decision pattern an action already uses (§5, "the source's bundle items are copied") —
-- because the evidence for a scenario is the history the forecast was computed from, and there is
-- nothing about an assumed future to cite. Copying rather than pointing means a regenerated
-- forecast cannot change what a saved scenario says it rests on.
alter type public.evidence_kind_enum add value if not exists 'scenario';

alter table public.evidence_bundles drop constraint evidence_bundles_origin_table_known;
alter table public.evidence_bundles
  add constraint evidence_bundles_origin_table_known check (
    origin_table in ('metric_snapshots', 'alerts', 'ai_messages',
                     'health_scores', 'actions', 'report_files', 'forecast_runs',
                     'scenario_runs'));

drop trigger same_org_ref_origin on public.evidence_bundles;
create trigger same_org_ref_origin before insert or update on public.evidence_bundles
  for each row execute function app.same_org_ref(
    'origin_id', 'origin_table',
    'metric_snapshots', 'metric_snapshots', 'alerts', 'alerts', 'ai_messages', 'ai_messages',
    'health_scores', 'health_scores', 'actions', 'actions', 'report_files', 'report_files',
    'forecast_runs', 'forecast_runs', 'scenario_runs', 'scenario_runs');

-- ---------------------------------------------------------------------------
-- Privileges and RLS (ADR-026)
-- ---------------------------------------------------------------------------
alter table public.scenario_runs owner to motion_definer;
alter table public.scenario_values owner to motion_definer;
alter table public.scenario_runs enable row level security;
alter table public.scenario_runs force row level security;
alter table public.scenario_values enable row level security;
alter table public.scenario_values force row level security;

revoke insert, update, delete, truncate on public.scenario_runs, public.scenario_values
  from authenticated, anon;
grant select on public.scenario_runs, public.scenario_values to authenticated;
grant all on public.scenario_runs, public.scenario_values to service_role;

create policy definer_all on public.scenario_runs for all to motion_definer using (true) with check (true);
create policy definer_all on public.scenario_values for all to motion_definer using (true) with check (true);

-- The same role set that may READ the figures a scenario is made of, which includes a client and
-- excludes `suspended_member` (ADR-044.4 freezes them to Home). Creating one is narrower, and that
-- narrowing is a permission check inside the write function rather than a policy: RLS bounds what
-- a session can SEE, and `authenticated` cannot write these tables at all.
create policy scenario_runs_select on public.scenario_runs for select to authenticated
  using (organization_id in (select app.org_ids_with_role(
    variadic array['owner', 'admin', 'employee', 'super_admin', 'client'])));
create policy scenario_values_select on public.scenario_values for select to authenticated
  using (organization_id in (select app.org_ids_with_role(
    variadic array['owner', 'admin', 'employee', 'super_admin', 'client'])));

-- ---------------------------------------------------------------------------
-- The write surface: server only (ADR-043)
-- ---------------------------------------------------------------------------
-- The ASSUMPTIONS are user intent, but the FIGURES are a server-observed fact — what the
-- deterministic engine worked out. `api.*` is granted to `authenticated`, so anything it accepts is
-- something a browser can assert with the user's own token; a browser that could assert a scenario
-- figure could publish any number it liked under MOTION's name. The whole row is therefore written
-- by `api_server`, with the human actor passed explicitly and re-validated here.
create function api_server.finish_scenario(
  p_actor    uuid,
  p_org      uuid,
  p_input    jsonb,
  p_values   jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_run      uuid;
  v_bundle   uuid;
  v_src      uuid;
  v_value    jsonb;
  v_sort     integer := 0;
  v_item     record;
  v_calc     uuid := nullif(p_input ->> 'calculation_run_id', '')::uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_actor is null then
    raise exception 'PERMISSION_DENIED: an actor is required' using errcode = '42501';
  end if;
  /*
   * Working out a scenario is triggering a deterministic calculation over the organisation's own
   * figures, which is what `intelligence.recompute` names — held by owner, admin, employee and
   * super admin, and not by a client. No new permission was invented: §19 and §22 forbid one that
   * could sit outside the matrix, and ADR-099 set the precedent (ADR-100).
   */
  if not app.has_permission_of(p_actor, p_org, 'intelligence.recompute') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.scenario_runs
         (organization_id, name, forecast_run_id, method, config_version, assumptions,
          horizon_months, basis, data_quality, unavailable, created_by)
  values (p_org,
          p_input ->> 'name',
          (p_input ->> 'forecast_run_id')::uuid,
          p_input ->> 'method',
          p_input ->> 'config_version',
          coalesce(p_input -> 'assumptions', '[]'::jsonb),
          (p_input ->> 'horizon_months')::integer,
          nullif(p_input ->> 'basis', '')::public.forecast_basis_enum,
          coalesce(p_input -> 'data_quality', '{}'::jsonb),
          coalesce(p_input -> 'unavailable', '[]'::jsonb),
          p_actor)
  returning id into v_run;

  for v_value in select * from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) loop
    insert into public.scenario_values
           (organization_id, scenario_run_id, period_id, metric_key,
            baseline_value, scenario_value, currency, derivation, derived_from)
    values (p_org, v_run,
            (v_value ->> 'period_id')::uuid,
            v_value ->> 'metric_key',
            (v_value ->> 'baseline_value')::numeric,
            (v_value ->> 'scenario_value')::numeric,
            nullif(v_value ->> 'currency', ''),
            v_value ->> 'derivation',
            coalesce((select array_agg(x) from jsonb_array_elements_text(v_value -> 'derived_from') x), '{}'));
  end loop;

  insert into public.evidence_bundles
         (organization_id, kind, origin_table, origin_id, calculation_run_id, created_by_type, created_by)
  values (p_org, 'scenario', 'scenario_runs', v_run, v_calc, 'system', p_actor)
  returning id into v_bundle;

  /*
   * The forecast's own items, copied. A scenario rests on exactly the history its baseline rests
   * on; re-deriving that list here would be a second evidence path for the same chain, and pointing
   * at the forecast's bundle instead would let a regenerated forecast rewrite what a saved scenario
   * cites. Each item keeps the HISTORY's assurance while every scenario value stays `estimated`.
   */
  v_src := nullif(p_input ->> 'forecast_bundle_id', '')::uuid;
  if v_src is not null then
    for v_item in
      select ei.item_type, ei.ref_id, ei.ref_revision_no, ei.query_descriptor, ei.descriptor_hash,
             ei.label, ei.assurance_level
        from public.evidence_items ei
        join public.evidence_bundles eb
          on eb.id = ei.bundle_id and eb.organization_id = ei.organization_id
       where ei.organization_id = p_org and ei.bundle_id = v_src
       order by ei.sort_order
    loop
      insert into public.evidence_items
             (organization_id, bundle_id, sort_order, item_type, ref_id, ref_revision_no,
              query_descriptor, descriptor_hash, label, assurance_level)
      values (p_org, v_bundle, v_sort, v_item.item_type, v_item.ref_id, v_item.ref_revision_no,
              v_item.query_descriptor, v_item.descriptor_hash, v_item.label, v_item.assurance_level);
      v_sort := v_sort + 1;
    end loop;
  end if;

  perform app.audit(p_org, 'scenario.created', 'scenario_runs', v_run, null,
                    jsonb_build_object('method', p_input ->> 'method',
                                       'forecast_run_id', p_input ->> 'forecast_run_id',
                                       'assumption_kinds',
                                         (select coalesce(jsonb_agg(a ->> 'kind'), '[]'::jsonb)
                                            from jsonb_array_elements(
                                              coalesce(p_input -> 'assumptions', '[]'::jsonb)) a),
                                       'evidence_bundle_id', v_bundle),
                    '{}'::jsonb, p_actor);
  return v_run;
end $$;

alter function api_server.finish_scenario(uuid, uuid, jsonb, jsonb) owner to motion_definer;
revoke all on function api_server.finish_scenario(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function api_server.finish_scenario(uuid, uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Putting one away (ADR-026): user intent, so `api`, so throttled and audited.
-- ---------------------------------------------------------------------------
-- Archiving, not deleting. A saved scenario's evidence bundle points at it, and deleting the row
-- would leave a bundle citing something that no longer exists — the one thing EVIDENCE_MODEL.md §8
-- will not have. Archiving takes it out of the list and keeps the record of what was modelled.
create function api.archive_scenario(p_scenario uuid, p_archived boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_was timestamptz;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select s.organization_id, s.archived_at into v_org, v_was
    from public.scenario_runs s where s.id = p_scenario;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_org, 'intelligence.recompute');

  update public.scenario_runs
     set archived_at = case when p_archived then now() else null end
   where organization_id = v_org and id = p_scenario;

  perform app.audit(v_org, 'scenario.archived', 'scenario_runs', p_scenario,
                    jsonb_build_object('archived', v_was is not null),
                    jsonb_build_object('archived', p_archived), '{}'::jsonb);
  return p_scenario;
end $$;

alter function api.archive_scenario(uuid, boolean) owner to motion_definer;
revoke all on function api.archive_scenario(uuid, boolean) from public, anon;
grant execute on function api.archive_scenario(uuid, boolean) to authenticated;
