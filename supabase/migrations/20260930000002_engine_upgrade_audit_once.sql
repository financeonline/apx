-- MOTION — ADR-123 (independent audit L-5) · the engine-upgrade sweep audits a job only when it
-- QUEUES one.
--
-- `enqueue_engine_upgrade` (20260930000001) wrote a `job.enqueued` audit row for every eligible
-- organisation on every call — also when `app.enqueue_recalculation` merely re-found the job already
-- queued — so 18 jobs left 36 audit rows, and the nightly sweep kept adding one a night for an
-- organisation whose run keeps failing. An audit row now means a job was queued. The count it
-- returns is unchanged: every organisation still behind (newly queued or already waiting).

create or replace function api_server.enqueue_engine_upgrade(p_engine_version text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid;
  v_job     uuid;
  v_waiting boolean;
  v_count   integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_engine_version is null or p_engine_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$' then
    raise exception 'VALIDATION: an engine version is major.minor.patch' using errcode = '22023';
  end if;

  for v_org in
    select o.id
      from public.organizations o
     where o.status in ('active', 'suspended')
       and exists (select 1 from public.calculation_runs r
                    where r.organization_id = o.id and r.status = 'succeeded')
       and not exists (select 1 from public.calculation_runs r
                        where r.organization_id = o.id and r.status = 'succeeded'
                          and r.engine_version = p_engine_version)
     order by o.id
  loop
    v_waiting := exists (select 1 from public.jobs j
                          where j.organization_id = v_org and j.job_type = 'calculation.run'
                            and j.status = 'queued');
    v_job := app.enqueue_recalculation(v_org, 'recalc_manual');
    if not v_waiting then
      perform app.audit(v_org, 'job.enqueued', 'jobs', v_job, null,
                        jsonb_build_object('job_type', 'calculation.run', 'reason', 'engine_upgrade',
                                           'engine_version', p_engine_version),
                        '{}'::jsonb, null);
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

alter function api_server.enqueue_engine_upgrade(text) owner to motion_definer;
revoke all on function api_server.enqueue_engine_upgrade(text) from public, anon, authenticated;
grant execute on function api_server.enqueue_engine_upgrade(text) to service_role;
