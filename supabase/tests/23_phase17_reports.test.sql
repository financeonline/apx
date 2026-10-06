-- MOTION — pgTAP · Phase 17: stored reports, their PDFs, the user-requested compose and the schedule.
-- Contract: migrations 20261010000002 (kinds), 20261010000003 (reports). The end-to-end cases — the
-- figures, the timezone, RBAC through the API, the PDF in Storage — are in
-- test/integration/phase17-reports.test.ts.
begin;
create extension if not exists pgtap;
select plan(14);

insert into public.organizations (id, slug, name, timezone)
values ('e1700000-0000-0000-0000-0000000000e1', 'pgt-phase17', 'PGT Phase17', 'Europe/London');
select app.ensure_periods('e1700000-0000-0000-0000-0000000000e1', '2026-08-01', '2026-10-31');

select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.reports'::regclass),
          'reports: row level security is enabled and forced');

-- The window rules live in the table, so no caller can store a malformed one.
select throws_ok($$
  insert into public.reports (organization_id, report_kind, window_start, window_end, origin, content, content_version)
  values ('e1700000-0000-0000-0000-0000000000e1', 'daily_brief', '2026-09-07', '2026-09-08', 'scheduled', '{}', 'brief.v1')$$,
  '23514', null, 'a daily brief covers exactly one day');
select throws_ok($$
  insert into public.reports (organization_id, report_kind, window_start, window_end, origin, content, content_version)
  values ('e1700000-0000-0000-0000-0000000000e1', 'weekly_intelligence', '2026-09-08', '2026-09-14', 'scheduled', '{}', 'brief.v1')$$,
  '23514', null, 'a week starts on a Monday and is seven days');
select throws_ok($$
  insert into public.reports (organization_id, report_kind, window_start, window_end, origin, requested_by, content, content_version)
  values ('e1700000-0000-0000-0000-0000000000e1', 'daily_brief', '2026-09-07', '2026-09-07', 'scheduled',
          -- Any id: the CHECK is evaluated before the profile FK, so this needs no user.
          'a1700000-0000-0000-0000-000000000001', '{}', 'brief.v1')$$,
  '23514', null, 'a scheduled report has no actor');
select throws_ok($$
  insert into public.reports (organization_id, report_kind, window_start, window_end, origin, content, content_version)
  values ('e1700000-0000-0000-0000-0000000000e1', 'monthly_management', '2026-09-01', '2026-09-30', 'requested', '{}', 'x')$$,
  '23514', null, 'the monthly report is not a composed report');

insert into public.reports (id, organization_id, report_kind, window_start, window_end, origin, content, content_version)
values ('f1700000-0000-0000-0000-000000000001', 'e1700000-0000-0000-0000-0000000000e1', 'daily_brief',
        '2026-09-07', '2026-09-07', 'scheduled', '{"said":"then"}', 'brief.v1');
select throws_ok($$update public.reports set content = '{"said":"now"}' where id = 'f1700000-0000-0000-0000-000000000001'$$,
  null, 'IMMUTABLE: reports is append-only', 'what a report said is never edited');
select throws_ok($$delete from public.reports where id = 'f1700000-0000-0000-0000-000000000001'$$,
  null, 'IMMUTABLE: reports is append-only', 'nor deleted');

-- A PDF belongs to a month (monthly) or to a stored report (Phase 17), never neither.
select throws_ok($$
  insert into public.report_files (organization_id, report_kind, storage_path)
  values ('e1700000-0000-0000-0000-0000000000e1', 'daily_brief', 'e1/r/x.pdf')$$,
  '23514', null, 'a composed report''s PDF names its report');

-- The server-only writers refuse anybody but the server.
select throws_ok($$select api_server.record_report(null, 'e1700000-0000-0000-0000-0000000000e1', 'daily_brief',
                   '2026-09-07', '2026-09-07', null, null, 'scheduled', '{}', 'brief.v1')$$,
  '42501', null, 'record_report is callable only by the server');
select throws_ok($$select api_server.enqueue_scheduled_reports(now())$$,
  '42501', null, 'the schedule is callable only by the server');

-- The schedule: an organisation MOTION has calculated for gets yesterday's brief after its local
-- midnight, and last week's report on its local Monday — once.
insert into public.calculation_runs (organization_id, trigger, status, started_at, finished_at, engine_version,
                                     period_from, period_to, as_of)
select 'e1700000-0000-0000-0000-0000000000e1', 'recalc_manual', 'succeeded', now(), now(), '15.0.0',
       (select id from public.fiscal_periods where organization_id = 'e1700000-0000-0000-0000-0000000000e1' and period_start = '2026-09-01'),
       (select id from public.fiscal_periods where organization_id = 'e1700000-0000-0000-0000-0000000000e1' and period_start = '2026-09-01'),
       '2026-09-30';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
-- 23:30 UTC on Sunday 4 October 2026 is 00:30 on Monday 5 October in London.
select api_server.enqueue_scheduled_reports('2026-10-04T23:30:00Z');
select is((select string_agg((payload ->> 'kind') || ':' || (payload ->> 'windowStart'), ',' order by payload ->> 'kind')
             from public.jobs where organization_id = 'e1700000-0000-0000-0000-0000000000e1' and job_type = 'report.compose'),
          'daily_brief:2026-10-04,weekly_intelligence:2026-09-28',
          'Monday after local midnight: yesterday''s brief and last week''s report');
select api_server.enqueue_scheduled_reports('2026-10-05T05:00:00Z');
select is((select count(*)::int from public.jobs where organization_id = 'e1700000-0000-0000-0000-0000000000e1' and job_type = 'report.compose'),
          2, 'the same windows are never queued twice');
select is((select count(*)::int from public.jobs where organization_id = 'e1700000-0000-0000-0000-0000000000e1'
             and job_type = 'report.compose' and requested_by is not null), 0, 'a scheduled job has no actor');
select set_config('request.jwt.claims', '', true);

select ok(position('''reports''' in pg_get_functiondef('api_server.purge_organization(uuid, uuid)'::regprocedure)) > 0,
          'the purge deletes stored reports with the organisation');

select * from finish();
rollback;
