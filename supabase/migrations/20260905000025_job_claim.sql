-- MOTION — Phase 2 (plan Phase 4) · Atomic job claim for the worker.
-- Contract: DATABASE_ARCHITECTURE.md §9 (jobs); ADR-013, ADR-031.3, ADR-038.12, ADR-044.6; R2-A-10.
--
-- Claiming has to be one statement. Two workers running the same cron minute, or one worker retried
-- by the platform, must not both pick up the same job — a double-run of `calculation.run` would
-- publish two sets of pointers for one period, and a double-run of `org.purge` is unthinkable.
-- `for update skip locked` gives exactly-one-claimer without a lock table.

create function api_server.claim_job(p_worker text)
returns table (
  job_id          uuid,
  organization_id uuid,
  job_type        public.job_type_enum,
  payload         jsonb,
  requested_by    uuid,
  attempts        smallint,
  max_attempts    smallint
)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-044.6 / R2-A-10: a job whose worker died is returned to the queue before anyone claims, so a
  -- lost worker delays a job by its budget rather than stalling it forever.
  perform app.reclaim_stale_jobs();

  select j.id into v_id
    from public.jobs j
    left join public.organizations o on o.id = j.organization_id
   where j.status = 'queued'
     and j.run_after <= now()
     and j.attempts < j.max_attempts
     -- ADR-038.12: work for a suspended or closing organization waits, except the purge itself,
     -- which is the whole point of the closing state.
     and (j.organization_id is null
          or j.job_type = 'org.purge'
          or o.status = 'active')
   order by j.run_after, j.created_at
   for update of j skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  return query
    update public.jobs j
       set status = 'running', locked_at = now(), locked_by = p_worker, attempts = j.attempts + 1
     where j.id = v_id
    returning j.id, j.organization_id, j.job_type, j.payload, j.requested_by, j.attempts, j.max_attempts;
end $$;

-- Records the outcome. Separate from the claim so a worker crash between the two leaves the job
-- `running` and reclaimable, rather than lost.
create function api_server.finish_job(
  p_job    uuid,
  p_status public.job_status_enum,
  p_result jsonb default '{}'::jsonb,
  p_error  text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_attempts smallint; v_max smallint; v_type public.job_type_enum; v_org uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_status not in ('succeeded', 'failed', 'dead', 'deferred_upstream') then
    raise exception 'VALIDATION: finish_job records a terminal outcome only' using errcode = '22023';
  end if;

  select j.attempts, j.max_attempts, j.job_type, j.organization_id
    into v_attempts, v_max, v_type, v_org
    from public.jobs j where j.id = p_job and j.status = 'running';
  if v_type is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.jobs j
     set status = case
           -- A failure with attempts left goes back to the queue with exponential backoff; only an
           -- exhausted job is `dead`, and only a `dead` job stops being retried.
           when p_status = 'failed' and v_attempts < v_max then 'queued'::public.job_status_enum
           when p_status = 'failed' then 'dead'::public.job_status_enum
           else p_status end,
         run_after = case
           when p_status = 'failed' and v_attempts < v_max
             then now() + (interval '30 seconds' * power(2, v_attempts)::integer)
           when p_status = 'deferred_upstream' then now() + interval '10 minutes'
           else j.run_after end,
         locked_at = null,
         locked_by = null,
         last_error = p_error,
         result = coalesce(p_result, '{}'::jsonb),
         finished_at = case when p_status in ('succeeded', 'dead') then now() else null end
   where j.id = p_job;

  if p_status = 'dead' or (p_status = 'failed' and v_attempts >= v_max) then
    perform app.audit(v_org, 'job.dead', 'jobs', p_job, null,
                      jsonb_build_object('job_type', v_type, 'error', p_error), '{}'::jsonb);
  end if;
  return p_job;
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api_server' and p.proname in ('claim_job', 'finish_job')
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public, authenticated, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
