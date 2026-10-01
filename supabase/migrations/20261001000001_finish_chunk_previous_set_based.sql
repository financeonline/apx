-- MOTION — `finish_chunk` resolves each new cell's previous snapshot in ONE set-based pass.
--
-- The metric_current insert looked up `previous_snapshot_id` with a correlated subquery per row,
-- matching on `dimension_id is not distinct from …`, which no index can serve: for a period with N
-- cells of one metric (one per customer) every row re-read all N candidates of that metric — N² heap
-- visits inside one RPC. 1,050 customers in one month (the ADR-123 BIGINV fixture) put the chunk at
-- 5–9 s against the 8 s statement timeout, so the run failed or passed by machine noise, and a real
-- organisation with a few thousand customers would fail every time.
--
-- The latest earlier snapshot per cell is now picked once (DISTINCT ON, newest run first — the same
-- `order by started_at desc` the subquery used) and hash-joined on the cell. NULL-safe equality is
-- spelled as "both null, or equal", which is hashable, instead of IS NOT DISTINCT FROM, which is not.
-- Behaviour is otherwise unchanged; the body is the 20260911000001 definition with that one insert
-- rewritten.

create or replace function api_server.finish_chunk(p_org uuid, p_run uuid, p_snapshots jsonb, p_period_ids uuid[], p_aggregated_at timestamp with time zone, p_cursor text, p_as_of_keys text[] DEFAULT NULL::text[])
returns jsonb
language plpgsql security definer set search_path = ''
as $motion$
declare
  s          jsonb;
  v_written  integer := 0;
  v_period   uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);
  if not exists (select 1 from public.calculation_runs r
                  where r.organization_id = p_org and r.id = p_run and r.status = 'running') then
    raise exception 'CONFLICT: this run is not running' using errcode = '40001';
  end if;

  delete from public.metric_snapshots
   where organization_id = p_org and calculation_run_id = p_run
     and period_id = any (p_period_ids);

  for s in select * from jsonb_array_elements(p_snapshots) loop
    insert into public.metric_snapshots
           (id, organization_id, calculation_run_id, period_id, metric_key, dimension_type,
            dimension_id, dimension_key, value, unit, currency, basis, assurance_level,
            data_quality, components, evidence_query)
    -- The id comes from the ENGINE when it has one (ADR-059): a derived metric's
    -- `evidence_query.components[].snapshot_id` has to name its inputs, and it is composed before
    -- anything is inserted, so the ids have to exist before the insert or the chain is written
    -- with nulls in it. `gen_random_uuid()` remains the default for any caller that does not care.
    values (coalesce((s ->> 'id')::uuid, gen_random_uuid()), p_org, p_run,
            (s ->> 'period_id')::uuid,
            s ->> 'metric_key',
            coalesce((s ->> 'dimension_type')::public.metric_dimension_enum, 'none'),
            (s ->> 'dimension_id')::uuid,
            s ->> 'dimension_key',
            (s ->> 'value')::numeric,
            (s ->> 'unit')::public.metric_unit_enum,
            s ->> 'currency',
            (s ->> 'basis')::public.metric_basis_enum,
            (s ->> 'assurance_level')::public.assurance_level_enum,
            coalesce(s -> 'data_quality', '{}'::jsonb),
            coalesce(s -> 'components', '{}'::jsonb),
            s -> 'evidence_query');
    v_written := v_written + 1;
  end loop;

  foreach v_period in array p_period_ids loop
    if p_as_of_keys is null then
      delete from public.metric_current c
       where c.organization_id = p_org and c.period_id = v_period;
    else
      delete from public.metric_current c
       where c.organization_id = p_org and c.period_id = v_period
         and c.metric_key = any (p_as_of_keys);
    end if;

    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id, dimension_key,
            snapshot_id, calculation_run_id, previous_snapshot_id)
    select p_org, m.period_id, m.metric_key, m.dimension_type, m.dimension_id, m.dimension_key,
           m.id, p_run, prev.id
      from public.metric_snapshots m
      left join (
        -- The newest earlier run's snapshot of every cell of this period, picked once.
        select distinct on (s.metric_key, s.dimension_type, s.dimension_id, s.dimension_key)
               s.id, s.metric_key, s.dimension_type, s.dimension_id, s.dimension_key
          from public.metric_snapshots s
          join public.calculation_runs pr
            on pr.organization_id = s.organization_id and pr.id = s.calculation_run_id
         where s.organization_id = p_org
           and s.period_id = v_period
           and s.calculation_run_id <> p_run
         order by s.metric_key, s.dimension_type, s.dimension_id, s.dimension_key, pr.started_at desc
      ) prev
        on prev.metric_key = m.metric_key
       and prev.dimension_type = m.dimension_type
       and (prev.dimension_id is null) = (m.dimension_id is null)
       and coalesce(prev.dimension_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(m.dimension_id, '00000000-0000-0000-0000-000000000000'::uuid)
       and (prev.dimension_key is null) = (m.dimension_key is null)
       and coalesce(prev.dimension_key, '') = coalesce(m.dimension_key, '')
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
end $motion$;
