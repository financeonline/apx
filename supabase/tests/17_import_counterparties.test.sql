-- MOTION — pgTAP · an invoice list creates the customers and suppliers it names (IMPORT_ENGINE.md §6.6).
-- Contract: migration 20261004000001; RBAC_MATRIX.md (imports.review); ADR-045.3 (no figures in names).
begin;
create extension if not exists pgtap;
select plan(17);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('f7000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','cp-owner@test.motion','x',now(),now(),now()),
  ('f7000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','cp-client@test.motion','x',now(),now(),now()),
  ('f7000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','cp-outsider@test.motion','x',now(),now(),now());

insert into public.organizations (id, slug, name) values
  ('f7a00000-0000-0000-0000-00000000000a','pgt-cp-a','PGT-CP Org A'),
  ('f7b00000-0000-0000-0000-00000000000b','pgt-cp-b','PGT-CP Org B');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('f7a00000-0000-0000-0000-00000000000a','f7000000-0000-0000-0000-000000000001','owner'),
  ('f7a00000-0000-0000-0000-00000000000a','f7000000-0000-0000-0000-000000000002','client'),
  ('f7b00000-0000-0000-0000-00000000000b','f7000000-0000-0000-0000-000000000003','owner');

insert into public.source_documents (id, organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
values
  ('d7000000-0000-0000-0000-000000000001','f7a00000-0000-0000-0000-00000000000a','a/1.csv','1.csv','text/csv',1,decode('d701','hex'),'ready','invoice'),
  ('d7000000-0000-0000-0000-000000000002','f7a00000-0000-0000-0000-00000000000a','a/2.csv','2.csv','text/csv',1,decode('d702','hex'),'ready','invoice'),
  ('d7000000-0000-0000-0000-000000000003','f7a00000-0000-0000-0000-00000000000a','a/3.csv','3.csv','text/csv',1,decode('d703','hex'),'ready','general_ledger'),
  ('d7000000-0000-0000-0000-000000000004','f7a00000-0000-0000-0000-00000000000a','a/4.csv','4.csv','text/csv',1,decode('d704','hex'),'ready','invoice');

insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, status, period_start, period_end)
values
  ('b7000000-0000-0000-0000-000000000001','f7a00000-0000-0000-0000-00000000000a','d7000000-0000-0000-0000-000000000001','sales_invoices','invoices','validating','2026-08-01','2026-08-31'),
  ('b7000000-0000-0000-0000-000000000002','f7a00000-0000-0000-0000-00000000000a','d7000000-0000-0000-0000-000000000002','purchase_report','invoices','validating','2026-08-01','2026-08-31'),
  ('b7000000-0000-0000-0000-000000000003','f7a00000-0000-0000-0000-00000000000a','d7000000-0000-0000-0000-000000000003','general_ledger','ledger_entries','validating','2026-08-01','2026-08-31'),
  ('b7000000-0000-0000-0000-000000000004','f7a00000-0000-0000-0000-00000000000a','d7000000-0000-0000-0000-000000000004','sales_invoices','invoices','rolled_back','2026-08-01','2026-08-31');

create procedure pg_temp.act_as(p_user uuid)
language plpgsql as $$
declare v_email text;
begin
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'email', v_email, 'aal', 'aal1')::text, true);
end $$;
create procedure pg_temp.act_as_postgres()
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

select has_function('api', 'create_import_counterparties', array['uuid', 'jsonb'], 'api.create_import_counterparties exists');
select ok(not has_function_privilege('anon', 'api.create_import_counterparties(uuid, jsonb)', 'execute'),
          'anon cannot execute it');
select ok(has_function_privilege('authenticated', 'api.create_import_counterparties(uuid, jsonb)', 'execute'),
          'a signed-in user can; the function checks the permission itself');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');

-- A sales list: two names that normalise alike are ONE customer.
select is(api.create_import_counterparties('b7000000-0000-0000-0000-000000000001',
            '["Acme Ltd", "  ACME   LTD. ", "Beta Trading", ""]'::jsonb), 2,
          'a sales list creates each new name once, by normalised name');
call pg_temp.act_as_postgres();
select is((select string_agg(kind::text, ',' order by name) from public.counterparties
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a'), 'customer,customer',
          'the kind comes from the batch: a sales list names customers');
select is((select count(*)::int from public.audit_events
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a' and action = 'counterparty.created'), 2,
          'every creation is audited');

-- A purchase report: one existing customer is now a supplier too, one name is new.
call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select is(api.create_import_counterparties('b7000000-0000-0000-0000-000000000002',
            '["Acme Ltd", "Gamma Freight"]'::jsonb), 1,
          'a purchase list creates only the names that are new');
call pg_temp.act_as_postgres();
select is((select kind::text from public.counterparties
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a' and normalized_name = 'acme ltd'), 'both',
          'a customer met on a purchase list becomes both (§6.6)');
select is((select kind::text from public.counterparties
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a' and normalized_name = 'gamma freight'), 'supplier',
          'a new name on a purchase list is a supplier');
select is((select count(*)::int from public.audit_events
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a' and action = 'counterparty.kind_changed'), 1,
          'the kind change is audited');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select throws_ok($$ select api.create_import_counterparties('b7000000-0000-0000-0000-000000000003', '["Delta"]'::jsonb) $$,
                 '22023', null, 'a ledger batch cannot add counterparties');
select throws_ok($$ select api.create_import_counterparties('b7000000-0000-0000-0000-000000000001', '["Acme (owed £45,000)"]'::jsonb) $$,
                 '22023', null, 'a name carrying an amount is refused (ADR-045.3)');
select throws_ok($$ select api.create_import_counterparties('b7000000-0000-0000-0000-000000000001', '["Rebate 10% Ltd"]'::jsonb) $$,
                 '22023', null, 'a name carrying a percentage is refused');
select lives_ok($$ select api.create_import_counterparties('b7000000-0000-0000-0000-000000000001', '["Studio 54", "3M"]'::jsonb) $$,
                'digits alone are allowed in a name');
select throws_ok($$ select api.create_import_counterparties('b7000000-0000-0000-0000-000000000004', '["Epsilon"]'::jsonb) $$,
                 '40001', null, 'a batch no longer open for mapping cannot add counterparties');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000002');
select throws_ok($$ select api.create_import_counterparties('b7000000-0000-0000-0000-000000000001', '["Zeta"]'::jsonb) $$,
                 '42501', null, 'a client cannot create counterparties (imports.review)');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000003');
select throws_ok($$ select api.create_import_counterparties('b7000000-0000-0000-0000-000000000001', '["Zeta"]'::jsonb) $$,
                 'P0002', null, 'another organisation''s batch does not exist for an outsider');
call pg_temp.act_as_postgres();

select * from finish();
rollback;
