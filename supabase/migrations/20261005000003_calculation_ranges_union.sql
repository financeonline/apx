-- MOTION — Engine · a coalesced recalculation computes the UNION of what every trigger changed (FU-16, ADR-132).
-- Contract: FINANCIAL_ENGINE.md §2.4; ADR-031.1, ADR-131.
--
-- One calculation can wait per organisation (`jobs_idempotency_queued_unique`), so a second trigger
-- COALESCES into the waiting job. Until now the waiting job kept its own payload and the new trigger
-- was dropped:
--   - a March import waiting, then a January import: January was never recomputed;
--   - a March import waiting, then an account remap (which changes every period): only March onward
--     was recomputed, under the new mapping, with earlier months left on the old one.
-- And a calculation could be CLAIMED while another for the same organisation was RUNNING (the index
-- covers queued rows only), so two runs could interleave their pointer writes.
--
--   1. `app.merged_calculation_payload` keeps the union: a full-range trigger (`recalc_manual`,
--      `account_remapped`, `settings_changed`) wins outright; a `scheduled` payload gives way; any
--      other two keep EVERY trigger reference in `refs`, and the handler recomputes from the
--      earliest period any of them touched (`calculation-run.ts periodsTouchedByAll`).
--   2. `app.enqueue_recalculation` is one statement: insert, or merge into the queued job.
--   3. `api_server.claim_job` never starts a calculation for an organisation with one running. The
--      waiting job runs after it, with everything that arrived meanwhile.

create or replace function app.merged_calculation_payload(p_queued jsonb, p_other jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  with refs as (
    select distinct r
      from (
        select jsonb_array_elements(coalesce(p_queued -> 'refs', jsonb_build_array(
                 jsonb_build_object('trigger', p_queued ->> 'trigger', 'triggerRefId', p_queued -> 'triggerRefId')))) as r
        union all
        select jsonb_array_elements(coalesce(p_other -> 'refs', jsonb_build_array(
                 jsonb_build_object('trigger', p_other ->> 'trigger', 'triggerRefId', p_other -> 'triggerRefId')))) as r
      ) u
  )
  select case
           when p_queued is null then p_other
           when p_other is null then p_queued
           when p_queued ->> 'trigger' = 'scheduled' then p_other
           when p_other ->> 'trigger' = 'scheduled' then p_queued
           when p_queued ->> 'trigger' in ('recalc_manual', 'account_remapped', 'settings_changed') then p_queued
           when p_other ->> 'trigger' in ('recalc_manual', 'account_remapped', 'settings_changed') then p_other
           when p_queued = p_other then p_queued
           else jsonb_build_object(
                  'trigger', p_queued ->> 'trigger',
                  'triggerRefId', p_queued -> 'triggerRefId',
                  'refs', (select jsonb_agg(r order by r::text) from refs))
         end;
$$;
alter function app.merged_calculation_payload(jsonb, jsonb) owner to motion_definer;
revoke all on function app.merged_calculation_payload(jsonb, jsonb) from public, authenticated, anon;

create or replace function app.enqueue_recalculation(
  p_org     uuid,
  p_trigger public.calculation_trigger_enum,
  p_ref     uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_job uuid;
begin
  -- One statement: a concurrent enqueue either inserts or merges, never drops.
  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
  values (p_org, 'calculation.run',
          jsonb_build_object('trigger', p_trigger::text, 'triggerRefId', p_ref),
          app.uid(), 'calculation.run:' || p_org::text)
  on conflict (job_type, idempotency_key) where (status = 'queued' and idempotency_key is not null)
    do update set payload = app.merged_calculation_payload(public.jobs.payload, excluded.payload)
  returning id into v_job;
  return v_job;
end $$;
alter function app.enqueue_recalculation(uuid, public.calculation_trigger_enum, uuid) owner to motion_definer;

create or replace function api_server.claim_job(p_worker text)
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

  -- FU-16: claims are serialised, so the "nothing of this organisation is running" test below sees
  -- every claim committed before it. A claim is a few milliseconds; the run itself is not locked.
  perform pg_advisory_xact_lock(hashtext('api_server.claim_job'));

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
     -- FU-16: one calculation per organisation at a time. The waiting job runs after the running one
     -- and carries everything that arrived meanwhile.
     and not (j.job_type = 'calculation.run' and exists (
           select 1 from public.jobs r
            where r.organization_id = j.organization_id and r.job_type = 'calculation.run'
              and r.status = 'running'))
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
alter function api_server.claim_job(text) owner to motion_definer;
revoke all on function api_server.claim_job(text) from public, authenticated, anon;
grant execute on function api_server.claim_job(text) to service_role;
