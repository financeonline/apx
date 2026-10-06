-- MOTION — Phase 17 · Intelligent Reporting: stored reports, their PDFs, and the schedule.
-- Contract: PHASE_17_IMPLEMENTATION.md §8, §9; ADR-141 (owner decisions R17-1…R17-4).
--
-- 1. `public.reports` — what a report SAID, as composed. A daily brief lists the alerts open and the
--    actions overdue at the moment it was composed; recomposing it next week would say something
--    else, because alerts resolve and actions close. So a composed report is stored, append-only,
--    and that stored content is what the screen and the PDF show. Recomposing writes a NEW row; the
--    latest for a (kind, window) is the one listed, and the earlier ones stay as the record.
--      * `window_start`/`window_end` (inclusive, organisation-local dates) say what the report covers.
--      * `period_id` names the month for the adviser and custom reports (NULL for daily/weekly).
--      * `origin`: `scheduled` (the hourly sweep, no actor) or `requested` (a person asked).
--      * Readable with `reports.view` — except a Custom AI Report, which is its author's own, like
--        the analyst conversation it is built from (`ai_conversations` is per user).
--
-- 2. `api_server.record_report(...)` — server-asserted, scoped (ADR-090), audited `report.composed`.
--
-- 3. `report_files` — a PDF may now belong to a stored report (`report_id`) rather than a month;
--    `api_server.record_report_pdf` derives the path `{org}/r/{report}/{file}.pdf`. The select policy
--    hides the PDF of another person's Custom AI Report.
--
-- 4. `api.enqueue_job` — `report.compose` is user-requestable with `reports.generate`, for a
--    completed organisation-local day (daily), a completed Monday–Sunday week (weekly), or the
--    adviser report; `report.render` accepts a `reportId` as well as a `periodId`.
--
-- 5. `api_server.enqueue_scheduled_reports(p_now)` — HOURLY, like the scheduled recalculation: for
--    each active organisation with at least one succeeded calculation, the first tick after its
--    local midnight queues yesterday's brief, and on a local Monday last week's report. Once per
--    organisation, kind and window, whatever became of the job (R17-3: no email).
--
-- 6. The purge order gains `reports`.

-- ---------------------------------------------------------------------------------------------
-- 1. Stored reports
-- ---------------------------------------------------------------------------------------------
create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  report_kind      public.report_kind_enum not null
                   constraint reports_kind_composed check (report_kind <> 'monthly_management'),
  window_start     date not null,
  window_end       date not null,
  period_id        uuid,
  origin           text not null constraint reports_origin check (origin in ('scheduled', 'requested')),
  requested_by     uuid references public.profiles (id) on delete set null,
  job_id           uuid,
  content          jsonb not null constraint reports_content_object check (jsonb_typeof(content) = 'object'),
  content_version  text not null constraint reports_content_version check (length(content_version) between 1 and 40),
  created_at       timestamptz not null default now(),
  constraint reports_window check (window_end >= window_start),
  constraint reports_daily_window check (report_kind <> 'daily_brief' or window_end = window_start),
  constraint reports_weekly_window check (
    report_kind <> 'weekly_intelligence'
    or (extract(isodow from window_start) = 1 and window_end = window_start + 6)),
  constraint reports_period_required check (
    report_kind not in ('adviser', 'custom_ai') or period_id is not null),
  constraint reports_scheduled_has_no_actor check (origin <> 'scheduled' or requested_by is null),
  constraint reports_custom_is_requested check (
    report_kind <> 'custom_ai' or (origin = 'requested' and requested_by is not null)),
  constraint reports_org_id_unique unique (organization_id, id),
  constraint reports_period_fk
    foreign key (organization_id, period_id) references public.fiscal_periods (organization_id, id),
  constraint reports_job_fk
    foreign key (organization_id, job_id) references public.jobs (organization_id, id) on delete set null
);

create index reports_latest on public.reports (organization_id, report_kind, window_start desc, created_at desc, id desc);

alter table public.reports owner to motion_definer;
alter table public.reports enable row level security;
alter table public.reports force row level security;
revoke insert, update, delete, truncate on public.reports from authenticated, anon;
revoke select on public.reports from anon;
grant select on public.reports to authenticated;
grant all on public.reports to service_role;

create policy definer_all on public.reports for all to motion_definer using (true) with check (true);
create policy reports_select on public.reports for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and (report_kind <> 'custom_ai' or requested_by = (select app.uid())));

-- What a report said is a record: never edited, never deleted except with its organisation.
create trigger append_only_guard before update or delete on public.reports
  for each row execute function app.append_only_guard_cascadable();

-- `job_id … on delete set null` would be an UPDATE the guard refuses; jobs are deleted only by the
-- purge, which deletes `reports` first (§6), so the action never fires on a live row.

-- ---------------------------------------------------------------------------------------------
-- 2. Recording a composed report
-- ---------------------------------------------------------------------------------------------
create function api_server.record_report(
  p_actor           uuid,
  p_org             uuid,
  p_kind            public.report_kind_enum,
  p_window_start    date,
  p_window_end      date,
  p_period          uuid,
  p_job             uuid,
  p_origin          text,
  p_content         jsonb,
  p_content_version text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.require_scope(p_org);

  -- A person's report is theirs only while they may make one. The scheduled sweep has no actor.
  if p_actor is not null then
    if p_kind = 'custom_ai' then
      if not (app.has_permission_of(p_actor, p_org, 'reports.view')
              and app.has_permission_of(p_actor, p_org, 'ai.use')) then
        raise exception 'PERMISSION_DENIED: reports.view and ai.use' using errcode = '42501';
      end if;
    elsif not app.has_permission_of(p_actor, p_org, 'reports.generate') then
      raise exception 'PERMISSION_DENIED: reports.generate' using errcode = '42501';
    end if;
  elsif p_origin <> 'scheduled' then
    raise exception 'VALIDATION: a requested report names who requested it' using errcode = '22023';
  end if;

  if p_period is not null and not exists (
       select 1 from public.fiscal_periods f where f.organization_id = p_org and f.id = p_period) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.reports
         (organization_id, report_kind, window_start, window_end, period_id, origin, requested_by,
          job_id, content, content_version)
  values (p_org, p_kind, p_window_start, p_window_end, p_period, p_origin, p_actor,
          p_job, p_content, p_content_version)
  returning id into v_id;

  perform app.audit(p_org, 'report.composed', 'reports', v_id, null,
                    jsonb_build_object('report_kind', p_kind, 'window_start', p_window_start,
                                       'window_end', p_window_end, 'origin', p_origin,
                                       'content_version', p_content_version),
                    jsonb_build_object('job_id', p_job), p_actor);
  return v_id;
end $$;

alter function api_server.record_report(uuid, uuid, public.report_kind_enum, date, date, uuid, uuid, text, jsonb, text)
  owner to motion_definer;
revoke all on function api_server.record_report(uuid, uuid, public.report_kind_enum, date, date, uuid, uuid, text, jsonb, text)
  from public, authenticated, anon;
grant execute on function api_server.record_report(uuid, uuid, public.report_kind_enum, date, date, uuid, uuid, text, jsonb, text)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. PDFs of stored reports
-- ---------------------------------------------------------------------------------------------
alter table public.report_files alter column period_id drop not null;
alter table public.report_files add column report_id uuid;
alter table public.report_files
  add constraint report_files_report_fk
    foreign key (organization_id, report_id) references public.reports (organization_id, id),
  add constraint report_files_subject check (
    (report_kind = 'monthly_management' and period_id is not null and report_id is null)
    or (report_kind <> 'monthly_management' and report_id is not null));
create index report_files_by_report on public.report_files (organization_id, report_id, created_at desc)
  where report_id is not null;

drop policy report_files_select on public.report_files;
create policy report_files_select on public.report_files for select to authenticated
  using (organization_id in (select app.org_ids_with_permission('reports.view'))
         and deleted_at is null
         -- The PDF of a report is readable exactly where the report is (the reports policy applies
         -- inside this subquery).
         and (report_id is null
              or exists (select 1 from public.reports r
                          where r.organization_id = report_files.organization_id
                            and r.id = report_files.report_id)));

create function api_server.record_report_pdf(
  p_actor uuid, p_org uuid, p_report uuid, p_job uuid, p_file uuid, p_sha256 bytea, p_bytes bigint
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_kind public.report_kind_enum; v_period uuid;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.require_scope(p_org);

  select r.report_kind, r.period_id into v_kind, v_period
    from public.reports r where r.organization_id = p_org and r.id = p_report;
  if v_kind is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- As for monthly reports: the caller names the FILE, never the PATH (R2-A-09).
  v_id := coalesce(p_file, gen_random_uuid());
  insert into public.report_files
         (id, organization_id, period_id, report_id, report_kind, job_id, storage_bucket, storage_path,
          sha256, byte_size, generated_by)
  values (v_id, p_org, v_period, p_report, v_kind, p_job, 'reports',
          p_org::text || '/r/' || p_report::text || '/' || v_id::text || '.pdf',
          p_sha256, p_bytes, p_actor);

  perform app.audit(p_org, 'report.generated', 'report_files', v_id, null,
                    jsonb_build_object('report_id', p_report, 'report_kind', v_kind, 'byte_size', p_bytes),
                    jsonb_build_object('job_id', p_job), p_actor);
  return v_id;
end $$;

alter function api_server.record_report_pdf(uuid, uuid, uuid, uuid, uuid, bytea, bigint) owner to motion_definer;
revoke all on function api_server.record_report_pdf(uuid, uuid, uuid, uuid, uuid, bytea, bigint) from public, authenticated, anon;
grant execute on function api_server.record_report_pdf(uuid, uuid, uuid, uuid, uuid, bytea, bigint) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. User-requested jobs
-- ---------------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------------
-- 5. The schedule
-- ---------------------------------------------------------------------------------------------
create function api_server.enqueue_scheduled_reports(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid;
  v_today date;
  v_kind  text;
  v_start date;
  v_end   date;
  v_key   text;
  v_job   uuid;
  v_count integer := 0;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  for v_org, v_today in
    select o.id, (p_now at time zone o.timezone)::date
      from public.organizations o
      join pg_catalog.pg_timezone_names tz on tz.name = o.timezone
     where o.status = 'active'
       -- An organisation MOTION has never calculated for has nothing to brief on.
       and exists (select 1 from public.calculation_runs r
                    where r.organization_id = o.id and r.status = 'succeeded')
     order by o.id
  loop
    foreach v_kind in array array['daily_brief', 'weekly_intelligence'] loop
      if v_kind = 'daily_brief' then
        v_start := v_today - 1;
        v_end := v_start;
      else
        -- Only on a local Monday, for the week that ended last night.
        continue when extract(isodow from v_today) <> 1;
        v_start := v_today - 7;
        v_end := v_today - 1;
      end if;

      v_key := 'report.compose:' || v_org::text || ':' || v_kind || ':' || v_start::text;
      -- Once per organisation, kind and window: a job in any state, or a report already stored.
      continue when exists (select 1 from public.jobs j
                             where j.job_type = 'report.compose' and j.idempotency_key = v_key);
      continue when exists (select 1 from public.reports r
                             where r.organization_id = v_org and r.report_kind = v_kind::public.report_kind_enum
                               and r.window_start = v_start);

      insert into public.jobs (organization_id, job_type, payload, requested_by, idempotency_key)
      values (v_org, 'report.compose',
              jsonb_build_object('kind', v_kind, 'windowStart', v_start::text, 'windowEnd', v_end::text,
                                 'origin', 'scheduled'),
              null, v_key)
      on conflict do nothing
      returning id into v_job;

      if v_job is not null then
        perform app.audit(v_org, 'job.enqueued', 'jobs', v_job, null,
                          jsonb_build_object('job_type', 'report.compose', 'reason', 'scheduled',
                                             'report_kind', v_kind, 'window_start', v_start),
                          '{}'::jsonb, null);
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;

  return v_count;
end $$;

alter function api_server.enqueue_scheduled_reports(timestamptz) owner to motion_definer;
revoke all on function api_server.enqueue_scheduled_reports(timestamptz) from public, anon, authenticated;
grant execute on function api_server.enqueue_scheduled_reports(timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. The purge order gains `reports` (after `report_files`, which references it)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_server.purge_organization(p_org uuid, p_job uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status    public.org_status_enum;
  v_requested timestamptz;
  v_running   integer;
  v_table     text;
  v_n         integer;
  v_counts    jsonb := '{}'::jsonb;
  v_redacted  integer;
  v_left      integer;
  v_offender  text;
  -- Children before parents, from the FK graph (NO ACTION constraints make the order matter).
  v_order     text[] := array[
    -- Tables added after this list was last written (Phases 11, 12, 14 and Step 0F). The guard
    -- below refused every purge of an organisation holding a row in any of them.
    'scenario_values', 'scenario_runs', 'forecast_values', 'forecast_runs',
    'invoice_lines', 'opportunities', 'campaign_spend', 'campaigns', 'marketing_channels', 'products',
    'report_completeness_attestations',
    'evidence_items', 'ai_feedback', 'ai_tool_calls', 'ai_messages', 'ai_conversations',
    'alert_revisions', 'alerts', 'actions', 'report_files', 'reports', 'evidence_bundles',
    'health_current', 'health_scores', 'metric_current', 'metric_snapshots',
    'category_history', 'account_category_history', 'record_status_events',
    'bank_transactions', 'recurring_payment_groups', 'ledger_entries', 'invoices',
    'period_balances', 'import_rows', 'calculation_runs', 'import_batches', 'import_mappings',
    'source_documents', 'counterparties', 'bank_accounts', 'accounts', 'fiscal_periods',
    'ownership_transfers', 'invitations', 'organization_assignments', 'organization_memberships',
    'platform_org_settings'
  ];
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;

  -- ADR-090: this function only ever runs inside a job, and a job is always scoped. A call that
  -- arrives with no scope, or with another organization's, is refused before it writes anything.
  perform app.require_scope(p_org);

  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));

  select o.status, o.deletion_requested_at into v_status, v_requested
    from public.organizations o where o.id = p_org;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotent: a retry after the rows went (the handler died before the objects did) has nothing
  -- to re-verify and nothing to delete here.
  if v_status = 'deleted' then
    return jsonb_build_object('status', 'already_deleted');
  end if;

  -- The two facts the trigger relied on thirty days ago, re-verified now (§2). A purge running for
  -- an organisation in any other state — cancelled, requeued by hand, a trigger bug — is refused,
  -- and the refusal is a CONFLICT the worker records, not a silent no-op.
  if v_status <> 'pending_deletion' or v_requested is null then
    raise exception 'CONFLICT: % is not scheduled for deletion', p_org using errcode = '23514';
  end if;
  if v_requested > now() - interval '30 days' then
    raise exception 'CONFLICT: % was scheduled for deletion less than 30 days ago (%)', p_org, v_requested
      using errcode = '23514';
  end if;

  -- Zero running jobs of the organisation other than this one. Waiting is not failing: the caller
  -- defers and comes back.
  select count(*) into v_running
    from public.jobs j
   where j.organization_id = p_org and j.status = 'running' and j.id is distinct from p_job;
  if v_running > 0 then
    return jsonb_build_object('status', 'waiting', 'running_jobs', v_running);
  end if;

  -- The append-only guards and the audit redaction policy open for this transaction only.
  perform set_config('app.purge', 'on', true);

  foreach v_table in array v_order loop
    execute format('delete from public.%I where organization_id = $1', v_table) using p_org;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_counts := v_counts || jsonb_build_object(v_table, v_n);
    end if;
  end loop;

  -- Every other job of the organisation goes; this one stays so the worker can record its outcome.
  delete from public.jobs j where j.organization_id = p_org and j.id is distinct from p_job;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    v_counts := v_counts || jsonb_build_object('jobs', v_n);
  end if;

  -- The guard: no base table carrying organization_id may still hold a row for this organisation.
  -- This is what turns "a table was added and this list was not updated" into a loud failure.
  for v_table in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'organization_id'
       and t.table_type = 'BASE TABLE'
       and c.table_name not in ('organizations', 'audit_events', 'jobs')
       and c.table_name not like 'audit_events_%'
       and c.table_name not like 'metric_snapshots_p%'
  loop
    execute format('select count(*) from public.%I where organization_id = $1', v_table)
       into v_left using p_org;
    if v_left > 0 then
      v_offender := v_table;
      exit;
    end if;
  end loop;
  if v_offender is not null then
    raise exception 'CONFLICT: purge left % row(s) in %; the deletion order in api_server.purge_organization needs that table',
      v_left, v_offender using errcode = '23514';
  end if;

  -- The organisation row survives, marked. `profiles.last_active_org_id` would have been nulled by
  -- its FK had the row gone; it has not, so it is nulled here.
  update public.organizations
     set status = 'deleted', deleted_at = now()
   where id = p_org;
  update public.profiles set last_active_org_id = null where last_active_org_id = p_org;

  -- Redaction (ADR-038.9): the events survive as the record that things happened; what they
  -- carried of the customer's data does not. This runs AFTER the status update so that update's
  -- own audit diff is redacted with the rest.
  update public.audit_events
     set before = null, after = null, metadata = '{}'::jsonb, ip = null, user_agent = null
   where organization_id = p_org;
  get diagnostics v_redacted = row_count;

  perform set_config('app.purge', 'off', true);

  -- Written last, so it is the one event about this organisation that keeps a payload — `after`
  -- holds counts, and nothing that was in the rows.
  perform app.audit(p_org, 'org.purged', 'organizations', p_org, null,
                    jsonb_build_object('rows', v_counts, 'audit_events_redacted', v_redacted,
                                       'job_id', p_job),
                    '{}'::jsonb, null);

  return jsonb_build_object('status', 'purged', 'rows', v_counts,
                            'audit_events_redacted', v_redacted);
end $function$;
