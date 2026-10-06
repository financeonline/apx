-- MOTION — pgTAP · Funding Readiness (Phase 16, ADR-145), migrations 20261013000001/2. The lifecycle
-- through real calculations is in test/integration/funding-readiness.test.ts. The Funding Readiness
-- Report (REQ-RP-05) follows the flag too: migrations 20261014000001/2.
begin;
create extension if not exists pgtap;
select plan(12);

insert into public.organizations (id, slug, name) values ('e2600000-0000-0000-0000-0000000000e2', 'pgt-funding', 'PGT Funding');

select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
            where oid in ('public.funding_assessments'::regclass, 'public.funding_current'::regclass)),
          'both funding tables force row level security');
select ok(position('funding_enabled' in (select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'funding_assessments_select')) > 0,
          'RLS hides every assessment while the flag is off (U-5)');
select ok(position('funding_enabled' in (select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'funding_current_select')) > 0,
          'and every pointer');
select ok(not has_table_privilege('authenticated', 'public.funding_assessments', 'insert'), 'nobody writes an assessment directly');

select is(app.funding_enabled('e2600000-0000-0000-0000-0000000000e2'), false, 'off by default (D-5)');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.headers', '{"x-motion-org":"e2600000-0000-0000-0000-0000000000e2"}', true);
select is(api_server.finish_funding('e2600000-0000-0000-0000-0000000000e2', '[{"period_id":"00000000-0000-0000-0000-000000000000"}]'::jsonb, 'calculation_run'),
          0, 'the writer writes nothing while the flag is off (ADR-121)');
select set_config('request.jwt.claims', '', true);

update public.organizations set features = features || '{"funding_readiness": true}' where id = 'e2600000-0000-0000-0000-0000000000e2';
select is((select payload ->> 'trigger' from public.jobs where organization_id = 'e2600000-0000-0000-0000-0000000000e2' and job_type = 'funding.assess'),
          'enablement_backfill', 'switching it on queues the backfill in the same transaction');
select ok(exists (select 1 from pg_trigger where tgname = 'append_only_guard' and tgrelid = 'public.funding_assessments'::regclass),
          'assessments are append-only');
select ok(position('''funding_assessments''' in pg_get_functiondef('api_server.purge_organization(uuid, uuid)'::regprocedure)) > 0,
          'the purge deletes the assessments');

select ok(position('funding_enabled' in (select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'reports_select')) > 0,
          'RLS hides a stored Funding Readiness Report while the flag is off');
select ok(position('''funding_readiness''' in (select pg_get_constraintdef(oid) from pg_constraint where conname = 'reports_period_required')) > 0,
          'a Funding Readiness Report names its month');
select ok(position('funding_enabled' in pg_get_functiondef('api.enqueue_job(uuid, public.job_type_enum, jsonb)'::regprocedure)) > 0,
          'asking for one is refused while the flag is off');

select * from finish();
rollback;
