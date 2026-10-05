-- MOTION — pgTAP · Step 0F: report completeness, corrected-report replacement, the Debit / Credit sign.
-- Contract: migrations 20261007000001 (report_complete), 20261008000001 (IMP-TB-016),
--           20261008000002 (replacement at commit, N-3; sign guard, N-6). End-to-end cases through the
--           real upload path are in test/integration/step0f-reproductions.test.ts.
begin;
create extension if not exists pgtap;
select plan(8);

-- N-1: coverage returns the reviewer's attestation, and only `complete` counts.
insert into public.organizations (id, slug, name) values ('e9000000-0000-0000-0000-0000000000e9', 'pgt-step0f', 'PGT Step0F');
insert into public.source_documents (id, organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
values ('d9000000-0000-0000-0000-000000000001', 'e9000000-0000-0000-0000-0000000000e9', 'e9/tb.csv', 'tb.csv', 'text/csv', 1, decode('e901', 'hex'), 'ready', 'trial_balance');
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, status,
                                   period_start, period_end, extraction_method, committed_at, balance_basis, confirmations)
values
  ('b9000000-0000-0000-0000-000000000001', 'e9000000-0000-0000-0000-0000000000e9', 'd9000000-0000-0000-0000-000000000001', 'trial_balance', 'period_balances',
   'committed', '2026-07-01', '2026-07-31', 'csv', now(), 'movement',
   '{"IMP-TB-016": {"by": null, "at": "2026-08-01T00:00:00Z", "value": {"report_complete": "complete"}}}'),
  ('b9000000-0000-0000-0000-000000000002', 'e9000000-0000-0000-0000-0000000000e9', 'd9000000-0000-0000-0000-000000000001', 'trial_balance', 'period_balances',
   'committed', '2026-08-01', '2026-08-31', 'csv', now(), 'movement',
   '{"IMP-TB-016": {"by": null, "at": "2026-09-01T00:00:00Z", "value": {"report_complete": "partial"}}}'),
  ('b9000000-0000-0000-0000-000000000003', 'e9000000-0000-0000-0000-0000000000e9', 'd9000000-0000-0000-0000-000000000001', 'trial_balance', 'period_balances',
   'committed', '2026-09-01', '2026-09-30', 'csv', now(), 'movement', '{}');

-- (Answers are per month the batch STATES; these batches hold no rows, so the map is empty for all
-- three — the per-month cases run through real imports in test/integration/report-completeness-attestation.test.ts.)
select is((select completeness_by_month from app.batch_coverage('e9000000-0000-0000-0000-0000000000e9', '2026-07-01', '2026-07-31')
            where batch_id = 'b9000000-0000-0000-0000-000000000001'), '{}'::jsonb, 'no rows → no month answered, whatever the import said');
select is((select record_assurance::text from app.batch_coverage('e9000000-0000-0000-0000-0000000000e9', '2026-08-01', '2026-08-31')
            where batch_id = 'b9000000-0000-0000-0000-000000000002'), 'verified', 'a csv report''s own record assurance');
select ok(exists (select 1 from information_schema.columns where table_schema = 'public'
            and table_name = 'report_completeness_attestations' and column_name = 'supersedes_id'),
          'owner attestations are stored append-only with what they correct');

-- N-1: the attestation is an answer, one of two.
select ok(position('IMP-TB-016' in pg_get_functiondef('api.record_batch_confirmation(uuid, text, jsonb)'::regprocedure)) > 0,
          'record_batch_confirmation validates IMP-TB-016');

-- N-3: commit inserts balance rows outside single_current_balance, supersedes, then promotes; and asks first.
select ok(position('''pending''' in pg_get_functiondef('app.commit_import_batch(uuid, uuid, uuid)'::regprocedure)) > 0,
          'commit inserts balance rows pending');
select ok(position('IMP-COV-013' in pg_get_functiondef('app.commit_import_batch(uuid, uuid, uuid)'::regprocedure)) > 0,
          'commit asks IMP-COV-013 before replacing accepted balances');
select ok(position('needs_confirmation' in pg_get_functiondef('app.commit_import_batch(uuid, uuid, uuid)'::regprocedure)) > 0,
          'and returns rather than raises, so the new question survives');
-- N-6: the reporting flip is only for a one-column layout.
select ok(position('''debit_total'') is null' in pg_get_functiondef('app.commit_import_batch(uuid, uuid, uuid)'::regprocedure)) > 0,
          'commit never flips a row that carries debit or credit totals');

select * from finish();
rollback;
