-- APX — pgTAP · company roles, per-person permissions and permission-based reads (ADR-172).
-- Contract: src/modules/tenancy/domain/member-access.ts; RBAC_MATRIX.md §2.1, §7, §8;
--           migrations 20261018000017 – 20261018000019.
--
-- What this file proves, at the database (the TypeScript checks are a convenience; these are the
-- control):
--   1. the ceiling ranks the new roles below admin, so owners and admins govern them;
--   2. a 3rd party reads the overview (organisation, months, the Business Health Score, the CURRENT
--      undimensioned figures, the run) and ZERO rows of every detail table — each of which holds a
--      row, so every zero is a refusal;
--   3. an accountant reads the detail and the documents, not the audit log or others' AI;
--   4. a switch opens and closes a table for ONE person (documents.view for a client; financials.view
--      for a 3rd party; financials.view taken from a client), and is ignored for an owner, for a
--      suspended organisation and for APX staff;
--   5. the switches table refuses a non-switchable permission and a non-member;
--   6. api.set_member_permission's refusals: not users.manage, self, owner, beyond one's own rights;
--   7. a role change carries the owner's switches and clears the rest (20261018000032); and
--   8. the SHAPE: no policy grants by the old five-role list any more, and the switch-aware set
--      helpers stay one evaluation per statement (ADR-065).

begin;
create extension if not exists pgtap;

select plan(118);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select ('e3000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'ma-' || n || '@test.motion', 'x', now(), now(), now()
  from generate_series(1, 12) n;

-- Funding Readiness is on for A and B, so its reports are readable at all (app.funding_enabled).
insert into public.organizations (id, slug, name, features) values
  ('e3a00000-0000-0000-0000-00000000000a', 'pgt-ma-a', 'PGT-MA Org A', '{"funding_readiness": true}'),
  ('e3b00000-0000-0000-0000-00000000000b', 'pgt-ma-b', 'PGT-MA Org B', '{"funding_readiness": true}'),
  ('e3500000-0000-0000-0000-000000000005', 'pgt-ma-s', 'PGT-MA Suspended Org', '{}');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000001', 'owner'),
  ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000002', 'admin'),
  ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000003', 'accountant'),
  ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000004', 'client'),
  ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000005', 'third_party'),
  ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000006', 'admin'),
  ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000010', 'owner'),
  ('e3b00000-0000-0000-0000-00000000000b', 'e3000000-0000-0000-0000-000000000007', 'owner'),
  ('e3b00000-0000-0000-0000-00000000000b', 'e3000000-0000-0000-0000-000000000008', 'third_party'),
  ('e3500000-0000-0000-0000-000000000005', 'e3000000-0000-0000-0000-000000000011', 'owner'),
  ('e3500000-0000-0000-0000-000000000005', 'e3000000-0000-0000-0000-000000000012', 'client');

-- An assigned Financial Analyst (platform `employee`) of organisation A.
insert into public.platform_users (user_id, platform_role) values
  ('e3000000-0000-0000-0000-000000000009', 'employee');
insert into public.organization_assignments (organization_id, employee_user_id, status, ends_at) values
  ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000009', 'active', now() + interval '6 months');

-- One row in every table under test, per organisation (the house seed of 06_financial_rls, plus the
-- commercial records, a per-customer figure and a stored report of each kind a 3rd party may and may
-- not read).
create procedure pg_temp.seed_org(p_org uuid, p_tag text)
language plpgsql as $$
declare
  v_period uuid; v_acct uuid; v_cp uuid; v_bank uuid; v_run uuid; v_doc uuid; v_inv uuid;
  v_batch uuid; v_health uuid; v_snap uuid; v_cp_snap uuid; v_ledger uuid; v_txn uuid; v_alert uuid;
  v_product uuid;
begin
  insert into public.accounts (organization_id, name, normalized_name, account_type, standard_category)
  values (p_org, p_tag || ' Sales', p_tag || ' sales', 'income', 'revenue') returning id into v_acct;
  insert into public.counterparties (organization_id, name, normalized_name)
  values (p_org, p_tag || ' Customer', p_tag || ' customer') returning id into v_cp;
  insert into public.bank_accounts (organization_id, name, bank_name, account_type)
  values (p_org, p_tag || ' Current', 'PGT Bank', 'current') returning id into v_bank;
  insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount)
  values (p_org, '2026-03-10', v_acct, 'debit', 100) returning id, period_id into v_ledger, v_period;
  insert into public.period_balances
    (organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis, record_status)
  values (p_org, '2026-03-01', v_acct, 100, 'trial_balance', 'cumulative', 'accepted');
  insert into public.invoices
    (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount)
  values (p_org, 'sales', v_cp, p_tag || '-INV-1', '2026-03-12', 250) returning id into v_inv;
  insert into public.products (organization_id, name, normalized_name)
  values (p_org, p_tag || ' Widget', p_tag || ' widget') returning id into v_product;
  insert into public.invoice_lines (organization_id, invoice_id, product_id, amount)
  values (p_org, v_inv, v_product, 250);
  insert into public.bank_transactions
    (organization_id, bank_account_id, transaction_date, amount, description_raw)
  values (p_org, v_bank, '2026-03-14', -30, 'SO ' || p_tag) returning id into v_txn;
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
  -- A headline figure (undimensioned) and a per-customer one, both current.
  insert into public.metric_snapshots
    (organization_id, calculation_run_id, period_id, metric_key, unit, basis, assurance_level, value)
  values (p_org, v_run, v_period, 'pgt.ma.metric', 'money', 'ledger', 'verified', 42)
  returning id into v_snap;
  insert into public.metric_current (organization_id, period_id, metric_key, snapshot_id, calculation_run_id)
  values (p_org, v_period, 'pgt.ma.metric', v_snap, v_run);
  insert into public.metric_snapshots
    (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id,
     unit, basis, assurance_level, value)
  values (p_org, v_run, v_period, 'customer_revenue', 'counterparty', v_cp, 'money', 'ledger', 'verified', 250)
  returning id into v_cp_snap;
  insert into public.metric_current
    (organization_id, period_id, metric_key, dimension_type, dimension_id, snapshot_id, calculation_run_id)
  values (p_org, v_period, 'customer_revenue', 'counterparty', v_cp, v_cp_snap, v_run);
  insert into public.health_scores
    (organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version)
  values (p_org, v_run, v_period, 70, 5, 5, 'v1') returning id into v_health;
  insert into public.health_current (organization_id, period_id, health_score_id)
  values (p_org, v_period, v_health);
  insert into public.alerts
    (organization_id, rule_key, rule_version, severity, period_id, title, explanation,
     dedupe_key, key_kind, calculation_run_id)
  values (p_org, 'pgt.ma.rule', '1', 'high', v_period, 'title', p_tag || ' Customer is overdue',
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
  -- An internal report (the daily brief) and an outward one (Funding Readiness).
  insert into public.reports (organization_id, report_kind, window_start, window_end, origin, content, content_version)
  values (p_org, 'daily_brief', '2026-03-31', '2026-03-31', 'scheduled', '{}'::jsonb, 'brief.v1');
  insert into public.reports (organization_id, report_kind, window_start, window_end, period_id, origin, content, content_version)
  values (p_org, 'funding_readiness', '2026-03-01', '2026-03-31', v_period, 'scheduled', '{}'::jsonb, 'funding.v1');
end $$;

call pg_temp.seed_org('e3a00000-0000-0000-0000-00000000000a', 'MAA');
call pg_temp.seed_org('e3b00000-0000-0000-0000-00000000000b', 'MAB');
call pg_temp.seed_org('e3500000-0000-0000-0000-000000000005', 'MAS');

-- ---------------------------------------------------------------------------
-- Impersonation helpers (the house pattern from 06_financial_rls.test.sql).
-- ---------------------------------------------------------------------------
create procedure pg_temp.act_as(p_user uuid)
language plpgsql as $$
declare v_email text;
begin
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'email', v_email, 'aal', 'aal1',
                      'amr', json_build_array(json_build_object('method', 'password',
                                                                'timestamp', extract(epoch from now())::bigint)))::text,
    true);
end $$;

create procedure pg_temp.act_as_postgres()
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create function pg_temp.visible_rows(p_user uuid, p_sql text)
returns integer language plpgsql as $$
declare v integer;
begin
  call pg_temp.act_as(p_user);
  execute p_sql into v;
  call pg_temp.act_as_postgres();
  return v;
end $$;

create function pg_temp.rows_of(p_user uuid, p_table text, p_org uuid)
returns integer language plpgsql as $$
begin
  return pg_temp.visible_rows(p_user,
    format('select count(*) from public.%I where organization_id = %L', p_table, p_org));
end $$;

-- Runs one statement as a user; returns the SQLSTATE it raised, or 'ok'.
create function pg_temp.try_as(p_user uuid, p_sql text)
returns text language plpgsql as $$
declare v text := 'ok';
begin
  call pg_temp.act_as(p_user);
  begin
    execute p_sql;
  exception when others then
    v := sqlstate;
  end;
  call pg_temp.act_as_postgres();
  return v;
end $$;

create function pg_temp.has_perm(p_user uuid, p_org uuid, p_perm text)
returns boolean language plpgsql as $$
declare v boolean;
begin
  call pg_temp.act_as(p_user);
  v := app.has_permission(p_org, p_perm);
  call pg_temp.act_as_postgres();
  return v;
end $$;

-- The detail tables a 3rd party must never read.
create temp table detail_tables (relname text primary key) on commit drop;
insert into detail_tables values
  ('accounts'), ('counterparties'), ('ledger_entries'), ('period_balances'), ('invoices'),
  ('invoice_lines'), ('products'), ('bank_accounts'), ('bank_transactions'),
  ('recurring_payment_groups'), ('category_history'), ('account_category_history'),
  ('record_status_events'), ('alerts'), ('alert_revisions'), ('actions'), ('evidence_bundles'),
  ('source_documents'), ('import_mappings'), ('import_batches'), ('import_rows');
grant select on detail_tables to authenticated;

-- ---------------------------------------------------------------------------
-- 0. Non-vacuity: every table asserted on holds a row in organisation A.
-- ---------------------------------------------------------------------------
create function pg_temp.raw_rows(p_table text, p_org uuid) returns integer
language plpgsql as $$
declare v integer;
begin
  execute format('select count(*) from public.%I where organization_id = %L', p_table, p_org) into v;
  return v;
end $$;

select is((select count(*)::int from detail_tables d
            where pg_temp.raw_rows(d.relname, 'e3a00000-0000-0000-0000-00000000000a') < 1),
          0, 'every detail table holds a row in organisation A, so each zero below is a refusal');

-- ---------------------------------------------------------------------------
-- 1. The ceiling
-- ---------------------------------------------------------------------------
select is(app.role_rank('accountant'), 1, 'accountant ranks with client (1)');
select is(app.role_rank('third_party'), 1, 'third_party ranks with client (1)');
select ok(app.ceiling_allows('admin', 'accountant') and app.ceiling_allows('admin', 'third_party'),
          'an admin may invite, move and remove an accountant and a 3rd party');
select ok(not app.ceiling_allows('accountant', 'client') and not app.ceiling_allows('third_party', 'client'),
          'neither new role governs anybody');

-- ---------------------------------------------------------------------------
-- 2. A 3rd party: the overview, and nothing beneath it
-- ---------------------------------------------------------------------------
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000005', d.relname, 'e3a00000-0000-0000-0000-00000000000a'),
          0, format('a 3rd party reads ZERO rows of public.%s', d.relname))
  from detail_tables d order by d.relname;

select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000005', t.relname, 'e3a00000-0000-0000-0000-00000000000a'),
          1, format('a 3rd party CAN read the overview table public.%s', t.relname))
  from (values ('health_scores'), ('health_current'), ('calculation_runs')) t(relname);
select ok(pg_temp.rows_of('e3000000-0000-0000-0000-000000000005', 'fiscal_periods', 'e3a00000-0000-0000-0000-00000000000a') >= 1,
          'a 3rd party reads the months (no figures in them)');
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000005',
            'select count(*) from public.metric_snapshots where organization_id = ''e3a00000-0000-0000-0000-00000000000a'' and dimension_type = ''none'''),
          1, 'a 3rd party reads the current headline figure');
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000005',
            'select count(*) from public.metric_snapshots where organization_id = ''e3a00000-0000-0000-0000-00000000000a'' and dimension_type = ''counterparty'''),
          0, 'a 3rd party reads NO per-customer figure');
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000005',
            'select count(*) from public.reports where organization_id = ''e3a00000-0000-0000-0000-00000000000a'' and report_kind = ''funding_readiness'''),
          1, 'a 3rd party reads Funding Readiness (an outward report)');
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000005',
            'select count(*) from public.reports where organization_id = ''e3a00000-0000-0000-0000-00000000000a'' and report_kind = ''daily_brief'''),
          0, 'a 3rd party reads NO daily brief (alerts, actions and named records)');
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000005',
            'select count(*) from public.org_member_profiles where organization_id = ''e3a00000-0000-0000-0000-00000000000a'''),
          0, 'a 3rd party learns nobody''s name from org_member_profiles');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000005', 'audit_events', 'e3a00000-0000-0000-0000-00000000000a'),
          0, 'a 3rd party reads no audit event');
-- …and nothing of organisation B.
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000005', t.relname, 'e3b00000-0000-0000-0000-00000000000b'),
          0, format('a 3rd party of A reads ZERO rows of public.%s in organisation B', t.relname))
  from (values ('health_scores'), ('metric_snapshots'), ('reports'), ('fiscal_periods')) t(relname);

-- ---------------------------------------------------------------------------
-- 3. An accountant: the detail and the documents; not the audit log, the team or the AI
-- ---------------------------------------------------------------------------
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000003', d.relname, 'e3a00000-0000-0000-0000-00000000000a'),
          1, format('an accountant CAN read public.%s', d.relname))
  from (values ('ledger_entries'), ('invoices'), ('bank_transactions'), ('counterparties'),
               ('source_documents'), ('import_batches'), ('evidence_bundles'), ('alerts')) d(relname);
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000003', 'audit_events', 'e3a00000-0000-0000-0000-00000000000a'),
          0, 'an accountant reads no audit event');
select ok(not pg_temp.has_perm('e3000000-0000-0000-0000-000000000003', 'e3a00000-0000-0000-0000-00000000000a', 'ai.use'),
          'an accountant has no ai.use');
select ok(not pg_temp.has_perm('e3000000-0000-0000-0000-000000000003', 'e3a00000-0000-0000-0000-00000000000a', 'users.view'),
          'an accountant has no users.view');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000003',
            'select api.create_conversation(''e3a00000-0000-0000-0000-00000000000a'')'),
          '42501', 'an accountant cannot start an AI conversation');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000003',
            'select * from api.org_members(''e3a00000-0000-0000-0000-00000000000a'')'),
          '42501', 'an accountant cannot list the team');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000003',
            format('select api.set_alert_status(%L, ''resolved'')',
                   (select id from public.alerts where organization_id = 'e3a00000-0000-0000-0000-00000000000a'))),
          '42501', 'an accountant may not resolve an alert (acknowledge only)');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000003',
            format('select api.set_alert_status(%L, ''acknowledged'')',
                   (select id from public.alerts where organization_id = 'e3a00000-0000-0000-0000-00000000000a'))),
          'ok', 'an accountant may acknowledge an alert');

-- A client still reads what a client always read, and still no documents.
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000004', d.relname, 'e3a00000-0000-0000-0000-00000000000a'),
          1, format('a client CAN read public.%s', d.relname))
  from (values ('ledger_entries'), ('invoices'), ('bank_transactions'), ('alerts'), ('actions')) d(relname);
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000004', 'source_documents', 'e3a00000-0000-0000-0000-00000000000a'),
          0, 'a client reads no source document by default');

-- ---------------------------------------------------------------------------
-- 4. A switch opens and closes a table for ONE person
-- ---------------------------------------------------------------------------
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''documents.view'', true)'),
          'ok', 'the owner switches documents.view ON for the client');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000004', 'source_documents', 'e3a00000-0000-0000-0000-00000000000a'),
          1, '… and the client reads the source document');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000004', 'source_documents', 'e3b00000-0000-0000-0000-00000000000b'),
          0, '… of their own organisation only');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''documents.view'', false)'),
          'ok', 'the owner switches it OFF');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000004', 'source_documents', 'e3a00000-0000-0000-0000-00000000000a'),
          0, '… and the client reads none');
select is((select count(*)::int from public.audit_events
            where organization_id = 'e3a00000-0000-0000-0000-00000000000a' and action = 'member.permission_changed'),
          2, 'each switch is audited member.permission_changed');

-- Taking financials.view from a client closes the ledger but not the bank lines (banking.view).
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''financials.view'', false)'),
          'ok', 'the owner switches financials.view OFF for the client');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000004', 'ledger_entries', 'e3a00000-0000-0000-0000-00000000000a'),
          0, '… the client reads no ledger entry');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000004', 'bank_transactions', 'e3a00000-0000-0000-0000-00000000000a'),
          1, '… but still the bank lines (banking.view is untouched)');
select ok(not pg_temp.has_perm('e3000000-0000-0000-0000-000000000004', 'e3a00000-0000-0000-0000-00000000000a', 'financials.view'),
          '… and app.has_permission agrees');

-- financials.view switched ON for a 3rd party opens the ledger for that 3rd party only.
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000002',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000005'', ''financials.view'', true)'),
          'ok', 'an admin switches financials.view ON for the 3rd party');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000005', 'ledger_entries', 'e3a00000-0000-0000-0000-00000000000a'),
          1, '… who now reads the ledger');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000005', 'source_documents', 'e3a00000-0000-0000-0000-00000000000a'),
          0, '… and still no documents');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000008', 'ledger_entries', 'e3b00000-0000-0000-0000-00000000000b'),
          0, 'the 3rd party of organisation B is untouched');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000002',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000005'', ''financials.view'', null)'),
          'ok', 'back to the default');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000005', 'ledger_entries', 'e3a00000-0000-0000-0000-00000000000a'),
          0, '… and the ledger is closed again');

-- A switch on an OWNER's row (written directly — the api refuses it) is ignored.
insert into public.member_permission_overrides (organization_id, user_id, permission, granted)
values ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000010', 'financials.view', false);
select ok(pg_temp.has_perm('e3000000-0000-0000-0000-000000000010', 'e3a00000-0000-0000-0000-00000000000a', 'financials.view'),
          'a switch stored against an owner is ignored by app.has_permission');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000010', 'ledger_entries', 'e3a00000-0000-0000-0000-00000000000a'),
          1, '… and by the policies');
delete from public.member_permission_overrides where user_id = 'e3000000-0000-0000-0000-000000000010';

-- A suspended organisation freezes everyone, whatever their switches.
insert into public.member_permission_overrides (organization_id, user_id, permission, granted)
values ('e3500000-0000-0000-0000-000000000005', 'e3000000-0000-0000-0000-000000000012', 'documents.view', true);
update public.organizations set status = 'suspended' where id = 'e3500000-0000-0000-0000-000000000005';
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000012', 'source_documents', 'e3500000-0000-0000-0000-000000000005'),
          0, 'a switch is ignored in a suspended organisation (suspended_member)');
select ok(not pg_temp.has_perm('e3000000-0000-0000-0000-000000000012', 'e3500000-0000-0000-0000-000000000005', 'documents.view'),
          '… and by app.has_permission');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000012', 'health_current', 'e3500000-0000-0000-0000-000000000005'),
          1, 'the frozen Home still shows the health score');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000012', 'alerts', 'e3500000-0000-0000-0000-000000000005'),
          1, '… and the alerts (ADR-044.4)');

-- APX staff hold their role's permissions; no switch applies to them (they are not members).
select ok(pg_temp.has_perm('e3000000-0000-0000-0000-000000000009', 'e3a00000-0000-0000-0000-00000000000a', 'documents.view'),
          'the assigned Financial Analyst holds documents.view by role');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000009'', ''documents.view'', false)'),
          'P0002', 'nobody can switch a Financial Analyst (not a member: NOT FOUND)');

-- ---------------------------------------------------------------------------
-- 5. The switches table itself
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.member_permission_overrides (organization_id, user_id, permission, granted)
     values ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000004', 'users.manage', true) $$,
  '23514', null, 'users.manage cannot be stored as a switch (not switchable)');
select throws_ok(
  $$ insert into public.member_permission_overrides (organization_id, user_id, permission, granted)
     values ('e3a00000-0000-0000-0000-00000000000a', 'e3000000-0000-0000-0000-000000000007', 'ai.use', true) $$,
  '23503', null, 'a switch cannot exist for somebody who is not a member of that organisation');
select is(app.switchable_permissions(),
  array['dashboard.view', 'financials.view', 'financials.edit', 'imports.create', 'imports.review',
        'banking.view', 'banking.reconcile', 'customers.view', 'customers.edit', 'reports.view',
        'reports.generate', 'ai.use', 'actions.view', 'actions.create', 'actions.assign',
        'actions.update_own', 'alerts.manage', 'intelligence.recompute', 'documents.view',
        'data.export', 'audit.view']::text[],
  'the switchable list equals SWITCHABLE_PERMISSIONS in the contract');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000004',
            'insert into public.member_permission_overrides (organization_id, user_id, permission, granted) values (''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''ai.use'', true)'),
          '42501', 'nobody writes the switches table directly (ADR-026)');

-- ---------------------------------------------------------------------------
-- 6. api.set_member_permission's refusals
-- ---------------------------------------------------------------------------
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000004',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000005'', ''ai.use'', true)'),
          '42501', 'a client cannot switch anybody (users.manage)');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000003',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000005'', ''ai.use'', true)'),
          '42501', 'an accountant cannot switch anybody');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000002',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000002'', ''audit.view'', false)'),
          '42501', 'an admin cannot switch themselves');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000002',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000001'', ''ai.use'', false)'),
          '42501', 'an admin cannot switch an owner');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000010'', ''ai.use'', false)'),
          '42501', 'an owner cannot switch another owner');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''users.manage'', true)'),
          '22023', 'a non-switchable permission is refused');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000007',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''ai.use'', true)'),
          'P0002', 'an owner of ANOTHER organisation gets NOT FOUND');
-- Never beyond one's own rights: the owner takes audit.view from admin 2, who then cannot give it.
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000006'', ''audit.view'', false)'),
          'ok', 'the owner switches audit.view OFF for admin 2');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000006',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''audit.view'', true)'),
          '42501', '… who cannot switch audit.view ON for anybody');
select is(pg_temp.rows_of('e3000000-0000-0000-0000-000000000006', 'audit_events', 'e3a00000-0000-0000-0000-00000000000a'),
          0, '… and no longer reads the audit log');
-- …nor reset a switch when the default it restores would give what the admin lacks.
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000002'', ''audit.view'', false)'),
          'ok', 'the owner switches audit.view OFF for admin 1 too');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000006',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000002'', ''audit.view'', null)'),
          '42501', 'admin 2 cannot reset admin 1 to a default that grants what admin 2 lacks');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000006',
            'select api.set_member_permission(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''ai.use'', false)'),
          'ok', 'admin 2 may still take away (switch OFF) what they do not need to hold');

-- Who reads the switches: a member their own; whoever sees the team, everyone's.
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000004',
            'select count(*) from public.member_permission_overrides where user_id <> ''e3000000-0000-0000-0000-000000000004'''),
          0, 'a client sees nobody else''s switch');
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000004',
            'select count(*) from public.member_permission_overrides where user_id = ''e3000000-0000-0000-0000-000000000004'''),
          (select count(*)::int from public.member_permission_overrides where user_id = 'e3000000-0000-0000-0000-000000000004'),
          '… and every one of their own');
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000001',
            'select count(*) from public.member_permission_overrides where organization_id = ''e3a00000-0000-0000-0000-00000000000a'''),
          (select count(*)::int from public.member_permission_overrides where organization_id = 'e3a00000-0000-0000-0000-00000000000a'),
          'the owner sees every switch of the organisation');
select is(pg_temp.visible_rows('e3000000-0000-0000-0000-000000000007',
            'select count(*) from public.member_permission_overrides where organization_id = ''e3a00000-0000-0000-0000-00000000000a'''),
          0, 'an owner of another organisation sees none');

-- ---------------------------------------------------------------------------
-- 7. A role change carries the owner's switches and clears the rest
-- ---------------------------------------------------------------------------
select ok((select count(*) from public.member_permission_overrides
            where organization_id = 'e3a00000-0000-0000-0000-00000000000a'
              and user_id = 'e3000000-0000-0000-0000-000000000004') >= 2,
          'the client holds switches before the role change');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000001',
            'select api.change_member_role(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''accountant'')'),
          'ok', 'the owner makes the client an accountant');
-- Since the ADR-172 hardening (20261018000032) a role change CARRIES the switches an owner set and
-- clears the rest: the owner switched documents.view and financials.view, admin 2 switched ai.use.
select is((select string_agg(o.permission, ',' order by o.permission) from public.member_permission_overrides o
            where o.organization_id = 'e3a00000-0000-0000-0000-00000000000a'
              and o.user_id = 'e3000000-0000-0000-0000-000000000004'),
          'documents.view,financials.view', '… which keeps the owner''s switches and clears the admin''s (ai.use)');
select is((select count(*)::int from public.audit_events
            where organization_id = 'e3a00000-0000-0000-0000-00000000000a' and action = 'member.permissions_reset'),
          1, '… audited member.permissions_reset');
select ok(not pg_temp.has_perm('e3000000-0000-0000-0000-000000000004', 'e3a00000-0000-0000-0000-00000000000a', 'financials.view'),
          '… so the owner''s switch-off of financials.view holds in the new role too');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000002',
            'select api.change_member_role(''e3a00000-0000-0000-0000-00000000000a'', ''e3000000-0000-0000-0000-000000000004'', ''third_party'')'),
          'ok', 'an admin may move a member to 3rd party');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000002',
            'select * from api.invite_member_with_token(''e3a00000-0000-0000-0000-00000000000a'', ''new-accountant@test.motion'', ''accountant'')'),
          'ok', 'an admin may invite an accountant');
select is(pg_temp.try_as('e3000000-0000-0000-0000-000000000002',
            'select * from api.invite_member_with_token(''e3a00000-0000-0000-0000-00000000000a'', ''new-lender@test.motion'', ''third_party'')'),
          'ok', 'an admin may invite a 3rd party');

-- ---------------------------------------------------------------------------
-- 8. The shape (ADR-065)
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_policy p
     join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and pg_get_expr(p.polqual, p.polrelid) ~ 'org_ids_with_role\(VARIADIC ARRAY\[''owner''::text, ''admin''::text, ''employee''::text, ''super_admin''::text, ''client''::text'),
  0, 'no policy grants SELECT to the old five-role list: every data read is a permission');
select is(
  (select count(*)::int from pg_policy p
     join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and pg_get_expr(p.polqual, p.polrelid) ~ 'effective_permission|has_permission\('),
  0, 'no policy calls a per-row permission helper');
select ok(
  (select provolatile = 's' and prosecdef from pg_proc where oid = 'app.org_ids_with_permission(text)'::regprocedure),
  'org_ids_with_permission stays STABLE SECURITY DEFINER');
select ok(not has_function_privilege('authenticated', 'app.effective_permission(uuid, uuid, text, text)', 'execute'),
          'app.effective_permission is internal');

select * from finish();
rollback;
