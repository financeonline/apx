-- MOTION — Phase 4 (plan Phase 6) · The calculation run's write surface.
-- Contract: FINANCIAL_ENGINE.md §2.4; ADR-008, ADR-031, ADR-047.7/8.
--
-- Everything here is `api_server`, executable only by the service role, because every one of these
-- is a fact the ENGINE computed rather than an intention a user expressed (ADR-043). A browser that
-- could write a metric snapshot could write any figure it liked and it would appear on the
-- dashboard as a verified number.
--
-- The pointer rewrite in `finish_chunk` is the delicate part. §2.4 step 8 requires snapshots and
-- pointers to move in ONE transaction, so a reader never sees a half-written period, and requires
-- the previous pointer to be recorded so a failed run can put back exactly what it replaced.

create function api_server.start_calculation_run(
  p_org         uuid,
  p_trigger     public.calculation_trigger_enum,
  p_trigger_ref uuid,
  p_engine_version text,
  p_period_from uuid,
  p_period_to   uuid,
  p_as_of       date,
  p_fingerprint text,
  p_job         uuid default null,
  p_periods_total integer default 0
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_last_fingerprint bytea;
  v_run              uuid;
  v_fingerprint      bytea := decode(p_fingerprint, 'hex');
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-047.8: the fingerprint is computed from aggregate metadata BEFORE any write. An equal
  -- fingerprint means nothing the engine reads has changed, so the run finishes immediately rather
  -- than rewriting a year of identical snapshots. `recalc_manual` is exempt because a human asking
  -- for a recalculation is entitled to one even when nothing changed.
  select r.input_fingerprint into v_last_fingerprint
    from public.calculation_runs r
   where r.organization_id = p_org and r.status = 'succeeded'
   order by r.finished_at desc nulls last
   limit 1;

  if v_last_fingerprint is not null
     and v_last_fingerprint = v_fingerprint
     and p_trigger <> 'recalc_manual' then
    insert into public.calculation_runs
           (organization_id, job_id, trigger, trigger_ref_id, engine_version,
            period_from, period_to, as_of, status, input_fingerprint,
            started_at, finished_at, duration_ms, stats)
    values (p_org, p_job, p_trigger, p_trigger_ref, p_engine_version,
            p_period_from, p_period_to, p_as_of, 'succeeded', v_fingerprint,
            now(), now(), 0, jsonb_build_object('no_change', true))
    returning id into v_run;

    return jsonb_build_object('runId', v_run, 'noChange', true);
  end if;

  insert into public.calculation_runs
         (organization_id, job_id, trigger, trigger_ref_id, engine_version,
          period_from, period_to, as_of, status, input_fingerprint, started_at, progress)
  values (p_org, p_job, p_trigger, p_trigger_ref, p_engine_version,
          p_period_from, p_period_to, p_as_of, 'running', v_fingerprint, now(),
          jsonb_build_object('periods_done', 0, 'periods_total', p_periods_total))
  returning id into v_run;

  return jsonb_build_object('runId', v_run, 'noChange', false);
end $$;

-- One chunk's snapshots and pointers, in one transaction (§2.4 step 8).
create function api_server.finish_chunk(
  p_org           uuid,
  p_run           uuid,
  p_snapshots     jsonb,
  p_period_ids    uuid[],
  p_aggregated_at timestamptz,
  p_cursor        text,
  p_as_of_keys    text[] default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s          jsonb;
  v_snapshot uuid;
  v_written  integer := 0;
  v_period   uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if not exists (select 1 from public.calculation_runs r
                  where r.organization_id = p_org and r.id = p_run and r.status = 'running') then
    raise exception 'CONFLICT: this run is not running' using errcode = '40001';
  end if;

  -- Idempotent retry (§2.4 step 3): a re-attempted chunk removes its own previous output first,
  -- so a worker that died after writing half a chunk does not double it.
  delete from public.metric_snapshots
   where organization_id = p_org and calculation_run_id = p_run
     and period_id = any (p_period_ids);

  for s in select * from jsonb_array_elements(p_snapshots) loop
    insert into public.metric_snapshots
           (organization_id, calculation_run_id, period_id, metric_key, dimension_type,
            dimension_id, value, unit, currency, basis, assurance_level, data_quality,
            components, evidence_query)
    values (p_org, p_run,
            (s ->> 'period_id')::uuid,
            s ->> 'metric_key',
            coalesce((s ->> 'dimension_type')::public.metric_dimension_enum, 'none'),
            (s ->> 'dimension_id')::uuid,
            (s ->> 'value')::numeric,
            (s ->> 'unit')::public.metric_unit_enum,
            s ->> 'currency',
            (s ->> 'basis')::public.metric_basis_enum,
            (s ->> 'assurance_level')::public.assurance_level_enum,
            coalesce(s -> 'data_quality', '{}'::jsonb),
            coalesce(s -> 'components', '{}'::jsonb),
            s -> 'evidence_query')
    returning id into v_snapshot;
    v_written := v_written + 1;
  end loop;

  -- The pointer rewrite. Deleting every pointer for the period and re-inserting is what RETIRES a
  -- dimension that has vanished — a category nobody used this month, a merged counterparty. Updating
  -- in place would leave last month's dimension pointing at a snapshot this run did not write
  -- (finding F-B-16).
  foreach v_period in array p_period_ids loop
    -- ADR-047.7: remember what each pointer named, so a failed run can restore its whole range.
    if p_as_of_keys is null then
      delete from public.metric_current c
       where c.organization_id = p_org and c.period_id = v_period;
    else
      -- A daily scheduled run rewrites only the as-of-dependent keys (ADR-047.8), leaving every
      -- other figure exactly as the last full run left it.
      delete from public.metric_current c
       where c.organization_id = p_org and c.period_id = v_period
         and c.metric_key = any (p_as_of_keys);
    end if;

    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id,
            snapshot_id, calculation_run_id, previous_snapshot_id)
    select p_org, m.period_id, m.metric_key, m.dimension_type, m.dimension_id,
           m.id, p_run,
           (select prev.id
              from public.metric_snapshots prev
              join public.calculation_runs pr
                on pr.organization_id = prev.organization_id and pr.id = prev.calculation_run_id
             where prev.organization_id = p_org
               and prev.period_id = m.period_id
               and prev.metric_key = m.metric_key
               and prev.dimension_type = m.dimension_type
               and prev.dimension_id is not distinct from m.dimension_id
               and prev.calculation_run_id <> p_run
             order by pr.started_at desc
             limit 1)
      from public.metric_snapshots m
     where m.organization_id = p_org and m.calculation_run_id = p_run and m.period_id = v_period
       and (p_as_of_keys is null or m.metric_key = any (p_as_of_keys));
  end loop;

  update public.calculation_runs r
     set chunks = r.chunks || jsonb_build_array(jsonb_build_object(
           'cursor', p_cursor, 'aggregated_at', p_aggregated_at, 'finished_at', now())),
         progress = jsonb_build_object(
           'periods_done', coalesce((r.progress ->> 'periods_done')::int, 0) + array_length(p_period_ids, 1),
           'periods_total', coalesce((r.progress ->> 'periods_total')::int, 0))
   where r.organization_id = p_org and r.id = p_run;

  return jsonb_build_object('written', v_written, 'periods', array_length(p_period_ids, 1));
end $$;

create function api_server.finish_calculation_run(
  p_org    uuid,
  p_run    uuid,
  p_status public.calculation_status_enum,
  p_stats  jsonb default '{}'::jsonb,
  p_error  jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_started timestamptz; v_periods uuid[];
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  select r.started_at into v_started
    from public.calculation_runs r where r.organization_id = p_org and r.id = p_run;
  if v_started is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- §2.4 step 12: a failed run puts back exactly the pointers it replaced. Leaving them mixed
  -- between two runs is the one outcome that must not happen — a reader would see this month from
  -- the failed run and last month from the previous one.
  if p_status = 'failed' then
    select array_agg(distinct period_id) into v_periods
      from public.metric_snapshots
     where organization_id = p_org and calculation_run_id = p_run;

    if v_periods is not null then
      delete from public.metric_current c
       where c.organization_id = p_org and c.calculation_run_id = p_run;

      insert into public.metric_current
             (organization_id, period_id, metric_key, dimension_type, dimension_id,
              snapshot_id, calculation_run_id)
      select p_org, prev.period_id, prev.metric_key, prev.dimension_type, prev.dimension_id,
             prev.id, prev.calculation_run_id
        from public.metric_snapshots prev
       where prev.organization_id = p_org
         and prev.id in (select distinct previous_snapshot_id
                           from public.metric_current
                          where organization_id = p_org and calculation_run_id = p_run
                            and previous_snapshot_id is not null)
      on conflict do nothing;
    end if;
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

-- `fiscal_periods.is_complete` is maintained by the run and by nothing else (§2.2, ADR-030.1).
create function api_server.set_period_completeness(
  p_org uuid, p_periods uuid[], p_complete boolean[]
) returns integer
language plpgsql security definer set search_path = '' as $$
declare i integer; v_count integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  for i in 1 .. coalesce(array_length(p_periods, 1), 0) loop
    update public.fiscal_periods
       set is_complete = p_complete[i]
     where organization_id = p_org and id = p_periods[i]
       and is_complete is distinct from p_complete[i];
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api_server'
       and pg_catalog.pg_get_userbyid(p.proowner) <> 'motion_definer'
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public, authenticated, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
