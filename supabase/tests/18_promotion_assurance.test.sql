-- MOTION — pgTAP · a promoted row keeps its own batch's assurance and columns (ADR-130).
-- Contract: migration 20261005000001; IMPORT_ENGINE.md §11 step 4, §12.1.
begin;
create extension if not exists pgtap;
select plan(12);

select has_function('app', 'batch_record_assurance', array['uuid', 'uuid'], 'the assurance helper exists');
select ok(not has_function_privilege('authenticated', 'app.batch_record_assurance(uuid, uuid)', 'execute'),
          'no client can call it');

insert into public.organizations (id, slug, name) values ('e8000000-0000-0000-0000-0000000000e8', 'pgt-promo', 'PGT Promo');
insert into public.bank_accounts (id, organization_id, name, bank_name, account_type)
values ('a8000000-0000-0000-0000-0000000000a8', 'e8000000-0000-0000-0000-0000000000e8', 'Current', 'Bank', 'current');
insert into public.source_documents (id, organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
values
  ('d8000000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-0000000000e8', 'e8/a.csv', 'a.csv', 'text/csv', 1, decode('e801', 'hex'), 'ready', 'bank_statement'),
  ('d8000000-0000-0000-0000-000000000002', 'e8000000-0000-0000-0000-0000000000e8', 'e8/b.pdf', 'b.pdf', 'application/pdf', 1, decode('e802', 'hex'), 'ready', 'bank_statement');

-- The helper is commit's CASE, method by method.
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, bank_account_id, status,
                                   period_start, period_end, extraction_method, batch_issues)
values
  ('b8000000-0000-0000-0000-0000000000c1', 'e8000000-0000-0000-0000-0000000000e8', 'd8000000-0000-0000-0000-000000000001', 'bank_statement', 'bank_transactions',
   'a8000000-0000-0000-0000-0000000000a8', 'rolled_back', '2026-08-01', '2026-08-31', 'csv', '[]'),
  ('b8000000-0000-0000-0000-0000000000c2', 'e8000000-0000-0000-0000-0000000000e8', 'd8000000-0000-0000-0000-000000000001', 'bank_statement', 'bank_transactions',
   'a8000000-0000-0000-0000-0000000000a8', 'rolled_back', '2026-08-01', '2026-08-31', 'pdf_text', '[]'),
  ('b8000000-0000-0000-0000-0000000000c3', 'e8000000-0000-0000-0000-0000000000e8', 'd8000000-0000-0000-0000-000000000001', 'bank_statement', 'bank_transactions',
   'a8000000-0000-0000-0000-0000000000a8', 'rolled_back', '2026-08-01', '2026-08-31', 'pdf_text', '[{"code":"IMP-BAL-007"}]'),
  ('b8000000-0000-0000-0000-0000000000c4', 'e8000000-0000-0000-0000-0000000000e8', 'd8000000-0000-0000-0000-000000000001', 'bank_statement', 'bank_transactions',
   'a8000000-0000-0000-0000-0000000000a8', 'rolled_back', '2026-08-01', '2026-08-31', 'pdf_claude', '[]');
select is(app.batch_record_assurance('e8000000-0000-0000-0000-0000000000e8', 'b8000000-0000-0000-0000-0000000000c1')::text, 'verified', 'csv → verified');
select is(app.batch_record_assurance('e8000000-0000-0000-0000-0000000000e8', 'b8000000-0000-0000-0000-0000000000c2')::text, 'verified', 'reconciled pdf_text → verified');
select is(app.batch_record_assurance('e8000000-0000-0000-0000-0000000000e8', 'b8000000-0000-0000-0000-0000000000c3')::text, 'calculated', 'unreconciled pdf_text → calculated');
select is(app.batch_record_assurance('e8000000-0000-0000-0000-0000000000e8', 'b8000000-0000-0000-0000-0000000000c4')::text, 'inferred', 'pdf_claude → inferred');
select ok(position('when ''pdf_claude'' then ''inferred''' in pg_get_functiondef('app.commit_import_batch(uuid, uuid, uuid)'::regprocedure)) > 0,
          'commit still stamps pdf_claude rows inferred, as the helper does');

-- A (csv) holds a line; B (AI-read PDF) skipped the same line as A's duplicate. Rolling A back
-- promotes B's row — which must come back inferred, with its running balance and posted date.
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, bank_account_id, status,
                                   period_start, period_end, extraction_method, batch_issues, committed_at)
values
  ('b8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000000e8', 'd8000000-0000-0000-0000-000000000001', 'bank_statement', 'bank_transactions',
   'a8000000-0000-0000-0000-0000000000a8', 'committed', '2026-08-01', '2026-08-31', 'csv', '[]', now()),
  ('b8000000-0000-0000-0000-0000000000b1', 'e8000000-0000-0000-0000-0000000000e8', 'd8000000-0000-0000-0000-000000000002', 'bank_statement', 'bank_transactions',
   'a8000000-0000-0000-0000-0000000000a8', 'committed', '2026-08-01', '2026-08-31', 'pdf_claude', '[]', now());
insert into public.import_rows (id, organization_id, batch_id, row_number, source_ref, mapped_data, status, reviewer_decision)
values ('f8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000000e8', 'b8000000-0000-0000-0000-0000000000a1', 2, 'csv:row:2',
        '{"transaction_date":"2026-08-04","amount":"-42.50","description":"TRAIN"}', 'committed', 'none');
insert into public.bank_transactions (id, organization_id, bank_account_id, transaction_date, amount, description_raw,
                                      source_document_id, import_batch_id, import_row_id, record_status, assurance_level)
values ('c8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000000e8', 'a8000000-0000-0000-0000-0000000000a8', '2026-08-04', -42.50, 'TRAIN',
        'd8000000-0000-0000-0000-000000000001', 'b8000000-0000-0000-0000-0000000000a1', 'f8000000-0000-0000-0000-0000000000a1', 'accepted', 'verified');
update public.import_rows set committed_record_id = 'c8000000-0000-0000-0000-0000000000a1', committed_table = 'bank_transactions'
 where id = 'f8000000-0000-0000-0000-0000000000a1';
insert into public.import_rows (id, organization_id, batch_id, row_number, source_ref, mapped_data, status, reviewer_decision,
                                duplicate_of_table, duplicate_of_id, reviewer_reason)
values ('f8000000-0000-0000-0000-0000000000b1', 'e8000000-0000-0000-0000-0000000000e8', 'b8000000-0000-0000-0000-0000000000b1', 2, 'page:1;line:4',
        '{"transaction_date":"2026-08-04","posted_date":"2026-08-05","amount":"-42.50","description":"TRAIN","balance_after":"957.50"}',
        'skipped', 'skip', 'bank_transactions', 'c8000000-0000-0000-0000-0000000000a1', 'duplicate of the csv line');

select lives_ok($$ select app.rollback_import_batch('e8000000-0000-0000-0000-0000000000e8', 'b8000000-0000-0000-0000-0000000000a1', 'pgtap', null) $$,
                'the csv batch rolls back');
select is((select assurance_level::text from public.bank_transactions where import_row_id = 'f8000000-0000-0000-0000-0000000000b1'), 'inferred',
          'the promoted AI-read row stays inferred — not verified');
select is((select balance_after::text || '|' || posted_date::text from public.bank_transactions where import_row_id = 'f8000000-0000-0000-0000-0000000000b1'),
          '957.50|2026-08-05', 'and keeps its running balance and posted date');
select is((select promoted_from_batch_id::text from public.bank_transactions where import_row_id = 'f8000000-0000-0000-0000-0000000000b1'),
          'b8000000-0000-0000-0000-0000000000a1', 'it records the batch whose rollback promoted it');
select is((select record_status::text from public.bank_transactions where id = 'c8000000-0000-0000-0000-0000000000a1'), 'rejected',
          'the rolled-back line is rejected');

select * from finish();
rollback;
