-- MOTION — Phase 5 (plan Phase 7) · The chunk writer carries `dimension_key`.
-- Contract: ADR-053; FINANCIAL_ENGINE.md §2.4 step 8.
--
-- `finish_chunk` was written before non-row dimensions had anywhere to live, so it inserted and
-- re-pointed on `dimension_id` alone. Left as it was, every category-dimensioned snapshot in a chunk
-- would collide on the uniqueness key and only one category per period would survive.

create or replace function api_server.finish_chunk(
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

  delete from public.metric_snapshots
   where organization_id = p_org and calculation_run_id = p_run
     and period_id = any (p_period_ids);

  for s in select * from jsonb_array_elements(p_snapshots) loop
    insert into public.metric_snapshots
           (organization_id, calculation_run_id, period_id, metric_key, dimension_type,
            dimension_id, dimension_key, value, unit, currency, basis, assurance_level,
            data_quality, components, evidence_query)
    values (p_org, p_run,
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
               and prev.dimension_key is not distinct from m.dimension_key
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

alter function api_server.finish_chunk(uuid, uuid, jsonb, uuid[], timestamptz, text, text[])
  owner to motion_definer;
revoke all on function api_server.finish_chunk(uuid, uuid, jsonb, uuid[], timestamptz, text, text[])
  from public, authenticated, anon;
grant execute on function api_server.finish_chunk(uuid, uuid, jsonb, uuid[], timestamptz, text, text[])
  to service_role;
