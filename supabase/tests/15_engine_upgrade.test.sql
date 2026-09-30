-- MOTION — pgTAP · the engine-upgrade recalculation (ADR-120 decision 1.4, ADR-123 L-10).
-- Contract: DATABASE_ARCHITECTURE.md (`enqueue_engine_upgrade`); FINANCIAL_ENGINE.md §6.
begin;
create extension if not exists pgtap;
select plan(12);

select has_function('api_server', 'enqueue_engine_upgrade', array['text'], 'api_server.enqueue_engine_upgrade exists');
select ok((select prosecdef from pg_proc where oid = 'api_server.enqueue_engine_upgrade(text)'::regprocedure),
          'it is security definer');
select ok(not has_function_privilege('authenticated', 'api_server.enqueue_engine_upgrade(text)', 'execute'),
          'authenticated cannot execute it');
select ok(not has_function_privilege('anon', 'api_server.enqueue_engine_upgrade(text)', 'execute'),
          'anon cannot execute it');
select ok(has_function_privilege('service_role', 'api_server.enqueue_engine_upgrade(text)', 'execute'),
          'service_role can execute it');

-- Three organisations: OLD (succeeded run on 1.0.0), NEW (succeeded run on 2.0.0), NEVER (no run).
insert into public.organizations (id, slug, name) values
  ('e1000000-0000-0000-0000-0000000000e1', 'upg-old', 'Upgrade Old'),
  ('e2000000-0000-0000-0000-0000000000e2', 'upg-new', 'Upgrade New'),
  ('e3000000-0000-0000-0000-0000000000e3', 'upg-never', 'Upgrade Never');
insert into public.fiscal_periods (id, organization_id, period_start, period_end, fiscal_year, fiscal_quarter, label) values
  ('f1000000-0000-0000-0000-0000000000f1', 'e1000000-0000-0000-0000-0000000000e1', '2026-06-01', '2026-06-30', 2026, 2, 'Jun 2026'),
  ('f2000000-0000-0000-0000-0000000000f2', 'e2000000-0000-0000-0000-0000000000e2', '2026-06-01', '2026-06-30', 2026, 2, 'Jun 2026');
insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status) values
  ('e1000000-0000-0000-0000-0000000000e1', 'recalc_manual', '1.0.0', 'f1000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f1', '2026-06-30', 'succeeded'),
  ('e2000000-0000-0000-0000-0000000000e2', 'recalc_manual', '2.0.0', 'f2000000-0000-0000-0000-0000000000f2', 'f2000000-0000-0000-0000-0000000000f2', '2026-06-30', 'succeeded');

select throws_ok($$ select api_server.enqueue_engine_upgrade('2.0.0') $$, '42501', null,
                 'a caller without the service-role claim is refused');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok($$ select api_server.enqueue_engine_upgrade('latest') $$, '22023', null,
                 'something that is not major.minor.patch is refused');

select ok(api_server.enqueue_engine_upgrade('2.0.0') >= 1, 'the sweep reports the organisations it queued');
select is((select count(*)::int from public.jobs where organization_id = 'e1000000-0000-0000-0000-0000000000e1'
             and job_type = 'calculation.run' and status = 'queued'), 1,
          'the organisation on an older engine is queued once');
select is((select count(*)::int from public.jobs where organization_id in
             ('e2000000-0000-0000-0000-0000000000e2', 'e3000000-0000-0000-0000-0000000000e3')
             and job_type = 'calculation.run'), 0,
          'an organisation already on the version, or never computed, is not queued');

select api_server.enqueue_engine_upgrade('2.0.0');
select is((select count(*)::int from public.jobs where organization_id = 'e1000000-0000-0000-0000-0000000000e1'
             and job_type = 'calculation.run' and status = 'queued'), 1,
          'a second sweep queues nothing twice');
select is((select count(*)::int from public.audit_events where organization_id = 'e1000000-0000-0000-0000-0000000000e1'
             and action = 'job.enqueued' and after ->> 'reason' = 'engine_upgrade'), 1,
          'and audits only the job it actually queued (L-5)');

select * from finish();
rollback;
