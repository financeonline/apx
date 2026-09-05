-- MOTION — pgTAP · The Phase 4 triggers.
-- Contract: DATABASE_ARCHITECTURE.md §12 (triggers and constraints checklist);
--           ADR-007 (fiscal calendar), ADR-034 (history), ADR-038.4 (masking),
--           ADR-044.8 / F-A-13 / R2-A-12 (same_org_ref, the guard for polymorphic references),
--           ADR-046.1 / R2-C-09 (append-only for every principal, owner included),
--           ADR-046.2 / R2-C-10 (a running calculation notices the ground moving),
--           ADR-047.1 (superseded_at is current state; the reset must be permitted).
--
-- Everything asserted here has to hold when the application is wrong: a direct PostgREST call, a
-- job worker or a future refactor must all hit the same wall.

begin;
create extension if not exists pgtap;

select plan(77);

-- ---------------------------------------------------------------------------
-- Fixtures. Two organizations with different fiscal calendars, plus a second tenant for the
-- cross-org assertions. Written as postgres so states api.* forbids can be built.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('f5000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','trg-owner@test.motion','x',now(),now(),now());

insert into public.organizations (id, slug, name, fiscal_year_start_month) values
  ('f5a00000-0000-0000-0000-00000000000a','pgt-trg-jan','PGT-TRG January Org', 1),
  ('f5b00000-0000-0000-0000-00000000000b','pgt-trg-apr','PGT-TRG April Org',   4),
  ('f5c00000-0000-0000-0000-00000000000c','pgt-trg-other','PGT-TRG Other Org', 1);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('f5a00000-0000-0000-0000-00000000000a','f5000000-0000-0000-0000-000000000001','owner');

insert into public.accounts (id, organization_id, name, normalized_name, account_type, standard_category) values
  ('f5d00000-0000-0000-0000-00000000000a','f5a00000-0000-0000-0000-00000000000a','PGT-TRG Sales','pgt trg sales','income','revenue'),
  ('f5d00000-0000-0000-0000-00000000000b','f5b00000-0000-0000-0000-00000000000b','PGT-TRG Sales','pgt trg sales','income','revenue'),
  -- The foreign account every cross-tenant assertion below points at.
  ('f5d00000-0000-0000-0000-00000000000c','f5c00000-0000-0000-0000-00000000000c','PGT-TRG Foreign','pgt trg foreign','income','revenue');

insert into public.bank_accounts (id, organization_id, name, bank_name, account_type) values
  ('f5e00000-0000-0000-0000-00000000000a','f5a00000-0000-0000-0000-00000000000a','PGT-TRG Current','PGT Bank','current');

-- ===========================================================================
-- 1. period_assign — the fiscal period is created on demand and labelled correctly (ADR-007)
-- ===========================================================================
select is((select count(*)::int from public.fiscal_periods
            where organization_id = 'f5a00000-0000-0000-0000-00000000000a'),
          0, 'the January organization starts with no fiscal periods at all');

insert into public.ledger_entries
  (id, organization_id, entry_date, account_id, direction, amount)
values ('f5100000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        '2026-05-20','f5d00000-0000-0000-0000-00000000000a','debit', 100);

select is((select count(*)::int from public.fiscal_periods
            where organization_id = 'f5a00000-0000-0000-0000-00000000000a'),
          1, 'period_assign CREATED the missing fiscal period on insert');
select isnt((select period_id from public.ledger_entries where id = 'f5100000-0000-0000-0000-000000000001'),
            null, 'period_assign populated ledger_entries.period_id');

select row_eq(
  $$ select p.period_start, p.period_end, p.fiscal_year, p.fiscal_quarter, p.label
       from public.fiscal_periods p
       join public.ledger_entries e on e.period_id = p.id
      where e.id = 'f5100000-0000-0000-0000-000000000001' $$,
  row('2026-05-01'::date, '2026-05-31'::date, 2026::smallint, 2::smallint, 'May 2026'::text),
  'a January-start organization files May 2026 as FY2026 Q2, Mon YYYY label, month-bounded');

-- The second row of the same month reuses the period rather than creating a second one.
insert into public.ledger_entries
  (id, organization_id, entry_date, account_id, direction, amount)
values ('f5100000-0000-0000-0000-000000000002','f5a00000-0000-0000-0000-00000000000a',
        '2026-05-28','f5d00000-0000-0000-0000-00000000000a','credit', 40);
select is((select count(*)::int from public.fiscal_periods
            where organization_id = 'f5a00000-0000-0000-0000-00000000000a'),
          1, 'a second row in the same month reuses the existing period');
select is((select count(distinct period_id)::int from public.ledger_entries
            where organization_id = 'f5a00000-0000-0000-0000-00000000000a'),
          1, 'both May rows carry the same period_id');

-- January is Q1 and December is Q4 for a January-start organization.
insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount) values
  ('f5a00000-0000-0000-0000-00000000000a','2026-01-15','f5d00000-0000-0000-0000-00000000000a','debit', 1),
  ('f5a00000-0000-0000-0000-00000000000a','2026-12-31','f5d00000-0000-0000-0000-00000000000a','debit', 1);
select row_eq(
  $$ select fiscal_year, fiscal_quarter from public.fiscal_periods
      where organization_id = 'f5a00000-0000-0000-0000-00000000000a' and period_start = '2026-01-01' $$,
  row(2026::smallint, 1::smallint), 'January-start: Jan 2026 is FY2026 Q1');
select row_eq(
  $$ select fiscal_year, fiscal_quarter from public.fiscal_periods
      where organization_id = 'f5a00000-0000-0000-0000-00000000000a' and period_start = '2026-12-01' $$,
  row(2026::smallint, 4::smallint), 'January-start: Dec 2026 is FY2026 Q4');

-- The April wrap. April 2026 opens FY2026; March 2027 is the LAST month of it, not the first of 2027.
insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount) values
  ('f5b00000-0000-0000-0000-00000000000b','2026-04-05','f5d00000-0000-0000-0000-00000000000b','debit', 1),
  ('f5b00000-0000-0000-0000-00000000000b','2027-01-09','f5d00000-0000-0000-0000-00000000000b','debit', 1),
  ('f5b00000-0000-0000-0000-00000000000b','2027-03-31','f5d00000-0000-0000-0000-00000000000b','debit', 1),
  ('f5b00000-0000-0000-0000-00000000000b','2027-04-01','f5d00000-0000-0000-0000-00000000000b','debit', 1);

select row_eq(
  $$ select fiscal_year, fiscal_quarter, label from public.fiscal_periods
      where organization_id = 'f5b00000-0000-0000-0000-00000000000b' and period_start = '2026-04-01' $$,
  row(2026::smallint, 1::smallint, 'Apr 2026'::text), 'April-start: Apr 2026 is FY2026 Q1');
select row_eq(
  $$ select fiscal_year, fiscal_quarter, label from public.fiscal_periods
      where organization_id = 'f5b00000-0000-0000-0000-00000000000b' and period_start = '2027-01-01' $$,
  row(2026::smallint, 4::smallint, 'Jan 2027'::text), 'April-start: Jan 2027 is FY2026 Q4');
select row_eq(
  $$ select fiscal_year, fiscal_quarter, label from public.fiscal_periods
      where organization_id = 'f5b00000-0000-0000-0000-00000000000b' and period_start = '2027-03-01' $$,
  row(2026::smallint, 4::smallint, 'Mar 2027'::text),
  'April-start: Mar 2027 is FY2026 Q4 — the wrap, not FY2027');
select row_eq(
  $$ select fiscal_year, fiscal_quarter, label from public.fiscal_periods
      where organization_id = 'f5b00000-0000-0000-0000-00000000000b' and period_start = '2027-04-01' $$,
  row(2027::smallint, 1::smallint, 'Apr 2027'::text), 'April-start: Apr 2027 opens FY2027 Q1');

-- The same trigger is attached to all four record tables, each on its own date column.
insert into public.bank_transactions (id, organization_id, bank_account_id, transaction_date, amount)
values ('f5200000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        'f5e00000-0000-0000-0000-00000000000a','2026-07-04', -25);
select is((select p.period_start from public.fiscal_periods p
             join public.bank_transactions t on t.period_id = p.id
            where t.id = 'f5200000-0000-0000-0000-000000000001'),
          '2026-07-01'::date, 'period_assign derives bank_transactions.period_id from transaction_date');

insert into public.counterparties (id, organization_id, name, normalized_name)
values ('f5f00000-0000-0000-0000-00000000000a','f5a00000-0000-0000-0000-00000000000a','PGT-TRG CP','pgt trg cp');
insert into public.invoices
  (id, organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount)
values ('f5300000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a','sales',
        'f5f00000-0000-0000-0000-00000000000a','PGT-TRG-1','2026-08-09', 10);
select is((select p.period_start from public.fiscal_periods p
             join public.invoices i on i.period_id = p.id
            where i.id = 'f5300000-0000-0000-0000-000000000001'),
          '2026-08-01'::date, 'period_assign derives invoices.period_id from issue_date');

insert into public.period_balances
  (id, organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis)
values ('f5400000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        '2026-09-01','f5d00000-0000-0000-0000-00000000000a', 5, 'trial_balance','cumulative');
select is((select p.period_start from public.fiscal_periods p
             join public.period_balances b on b.period_id = p.id
            where b.id = 'f5400000-0000-0000-0000-000000000001'),
          '2026-09-01'::date, 'period_assign derives period_balances.period_id from period_start (ADR-027.1)');

-- A row with no date at all cannot be filed, and says so as a VALIDATION error.
select throws_ok(
  $$ insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount)
     values ('f5a00000-0000-0000-0000-00000000000a', null,'f5d00000-0000-0000-0000-00000000000a','debit', 1) $$,
  '22023', null, 'a ledger entry with no entry_date is refused as a VALIDATION error');

-- ===========================================================================
-- 2. same_org_ref — the guard for polymorphic references
-- ===========================================================================
insert into public.fiscal_periods (id, organization_id, period_start, period_end, fiscal_year, fiscal_quarter, label)
values ('f5c10000-0000-0000-0000-00000000000c','f5c00000-0000-0000-0000-00000000000c',
        '2026-05-01','2026-05-31', 2026, 2, 'May 2026');

insert into public.calculation_runs
  (id, organization_id, trigger, engine_version, period_from, period_to, as_of, status)
values ('f5500000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a','recalc_manual','1.0.0',
        (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
        (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
        '2026-05-31','succeeded'),
       ('f5500000-0000-0000-0000-000000000002','f5c00000-0000-0000-0000-00000000000c','recalc_manual','1.0.0',
        'f5c10000-0000-0000-0000-00000000000c','f5c10000-0000-0000-0000-00000000000c','2026-05-31','succeeded');

-- A ledger entry in the OTHER organization, the target of the cross-tenant attempts below.
insert into public.ledger_entries (id, organization_id, entry_date, account_id, direction, amount)
values ('f5100000-0000-0000-0000-0000000000ff','f5c00000-0000-0000-0000-00000000000c',
        '2026-05-20','f5d00000-0000-0000-0000-00000000000c','debit', 1);

insert into public.evidence_bundles (id, organization_id, kind, origin_table)
values ('f5600000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a','metric','metric_snapshots');

-- evidence_items.ref_id
select throws_ok(
  $$ insert into public.evidence_items (organization_id, bundle_id, item_type, ref_id, label, assurance_level)
     values ('f5a00000-0000-0000-0000-00000000000a','f5600000-0000-0000-0000-000000000001',
             'account','f5d00000-0000-0000-0000-00000000000c','foreign account','verified') $$,
  '22023', null, 'same_org_ref refuses evidence_items.ref_id pointing at another organization');
select lives_ok(
  $$ insert into public.evidence_items (organization_id, bundle_id, item_type, ref_id, label, assurance_level)
     values ('f5a00000-0000-0000-0000-00000000000a','f5600000-0000-0000-0000-000000000001',
             'account','f5d00000-0000-0000-0000-00000000000a','own account','verified') $$,
  'same_org_ref permits evidence_items.ref_id pointing at the same organization');
select throws_ok(
  $$ insert into public.evidence_items (organization_id, bundle_id, item_type, ref_id, label, assurance_level)
     values ('f5a00000-0000-0000-0000-00000000000a','f5600000-0000-0000-0000-000000000001',
             'account','00000000-0000-0000-0000-0000000000ff','no such account','verified') $$,
  '22023', null, 'same_org_ref refuses evidence_items.ref_id pointing at a row that does not exist');

-- alerts.subject_id
select throws_ok(
  $$ insert into public.alerts
       (organization_id, rule_key, rule_version, severity, period_id, subject_type, subject_id,
        title, explanation, dedupe_key, key_kind, calculation_run_id)
     values ('f5a00000-0000-0000-0000-00000000000a','pgt.trg','1','high',
             (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
             'account','f5d00000-0000-0000-0000-00000000000c','t','e','pgt-trg-x','state',
             'f5500000-0000-0000-0000-000000000001') $$,
  '22023', null, 'same_org_ref refuses alerts.subject_id pointing at another organization');
select lives_ok(
  $$ insert into public.alerts
       (organization_id, rule_key, rule_version, severity, period_id, subject_type, subject_id,
        title, explanation, dedupe_key, key_kind, calculation_run_id)
     values ('f5a00000-0000-0000-0000-00000000000a','pgt.trg','1','high',
             (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
             'account','f5d00000-0000-0000-0000-00000000000a','t','e','pgt-trg-ok','state',
             'f5500000-0000-0000-0000-000000000001') $$,
  'same_org_ref permits alerts.subject_id pointing at the same organization');

-- record_status_events.record_id
select throws_ok(
  $$ insert into public.record_status_events (organization_id, record_table, record_id, event)
     values ('f5a00000-0000-0000-0000-00000000000a','ledger_entries',
             'f5100000-0000-0000-0000-0000000000ff','superseded') $$,
  '22023', null, 'same_org_ref refuses record_status_events.record_id pointing at another organization');
select lives_ok(
  $$ insert into public.record_status_events (organization_id, record_table, record_id, event)
     values ('f5a00000-0000-0000-0000-00000000000a','ledger_entries',
             'f5100000-0000-0000-0000-000000000001','accepted') $$,
  'same_org_ref permits record_status_events.record_id pointing at the same organization');

-- import_rows.duplicate_of_id
insert into public.source_documents
  (id, organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status)
values ('f5700000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        'f5a/doc1/pgt-trg.csv','pgt-trg.csv','text/csv', 10, '\x01'::bytea, 'ready');
insert into public.import_batches
  (id, organization_id, source_document_id, import_type, target_table, period_start, period_end)
values ('f5800000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        'f5700000-0000-0000-0000-000000000001','general_ledger','ledger_entries','2026-05-01','2026-05-31');

select throws_ok(
  $$ insert into public.import_rows
       (organization_id, batch_id, row_number, duplicate_of_table, duplicate_of_id)
     values ('f5a00000-0000-0000-0000-00000000000a','f5800000-0000-0000-0000-000000000001', 1,
             'ledger_entries','f5100000-0000-0000-0000-0000000000ff') $$,
  '22023', null, 'same_org_ref refuses import_rows.duplicate_of_id pointing at another organization');
select lives_ok(
  $$ insert into public.import_rows
       (organization_id, batch_id, row_number, duplicate_of_table, duplicate_of_id)
     values ('f5a00000-0000-0000-0000-00000000000a','f5800000-0000-0000-0000-000000000001', 2,
             'ledger_entries','f5100000-0000-0000-0000-000000000001') $$,
  'same_org_ref permits import_rows.duplicate_of_id pointing at the same organization');

-- A discriminator that names no table at all is skipped rather than rejected (`none`, category).
select lives_ok(
  $$ insert into public.alerts
       (organization_id, rule_key, rule_version, severity, period_id, subject_type, subject_id,
        title, explanation, dedupe_key, key_kind, calculation_run_id)
     values ('f5a00000-0000-0000-0000-00000000000a','pgt.trg','1','low',
             (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
             'standard_category','f5d00000-0000-0000-0000-00000000000c','t','e','pgt-trg-cat','state',
             'f5500000-0000-0000-0000-000000000001') $$,
  'same_org_ref skips a discriminator that names no table (standard_category)');

-- ===========================================================================
-- 3. mask_description (ADR-038.4)
-- ===========================================================================
insert into public.bank_transactions (id, organization_id, bank_account_id, transaction_date, amount, description_raw)
values
  ('f5200000-0000-0000-0000-00000000000a','f5a00000-0000-0000-0000-00000000000a','f5e00000-0000-0000-0000-00000000000a','2026-06-01', -1, 'SO 12-34-56 RENT'),
  ('f5200000-0000-0000-0000-00000000000b','f5a00000-0000-0000-0000-00000000000a','f5e00000-0000-0000-0000-00000000000a','2026-06-02', -1, 'TRANSFER TO 12345678 THANKS'),
  ('f5200000-0000-0000-0000-00000000000c','f5a00000-0000-0000-0000-00000000000a','f5e00000-0000-0000-0000-00000000000a','2026-06-03', -1, 'CARD PAYMENT REF INV-2026-001'),
  ('f5200000-0000-0000-0000-00000000000d','f5a00000-0000-0000-0000-00000000000a','f5e00000-0000-0000-0000-00000000000a','2026-06-04', -1, 'DD BRITISH GAS 1,234.56 GBP');

select is((select description_normalized from public.bank_transactions where id='f5200000-0000-0000-0000-00000000000a'),
          'SO ****3456 RENT', 'mask_description masks a sort code to ****last4');
select is((select description_normalized from public.bank_transactions where id='f5200000-0000-0000-0000-00000000000b'),
          'TRANSFER TO ****5678 THANKS', 'mask_description masks an account number to ****last4');
select is((select description_normalized from public.bank_transactions where id='f5200000-0000-0000-0000-00000000000c'),
          'CARD PAYMENT REF INV-2026-001', 'mask_description leaves a reference alone');
select is((select description_normalized from public.bank_transactions where id='f5200000-0000-0000-0000-00000000000d'),
          'DD BRITISH GAS 1,234.56 GBP', 'mask_description leaves an amount alone');

-- The raw column is kept verbatim: the masking is a derivation, not a destruction (ADR-038.4).
select is((select description_raw from public.bank_transactions where id='f5200000-0000-0000-0000-00000000000a'),
          'SO 12-34-56 RENT', 'description_raw is stored verbatim');

-- Re-masking on UPDATE, so an edit cannot smuggle an unmasked description into the derived column.
update public.bank_transactions set description_raw = 'NEW SO 98-76-54 X'
 where id = 'f5200000-0000-0000-0000-00000000000a';
select is((select description_normalized from public.bank_transactions where id='f5200000-0000-0000-0000-00000000000a'),
          'NEW SO ****7654 X', 'mask_description re-derives on UPDATE of description_raw');

-- ===========================================================================
-- 4. superseded_at_set (ADR-047.1) — the reset to NULL is the rollback path
-- ===========================================================================
select is((select superseded_at from public.ledger_entries where id='f5100000-0000-0000-0000-000000000001'),
          null, 'a fresh ledger entry has no superseded_at');

update public.ledger_entries set superseded_by = 'f5100000-0000-0000-0000-000000000002'
 where id = 'f5100000-0000-0000-0000-000000000001';
select isnt((select superseded_at from public.ledger_entries where id='f5100000-0000-0000-0000-000000000001'),
            null, 'superseded_at_set stamps superseded_at when superseded_by is set');

update public.ledger_entries set superseded_by = null
 where id = 'f5100000-0000-0000-0000-000000000001';
select is((select superseded_at from public.ledger_entries where id='f5100000-0000-0000-0000-000000000001'),
          null, 'superseded_at_set CLEARS superseded_at on the reset to NULL (ADR-047.1 rollback)');
select is((select superseded_by from public.ledger_entries where id='f5100000-0000-0000-0000-000000000001'),
          null, 'the reset of superseded_by itself is permitted');

-- The same trigger is attached to all four record tables.
update public.invoices set superseded_by = 'f5300000-0000-0000-0000-000000000001'
 where id = 'f5300000-0000-0000-0000-000000000001' and false;   -- no-op guard against self-supersede
insert into public.invoices
  (id, organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount)
values ('f5300000-0000-0000-0000-000000000002','f5a00000-0000-0000-0000-00000000000a','sales',
        'f5f00000-0000-0000-0000-00000000000a','PGT-TRG-2','2026-08-09', 10);
update public.invoices set superseded_by = 'f5300000-0000-0000-0000-000000000002'
 where id = 'f5300000-0000-0000-0000-000000000001';
select isnt((select superseded_at from public.invoices where id='f5300000-0000-0000-0000-000000000001'),
            null, 'superseded_at_set is attached to invoices too');

update public.bank_transactions set superseded_by = 'f5200000-0000-0000-0000-00000000000b'
 where id = 'f5200000-0000-0000-0000-000000000001';
select isnt((select superseded_at from public.bank_transactions where id='f5200000-0000-0000-0000-000000000001'),
            null, 'superseded_at_set is attached to bank_transactions too');

update public.period_balances set superseded_by = 'f5400000-0000-0000-0000-000000000001'
 where id = 'f5400000-0000-0000-0000-000000000001' and false;
insert into public.period_balances
  (id, organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis)
values ('f5400000-0000-0000-0000-000000000002','f5a00000-0000-0000-0000-00000000000a',
        '2026-09-01','f5d00000-0000-0000-0000-00000000000a', 6, 'trial_balance','cumulative');
update public.period_balances set superseded_by = 'f5400000-0000-0000-0000-000000000002'
 where id = 'f5400000-0000-0000-0000-000000000001';
select isnt((select superseded_at from public.period_balances where id='f5400000-0000-0000-0000-000000000001'),
            null, 'superseded_at_set is attached to period_balances too');

-- ===========================================================================
-- 5. append_only_guard — for EVERY principal, the owner and the service role included (ADR-046.1)
-- ===========================================================================
-- One row in each of the six append-only tables, so the UPDATE and DELETE below actually match
-- something: a statement that matches no row fires no row-level trigger and would pass vacuously.
insert into public.metric_snapshots
  (id, organization_id, calculation_run_id, period_id, metric_key, unit, basis, assurance_level, value)
values ('f5900000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        'f5500000-0000-0000-0000-000000000001',
        (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
        'pgt.trg.metric','money','ledger','verified', 1);

insert into public.health_scores
  (id, organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version)
values ('f5a10000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        'f5500000-0000-0000-0000-000000000001',
        (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
        70, 5, 5, 'v1');

insert into public.alert_revisions
  (id, organization_id, alert_id, revision_no, rule_version, severity, explanation, calculation_run_id)
values ('f5b10000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        (select id from public.alerts where dedupe_key = 'pgt-trg-ok'), 1, '1','high','e',
        'f5500000-0000-0000-0000-000000000001');

-- evidence_bundles / evidence_items / record_status_events already carry rows from section 2.

-- Each table really does hold a fixture row; without this the guard assertions prove nothing.
select cmp_ok(
  (select count(*)::int from public.evidence_bundles where organization_id='f5a00000-0000-0000-0000-00000000000a')
  + (select count(*)::int from public.evidence_items where organization_id='f5a00000-0000-0000-0000-00000000000a')
  + (select count(*)::int from public.alert_revisions where organization_id='f5a00000-0000-0000-0000-00000000000a')
  + (select count(*)::int from public.record_status_events where organization_id='f5a00000-0000-0000-0000-00000000000a')
  + (select count(*)::int from public.metric_snapshots where organization_id='f5a00000-0000-0000-0000-00000000000a')
  + (select count(*)::int from public.health_scores where organization_id='f5a00000-0000-0000-0000-00000000000a'),
  '>=', 6, 'every append-only table holds at least one fixture row for the guard to protect');

-- As the table owner. motion_definer is NOBYPASSRLS and holds the definer_all policy, so it can see
-- and would otherwise be able to change every row: the guard is the only thing stopping it.
set local role motion_definer;
select throws_ok(
  format('update public.%I set organization_id = organization_id', t.relname),
  '23514', null, 'motion_definer (the owner) cannot UPDATE public.' || t.relname)
  from (values ('alert_revisions'), ('evidence_bundles'), ('evidence_items'),
               ('health_scores'), ('metric_snapshots'), ('record_status_events')) as t(relname);
select throws_ok(
  format('delete from public.%I', t.relname),
  '23514', null, 'motion_definer (the owner) cannot DELETE from public.' || t.relname)
  from (values ('alert_revisions'), ('evidence_bundles'), ('evidence_items'),
               ('health_scores'), ('metric_snapshots'), ('record_status_events')) as t(relname);
reset role;

set local role service_role;
select throws_ok(
  format('update public.%I set organization_id = organization_id', t.relname),
  '23514', null, 'service_role cannot UPDATE public.' || t.relname)
  from (values ('alert_revisions'), ('evidence_bundles'), ('evidence_items'),
               ('health_scores'), ('metric_snapshots'), ('record_status_events')) as t(relname);
select throws_ok(
  format('delete from public.%I', t.relname),
  '23514', null, 'service_role cannot DELETE from public.' || t.relname)
  from (values ('alert_revisions'), ('evidence_bundles'), ('evidence_items'),
               ('health_scores'), ('metric_snapshots'), ('record_status_events')) as t(relname);
reset role;

-- ===========================================================================
-- 6. history_close_only — the one column that may move (ADR-034)
-- ===========================================================================
insert into public.category_history
  (id, organization_id, bank_transaction_id, category_account_id, source)
values ('f5c10000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        'f5200000-0000-0000-0000-00000000000a','f5d00000-0000-0000-0000-00000000000a','rule'),
       ('f5c10000-0000-0000-0000-000000000002','f5a00000-0000-0000-0000-00000000000a',
        'f5200000-0000-0000-0000-00000000000b','f5d00000-0000-0000-0000-00000000000a','rule');

insert into public.account_category_history
  (id, organization_id, account_id, standard_category)
values ('f5d10000-0000-0000-0000-000000000001','f5a00000-0000-0000-0000-00000000000a',
        'f5d00000-0000-0000-0000-00000000000a','revenue'),
       ('f5d10000-0000-0000-0000-000000000002','f5a00000-0000-0000-0000-00000000000a',
        'f5d00000-0000-0000-0000-00000000000a','revenue');

select lives_ok(
  $$ update public.category_history set valid_to = now()
      where id = 'f5c10000-0000-0000-0000-000000000001' $$,
  'history_close_only permits setting category_history.valid_to once');
select throws_ok(
  $$ update public.category_history set valid_to = now() + interval '1 day'
      where id = 'f5c10000-0000-0000-0000-000000000001' $$,
  '23514', null, 'history_close_only refuses a SECOND change to category_history.valid_to');
select throws_ok(
  $$ update public.category_history set valid_to = now(), source = 'user'
      where id = 'f5c10000-0000-0000-0000-000000000002' $$,
  '23514', null, 'history_close_only refuses changing any other column of category_history');
select throws_ok(
  $$ delete from public.category_history where id = 'f5c10000-0000-0000-0000-000000000002' $$,
  '23514', null, 'history_close_only refuses DELETE on category_history');

select lives_ok(
  $$ update public.account_category_history set valid_to = now()
      where id = 'f5d10000-0000-0000-0000-000000000001' $$,
  'history_close_only permits setting account_category_history.valid_to once');
select throws_ok(
  $$ update public.account_category_history set valid_to = now() + interval '1 day'
      where id = 'f5d10000-0000-0000-0000-000000000001' $$,
  '23514', null, 'history_close_only refuses a SECOND change to account_category_history.valid_to');
select throws_ok(
  $$ update public.account_category_history set valid_to = now(), standard_category = 'payroll'
      where id = 'f5d10000-0000-0000-0000-000000000002' $$,
  '23514', null, 'history_close_only refuses changing any other column of account_category_history');
select throws_ok(
  $$ delete from public.account_category_history where id = 'f5d10000-0000-0000-0000-000000000002' $$,
  '23514', null, 'history_close_only refuses DELETE on account_category_history');

-- ===========================================================================
-- 7. flag_runs_stale — a running calculation notices the ground moving (ADR-046.2; R2-C-10)
-- ===========================================================================
insert into public.calculation_runs
  (id, organization_id, trigger, engine_version, period_from, period_to, as_of, status, started_at)
values ('f5500000-0000-0000-0000-00000000000a','f5a00000-0000-0000-0000-00000000000a','recalc_manual','1.0.0',
        (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
        (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
        '2026-05-31','running', now()),
       -- a running run in ANOTHER organization, which must be left alone
       ('f5500000-0000-0000-0000-00000000000b','f5c00000-0000-0000-0000-00000000000c','recalc_manual','1.0.0',
        'f5c10000-0000-0000-0000-00000000000c','f5c10000-0000-0000-0000-00000000000c','2026-05-31','running', now()),
       -- a SUCCEEDED run, which is history and must not be re-flagged
       ('f5500000-0000-0000-0000-00000000000c','f5a00000-0000-0000-0000-00000000000a','recalc_manual','1.0.0',
        (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
        (select id from public.fiscal_periods where organization_id='f5a00000-0000-0000-0000-00000000000a' and period_start='2026-05-01'),
        '2026-05-31','succeeded', now());

select is((select stale from public.calculation_runs where id='f5500000-0000-0000-0000-00000000000a'),
          false, 'a running calculation starts not stale');

insert into public.record_status_events (organization_id, record_table, record_id, event)
values ('f5a00000-0000-0000-0000-00000000000a','ledger_entries','f5100000-0000-0000-0000-000000000002','superseded');

select is((select stale from public.calculation_runs where id='f5500000-0000-0000-0000-00000000000a'),
          true, 'flag_runs_stale marks the running run stale when a record_status_event lands');
select is((select stale from public.calculation_runs where id='f5500000-0000-0000-0000-00000000000c'),
          false, 'a SUCCEEDED run is not re-flagged');
select is((select stale from public.calculation_runs where id='f5500000-0000-0000-0000-00000000000b'),
          false, 'a running run in ANOTHER organization is not flagged');

-- The counterparty merge does the same, for the same reason.
update public.calculation_runs set stale = false where id = 'f5500000-0000-0000-0000-00000000000a';
insert into public.counterparties (id, organization_id, name, normalized_name)
values ('f5f00000-0000-0000-0000-00000000000b','f5a00000-0000-0000-0000-00000000000a','PGT-TRG CP2','pgt trg cp2');
update public.counterparties set merged_into_id = 'f5f00000-0000-0000-0000-00000000000a'
 where id = 'f5f00000-0000-0000-0000-00000000000b';
select is((select stale from public.calculation_runs where id='f5500000-0000-0000-0000-00000000000a'),
          true, 'counterparty_merged marks the running run stale too');

select * from finish();
rollback;
