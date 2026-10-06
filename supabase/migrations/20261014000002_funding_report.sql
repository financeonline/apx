-- MOTION — Phase 17 · the Funding Readiness Report (REQ-RP-05; ADR-141, ADR-145).
--
-- A stored report of one month's CURRENT Funding Readiness assessment — the same rows the page shows,
-- frozen as the report says them — with its PDF. Like the page, it exists only while
-- `features.funding_readiness` is on: composing one is refused otherwise, and a stored one is hidden by
-- RLS while the flag is off (U-5), as are its PDFs (they are readable exactly where the report is).

alter table public.reports drop constraint reports_period_required;
alter table public.reports add constraint reports_period_required check (
  report_kind not in ('adviser', 'custom_ai', 'funding_readiness') or period_id is not null);

drop policy reports_select on public.reports;
create policy reports_select on public.reports for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and (report_kind <> 'custom_ai' or requested_by = (select app.uid()))
         and (report_kind <> 'funding_readiness' or app.funding_enabled(organization_id)));

create or replace function api.enqueue_job(p_org uuid, p_job_type public.job_type_enum, p_payload jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id      uuid;
  v_payload jsonb;
  v_key     text;
  v_kind    text;
  v_start   date;
  v_end     date;
  v_today   date;
  v_report  uuid;
begin
  perform app.throttle(app.uid(), 'enqueue_job:' || p_job_type::text, 30, interval '1 hour');
  perform app.require_org(p_org);

  -- Only these job types are user-intent. Everything else is server-originated and goes through
  -- api_server.enqueue_job; org.purge is trigger-only.
  if p_job_type = 'calculation.run' then
    perform app.require_permission(p_org, 'intelligence.recompute');
    v_payload := jsonb_build_object(
      'trigger', 'recalc_manual',                                   -- derived, never accepted
      'periodFrom', p_payload ->> 'periodFrom',
      'periodTo',   p_payload ->> 'periodTo');
    v_key := 'calculation.run:' || p_org::text;

  elsif p_job_type = 'report.render' then
    perform app.require_permission(p_org, 'reports.generate');
    if p_payload ? 'reportId' then
      begin
        v_report := (p_payload ->> 'reportId')::uuid;
      exception when others then
        raise exception 'VALIDATION: reportId is not a uuid' using errcode = '22023';
      end;
      -- Resolved through the reports policy: another person's Custom AI Report, or another
      -- organisation's report, is simply not there.
      if not exists (select 1 from public.reports r where r.organization_id = p_org and r.id = v_report
                        and (r.report_kind <> 'custom_ai' or r.requested_by = app.uid())) then
        raise exception 'NOT_FOUND' using errcode = 'P0002';
      end if;
      v_payload := jsonb_build_object('reportId', v_report);
      v_key := 'report.render:' || p_org::text || ':r:' || v_report::text;
    else
      v_payload := jsonb_build_object('periodId', p_payload ->> 'periodId');
      v_key := 'report.render:' || p_org::text || ':' || coalesce(p_payload ->> 'periodId', '');
    end if;

  elsif p_job_type = 'report.compose' then
    perform app.require_permission(p_org, 'reports.generate');
    v_kind := p_payload ->> 'kind';
    select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = p_org;

    if v_kind in ('daily_brief', 'weekly_intelligence') then
      begin
        v_start := (p_payload ->> 'windowStart')::date;
      exception when others then
        raise exception 'VALIDATION: windowStart is not a date' using errcode = '22023';
      end;
      if v_start is null then
        raise exception 'VALIDATION: windowStart is required' using errcode = '22023';
      end if;
      if v_kind = 'daily_brief' then
        v_end := v_start;
      else
        if extract(isodow from v_start) <> 1 then
          raise exception 'VALIDATION: a week starts on a Monday' using errcode = '22023';
        end if;
        v_end := v_start + 6;
      end if;
      -- A brief for a day still in progress would be stored as if the day were over.
      if v_end >= v_today then
        raise exception 'VALIDATION: that % has not finished yet', case v_kind when 'daily_brief' then 'day' else 'week' end
          using errcode = '22023';
      end if;
      v_payload := jsonb_build_object('kind', v_kind, 'windowStart', v_start::text,
                                      'windowEnd', v_end::text, 'origin', 'requested');
      v_key := 'report.compose:' || p_org::text || ':' || v_kind || ':' || v_start::text;
    elsif v_kind = 'adviser' then
      -- The window is the latest complete month with figures; the job derives it.
      v_payload := jsonb_build_object('kind', 'adviser', 'origin', 'requested');
      v_key := 'report.compose:' || p_org::text || ':adviser';
    elsif v_kind = 'funding_readiness' then
      -- REQ-RP-05: only while Funding Readiness is switched on (U-5); the job reads the month's current
      -- assessment, the latest unless one is named.
      if not app.funding_enabled(p_org) then
        raise exception 'NOT_FOUND' using errcode = 'P0002';
      end if;
      v_payload := jsonb_build_object('kind', 'funding_readiness', 'origin', 'requested', 'periodId', p_payload ->> 'periodId');
      v_key := 'report.compose:' || p_org::text || ':funding_readiness';
    else
      raise exception 'VALIDATION: % reports are not composed by a job', coalesce(v_kind, 'unnamed')
        using errcode = '22023';
    end if;

  else
    raise exception 'PERMISSION_DENIED: % is not a user-requestable job', p_job_type
      using errcode = '42501';
  end if;

  insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
  values (p_org, p_job_type, v_payload, app.uid(), v_key)
  on conflict (job_type, idempotency_key) where (status = 'queued' and idempotency_key is not null)
    do update set payload = public.jobs.payload || v_payload
  returning id into v_id;

  perform app.audit(p_org, 'job.enqueued', 'jobs', v_id, null,
                    jsonb_build_object('job_type', p_job_type), '{}'::jsonb);
  return v_id;
end $$;

