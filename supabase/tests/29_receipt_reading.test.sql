-- MOTION — pgTAP · Reading receipts with AI (ADR-150), migration 20261017000001. The path through
-- the wizard, the job and the commit is in test/integration/receipt-reading.test.ts.
begin;
create extension if not exists pgtap;
select plan(5);

select ok((select 'image/jpeg' = any (allowed_mime_types) and 'image/png' = any (allowed_mime_types)
             from storage.buckets where id = 'source-documents'), 'receipt photos may be stored');
select ok(not (select 'image/gif' = any (allowed_mime_types) from storage.buckets where id = 'source-documents'), 'and nothing else new');
select ok(not has_function_privilege('authenticated', 'api_server.begin_receipt_extraction(uuid, uuid, uuid, uuid, integer, uuid)', 'execute'),
          'no signed-in user starts a reading directly');
select throws_ok($$ select api_server.begin_receipt_extraction(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid()) $$,
                 '42501', null, 'it refuses anyone but the server');
select ok(position('account_type = ''expense''' in pg_get_functiondef('api_server.begin_receipt_extraction(uuid, uuid, uuid, uuid, integer, uuid)'::regprocedure)) > 0,
          'the receipts post only to an expense account the reviewer chose');

select * from finish();
rollback;
