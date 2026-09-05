-- MOTION — Phase 4 (plan Phase 6) · Correction to the failed-run pointer restore.
-- Contract: FINANCIAL_ENGINE.md §2.4 step 12.
--
-- The first version deleted the failed run's pointers and THEN read `previous_snapshot_id` from
-- `metric_current` to decide what to put back — from rows it had just removed. The restore silently
-- put back nothing, which is worse than not restoring at all: the organization would be left with no
-- current pointer for the range, so the dashboard would show nothing rather than the previous run's
-- figures. Found by the integration suite, not by inspection.
--
-- The previous ids are now captured BEFORE the delete.

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
      dimension_id uuid, snapshot_id uuid, calculation_run_id uuid
    ) on commit drop;
    delete from _restore_pointers;

    insert into _restore_pointers
    select prev.period_id, prev.metric_key, prev.dimension_type, prev.dimension_id,
           prev.id, prev.calculation_run_id
      from public.metric_current c
      join public.metric_snapshots prev
        on prev.organization_id = c.organization_id and prev.id = c.previous_snapshot_id
     where c.organization_id = p_org and c.calculation_run_id = p_run
       and c.previous_snapshot_id is not null;

    delete from public.metric_current c
     where c.organization_id = p_org and c.calculation_run_id = p_run;

    insert into public.metric_current
           (organization_id, period_id, metric_key, dimension_type, dimension_id,
            snapshot_id, calculation_run_id)
    select p_org, period_id, metric_key, dimension_type, dimension_id,
           snapshot_id, calculation_run_id
      from _restore_pointers
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

alter function api_server.finish_calculation_run(uuid, uuid, public.calculation_status_enum, jsonb, jsonb)
  owner to motion_definer;
revoke all on function api_server.finish_calculation_run(uuid, uuid, public.calculation_status_enum, jsonb, jsonb)
  from public, authenticated, anon;
grant execute on function api_server.finish_calculation_run(uuid, uuid, public.calculation_status_enum, jsonb, jsonb)
  to service_role;
