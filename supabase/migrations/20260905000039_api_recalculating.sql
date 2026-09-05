-- MOTION — Phase 5 (plan Phase 7) · "Updating your numbers" for a tenant reader.
-- Contract: UX_ARCHITECTURE.md §7.1; DATABASE_ARCHITECTURE.md §9 (jobs RLS is platform-only),
-- §14.3 (reads RLS alone cannot express); ADR-031, finding F-D-03.
--
-- §7.1 requires the banner to key off a queued or running `calculation.run` JOB, never off
-- `calculation_runs.status` — an orphaned run row would otherwise leave the banner up forever. But
-- `jobs` is deliberately readable by platform staff only: it carries payloads and worker state that
-- are none of a tenant's business, and widening its policy to show a banner would be a poor trade.
--
-- So the question is answered by a function rather than by a policy. It returns a boolean and
-- nothing else: no job id, no payload, no error text, no queue depth. A tenant learns exactly the
-- one fact the interface needs and not a byte more.

create function api.is_recalculating(p_org uuid)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_org(p_org);
  return exists (
    select 1 from public.jobs j
     where j.organization_id = p_org
       and j.job_type = 'calculation.run'
       and j.status in ('queued', 'running'));
end $$;

alter function api.is_recalculating(uuid) owner to motion_definer;
revoke all on function api.is_recalculating(uuid) from public;
grant execute on function api.is_recalculating(uuid) to authenticated;
