-- MOTION — pgTAP · an invoice list is FULL unless confirmed open items (FU-13, ADR-125).
-- Contract: IMPORT_ENGINE.md (IMP-INV-012, invoice_list_kind); migration 20260930000004.
begin;
create extension if not exists pgtap;
select plan(14);

select has_function('app', 'invoice_list_kind_at_commit', array[]::text[], 'the commit trigger function exists');
select has_function('app', 'backfill_invoice_list_kind', array[]::text[], 'the backfill function exists');
select has_trigger('public', 'import_batches', 'import_batches_invoice_list_kind', 'the trigger is on import_batches');
select ok(not has_function_privilege('authenticated', 'app.backfill_invoice_list_kind()', 'execute')
          and not has_function_privilege('anon', 'app.backfill_invoice_list_kind()', 'execute'),
          'no client can run the backfill');
select ok(not has_function_privilege('authenticated', 'app.invoice_list_kind_at_commit()', 'execute'),
          'no client can call the trigger function');

insert into public.organizations (id, slug, name) values ('e5000000-0000-0000-0000-0000000000e5', 'fu13-org', 'FU13 Org');
insert into public.source_documents (id, organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status)
values ('d5000000-0000-0000-0000-0000000000d5', 'e5000000-0000-0000-0000-0000000000e5', 'e5/doc.csv', 'doc.csv', 'text/csv', 10,
        extensions.digest('fu13', 'sha256'), 'ready');

-- A: an ordinary sales list, awaiting review, then committed.
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, status, period_start, period_end)
values ('b5000000-0000-0000-0000-0000000000a1', 'e5000000-0000-0000-0000-0000000000e5', 'd5000000-0000-0000-0000-0000000000d5',
        'sales_invoices', 'invoices', 'awaiting_review', '2026-05-01', '2026-05-31');
select is((select invoice_list_kind::text from public.import_batches where id = 'b5000000-0000-0000-0000-0000000000a1'), null,
          'before commit the kind is not decided');
update public.import_batches set status = 'committed', committed_at = now() where id = 'b5000000-0000-0000-0000-0000000000a1';
select is((select invoice_list_kind::text from public.import_batches where id = 'b5000000-0000-0000-0000-0000000000a1'), 'full',
          'an unflagged list commits as full');

-- B: a list whose reviewer confirmed IMP-INV-012 (the review page sends {answer: 'yes'}).
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, status, period_start, period_end, confirmations)
values ('b5000000-0000-0000-0000-0000000000b2', 'e5000000-0000-0000-0000-0000000000e5', 'd5000000-0000-0000-0000-0000000000d5',
        'sales_invoices', 'invoices', 'awaiting_review', '2026-06-01', '2026-06-30',
        '{"IMP-INV-012": {"value": {"answer": "yes"}}}'::jsonb);
update public.import_batches set status = 'committed', committed_at = now() where id = 'b5000000-0000-0000-0000-0000000000b2';
select is((select invoice_list_kind::text from public.import_batches where id = 'b5000000-0000-0000-0000-0000000000b2'), 'open_items',
          'a list confirmed as open items commits as open items');

-- C: an explicit kind is left as it is.
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, status, period_start, period_end, invoice_list_kind, confirmations)
values ('b5000000-0000-0000-0000-0000000000c3', 'e5000000-0000-0000-0000-0000000000e5', 'd5000000-0000-0000-0000-0000000000d5',
        'sales_invoices', 'invoices', 'committed', '2026-07-01', '2026-07-31', 'full', '{"IMP-INV-012": {}}'::jsonb);
select is((select invoice_list_kind::text from public.import_batches where id = 'b5000000-0000-0000-0000-0000000000c3'), 'full',
          'an explicit kind is never overwritten');

-- D: a batch of another kind is untouched.
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, status, period_start, period_end)
values ('b5000000-0000-0000-0000-0000000000d4', 'e5000000-0000-0000-0000-0000000000e5', 'd5000000-0000-0000-0000-0000000000d5',
        'general_ledger', 'ledger_entries', 'committed', '2026-05-01', '2026-05-31');
select is((select invoice_list_kind::text from public.import_batches where id = 'b5000000-0000-0000-0000-0000000000d4'), null,
          'a general ledger batch gets no list kind');

-- The backfill: batches committed before the trigger existed (planted with triggers off).
set local session_replication_role = replica;
insert into public.import_batches (id, organization_id, source_document_id, import_type, target_table, status, period_start, period_end, confirmations)
values ('b5000000-0000-0000-0000-0000000000e5', 'e5000000-0000-0000-0000-0000000000e5', 'd5000000-0000-0000-0000-0000000000d5',
        'sales_invoices', 'invoices', 'committed', '2026-03-01', '2026-03-31', '{}'::jsonb),
       ('b5000000-0000-0000-0000-0000000000f6', 'e5000000-0000-0000-0000-0000000000e5', 'd5000000-0000-0000-0000-0000000000d5',
        'sales_invoices', 'invoices', 'committed', '2026-04-01', '2026-04-30', '{"IMP-INV-012": {}}'::jsonb),
       ('b5000000-0000-0000-0000-0000000000a7', 'e5000000-0000-0000-0000-0000000000e5', 'd5000000-0000-0000-0000-0000000000d5',
        'sales_invoices', 'invoices', 'awaiting_review', '2026-02-01', '2026-02-28', '{}'::jsonb);
set local session_replication_role = origin;

select is(app.backfill_invoice_list_kind(), 2, 'the backfill touches exactly the committed invoice batches without a kind');
select is((select invoice_list_kind::text from public.import_batches where id = 'b5000000-0000-0000-0000-0000000000e5'), 'full',
          'an old unflagged list becomes full');
select is((select invoice_list_kind::text from public.import_batches where id = 'b5000000-0000-0000-0000-0000000000f6'), 'open_items',
          'an old confirmed open-items list becomes open items');
select is((select invoice_list_kind::text from public.import_batches where id = 'b5000000-0000-0000-0000-0000000000a7'), null,
          'a batch not yet committed is left for its own commit to decide');

select * from finish();
rollback;
