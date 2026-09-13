-- MOTION — Phase 11 · Forecasting.
-- Contract: PRODUCT_REQUIREMENTS.md REQ-FC-01, REQ-FC-02, REQ-FC-05; DATABASE_ARCHITECTURE.md §395
--           ("`forecasts` … each arrives with its phase and attaches by organization_id and, where
--           relevant, period_id"); EVIDENCE_MODEL.md §5; ADR-016, ADR-026, ADR-043, ADR-092, ADR-099.
--
-- WHAT THIS IS. Two tables and one server function. A forecast RUN records what was worked out, from
-- what, by which method and when; forecast VALUES are one figure per future period per metric. Both
-- attach by `organization_id`, values attach by `period_id` to a real `fiscal_periods` row — an
-- organisation is seeded with twelve months forward, so the forecast never invents a month.
--
-- WHY NOT `metric_snapshots`. A snapshot is what the engine COMPUTED for a period that happened; it
-- is pinned by `metric_current`, cited by health scores, alerts and evidence, and append-only per
-- calculation run. A forecast is a different kind of claim about a period that has not happened, and
-- putting it in the same table would mean every existing reader of `metric_current` — Home, Money,
-- the analyst's tools, the evidence drawer — had to learn the difference or risk showing a forecast
-- as a figure. Separate tables make that mistake impossible rather than merely discouraged.
--
-- REQ-FC-05 is enforced by the column default AND a CHECK: every forecast value is `estimated`, and
-- there is no way to write one that is not.

create type public.forecast_basis_enum as enum ('strong', 'limited', 'weak');

create table public.forecast_runs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  -- The method and its config version, stamped so a stored forecast can be read back against the
  -- rules that were in force (ADR-099), exactly as `health_scores.config_version` is.
  method              text not null,
  config_version      text not null,
  -- What it rested on: the run whose snapshots were read, and the window of complete months.
  calculation_run_id  uuid,
  basis_from_period   uuid,
  basis_to_period     uuid,
  periods_used        integer not null default 0,
  horizon_months      integer not null,
  basis               public.forecast_basis_enum,
  -- Per-metric baselines, exclusions and the reasons anything was refused. The explanation is
  -- stored rather than recomputed, so "why did it say that?" survives a config bump (ADR-017's rule).
  breakdown           jsonb not null default '[]'::jsonb,
  unavailable         jsonb not null default '[]'::jsonb,
  generated_at        timestamptz not null default now(),
  generated_by        uuid,
  constraint forecast_runs_org_id_unique unique (organization_id, id),
  constraint forecast_runs_horizon check (horizon_months between 1 and 12),
  constraint forecast_runs_calc_fk
    foreign key (organization_id, calculation_run_id)
    references public.calculation_runs (organization_id, id),
  constraint forecast_runs_from_fk
    foreign key (organization_id, basis_from_period) references public.fiscal_periods (organization_id, id),
  constraint forecast_runs_to_fk
    foreign key (organization_id, basis_to_period) references public.fiscal_periods (organization_id, id)
);

-- The newest run for an organisation, which is the only one the product reads.
create index forecast_runs_recent on public.forecast_runs (organization_id, generated_at desc);

create table public.forecast_values (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  forecast_run_id   uuid not null,
  period_id         uuid not null,
  metric_key        text not null,
  -- NUMERIC(20,6) like `metric_snapshots.value`, so a forecast and an actual are the same shape and
  -- a variance between them is exact (ADR-006).
  value             numeric(20,6) not null,
  currency          char(3),
  -- REQ-FC-05. Defaulted and constrained: there is no way to write a forecast that claims more.
  assurance_level   public.assurance_level_enum not null default 'estimated',
  -- 'baseline' (averaged from history) or 'identity' (derived from other forecast figures), with
  -- the keys it came from — so the drawer can show the arithmetic rather than assert it.
  derivation        text not null,
  derived_from      text[] not null default '{}',
  created_at        timestamptz not null default now(),
  constraint forecast_values_org_id_unique unique (organization_id, id),
  constraint forecast_values_run_fk
    foreign key (organization_id, forecast_run_id)
    references public.forecast_runs (organization_id, id) on delete cascade,
  constraint forecast_values_period_fk
    foreign key (organization_id, period_id)
    references public.fiscal_periods (organization_id, id),
  constraint forecast_values_cell_unique unique (organization_id, forecast_run_id, period_id, metric_key),
  constraint forecast_values_estimated check (assurance_level = 'estimated'),
  constraint forecast_values_derivation check (derivation in ('baseline', 'identity'))
);

create index forecast_values_lookup
  on public.forecast_values (organization_id, forecast_run_id, period_id);

-- ---------------------------------------------------------------------------
-- Evidence (EVIDENCE_MODEL.md §5; ADR-092)
-- ---------------------------------------------------------------------------
-- A forecast bundle's origin is the RUN. The `origin_table` allow-list added in ADR-092 has to name
-- it, or the constraint refuses the insert — which is the constraint working.
alter type public.evidence_kind_enum add value if not exists 'forecast';

alter table public.evidence_bundles drop constraint evidence_bundles_origin_table_known;
alter table public.evidence_bundles
  add constraint evidence_bundles_origin_table_known check (
    origin_table in ('metric_snapshots', 'alerts', 'ai_messages',
                     'health_scores', 'actions', 'report_files', 'forecast_runs'));

drop trigger same_org_ref_origin on public.evidence_bundles;
create trigger same_org_ref_origin before insert or update on public.evidence_bundles
  for each row execute function app.same_org_ref(
    'origin_id', 'origin_table',
    'metric_snapshots', 'metric_snapshots', 'alerts', 'alerts', 'ai_messages', 'ai_messages',
    'health_scores', 'health_scores', 'actions', 'actions', 'report_files', 'report_files',
    'forecast_runs', 'forecast_runs');

-- ---------------------------------------------------------------------------
-- Privileges and RLS (ADR-026): read for the roles that may see figures, writes through api_server.
-- ---------------------------------------------------------------------------
alter table public.forecast_runs owner to motion_definer;
alter table public.forecast_values owner to motion_definer;
alter table public.forecast_runs enable row level security;
alter table public.forecast_runs force row level security;
alter table public.forecast_values enable row level security;
alter table public.forecast_values force row level security;

revoke insert, update, delete, truncate on public.forecast_runs, public.forecast_values
  from authenticated, anon;
grant select on public.forecast_runs, public.forecast_values to authenticated;
grant all on public.forecast_runs, public.forecast_values to service_role;

create policy definer_all on public.forecast_runs for all to motion_definer using (true) with check (true);
create policy definer_all on public.forecast_values for all to motion_definer using (true) with check (true);

-- The same role set the figures themselves use: everyone with standing in the organisation, which
-- includes a client (a forecast is a figure they may see) and excludes `suspended_member` (ADR-044.4
-- freezes them to Home).
create policy forecast_runs_select on public.forecast_runs for select to authenticated
  using (organization_id in (select app.org_ids_with_role(
    variadic array['owner', 'admin', 'employee', 'super_admin', 'client'])));
create policy forecast_values_select on public.forecast_values for select to authenticated
  using (organization_id in (select app.org_ids_with_role(
    variadic array['owner', 'admin', 'employee', 'super_admin', 'client'])));

-- ---------------------------------------------------------------------------
-- The write surface: server only (ADR-043, ADR-090)
-- ---------------------------------------------------------------------------
-- A forecast is a SERVER-observed fact — the deterministic engine's output — in exactly the sense
-- `api_server.finish_health` writes a health score. It is written whole, with its evidence bundle,
-- in one transaction, so a run can never be half-visible.
create function api_server.finish_forecast(
  p_actor    uuid,
  p_org      uuid,
  p_input    jsonb,
  p_values   jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
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
  -- The actor must be able to see the figures a forecast is made of. `dashboard.view` is held by
  -- every role that resolves and by nobody else, so this is the same reach the page has.
  if not app.has_permission_of(p_actor, p_org, 'dashboard.view') then
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
end $$;

alter function api_server.finish_forecast(uuid, uuid, jsonb, jsonb) owner to motion_definer;
revoke all on function api_server.finish_forecast(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function api_server.finish_forecast(uuid, uuid, jsonb, jsonb) to service_role;
