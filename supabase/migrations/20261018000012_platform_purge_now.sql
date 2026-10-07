-- MOTION — The super admin deletes a company for good, now (ADR-168).
--
-- Owner, 2026-10-07: for a company whose deletion is requested, "ask me 'Are you sure you want to
-- delete it?' If I say yes, delete it. If I say no, don't."
--
-- api.platform_purge_now(p_org) skips the thirty-day wait for a company that is already
-- `pending_deletion`: it moves the request back past the thirty days and runs the queued `org.purge`
-- job now (queueing one if none is waiting). The purge itself is the existing, tested path
-- (`api_server.purge_organization` + the Storage half in the job): every tenant row deleted, the audit
-- trail redacted, every stored object removed, the company `deleted`. Nothing else changes.
--   - the super admin with a sign-in from the last ten minutes; only a company already scheduled;
--   - audited as platform.org_purge_now (the record survives the purge, redacted like the rest).

create function api.platform_purge_now(p_org uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_status public.org_status_enum;
  v_job    uuid;
begin
  perform app.throttle(app.uid(), 'platform_purge_now', 20, interval '1 hour');
  perform app.require_super_admin(true);

  select o.status into v_status from public.organizations o where o.id = p_org for update;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status <> 'pending_deletion' then
    raise exception 'CONFLICT: delete the company first; only a company whose deletion is requested can be deleted for good'
      using errcode = '23514';
  end if;

  perform app.audit(p_org, 'platform.org_purge_now', 'organizations', p_org, null, null, '{}'::jsonb);

  -- The purge re-verifies the thirty days; the super admin's decision is that they have passed.
  update public.organizations o
     set deletion_requested_at = now() - interval '30 days 1 minute'
   where o.id = p_org;

  update public.jobs j
     set run_after = now()
   where j.organization_id = p_org and j.job_type = 'org.purge' and j.status = 'queued'
  returning j.id into v_job;
  if v_job is null then
    insert into public.jobs (organization_id, job_type, payload, run_after, idempotency_key)
    values (p_org, 'org.purge', '{}'::jsonb, now(), 'org.purge:now:' || p_org::text || ':' || extract(epoch from now())::bigint)
    returning id into v_job;
  end if;
  return v_job;
end $$;

alter function api.platform_purge_now(uuid) owner to motion_definer;
revoke all on function api.platform_purge_now(uuid) from public, anon;
grant execute on function api.platform_purge_now(uuid) to authenticated;
