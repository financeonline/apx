-- MOTION — pgTAP · the daily scheduled recalculation and a queue that cannot jam on it (FU-6, ADR-131).
-- Contract: DATABASE_ARCHITECTURE.md (`enqueue_scheduled_recalculation`); migration 20261005000002.
begin;
create extension if not exists pgtap;
select plan(28);

select has_function('api_server', 'enqueue_scheduled_recalculation', array['timestamp with time zone'], 'api_server.enqueue_scheduled_recalculation exists');
select ok(not has_function_privilege('authenticated', 'api_server.enqueue_scheduled_recalculation(timestamptz)', 'execute'),
          'authenticated cannot execute it');
select ok(has_function_privilege('service_role', 'api_server.enqueue_scheduled_recalculation(timestamptz)', 'execute'),
          'service_role can execute it');

-- DUE: last run yesterday (London). TODAY: already run today. SUSP: suspended. NEVER: never run.
-- WAIT: due, but a calculation is already queued. DXB: due by Dubai's date.
insert into public.organizations (id, slug, name, status, timezone) values
  ('e9000000-0000-0000-0000-000000000001', 'sch-due',   'Sched Due',   'active',    'Europe/London'),
  ('e9000000-0000-0000-0000-000000000002', 'sch-today', 'Sched Today', 'active',    'Europe/London'),
  ('e9000000-0000-0000-0000-000000000003', 'sch-susp',  'Sched Susp',  'suspended', 'Europe/London'),
  ('e9000000-0000-0000-0000-000000000004', 'sch-never', 'Sched Never', 'active',    'Europe/London'),
  ('e9000000-0000-0000-0000-000000000005', 'sch-wait',  'Sched Wait',  'active',    'Europe/London'),
  ('e9000000-0000-0000-0000-000000000006', 'sch-dxb',   'Sched Dubai', 'active',    'Asia/Dubai');
insert into public.fiscal_periods (id, organization_id, period_start, period_end, fiscal_year, fiscal_quarter, label)
select gen_random_uuid(), o.id, date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date,
       2026, 4, 'Now'
  from public.organizations o where o.slug like 'sch-%';
insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status, finished_at)
select o.id, 'recalc_manual', '6.0.0', p.id, p.id,
       case o.slug when 'sch-today' then (now() at time zone 'Europe/London')::date
                   when 'sch-dxb' then (now() at time zone 'Asia/Dubai')::date - 1
                   else (now() at time zone 'Europe/London')::date - 1 end,
       'succeeded', now()
  from public.organizations o join public.fiscal_periods p on p.organization_id = o.id
 where o.slug in ('sch-due', 'sch-today', 'sch-susp', 'sch-wait', 'sch-dxb');
insert into public.jobs (organization_id, job_type, idempotency_key, payload)
values ('e9000000-0000-0000-0000-000000000005', 'calculation.run', 'calculation.run:e9000000-0000-0000-0000-000000000005',
        '{"trigger":"import_commit"}');

select throws_ok($$ select api_server.enqueue_scheduled_recalculation() $$, '42501', null,
                 'a caller without the service-role claim is refused');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(api_server.enqueue_scheduled_recalculation(), 2, 'it queues the two due organisations');
select is((select string_agg(o.slug, ',' order by o.slug) from public.jobs j join public.organizations o on o.id = j.organization_id
            where j.payload ->> 'trigger' = 'scheduled'), 'sch-due,sch-dxb', '… and nobody else');
select is((select payload ->> 'as_of' from public.jobs where organization_id = 'e9000000-0000-0000-0000-000000000006'
            and payload ->> 'trigger' = 'scheduled'), ((now() at time zone 'Asia/Dubai')::date)::text,
          'the as-of is the organisation''s own local date');
select is(api_server.enqueue_scheduled_recalculation(), 0, 'a second call the same night queues nothing');
select is((select count(*)::int from public.audit_events where action = 'job.enqueued' and after ->> 'reason' = 'scheduled'), 2,
          'one audit row per queued job');

-- Coalescing: an import arriving while the scheduled run waits takes it over.
select app.enqueue_recalculation('e9000000-0000-0000-0000-000000000001', 'import_commit');
select is((select payload ->> 'trigger' from public.jobs where organization_id = 'e9000000-0000-0000-0000-000000000001' and status = 'queued'),
          'import_commit', 'a waiting scheduled run gives way to an import');
select is((select count(*)::int from public.jobs where organization_id = 'e9000000-0000-0000-0000-000000000001' and status = 'queued'), 1,
          'still one queued calculation');

-- A failed retry with a queued twin is coalesced, not a unique violation.
update public.jobs set status = 'running', attempts = 1, locked_at = now()
 where organization_id = 'e9000000-0000-0000-0000-000000000006' and payload ->> 'trigger' = 'scheduled';
select app.enqueue_recalculation('e9000000-0000-0000-0000-000000000006', 'banking_edit');
select lives_ok($$ select api_server.finish_job((select id from public.jobs where organization_id = 'e9000000-0000-0000-0000-000000000006'
                                                 and status = 'running'), 'failed', '{}', 'boom') $$,
                'finishing a failed run whose key has a queued twin does not raise');
select is((select status::text from public.jobs where organization_id = 'e9000000-0000-0000-0000-000000000006' and payload ->> 'trigger' = 'scheduled'),
          'cancelled', 'the failed scheduled run is coalesced into its twin');
select is((select payload ->> 'trigger' from public.jobs where organization_id = 'e9000000-0000-0000-0000-000000000006' and status = 'queued'),
          'banking_edit', 'the twin keeps the wider work');

-- A lost worker with a queued twin: claim_job's reclaim no longer raises.
update public.jobs set status = 'running', attempts = 1, locked_at = now() - interval '2 hours'
 where organization_id = 'e9000000-0000-0000-0000-000000000005';
select app.enqueue_recalculation('e9000000-0000-0000-0000-000000000005', 'banking_edit');
select lives_ok($$ select app.reclaim_stale_jobs() $$, 'reclaiming a stale run whose key has a queued twin does not raise');
select is((select count(*)::int from public.jobs where organization_id = 'e9000000-0000-0000-0000-000000000005' and status = 'queued'), 1,
          'one queued calculation remains for that organisation');

-- ADR-135: offsets and daylight saving, at fixed instants (p_now), one run per local date.
-- Each organisation last ran on 2026-10-04 (local). At 2026-10-05 10:00 UTC:
--   Los Angeles (UTC-7)    → 03:00 on the 5th: due.
--   Kolkata (UTC+5:30)     → 15:30 on the 5th: due.
--   Kiritimati (UTC+14)    → 00:00 on the 6th: due, with the 6th as its date.
--   Pago Pago (UTC-11)     → 23:00 on the 4th: NOT due — its 5th has not begun.
-- The first part's organisations are taken out, so the counts below are this part's alone.
update public.organizations set status = 'suspended' where slug like 'sch-%';
insert into public.organizations (id, slug, name, status, timezone) values
  ('ea000000-0000-0000-0000-000000000001', 'tz-la',   'TZ LA',   'active', 'America/Los_Angeles'),
  ('ea000000-0000-0000-0000-000000000002', 'tz-kol',  'TZ Kol',  'active', 'Asia/Kolkata'),
  ('ea000000-0000-0000-0000-000000000003', 'tz-kir',  'TZ Kir',  'active', 'Pacific/Kiritimati'),
  ('ea000000-0000-0000-0000-000000000004', 'tz-pago', 'TZ Pago', 'active', 'Pacific/Pago_Pago'),
  ('ea000000-0000-0000-0000-000000000005', 'tz-ldn',  'TZ Ldn',  'active', 'Europe/London');
insert into public.fiscal_periods (id, organization_id, period_start, period_end, fiscal_year, fiscal_quarter, label)
select gen_random_uuid(), o.id, '2026-10-01', '2026-10-31', 2026, 4, 'Oct 2026'
  from public.organizations o where o.slug like 'tz-%';
insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status, finished_at)
select o.id, 'recalc_manual', '7.0.0', p.id, p.id, '2026-10-04', 'succeeded', '2026-10-04 12:00+00'
  from public.organizations o join public.fiscal_periods p on p.organization_id = o.id where o.slug like 'tz-%';

select api_server.enqueue_scheduled_recalculation('2026-10-05 10:00+00');
select is((select string_agg(o.slug || '=' || (j.payload ->> 'as_of'), ',' order by o.slug)
             from public.jobs j join public.organizations o on o.id = j.organization_id
            where o.slug like 'tz-%' and j.payload ->> 'trigger' = 'scheduled'),
          'tz-kir=2026-10-06,tz-kol=2026-10-05,tz-la=2026-10-05,tz-ldn=2026-10-05',
          'each organisation is due by its own date; Pago Pago''s 5th has not begun');
select is(api_server.enqueue_scheduled_recalculation('2026-10-05 10:59+00'), 0,
          'a tick a minute before Pago Pago''s midnight queues nobody twice, and not Pago Pago');
select is(api_server.enqueue_scheduled_recalculation('2026-10-05 11:00+00'), 1,
          'Pago Pago (UTC-11, no DST) is queued at its local midnight, 11:00 UTC');
select is(api_server.enqueue_scheduled_recalculation('2026-10-05 12:00+00'), 0,
          'the next hourly tick queues nobody');

-- Daylight saving. London springs forward at 01:00 UTC on 2026-03-29.
delete from public.jobs where organization_id = 'ea000000-0000-0000-0000-000000000005';
update public.calculation_runs set as_of = '2026-03-28' where organization_id = 'ea000000-0000-0000-0000-000000000005';
select is(api_server.enqueue_scheduled_recalculation('2026-03-28 23:30+00'), 0,
          'London at 23:30 GMT on the 28th: still the 28th, not due');
select is(api_server.enqueue_scheduled_recalculation('2026-03-29 00:30+00'), 1,
          'London at 00:30 on the 29th (still GMT): due');
select is(api_server.enqueue_scheduled_recalculation('2026-03-29 23:30+00'), 0,
          'London 23:30 UTC on the 29th is 00:30 BST on the 30th, a new local date — but the 29th''s run is still waiting, so nothing more is queued');

-- Fall back: Los Angeles leaves PDT at 09:00 UTC on 2026-11-01; the 1st has 25 hours, still one run.
delete from public.jobs where organization_id = 'ea000000-0000-0000-0000-000000000001';
update public.calculation_runs set as_of = '2026-10-31' where organization_id = 'ea000000-0000-0000-0000-000000000001';
select is(api_server.enqueue_scheduled_recalculation('2026-11-01 07:30+00'), 1, 'LA 00:30 PDT on 1 November: due');
select is(api_server.enqueue_scheduled_recalculation('2026-11-01 08:30+00'), 0, 'LA 01:30 PDT: already queued for the 1st');
select is(api_server.enqueue_scheduled_recalculation('2026-11-01 09:30+00'), 0, 'LA 01:30 PST (the repeated hour): still the 1st, not again');

-- Suspended: never queued, whatever the date.
update public.organizations set status = 'suspended' where id = 'ea000000-0000-0000-0000-000000000002';
delete from public.jobs where organization_id = 'ea000000-0000-0000-0000-000000000002';
select ok(api_server.enqueue_scheduled_recalculation('2026-10-07 10:00+00') >= 0, 'the sweep runs on the 7th');
select is((select count(*)::int from public.jobs where organization_id = 'ea000000-0000-0000-0000-000000000002'), 0,
          'a suspended organisation is never queued');

select * from finish();
rollback;
