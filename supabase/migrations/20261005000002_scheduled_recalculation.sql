-- MOTION — Engine · a daily scheduled recalculation, and a queue that cannot jam on it (FU-6, ADR-131).
-- Contract: FINANCIAL_ENGINE.md §2.4, §6; ADR-031.1, ADR-047.8 (amended by ADR-131); ADR-044.6.
--
-- 1. `api_server.enqueue_scheduled_recalculation(p_now)` — called HOURLY by `/api/jobs/scheduled`
--    (ADR-135): each organisation is due at the first tick after its own local midnight, whatever its
--    UTC offset or DST state, and idempotency per local date keeps it to ONE run a day. `p_now` exists
--    for tests (DST, offsets); production passes nothing. Nothing ever
--    queued the `scheduled` trigger (ADR-122 FU-6, H-14), so a month that ended with no new data kept
--    the figures computed while it was current — aged at an old date, its invoice coverage judged by
--    the current-month rule, never health-scored — and overdue invoices, "stopped" recurring payments
--    and their alerts moved only when someone imported something. One `calculation.run` per ACTIVE
--    organisation whose latest succeeded run is dated before today IN ITS OWN TIMEZONE. The date is
--    the "nothing changed" test: unchanged rows alone never justify skipping, because ageing and the
--    current month move with the date. The run decides the range (chunking `affectedRange`): the
--    current period, and the month that closed since the last run.
--      - Idempotent per organisation and local date: a scheduled job for that date in ANY status is
--        never queued again, and a run that already succeeded today makes the org ineligible.
--      - A calculation already waiting is left to run: it computes with today's date and the same
--        roll-over rule.
--      - Suspended, closing and deleted organisations are skipped (their jobs would only wait).
--      - Organisations never run are skipped: there is nothing to keep current.
--
-- 2. `app.enqueue_recalculation` — coalescing into a queued SCHEDULED job used to keep the scheduled
--    payload and drop the new trigger, so an import into January coalesced into a current-month run
--    would never be computed. A scheduled payload now gives way: every other trigger's range already
--    contains it.
--
-- 3. `api_server.finish_job` / `app.reclaim_stale_jobs` — `jobs_idempotency_queued_unique` covers
--    queued rows only. A calculation that FAILED (or whose worker was lost) while a twin with the same
--    key was already queued was put back to `queued`, which violates the index: `finish_job` raised,
--    and `reclaim_stale_jobs` — run inside every `claim_job` — raised too, stalling the whole queue.
--    Such a job is now COALESCED into its twin (`cancelled`, with the reason), and for a calculation
--    the twin is widened so nothing the failed job had to compute is lost.

-- ---------------------------------------------------------------------------------------------
-- The merge rule, in one place
-- ---------------------------------------------------------------------------------------------
create function app.merged_calculation_payload(p_queued jsonb, p_other jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
           when p_queued ->> 'trigger' = 'scheduled' then p_other
           when p_other ->> 'trigger' = 'scheduled' then p_queued
           when p_queued = p_other then p_queued
           -- Two different ranges, rare (a failure while another change waited): the full range is
           -- the only payload certain to contain both.
           else jsonb_build_object('trigger', 'recalc_manual', 'triggerRefId', null)
         end;
$$;
alter function app.merged_calculation_payload(jsonb, jsonb) owner to motion_definer;
revoke all on function app.merged_calculation_payload(jsonb, jsonb) from public, authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- 2. Coalescing a new trigger into a queued scheduled run
-- ---------------------------------------------------------------------------------------------
create or replace function app.enqueue_recalculation(
  p_org     uuid,
  p_trigger public.calculation_trigger_enum,
  p_ref     uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_job uuid; v_payload jsonb;
begin
  v_payload := jsonb_build_object('trigger', p_trigger::text, 'triggerRefId', p_ref);
  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
  values (p_org, 'calculation.run', v_payload, app.uid(), 'calculation.run:' || p_org::text)
  on conflict do nothing
  returning id into v_job;

  if v_job is null then
    -- ADR-031.1: the idempotency index covers QUEUED jobs only, so a collision means a run is
    -- already waiting and will pick this change up. Return it, so the caller can link to it.
    select j.id into v_job
      from public.jobs j
     where j.organization_id = p_org and j.job_type = 'calculation.run' and j.status = 'queued'
     order by j.created_at desc
     limit 1;
    -- FU-6: a waiting SCHEDULED run covers only the date-dependent periods; this trigger's range
    -- contains it, so the waiting job takes this payload rather than dropping it.
    update public.jobs j
       set payload = v_payload
     where j.id = v_job and j.payload ->> 'trigger' = 'scheduled' and p_trigger <> 'scheduled';
  end if;

  return v_job;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. A retry that would collide with a queued twin is coalesced into it
-- ---------------------------------------------------------------------------------------------
create or replace function app.reclaim_stale_jobs() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0; v_twin uuid; r record;
begin
  -- Oldest first, and the twin looked up at the moment each job is handled: two lost workers with
  -- one key requeue the first and coalesce the second into it.
  for r in
    select j.id, j.job_type, j.idempotency_key, j.payload, j.attempts, j.max_attempts, j.organization_id
      from public.jobs j
     where j.status = 'running'
       and j.locked_at < now() - (app.job_max_runtime(j.job_type) * 3)
     order by j.created_at, j.id
     for update of j
  loop
    v_twin := null;
    if r.idempotency_key is not null then
      select q.id into v_twin from public.jobs q
       where q.status = 'queued' and q.job_type = r.job_type and q.idempotency_key = r.idempotency_key
       limit 1;
    end if;

    if v_twin is not null then
      update public.jobs q
         set payload = case when r.job_type = 'calculation.run'
                            then app.merged_calculation_payload(q.payload, r.payload)
                            else r.payload || q.payload end
       where q.id = v_twin;
      update public.jobs
         set status = 'cancelled', locked_at = null, locked_by = null, finished_at = now(),
             last_error = 'coalesced into queued job ' || v_twin::text || ' after its worker was lost'
       where id = r.id;
    elsif r.attempts + 1 >= r.max_attempts then
      -- Lost on its last attempt: dead, not queued. A queued job no claim will take (claim_job needs
      -- attempts < max_attempts) would hold the organisation's queue slot for ever — every later
      -- trigger would merge into it and the daily enqueue would wait on it.
      update public.jobs
         set status = 'dead', locked_at = null, locked_by = null, attempts = attempts + 1,
             finished_at = now(), last_error = 'its worker was lost on the last attempt'
       where id = r.id;
      perform app.audit(r.organization_id, 'job.dead', 'jobs', r.id, null,
                        jsonb_build_object('job_type', r.job_type, 'error', 'worker lost on the last attempt'),
                        '{}'::jsonb);
    else
      update public.jobs
         set status = 'queued', locked_at = null, locked_by = null, attempts = attempts + 1
       where id = r.id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
alter function app.reclaim_stale_jobs() owner to motion_definer;
revoke all on function app.reclaim_stale_jobs() from public, authenticated, anon;

create or replace function api_server.finish_job(
  p_job    uuid,
  p_status public.job_status_enum,
  p_result jsonb default '{}'::jsonb,
  p_error  text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_attempts smallint; v_max smallint; v_type public.job_type_enum; v_org uuid;
  v_key text; v_payload jsonb; v_twin uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_status not in ('succeeded', 'failed', 'dead', 'deferred_upstream') then
    raise exception 'VALIDATION: finish_job records a terminal outcome only' using errcode = '22023';
  end if;

  select j.attempts, j.max_attempts, j.job_type, j.organization_id, j.idempotency_key, j.payload
    into v_attempts, v_max, v_type, v_org, v_key, v_payload
    from public.jobs j where j.id = p_job and j.status = 'running';
  if v_type is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- FU-6: a job that would go back to the queue while a twin with its key already waits there
  -- (a failure retry, or a deferral) is coalesced into the twin instead of violating the index.
  if v_key is not null and ((p_status = 'failed' and v_attempts < v_max) or p_status = 'deferred_upstream') then
    select q.id into v_twin from public.jobs q
     where q.status = 'queued' and q.job_type = v_type and q.idempotency_key = v_key
     limit 1;
    if v_twin is not null then
      update public.jobs q
         set payload = case when v_type = 'calculation.run'
                            then app.merged_calculation_payload(q.payload, v_payload)
                            else v_payload || q.payload end
       where q.id = v_twin;
      update public.jobs
         set status = 'cancelled', locked_at = null, locked_by = null, finished_at = now(),
             last_error = coalesce(p_error, '') || ' (coalesced into queued job ' || v_twin::text || ')',
             result = coalesce(p_result, '{}'::jsonb)
       where id = p_job;
      return p_job;
    end if;
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
alter function api_server.finish_job(uuid, public.job_status_enum, jsonb, text) owner to motion_definer;
revoke all on function api_server.finish_job(uuid, public.job_status_enum, jsonb, text) from public, authenticated, anon;
grant execute on function api_server.finish_job(uuid, public.job_status_enum, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 1. The nightly enqueue
-- ---------------------------------------------------------------------------------------------
create function api_server.enqueue_scheduled_recalculation(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid;
  v_today date;
  v_job   uuid;
  v_count integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  for v_org, v_today in
    select o.id, (p_now at time zone o.timezone)::date
      from public.organizations o
      -- A timezone the database does not know cannot fail the whole sweep for every tenant: such an
      -- organisation is skipped (its own runs fail loudly on the same value), and writes of a bad
      -- timezone are now refused (migration 20261005000004).
      join pg_catalog.pg_timezone_names tz on tz.name = o.timezone
      join lateral (
        select r.as_of
          from public.calculation_runs r
         where r.organization_id = o.id and r.status = 'succeeded'
         order by r.finished_at desc nulls last, r.id desc
         limit 1
      ) latest on true
     where o.status = 'active'
       and latest.as_of < (p_now at time zone o.timezone)::date
     order by o.id
  loop
    -- Once per organisation and local date, whatever became of the job.
    continue when exists (
      select 1 from public.jobs j
       where j.organization_id = v_org and j.job_type = 'calculation.run'
         and j.payload ->> 'trigger' = 'scheduled' and j.payload ->> 'as_of' = v_today::text);
    -- A calculation already waiting runs with today's date and the roll-over rule.
    continue when exists (
      select 1 from public.jobs j
       where j.organization_id = v_org and j.job_type = 'calculation.run' and j.status = 'queued');

    -- A month nothing has been dated in yet has no fiscal period, and a run with no current period
    -- would compute nothing — ageing and alerts would stand still for a quiet organisation.
    perform app.ensure_periods(v_org, v_today, v_today);

    insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
    values (v_org, 'calculation.run',
            jsonb_build_object('trigger', 'scheduled', 'triggerRefId', null, 'as_of', v_today::text),
            null, 'calculation.run:' || v_org::text)
    on conflict do nothing
    returning id into v_job;

    if v_job is not null then
      perform app.audit(v_org, 'job.enqueued', 'jobs', v_job, null,
                        jsonb_build_object('job_type', 'calculation.run', 'reason', 'scheduled',
                                           'as_of', v_today),
                        '{}'::jsonb, null);
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end $$;

alter function api_server.enqueue_scheduled_recalculation(timestamptz) owner to motion_definer;
revoke all on function api_server.enqueue_scheduled_recalculation(timestamptz) from public, anon, authenticated;
grant execute on function api_server.enqueue_scheduled_recalculation(timestamptz) to service_role;
