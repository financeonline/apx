-- MOTION — pgTAP · Budgets (ADR-142). Migrations 20261011000001/2. The import → commit → replace →
-- rollback journey and the variance are in test/integration/budgets.test.ts.
begin;
create extension if not exists pgtap;
select plan(8);

select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.budget_lines'::regclass),
          'budget_lines: row level security is enabled and forced');
select ok(not has_table_privilege('authenticated', 'public.budget_lines', 'insert'),
          'no authenticated role can insert a budget line');
select ok('budget' = any (enum_range(null::public.import_type_enum)::text[]), 'budget is an import type');
select ok('budget_lines' = any (enum_range(null::public.financial_record_table_enum)::text[]),
          'budget lines follow the financial-record contract');
select ok(position('''budget'' then ''budget_lines''' in pg_get_functiondef('api.start_import_batch(uuid, public.import_type_enum, jsonb)'::regprocedure)) > 0,
          'the wizard''s batch start sends a budget to budget_lines');
select ok(position('budget_lines' in pg_get_functiondef('app.commit_import_batch(uuid, uuid, uuid)'::regprocedure)) > 0,
          'commit writes budget lines and replaces a month''s budget at batch scope');
select ok(position('''budget_lines''' in pg_get_functiondef('api_server.purge_organization(uuid, uuid)'::regprocedure)) > 0,
          'the purge deletes budget lines');

insert into public.organizations (id, slug, name) values ('e2400000-0000-0000-0000-0000000000e2', 'pgt-budgets', 'PGT Budgets');
select app.ensure_periods('e2400000-0000-0000-0000-0000000000e2', '2026-09-01', '2026-09-30');
insert into public.accounts (id, organization_id, name, standard_category, account_type)
values ('a2400000-0000-0000-0000-000000000001', 'e2400000-0000-0000-0000-0000000000e2', 'Sales', 'revenue', 'income');
select throws_ok($$
  insert into public.budget_lines (organization_id, period_start, period_id, account_id, amount)
  values ('e2400000-0000-0000-0000-0000000000e2', '2026-09-15', '00000000-0000-0000-0000-000000000000',
          'a2400000-0000-0000-0000-000000000001', 1)$$,
  '23514', null, 'a budget line belongs to a month: its period starts on the first');

select * from finish();
rollback;
