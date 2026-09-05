-- MOTION — pgTAP · RLS and column privileges over the Phase 4 financial tables.
-- Contract: DATABASE_ARCHITECTURE.md §11; RBAC_MATRIX.md §2.1;
--           ADR-038.4 (raw bank text is not readable through the table),
--           ADR-044.2 / R2-A-04 (column privileges, and the two definer views),
--           ADR-044.4 (one suspension semantic — the frozen Home),
--           R2-A-07 (every role test is an allow-list, never a negation).
--
-- The suspended_member section is the one that matters most. `suspended_member` holds exactly one
-- permission, and the ONLY tenant tables it may read are the five that render the frozen Home. A
-- policy written as `<> 'client'` rather than as an allow-list would let it through every one of
-- them, and nothing else in the system would notice.

begin;
create extension if not exists pgtap;

select plan(122);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('f6000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rls-owner@test.motion','x',now(),now(),now()),
  ('f6000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rls-client@test.motion','x',now(),now(),now()),
  ('f6000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rls-outsider@test.motion','x',now(),now(),now()),
  ('f6000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rls-suspended@test.motion','x',now(),now(),now()),
  ('f6000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rls-employee@test.motion','x',now(),now(),now());

insert into public.organizations (id, slug, name) values
  ('f6a00000-0000-0000-0000-00000000000a','pgt-rls-a','PGT-RLS Org A'),
  ('f6b00000-0000-0000-0000-00000000000b','pgt-rls-b','PGT-RLS Org B'),
  ('f6500000-0000-0000-0000-000000000005','pgt-rls-susp','PGT-RLS Suspended Org');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('f6a00000-0000-0000-0000-00000000000a','f6000000-0000-0000-0000-000000000001','owner'),
  ('f6a00000-0000-0000-0000-00000000000a','f6000000-0000-0000-0000-000000000002','client'),
  ('f6b00000-0000-0000-0000-00000000000b','f6000000-0000-0000-0000-000000000003','owner'),
  -- An OWNER of a suspended organization: ADR-044.4 degrades the role, not the membership.
  ('f6500000-0000-0000-0000-000000000005','f6000000-0000-0000-0000-000000000004','owner');

insert into public.platform_users (user_id, platform_role) values
  ('f6000000-0000-0000-0000-000000000005','employee');
insert into public.organization_assignments (organization_id, employee_user_id, status, ends_at) values
  ('f6a00000-0000-0000-0000-00000000000a','f6000000-0000-0000-0000-000000000005','active', now() + interval '6 months');

-- Financial data in all three organizations, built by a helper so the three tenants are identical
-- and the only variable in the assertions below is who is reading.
create procedure pg_temp.seed_org(p_org uuid, p_tag text)
language plpgsql as $$
declare
  v_period uuid; v_acct uuid; v_cp uuid; v_bank uuid; v_run uuid; v_doc uuid;
  v_batch uuid; v_health uuid; v_snap uuid; v_ledger uuid; v_txn uuid; v_alert uuid;
begin
  insert into public.accounts (organization_id, name, normalized_name, account_type, standard_category)
  values (p_org, p_tag || ' Sales', p_tag || ' sales', 'income', 'revenue') returning id into v_acct;

  insert into public.counterparties (organization_id, name, normalized_name, email, notes)
  values (p_org, p_tag || ' CP', p_tag || ' cp', (p_tag || '@example.test')::extensions.citext,
          'private note') returning id into v_cp;

  insert into public.bank_accounts (organization_id, name, bank_name, account_type)
  values (p_org, p_tag || ' Current', 'PGT Bank', 'current') returning id into v_bank;

  insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount)
  values (p_org, '2026-03-10', v_acct, 'debit', 100) returning id, period_id into v_ledger, v_period;

  insert into public.period_balances
    (organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis, record_status)
  values (p_org, '2026-03-01', v_acct, 100, 'trial_balance', 'cumulative', 'accepted');

  insert into public.invoices
    (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount)
  values (p_org, 'sales', v_cp, p_tag || '-INV-1', '2026-03-12', 250);

  insert into public.bank_transactions
    (organization_id, bank_account_id, transaction_date, amount, description_raw)
  values (p_org, v_bank, '2026-03-14', -30, 'SO 12-34-56 ' || p_tag) returning id into v_txn;

  -- The two history tables and the lifecycle log. Seeded so the "reads ZERO rows" assertions below
  -- are refusals rather than empty tables: a zero over an empty table proves nothing.
  insert into public.account_category_history (organization_id, account_id, standard_category)
  values (p_org, v_acct, 'revenue');
  insert into public.category_history (organization_id, bank_transaction_id, category_account_id, source)
  values (p_org, v_txn, v_acct, 'rule');
  insert into public.record_status_events (organization_id, record_table, record_id, event)
  values (p_org, 'ledger_entries', v_ledger, 'accepted');
  insert into public.recurring_payment_groups
    (organization_id, bank_account_id, counterparty_key, direction, cadence, expected_amount,
     first_seen, last_seen, detector_version)
  values (p_org, v_bank, p_tag || '-key', 'outflow', 'monthly', 30, '2026-01-14', '2026-03-14', 'v1');

  insert into public.calculation_runs
    (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
  values (p_org, 'recalc_manual', '1.0.0', v_period, v_period, '2026-03-31', 'succeeded')
  returning id into v_run;

  insert into public.metric_snapshots
    (organization_id, calculation_run_id, period_id, metric_key, unit, basis, assurance_level, value)
  values (p_org, v_run, v_period, 'pgt.rls.metric', 'money', 'ledger', 'verified', 42)
  returning id into v_snap;

  insert into public.metric_current
    (organization_id, period_id, metric_key, snapshot_id, calculation_run_id)
  values (p_org, v_period, 'pgt.rls.metric', v_snap, v_run);

  insert into public.health_scores
    (organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version)
  values (p_org, v_run, v_period, 70, 5, 5, 'v1') returning id into v_health;

  insert into public.health_current (organization_id, period_id, health_score_id)
  values (p_org, v_period, v_health);

  insert into public.alerts
    (organization_id, rule_key, rule_version, severity, period_id, title, explanation,
     dedupe_key, key_kind, calculation_run_id)
  values (p_org, 'pgt.rls.rule', '1', 'high', v_period, 'title', 'explanation',
          p_tag || '-dedupe', 'state', v_run) returning id into v_alert;

  insert into public.alert_revisions
    (organization_id, alert_id, revision_no, rule_version, severity, explanation, calculation_run_id)
  values (p_org, v_alert, 1, '1', 'high', 'explanation', v_run);

  insert into public.actions (organization_id, title) values (p_org, p_tag || ' action');

  insert into public.source_documents
    (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status)
  values (p_org, p_org::text || '/doc/' || p_tag || '.csv', p_tag || '.csv', 'text/csv', 10,
          extensions.digest(p_tag, 'sha256'), 'ready')
  returning id into v_doc;

  insert into public.import_mappings (organization_id, name, import_type, header_signature)
  values (p_org, p_tag || ' mapping', 'general_ledger', p_tag || '-sig');

  insert into public.import_batches
    (organization_id, source_document_id, import_type, target_table, period_start, period_end)
  values (p_org, v_doc, 'general_ledger', 'ledger_entries', '2026-03-01', '2026-03-31')
  returning id into v_batch;

  insert into public.import_rows (organization_id, batch_id, row_number) values (p_org, v_batch, 1);

  insert into public.evidence_bundles (organization_id, kind, origin_table)
  values (p_org, 'metric', 'metric_snapshots');
end $$;

call pg_temp.seed_org('f6a00000-0000-0000-0000-00000000000a', 'PGTA');
call pg_temp.seed_org('f6b00000-0000-0000-0000-00000000000b', 'PGTB');
call pg_temp.seed_org('f6500000-0000-0000-0000-000000000005', 'PGTS');

-- Suspend the third organization AFTER seeding it: a suspended organization is frozen, not empty.
update public.organizations set status = 'suspended' where id = 'f6500000-0000-0000-0000-000000000005';

-- ---------------------------------------------------------------------------
-- Impersonation helpers (the house pattern from 03_rls_and_governance.test.sql).
-- ---------------------------------------------------------------------------
create procedure pg_temp.act_as(p_user uuid, p_aal text default 'aal1')
language plpgsql as $$
declare v_email text;
begin
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated',
                      'email', v_email,
                      'aal', p_aal,
                      'amr', json_build_array(json_build_object('method','password',
                                                                'timestamp', extract(epoch from now())::bigint)))::text,
    true);
end $$;

create procedure pg_temp.act_as_postgres()
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create function pg_temp.visible_rows(p_user uuid, p_sql text, p_aal text default 'aal1')
returns integer language plpgsql as $$
declare v integer;
begin
  call pg_temp.act_as(p_user, p_aal);
  execute p_sql into v;
  call pg_temp.act_as_postgres();
  return v;
end $$;

-- Counts rows of ONE named table restricted to ONE organization, so no assertion depends on rows
-- this test did not create.
create function pg_temp.rows_of(p_user uuid, p_table text, p_org uuid, p_aal text default 'aal1')
returns integer language plpgsql as $$
begin
  return pg_temp.visible_rows(p_user,
    format('select count(*) from public.%I where organization_id = %L', p_table, p_org), p_aal);
end $$;

-- Non-vacuity guard. Every table named in a "reads ZERO rows" assertion below must actually HOLD a
-- row for the organization in question, or the assertion is testing an empty table.
select is(
  (select count(*)::int from (
     select 'accounts' t, count(*) n from public.accounts where organization_id = o.org
     union all select 'counterparties', count(*) from public.counterparties where organization_id = o.org
     union all select 'ledger_entries', count(*) from public.ledger_entries where organization_id = o.org
     union all select 'period_balances', count(*) from public.period_balances where organization_id = o.org
     union all select 'invoices', count(*) from public.invoices where organization_id = o.org
     union all select 'bank_accounts', count(*) from public.bank_accounts where organization_id = o.org
     union all select 'bank_transactions', count(*) from public.bank_transactions where organization_id = o.org
     union all select 'recurring_payment_groups', count(*) from public.recurring_payment_groups where organization_id = o.org
     union all select 'category_history', count(*) from public.category_history where organization_id = o.org
     union all select 'account_category_history', count(*) from public.account_category_history where organization_id = o.org
     union all select 'fiscal_periods', count(*) from public.fiscal_periods where organization_id = o.org
     union all select 'calculation_runs', count(*) from public.calculation_runs where organization_id = o.org
     union all select 'metric_snapshots', count(*) from public.metric_snapshots where organization_id = o.org
     union all select 'metric_current', count(*) from public.metric_current where organization_id = o.org
     union all select 'health_scores', count(*) from public.health_scores where organization_id = o.org
     union all select 'health_current', count(*) from public.health_current where organization_id = o.org
     union all select 'alerts', count(*) from public.alerts where organization_id = o.org
     union all select 'alert_revisions', count(*) from public.alert_revisions where organization_id = o.org
     union all select 'record_status_events', count(*) from public.record_status_events where organization_id = o.org
     union all select 'actions', count(*) from public.actions where organization_id = o.org
     union all select 'evidence_bundles', count(*) from public.evidence_bundles where organization_id = o.org
     union all select 'source_documents', count(*) from public.source_documents where organization_id = o.org
     union all select 'import_mappings', count(*) from public.import_mappings where organization_id = o.org
     union all select 'import_batches', count(*) from public.import_batches where organization_id = o.org
     union all select 'import_rows', count(*) from public.import_rows where organization_id = o.org
   ) c where c.n <> 1),
  0, format('every table under test holds exactly one row for %s, so a zero below is a refusal', o.tag))
  from (values ('f6a00000-0000-0000-0000-00000000000a'::uuid, 'org A'),
               ('f6b00000-0000-0000-0000-00000000000b'::uuid, 'org B'),
               ('f6500000-0000-0000-0000-000000000005'::uuid, 'the suspended org')) as o(org, tag);

-- ===========================================================================
-- 1. A client reads the financial surface of their own organization...
-- ===========================================================================
select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000002', t.relname,
                          'f6a00000-0000-0000-0000-00000000000a'),
          1, format('a client CAN read public.%s of their own organization', t.relname))
  from (values ('ledger_entries'), ('invoices'), ('bank_transactions'),
               ('metric_current'), ('alerts')) as t(relname);

-- ...and the rest of the T-data surface, which is what `financials.view` buys.
select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000002', t.relname,
                          'f6a00000-0000-0000-0000-00000000000a'),
          1, format('a client CAN read public.%s of their own organization', t.relname))
  from (values ('accounts'), ('counterparties'), ('period_balances'), ('fiscal_periods'),
               ('calculation_runs'), ('metric_snapshots'), ('health_scores'), ('health_current'),
               ('actions'), ('bank_accounts'), ('recurring_payment_groups'),
               ('account_category_history'), ('category_history'), ('alert_revisions'),
               ('record_status_events')) as t(relname);

-- ===========================================================================
-- 2. ...and NOTHING of another organization.
-- ===========================================================================
select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000002', t.relname,
                          'f6b00000-0000-0000-0000-00000000000b'),
          0, format('a client reads ZERO rows of public.%s in another organization', t.relname))
  from (values ('ledger_entries'), ('invoices'), ('bank_transactions'), ('metric_current'),
               ('alerts'), ('accounts'), ('counterparties'), ('period_balances'),
               ('fiscal_periods'), ('calculation_runs'), ('metric_snapshots'),
               ('health_scores'), ('health_current'), ('actions'), ('evidence_bundles')) as t(relname);

-- The owner of A is equally blind to B: tenancy is not a role question.
select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000001', 'ledger_entries',
                          'f6b00000-0000-0000-0000-00000000000b'),
          0, 'an OWNER reads zero ledger_entries of another organization');

-- ===========================================================================
-- 3. The import surface needs imports.review, which a client does not hold.
-- ===========================================================================
select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000002', t.relname,
                          'f6a00000-0000-0000-0000-00000000000a'),
          0, format('a client CANNOT read public.%s (imports.review required)', t.relname))
  from (values ('source_documents'), ('import_batches'), ('import_rows'),
               ('import_mappings')) as t(relname);

select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000001', t.relname,
                          'f6a00000-0000-0000-0000-00000000000a'),
          1, format('an owner (who holds imports.review) CAN read public.%s', t.relname))
  from (values ('source_documents'), ('import_batches'), ('import_rows'),
               ('import_mappings')) as t(relname);

-- ===========================================================================
-- 4. suspended_member — the frozen Home, and nothing else (ADR-044.4)
-- ===========================================================================
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000004',
       'select count(*) from public.organizations where id = ''f6500000-0000-0000-0000-000000000005'''),
       1, 'a suspended_member still sees their organization row (frozen Home)');

select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000004', t.relname,
                          'f6500000-0000-0000-0000-000000000005'),
          1, format('a suspended_member CAN read the frozen-Home table public.%s', t.relname))
  from (values ('metric_current'), ('health_current'), ('health_scores'), ('alerts')) as t(relname);

-- Everything else is the allow-list, which omits suspended_member by construction (R2-A-07).
select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000004', t.relname,
                          'f6500000-0000-0000-0000-000000000005'),
          0, format('a suspended_member reads ZERO rows of public.%s', t.relname))
  from (values ('ledger_entries'), ('invoices'), ('bank_transactions'), ('accounts'),
               ('counterparties'), ('period_balances'), ('fiscal_periods'),
               ('account_category_history'), ('category_history'), ('bank_accounts'),
               ('recurring_payment_groups'), ('calculation_runs'), ('metric_snapshots'),
               ('alert_revisions'), ('record_status_events'), ('actions'),
               ('source_documents'), ('import_mappings'), ('import_batches'), ('import_rows'),
               ('evidence_bundles')) as t(relname);

-- ===========================================================================
-- 5. Column privileges (ADR-044.2; R2-A-04)
-- ===========================================================================
-- Catalogue level first, so a failure names the privilege rather than a query.
select ok(not has_column_privilege('authenticated', 'public.bank_transactions', 'description_raw', 'SELECT'),
          'authenticated holds NO select on bank_transactions.description_raw');
select ok(not has_column_privilege('authenticated', 'public.bank_transactions', 'counterparty_name_raw', 'SELECT'),
          'authenticated holds NO select on bank_transactions.counterparty_name_raw');
select ok(not has_column_privilege('authenticated', 'public.counterparties', 'email', 'SELECT'),
          'authenticated holds NO select on counterparties.email');
select ok(not has_column_privilege('authenticated', 'public.counterparties', 'notes', 'SELECT'),
          'authenticated holds NO select on counterparties.notes');
select ok(has_column_privilege('authenticated', 'public.bank_transactions', 'description_normalized', 'SELECT'),
          'authenticated DOES hold select on the masked description_normalized');

-- ...and at the query level, as the OWNER, which is the point: no row policy can protect a column.
call pg_temp.act_as('f6000000-0000-0000-0000-000000000001');
select throws_ok(
  'select description_raw from public.bank_transactions', '42501', null,
  'an OWNER cannot select bank_transactions.description_raw through the table (ADR-038.4)');
select throws_ok(
  'select counterparty_name_raw from public.bank_transactions', '42501', null,
  'an OWNER cannot select bank_transactions.counterparty_name_raw through the table');
select throws_ok(
  'select email from public.counterparties', '42501', null,
  'an OWNER cannot select counterparties.email through the table');
select throws_ok(
  'select notes from public.counterparties', '42501', null,
  'an OWNER cannot select counterparties.notes through the table');
select lives_ok(
  'select description_normalized from public.bank_transactions',
  'the masked description IS selectable through the table');
call pg_temp.act_as_postgres();

call pg_temp.act_as('f6000000-0000-0000-0000-000000000002');
select throws_ok(
  'select description_raw from public.bank_transactions', '42501', null,
  'a client cannot select bank_transactions.description_raw through the table');
select throws_ok(
  'select email from public.counterparties', '42501', null,
  'a client cannot select counterparties.email through the table');
call pg_temp.act_as_postgres();

-- The definer views are the only way in, and each re-imposes a permission of its own.
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000001',
       'select count(*) from public.bank_transactions_raw where organization_id = ''f6a00000-0000-0000-0000-00000000000a'''),
       1, 'bank_transactions_raw returns rows to a user holding imports.review');
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000002',
       'select count(*) from public.bank_transactions_raw where organization_id = ''f6a00000-0000-0000-0000-00000000000a'''),
       0, 'bank_transactions_raw returns ZERO rows to a client (no imports.review)');
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000001',
       'select count(*) from public.bank_transactions_raw where organization_id = ''f6b00000-0000-0000-0000-00000000000b'''),
       0, 'bank_transactions_raw re-imposes the tenant boundary as well');
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000001',
       'select count(*) from public.bank_transactions_raw where description_raw is not null
          and organization_id = ''f6a00000-0000-0000-0000-00000000000a'''),
       1, 'bank_transactions_raw actually exposes the withheld column to an authorised reader');

select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000001',
       'select count(*) from public.counterparties_contact where organization_id = ''f6a00000-0000-0000-0000-00000000000a'''),
       1, 'counterparties_contact returns rows to a user holding customers.edit');
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000002',
       'select count(*) from public.counterparties_contact where organization_id = ''f6a00000-0000-0000-0000-00000000000a'''),
       0, 'counterparties_contact returns ZERO rows to a client (customers.view is not customers.edit)');
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000001',
       'select count(*) from public.counterparties_contact where email is not null
          and organization_id = ''f6a00000-0000-0000-0000-00000000000a'''),
       1, 'counterparties_contact actually exposes the withheld email column');
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000004',
       'select count(*) from public.bank_transactions_raw where organization_id = ''f6500000-0000-0000-0000-000000000005'''),
       0, 'a suspended_member gets nothing from bank_transactions_raw either');

-- ===========================================================================
-- 6. A platform employee: MFA is a database fact, and the assignment is the scope (ADR-044.1)
-- ===========================================================================
select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000005', t.relname,
                          'f6a00000-0000-0000-0000-00000000000a', 'aal1'),
          0, format('an employee at aal1 reads ZERO rows of public.%s', t.relname))
  from (values ('ledger_entries'), ('invoices'), ('bank_transactions'), ('accounts'),
               ('metric_current'), ('alerts'), ('source_documents'), ('import_batches')) as t(relname);

select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000005', t.relname,
                          'f6a00000-0000-0000-0000-00000000000a', 'aal2'),
          1, format('the same employee at aal2 reads public.%s of the organization they are assigned to', t.relname))
  from (values ('ledger_entries'), ('invoices'), ('bank_transactions'), ('accounts'),
               ('metric_current'), ('alerts'), ('source_documents'), ('import_batches'),
               ('import_rows'), ('import_mappings')) as t(relname);

select is(pg_temp.rows_of('f6000000-0000-0000-0000-000000000005', t.relname,
                          'f6b00000-0000-0000-0000-00000000000b', 'aal2'),
          0, format('an employee at aal2 reads ZERO rows of public.%s in an unassigned organization', t.relname))
  from (values ('ledger_entries'), ('invoices'), ('bank_transactions'), ('accounts'),
               ('metric_current'), ('alerts')) as t(relname);

-- An employee holds imports.review, so the raw view opens for them — within the assignment only.
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000005',
       'select count(*) from public.bank_transactions_raw where organization_id = ''f6a00000-0000-0000-0000-00000000000a''',
       'aal2'),
       1, 'an assigned employee at aal2 sees bank_transactions_raw for that organization');
select is(pg_temp.visible_rows('f6000000-0000-0000-0000-000000000005',
       'select count(*) from public.bank_transactions_raw where organization_id = ''f6a00000-0000-0000-0000-00000000000a''',
       'aal1'),
       0, 'the same employee at aal1 sees nothing in bank_transactions_raw');

-- ===========================================================================
-- 7. Writes remain closed on every Phase 4 table (ADR-026)
-- ===========================================================================
call pg_temp.act_as('f6000000-0000-0000-0000-000000000001');
select throws_ok(
  'update public.ledger_entries set amount = 0', '42501', null,
  'an owner cannot UPDATE ledger_entries directly');
select throws_ok(
  'insert into public.alerts (organization_id, rule_key, rule_version, severity, period_id,
                              title, explanation, dedupe_key, key_kind, calculation_run_id)
   values (''f6a00000-0000-0000-0000-00000000000a'',''x'',''1'',''low'',
           ''00000000-0000-0000-0000-000000000000'',''t'',''e'',''d'',''state'',
           ''00000000-0000-0000-0000-000000000000'')',
  '42501', null, 'an owner cannot INSERT an alert directly');
select throws_ok(
  'delete from public.bank_transactions', '42501', null,
  'an owner cannot DELETE a bank transaction directly');
call pg_temp.act_as_postgres();

select * from finish();
rollback;
