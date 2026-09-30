-- MOTION — ADR-120 hardening · every organisation is recomputed on a new engine version.
-- Contract: FINANCIAL_ENGINE.md §6 ("a major bump enqueues calculation.run … for every active
-- organization"), ADR-120.
--
-- Engine 2.0.0 changes financial figures (receivables, payables, working capital, the cash chain).
-- Until an organisation's next run it shows the figures an older engine wrote, and nothing ever
-- guaranteed that next run would come. This queues it — through the EXISTING path, not a new one:
--
--   * `app.enqueue_recalculation(org, 'recalc_manual')`, the function every import and manual
--     recalculation already uses. Its idempotency key `calculation.run:<org>` coalesces with any
--     calculation already queued for the organisation, so calling this twice queues nothing twice.
--   * The ordinary worker then runs each organisation's job on its own, under `withOrgScope`: one
--     organisation's failure is its own job's failure (visible in /platform/jobs), never another's.
--   * The run itself recomputes the whole history on a version change (`loadLatestEngineVersion`).
--
-- Eligible = an organisation that is `active` or `suspended` (the worker already re-queues a
-- suspended organisation's jobs with backoff) which HAS figures from a succeeded run and has NO
-- succeeded run on `p_engine_version`. An organisation that never ran has no old figures to replace.
-- Resumable by construction: an organisation drops out of the eligible set only once a run on the
-- new version has SUCCEEDED, so a failed or interrupted one is picked up by the next call — the
-- nightly cron calls this every night (`/api/jobs/nightly`), so no organisation can be left behind
-- silently. Returns a count, never a row list (PostgREST caps set results at 1,000 rows).

create function api_server.enqueue_engine_upgrade(p_engine_version text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid;
  v_job   uuid;
  v_count integer := 0;
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
    v_job := app.enqueue_recalculation(v_org, 'recalc_manual');
    perform app.audit(v_org, 'job.enqueued', 'jobs', v_job, null,
                      jsonb_build_object('job_type', 'calculation.run', 'reason', 'engine_upgrade',
                                         'engine_version', p_engine_version),
                      '{}'::jsonb, null);
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

alter function api_server.enqueue_engine_upgrade(text) owner to motion_definer;
revoke all on function api_server.enqueue_engine_upgrade(text) from public, anon, authenticated;
grant execute on function api_server.enqueue_engine_upgrade(text) to service_role;
