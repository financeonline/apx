-- MOTION — a member may cancel only the jobs a member can request (ADR-071).
-- Contract: DATABASE_ARCHITECTURE.md §9 (jobs), §14 (api.enqueue_job's two user-requestable types),
--           ADR-043.3, ADR-044.6; PRODUCTION_AUDIT.md M5.
--
-- `api.cancel_job` gated on `intelligence.recompute` and cancelled ANY queued job of the
-- organisation by id — `org.purge`, `alerts.evaluate`, `storage.cleanup_orphans`, a large-import
-- commit — none of which a member can enqueue, see (`jobs_select` is super-admin only), or should
-- be able to stop. `api.enqueue_job` already fixes the set of user-requestable jobs at exactly two,
-- `calculation.run` and `report.render`; cancellation is the mirror of enqueue and is held to the
-- same set, and to the requester themselves. Cancelling a purge in particular would leave an
-- organisation `pending_deletion` with nothing scheduled to delete it (ADR-067) — only
-- `api.cancel_deletion`, which resets the status too, may do that.

create or replace function api.cancel_job(p_job uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $function$
declare v_org uuid; v_type public.job_type_enum; v_requested_by uuid;
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');

  select organization_id, job_type, requested_by
    into v_org, v_type, v_requested_by
    from public.jobs where id = p_job;
  if v_org is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform app.require_permission(v_org, 'intelligence.recompute');

  -- Only the two job types api.enqueue_job lets a user create, and only the user who created this
  -- one. Everything else is server-originated and is the platform's to manage from /platform/jobs.
  if v_type not in ('calculation.run', 'report.render') then
    raise exception 'PERMISSION_DENIED: % is not a job you can cancel', v_type using errcode = '42501';
  end if;
  if v_requested_by is distinct from app.uid() then
    raise exception 'PERMISSION_DENIED: only the person who started a job can cancel it'
      using errcode = '42501';
  end if;

  update public.jobs set status = 'cancelled', finished_at = now()
   where id = p_job and status = 'queued';
  if not found then
    raise exception 'CONFLICT: only a queued job can be cancelled' using errcode = '23514';
  end if;

  perform app.audit(v_org, 'job.cancelled', 'jobs', p_job, null, null, '{}'::jsonb);
  return p_job;
end $function$;
