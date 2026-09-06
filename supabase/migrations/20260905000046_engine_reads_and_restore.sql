-- MOTION — Audit of phases 1–7 · Three defects that only the real code path could reveal.
-- Contract: FINANCIAL_ENGINE.md §2.2/§2.4; ADR-043; ADR-057.
--
-- 1. THE ENGINE COULD NOT READ ITS OWN AGGREGATE.
--
--    `financial-engine/data/repository.ts` calls `rpc('aggregate_periods')`, `rpc('batch_coverage')`
--    and `rpc('aggregate_transfer_legs')` on an unqualified schema, which PostgREST resolves against
--    `public`. All three live in `app`, which is deliberately NOT exposed (config.toml exposes
--    `public`, `api` and `api_server` only). Every call returned PGRST202 "could not find the
--    function", so a calculation run failed on its first chunk — always.
--
--    Nothing caught it because every test of the aggregation calls `app.aggregate_periods(...)`
--    directly through psql, where schema qualification is free. The seam between the engine and
--    PostgREST was the one thing untested, and it was the one thing broken.
--
--    The fix is a thin `api_server` wrapper per function: the calculation worker holds the service
--    role, these are reads the SERVER performs to compute with, and `api_server` is where the
--    server-asserted surface lives (ADR-043). The bodies stay in `app`, unchanged.
--
-- 2. THE FAILED-RUN RESTORE COULD NEVER COMPLETE.
--
--    `finish_calculation_run` clears its temporary tables with `delete from _restore_pointers;`.
--    PostgREST connects through a role with `pg_safeupdate` armed, which refuses a DELETE with no
--    WHERE clause — SQLSTATE 21000. So the moment a run failed, the function that was supposed to
--    put the pointers back raised instead, and the run was never even marked failed.
--
--    Again invisible to psql, and again the restore is the path a test least often reaches.
--    `truncate` says what was meant and is not subject to the guard.

-- ---------------------------------------------------------------------------------------------
-- 1. The engine's three reads, reachable
-- ---------------------------------------------------------------------------------------------

-- The row types mirror `app.*` exactly. `setof record` would compile and then fail at every call:
-- PostgREST cannot supply the column definition list an untyped record needs.
create function api_server.aggregate_periods(
  p_org uuid, p_from date, p_to date, p_aggregated_at timestamptz default now()
) returns table (
  period_id uuid, source public.aggregate_source_enum,
  standard_category public.standard_category_enum, account_id uuid, counterparty_id uuid,
  bank_account_id uuid, balance_kind public.balance_kind_enum,
  balance_basis public.balance_basis_enum, invoice_type public.invoice_type_enum,
  transfer_kind public.transfer_kind_enum, unpaired_transfer boolean,
  debit numeric, credit numeric, amount numeric, row_count bigint,
  min_date date, max_date date
)
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  return query select * from app.aggregate_periods(p_org, p_from, p_to, p_aggregated_at);
end $$;

create function api_server.aggregate_transfer_legs(
  p_org uuid, p_from date, p_to date, p_aggregated_at timestamptz default now()
) returns table (
  period_id uuid, bank_account_id uuid, transfer_kind public.transfer_kind_enum,
  inflow numeric, outflow numeric, row_count bigint
)
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  return query select * from app.aggregate_transfer_legs(p_org, p_from, p_to, p_aggregated_at);
end $$;

create function api_server.batch_coverage(
  p_org uuid, p_from date, p_to date
) returns table (
  target_table public.import_target_enum, import_type public.import_type_enum,
  balance_kind public.balance_kind_enum, bank_account_id uuid,
  invoice_list_kind public.invoice_list_kind_enum, period_start date, period_end date,
  committed_at timestamptz, batch_id uuid
)
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  return query select * from app.batch_coverage(p_org, p_from, p_to);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. The restore, able to run
-- ---------------------------------------------------------------------------------------------

create or replace function api_server.finish_calculation_run(
  p_org    uuid,
  p_run    uuid,
  p_status public.calculation_status_enum,
  p_stats  jsonb default '{}'::jsonb,
  p_error  jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_started timestamptz;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  select r.started_at into v_started
    from public.calculation_runs r where r.organization_id = p_org and r.id = p_run;
  if v_started is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_status = 'failed' then
    -- Capture first, delete second. A reader must never be left with this month from a failed run
    -- and last month from the previous one — nor with no pointer at all.
    create temporary table if not exists _restore_pointers (
      period_id uuid, metric_key text, dimension_type public.metric_dimension_enum,
      dimension_id uuid, dimension_key text, snapshot_id uuid, calculation_run_id uuid
    ) on commit drop;
    -- TRUNCATE, not DELETE: the connection runs with `pg_safeupdate` armed, which refuses an
    -- unqualified DELETE (21000) and turned this whole restore into a raise (ADR-057.2).
    truncate _restore_pointers;

    insert into _restore_pointers
    select prev.period_id, prev.metric_key, prev.dimension_type, prev.dimension_id,
           prev.dimension_key, prev.id, prev.calculation_run_id
      from public.metric_current c
      join public.metric_snapshots prev
        on prev.organization_id = c.organization_id and prev.id = c.previous_snapshot_id
     where c.organization_id = p_org and c.calculation_run_id = p_run
       and c.previous_snapshot_id is not null;

    delete from public.metric_current c
     where c.organization_id = p_org and c.calculation_run_id = p_run;

    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key,
            snapshot_id, calculation_run_id)
    select p_org, period_id, metric_key, dimension_type, dimension_id, dimension_key,
           snapshot_id, calculation_run_id
      from _restore_pointers
    on conflict do nothing;

    create temporary table if not exists _restore_health (
      period_id uuid, health_score_id uuid, calculation_run_id uuid
    ) on commit drop;
    truncate _restore_health;

    insert into _restore_health
    select c.period_id, prev.id, prev.calculation_run_id
      from public.health_current c
      join public.health_scores prev
        on prev.organization_id = c.organization_id and prev.id = c.previous_health_score_id
     where c.organization_id = p_org and c.calculation_run_id = p_run
       and c.previous_health_score_id is not null;

    delete from public.health_current c
     where c.organization_id = p_org and c.calculation_run_id = p_run;

    insert into public.health_current
           (organization_id, period_id, health_score_id, calculation_run_id, updated_at)
    select p_org, period_id, health_score_id, calculation_run_id, now()
      from _restore_health
    on conflict do nothing;
  end if;

  update public.calculation_runs r
     set status = p_status,
         finished_at = now(),
         duration_ms = (extract(epoch from (now() - v_started)) * 1000)::integer,
         stats = coalesce(p_stats, '{}'::jsonb),
         error = p_error,
         failure_reason = case when p_status = 'failed' then 'error'::public.calculation_failure_enum end
   where r.organization_id = p_org and r.id = p_run;

  return p_run;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------------------------

do $$
declare fn text;
begin
  foreach fn in array array[
    'api_server.aggregate_periods(uuid, date, date, timestamptz)',
    'api_server.aggregate_transfer_legs(uuid, date, date, timestamptz)',
    'api_server.batch_coverage(uuid, date, date)',
    'api_server.finish_calculation_run(uuid, uuid, public.calculation_status_enum, jsonb, jsonb)'
  ]
  loop
    execute format('alter function %s owner to motion_definer', fn);
    execute format('revoke all on function %s from public, authenticated, anon', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
