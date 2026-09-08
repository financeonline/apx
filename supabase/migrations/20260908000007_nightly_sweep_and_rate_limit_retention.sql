-- MOTION — The nightly sweep is actually scheduled, and the throttle counter is pruned (ADR-074).
-- Contract: SERVICE_ARCHITECTURE.md §7 (`storage.cleanup_orphans` — "nightly", idempotency key
--           `date`), DATABASE_ARCHITECTURE.md §7 `api_rate_limits` (retention is the sweep's job),
--           ADR-064 ("Still missing: nothing enqueues this job"); PRODUCTION_AUDIT.md M4.
--
-- Two gaps with one root: the nightly sweep existed as a handler and nothing ever queued it, so the
-- retention it was meant to carry — `api_rate_limits`, which `app.throttle` upserts once per user,
-- per bucket, per minute and never deletes — never ran either. A table with a unique index that
-- every `api.*` call writes to, growing by hundreds of thousands of rows a day, gets slower every
-- month and never falls over on a day anyone is watching.

-- ---------------------------------------------------------------------------
-- Retention. Two days keeps every live window: the longest bucket in use is one day
-- (`upload:org`), and a row older than two days can belong to no window that is still counting.
-- ---------------------------------------------------------------------------
create function api_server.prune_rate_limits(p_keep interval default interval '2 days')
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_n integer;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  if p_keep < interval '1 day' then
    -- The longest live window is a day; pruning inside it would reset somebody's counter.
    raise exception 'VALIDATION: rate-limit rows must be kept for at least one day' using errcode = '22023';
  end if;
  delete from public.api_rate_limits where window_start < now() - p_keep;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- The nightly enqueue. One platform-wide `storage.cleanup_orphans` per calendar date, keyed on the
-- date as §7 specifies, so a cron that fires twice — or a deploy that re-runs it — queues nothing
-- twice. Returns the job that exists for the date, new or not.
-- ---------------------------------------------------------------------------
create function api_server.enqueue_nightly_sweep(p_date date default (now() at time zone 'utc')::date)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid; v_key text := 'storage.cleanup_orphans:' || p_date::text;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- Already queued for this date: hand it back. Already RUN for this date: also hand it back — the
  -- queued-only unique index would let a second one in, and one sweep a night is the contract.
  select j.id into v_id
    from public.jobs j
   where j.job_type = 'storage.cleanup_orphans' and j.idempotency_key = v_key
   order by j.created_at desc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
  values (null, 'storage.cleanup_orphans', jsonb_build_object('date', p_date), null, v_key)
  on conflict (job_type, idempotency_key) where (status = 'queued' and idempotency_key is not null)
    do update set payload = public.jobs.payload
  returning id into v_id;

  perform app.audit(null, 'job.enqueued', 'jobs', v_id, null,
                    jsonb_build_object('job_type', 'storage.cleanup_orphans', 'date', p_date),
                    '{}'::jsonb, null);
  return v_id;
end $$;

alter function api_server.prune_rate_limits(interval) owner to motion_definer;
alter function api_server.enqueue_nightly_sweep(date) owner to motion_definer;
revoke all on function api_server.prune_rate_limits(interval) from public, anon, authenticated;
revoke all on function api_server.enqueue_nightly_sweep(date) from public, anon, authenticated;
grant execute on function api_server.prune_rate_limits(interval) to service_role;
grant execute on function api_server.enqueue_nightly_sweep(date) to service_role;
