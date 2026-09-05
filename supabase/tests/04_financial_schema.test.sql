-- MOTION — pgTAP · Structure and constraints of the Phase 4 financial schema.
-- Contract: DATABASE_ARCHITECTURE.md §3–§9, §11, §12; TEST_STRATEGY.md §3;
--           ADR-004 (standard chart), ADR-029.1/.2 (identity and current-balance uniqueness),
--           ADR-032.4 (the assistant channel), ADR-044.8 (composite foreign keys).
--
-- The last section is the one that matters most: a generated sweep over every foreign key in
-- `public`. A tenant→tenant reference that omits organization_id is a cross-tenant read waiting to
-- happen, and no hand-written assertion can keep pace with a schema that grows. The sweep fails on
-- the FK itself, whatever migration added it.

begin;
create extension if not exists pgtap;

select plan(180);

-- ---------------------------------------------------------------------------
-- Fixtures. Written as postgres so states the api.* surface forbids can be built.
-- Everything created here carries the `pgt-fin` / `PGT-FIN` prefix, so the assertions below can
-- count their own rows and never depend on what else the database happens to hold.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('f4000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fin-owner@test.motion','x',now(),now(),now());

insert into public.organizations (id, slug, name, fiscal_year_start_month) values
  ('f4a00000-0000-0000-0000-00000000000a','pgt-fin-org-a','PGT-FIN Org A', 1),
  ('f4b00000-0000-0000-0000-00000000000b','pgt-fin-org-b','PGT-FIN Org B', 1);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('f4a00000-0000-0000-0000-00000000000a','f4000000-0000-0000-0000-000000000001','owner');

insert into public.fiscal_periods (id, organization_id, period_start, period_end, fiscal_year, fiscal_quarter, label)
values ('f4c00000-0000-0000-0000-00000000000c','f4a00000-0000-0000-0000-00000000000a',
        '2026-01-01','2026-01-31', 2026, 1, 'Jan 2026');

insert into public.accounts (id, organization_id, name, normalized_name, account_type, standard_category)
values ('f4d00000-0000-0000-0000-00000000000d','f4a00000-0000-0000-0000-00000000000a',
        'PGT-FIN Sales','pgt fin sales','income','revenue'),
       ('f4d00000-0000-0000-0000-00000000000e','f4a00000-0000-0000-0000-00000000000a',
        'PGT-FIN Bank','pgt fin bank','asset','cash');

insert into public.counterparties (id, organization_id, name, normalized_name, kind)
values ('f4e00000-0000-0000-0000-00000000000e','f4a00000-0000-0000-0000-00000000000a',
        'PGT-FIN Customer','pgt fin customer','customer');

insert into public.bank_accounts (id, organization_id, name, bank_name, account_type)
values ('f4f00000-0000-0000-0000-00000000000f','f4a00000-0000-0000-0000-00000000000a',
        'PGT-FIN Current','PGT Bank','current');

-- ---------------------------------------------------------------------------
-- 1. Every Phase 4 table exists, forces RLS and is owned by motion_definer.
-- ---------------------------------------------------------------------------
create table pg_temp.phase4_tables (relname text primary key);
insert into pg_temp.phase4_tables values
  ('fiscal_periods'), ('accounts'), ('account_category_history'), ('counterparties'),
  ('ledger_entries'), ('period_balances'), ('invoices'),
  ('bank_accounts'), ('bank_transactions'), ('recurring_payment_groups'), ('category_history'),
  ('source_documents'), ('import_mappings'), ('import_batches'), ('import_rows'),
  ('calculation_runs'), ('metric_snapshots'), ('metric_current'), ('health_scores'),
  ('health_current'), ('alerts'), ('alert_revisions'), ('evidence_bundles'), ('evidence_items'),
  ('record_status_events'),
  ('ai_conversations'), ('ai_messages'), ('ai_tool_calls'), ('ai_feedback'),
  ('actions'), ('report_files');

select has_table('public', t.relname, 'table exists: public.' || t.relname)
  from pg_temp.phase4_tables t order by t.relname;

select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.relname),
  'RLS enabled + forced: public.' || t.relname)
  from pg_temp.phase4_tables t order by t.relname;

select is(
  (select pg_catalog.pg_get_userbyid(c.relowner)
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.relname),
  'motion_definer',
  'owned by motion_definer: public.' || t.relname)
  from pg_temp.phase4_tables t order by t.relname;

-- metric_snapshots is hash-partitioned from day one (DATABASE_ARCHITECTURE.md §6).
select is(
  (select count(*)::int from pg_catalog.pg_inherits i
    where i.inhparent = 'public.metric_snapshots'::regclass),
  8, 'metric_snapshots has exactly eight hash partitions');

select ok(
  (select c.relkind from pg_catalog.pg_class c where c.oid = 'public.metric_snapshots'::regclass) = 'p',
  'metric_snapshots is a partitioned table');

-- The two definer views that carry the withheld columns (ADR-038.4).
select has_view('public', 'bank_transactions_raw', 'the definer view bank_transactions_raw exists');
select has_view('public', 'counterparties_contact', 'the definer view counterparties_contact exists');
select is(
  (select count(*)::int from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('bank_transactions_raw', 'counterparties_contact')
      and pg_catalog.pg_get_userbyid(c.relowner) <> 'motion_definer'),
  0, 'both definer views are owned by motion_definer');
select is(
  (select count(*)::int from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('bank_transactions_raw', 'counterparties_contact')
      and coalesce(c.reloptions, '{}') @> array['security_invoker=false']),
  2, 'both definer views set security_invoker = false');

-- ---------------------------------------------------------------------------
-- 2. standard_category_account_type — the pairing stated once (ADR-004).
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from unnest(enum_range(null::public.standard_category_enum))),
  26, 'standard_category_enum holds exactly 26 categories');

select is(public.standard_category_account_type(e.category::public.standard_category_enum),
          e.account_type::public.account_type_enum,
          format('standard_category_account_type(%s) = %s', e.category, e.account_type))
  from (values
    ('revenue','income'), ('other_income','income'),
    ('cost_of_sales','expense'), ('operating_expense','expense'), ('payroll','expense'),
    ('marketing','expense'), ('interest_expense','expense'), ('tax_expense','expense'),
    ('depreciation','expense'), ('other_expense','expense'),
    ('cash','asset'), ('receivables','asset'), ('inventory','asset'),
    ('other_current_asset','asset'), ('fixed_asset','asset'), ('other_asset','asset'),
    ('payables','liability'), ('credit_card','liability'), ('loan','liability'),
    ('tax_liability','liability'), ('other_current_liability','liability'),
    ('long_term_liability','liability'),
    ('equity','equity'), ('drawings','equity'),
    -- Holding categories. Assets by design, so an unmapped movement never lands in P&L (ADR-004).
    ('transfer','asset'), ('uncategorised','asset')
  ) as e(category, account_type);

-- The function is total: no category resolves to NULL, so the CHECK below can never be bypassed.
select is(
  (select count(*)::int from unnest(enum_range(null::public.standard_category_enum)) c
    where public.standard_category_account_type(c) is null),
  0, 'standard_category_account_type is total over the 26 categories');

-- ...and the check constraint actually refuses a pair the function disagrees with.
select throws_ok(
  $$ insert into public.accounts (organization_id, name, normalized_name, account_type, standard_category)
     values ('f4a00000-0000-0000-0000-00000000000a','PGT-FIN Bad','pgt fin bad','liability','revenue') $$,
  '23514', null, 'accounts_type_matches_category refuses liability + revenue');
select lives_ok(
  $$ insert into public.accounts (organization_id, name, normalized_name, account_type, standard_category)
     values ('f4a00000-0000-0000-0000-00000000000a','PGT-FIN Good','pgt fin good','income','revenue') $$,
  'accounts_type_matches_category accepts income + revenue');

-- ---------------------------------------------------------------------------
-- 3. single_current_balance (ADR-029.2)
-- ---------------------------------------------------------------------------
insert into public.period_balances
  (id, organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis, record_status)
values ('f4100000-0000-0000-0000-000000000001','f4a00000-0000-0000-0000-00000000000a',
        '2026-01-01','f4d00000-0000-0000-0000-00000000000d', 100, 'trial_balance','cumulative','accepted');

select throws_ok(
  $$ insert into public.period_balances
       (organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis, record_status)
     values ('f4a00000-0000-0000-0000-00000000000a','2026-01-01','f4d00000-0000-0000-0000-00000000000d',
             200, 'trial_balance','cumulative','accepted') $$,
  '23505', null,
  'single_current_balance refuses a second accepted, non-superseded row for the same cell and kind');

-- A different balance_kind for the same cell is a different figure and is allowed.
select lives_ok(
  $$ insert into public.period_balances
       (organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis, record_status)
     values ('f4a00000-0000-0000-0000-00000000000a','2026-01-01','f4d00000-0000-0000-0000-00000000000d',
             200, 'pnl_report','cumulative','accepted') $$,
  'single_current_balance is scoped to balance_kind');

-- The same pair with the first row superseded IS allowed: that is the correction path (ADR-026.6).
insert into public.period_balances
  (id, organization_id, period_start, account_id, closing_balance, balance_kind, balance_basis, record_status)
values ('f4100000-0000-0000-0000-000000000002','f4a00000-0000-0000-0000-00000000000a',
        '2026-01-01','f4d00000-0000-0000-0000-00000000000d', 300, 'trial_balance','cumulative','pending');

select lives_ok(
  $$ update public.period_balances set superseded_by = 'f4100000-0000-0000-0000-000000000002'
      where id = 'f4100000-0000-0000-0000-000000000001' $$,
  'the earlier balance row may be pointed at its replacement');
select lives_ok(
  $$ update public.period_balances set record_status = 'accepted'
      where id = 'f4100000-0000-0000-0000-000000000002' $$,
  'the replacement may then become the accepted, non-superseded row for that cell');
select is(
  (select count(*)::int from public.period_balances
    where organization_id = 'f4a00000-0000-0000-0000-00000000000a'
      and balance_kind = 'trial_balance' and record_status = 'accepted' and superseded_by is null),
  1, 'exactly one current trial_balance row survives the correction');

-- ---------------------------------------------------------------------------
-- 4. invoices_identity_unique (ADR-029.1)
-- ---------------------------------------------------------------------------
insert into public.invoices
  (id, organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount, record_status)
values ('f4200000-0000-0000-0000-000000000001','f4a00000-0000-0000-0000-00000000000a',
        'sales','f4e00000-0000-0000-0000-00000000000e','PGT-FIN-INV-1','2026-01-10', 500, 'accepted');

select throws_ok(
  $$ insert into public.invoices
       (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount, record_status)
     values ('f4a00000-0000-0000-0000-00000000000a','sales','f4e00000-0000-0000-0000-00000000000e',
             'PGT-FIN-INV-1','2026-01-10', 600, 'accepted') $$,
  '23505', null,
  'invoices_identity_unique refuses a second accepted, non-superseded invoice with the same identity');

select lives_ok(
  $$ insert into public.invoices
       (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount, record_status)
     values ('f4a00000-0000-0000-0000-00000000000a','purchase','f4e00000-0000-0000-0000-00000000000e',
             'PGT-FIN-INV-1','2026-01-10', 600, 'accepted') $$,
  'invoices_identity_unique is scoped to invoice_type');

insert into public.invoices
  (id, organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount, record_status)
values ('f4200000-0000-0000-0000-000000000002','f4a00000-0000-0000-0000-00000000000a',
        'sales','f4e00000-0000-0000-0000-00000000000e','PGT-FIN-INV-1','2026-01-10', 700, 'pending');

select lives_ok(
  $$ update public.invoices set superseded_by = 'f4200000-0000-0000-0000-000000000002'
      where id = 'f4200000-0000-0000-0000-000000000001' $$,
  'the earlier invoice may be pointed at its replacement');
select lives_ok(
  $$ update public.invoices set record_status = 'accepted'
      where id = 'f4200000-0000-0000-0000-000000000002' $$,
  'the replacement invoice may then become the current one (IMP-INV-010)');
select is(
  (select count(*)::int from public.invoices
    where organization_id = 'f4a00000-0000-0000-0000-00000000000a' and invoice_type = 'sales'
      and invoice_number = 'PGT-FIN-INV-1' and record_status = 'accepted' and superseded_by is null),
  1, 'exactly one current sales invoice survives the re-import');

-- ---------------------------------------------------------------------------
-- 5. evidence_item_xor
-- ---------------------------------------------------------------------------
insert into public.evidence_bundles (id, organization_id, kind, origin_table)
values ('f4300000-0000-0000-0000-000000000001','f4a00000-0000-0000-0000-00000000000a','metric','metric_snapshots');

select throws_ok(
  $$ insert into public.evidence_items
       (organization_id, bundle_id, item_type, ref_id, query_descriptor, descriptor_hash,
        label, assurance_level)
     values ('f4a00000-0000-0000-0000-00000000000a','f4300000-0000-0000-0000-000000000001',
             'account','f4d00000-0000-0000-0000-00000000000d','{"k":1}'::jsonb, '\x00'::bytea,
             'both','verified') $$,
  '23514', null, 'evidence_item_xor refuses a row carrying BOTH ref_id and query_descriptor');

select throws_ok(
  $$ insert into public.evidence_items
       (organization_id, bundle_id, item_type, label, assurance_level)
     values ('f4a00000-0000-0000-0000-00000000000a','f4300000-0000-0000-0000-000000000001',
             'account','neither','verified') $$,
  '23514', null, 'evidence_item_xor refuses a row carrying NEITHER');

select lives_ok(
  $$ insert into public.evidence_items
       (organization_id, bundle_id, item_type, ref_id, label, assurance_level)
     values ('f4a00000-0000-0000-0000-00000000000a','f4300000-0000-0000-0000-000000000001',
             'account','f4d00000-0000-0000-0000-00000000000d','ref only','verified') $$,
  'evidence_item_xor accepts a ref_id alone');

select throws_ok(
  $$ insert into public.evidence_items
       (organization_id, bundle_id, item_type, query_descriptor, label, assurance_level)
     values ('f4a00000-0000-0000-0000-00000000000a','f4300000-0000-0000-0000-000000000001',
             'query','{"k":1}'::jsonb,'query without hash','verified') $$,
  '23514', null, 'evidence_items_query_needs_hash refuses a descriptor with no hash (ADR-032.6)');

select throws_ok(
  $$ insert into public.evidence_items
       (organization_id, bundle_id, item_type, ref_id, ref_revision_no, label, assurance_level)
     values ('f4a00000-0000-0000-0000-00000000000a','f4300000-0000-0000-0000-000000000001',
             'account','f4d00000-0000-0000-0000-00000000000d', 1, 'revision on a non-alert','verified') $$,
  '23514', null, 'evidence_items_revision_only_for_alerts refuses ref_revision_no on an account item');

-- ---------------------------------------------------------------------------
-- 6. bank_transactions_transfer_consistent
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.bank_transactions
       (organization_id, bank_account_id, transaction_date, amount, is_transfer, transfer_kind)
     values ('f4a00000-0000-0000-0000-00000000000a','f4f00000-0000-0000-0000-00000000000f',
             '2026-01-05', -50, true, 'none') $$,
  '23514', null, 'bank_transactions_transfer_consistent refuses is_transfer = true with kind `none`');

select throws_ok(
  $$ insert into public.bank_transactions
       (organization_id, bank_account_id, transaction_date, amount, is_transfer, transfer_kind)
     values ('f4a00000-0000-0000-0000-00000000000a','f4f00000-0000-0000-0000-00000000000f',
             '2026-01-05', -50, false, 'cash_transfer') $$,
  '23514', null, 'bank_transactions_transfer_consistent refuses is_transfer = false with a real kind');

select lives_ok(
  $$ insert into public.bank_transactions
       (organization_id, bank_account_id, transaction_date, amount, is_transfer, transfer_kind)
     values ('f4a00000-0000-0000-0000-00000000000a','f4f00000-0000-0000-0000-00000000000f',
             '2026-01-05', -50, true, 'cash_transfer') $$,
  'bank_transactions_transfer_consistent accepts a consistent pair');

-- ---------------------------------------------------------------------------
-- 7. ai_messages_channel (ADR-032.4) — the assistant has no free-text channel.
-- ---------------------------------------------------------------------------
insert into public.ai_conversations (id, organization_id, user_id)
values ('f4400000-0000-0000-0000-000000000001','f4a00000-0000-0000-0000-00000000000a',
        'f4000000-0000-0000-0000-000000000001');

select throws_ok(
  $$ insert into public.ai_messages (organization_id, conversation_id, role, content)
     values ('f4a00000-0000-0000-0000-00000000000a','f4400000-0000-0000-0000-000000000001',
             'assistant','a free-text answer') $$,
  '23514', null, 'ai_messages_channel refuses an assistant row with non-null content');

select lives_ok(
  $$ insert into public.ai_messages (organization_id, conversation_id, role, structured_response)
     values ('f4a00000-0000-0000-0000-00000000000a','f4400000-0000-0000-0000-000000000001',
             'assistant','{"answer":"validated"}'::jsonb) $$,
  'ai_messages_channel accepts an assistant row carrying only structured_response');

select throws_ok(
  $$ insert into public.ai_messages (organization_id, conversation_id, role, content, structured_response)
     values ('f4a00000-0000-0000-0000-00000000000a','f4400000-0000-0000-0000-000000000001',
             'user','ask','{"x":1}'::jsonb) $$,
  '23514', null, 'ai_messages_channel refuses a user row carrying a structured_response');

select throws_ok(
  $$ insert into public.ai_messages (organization_id, conversation_id, role)
     values ('f4a00000-0000-0000-0000-00000000000a','f4400000-0000-0000-0000-000000000001','user') $$,
  '23514', null, 'ai_messages_channel refuses a user row with no content');

-- ---------------------------------------------------------------------------
-- 8. The composite-foreign-key sweep (ADR-044.8).
-- ---------------------------------------------------------------------------
-- Every foreign key from a tenant table (one carrying organization_id) must carry organization_id in
-- its own referencing column list, so Postgres itself refuses a row that points at another
-- organization's data. Three classes are exempt, and only three:
--
--   * `jobs` and `audit_events` — platform-class tables whose organization_id is nullable, exempted
--     BY NAME so a new tenant table cannot join them by accident.
--   * foreign keys whose TARGET has no organization_id column at all (profiles, organizations,
--     platform_users). Such a key physically cannot carry one; the second assertion below pins that
--     target set, so a future migration cannot enlarge the exemption quietly.
--
-- Polymorphic references carry no foreign key by construction and are covered by the same_org_ref
-- trigger instead — see 05_financial_triggers.test.sql.
create view pg_temp.tenant_fk_violations as
  select con.conrelid::regclass::text as referencing_table,
         con.conname                  as constraint_name,
         con.confrelid::regclass::text as target_table
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where con.contype = 'f'
     and n.nspname = 'public'
     -- the referencing table is a tenant table
     and exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = con.conrelid and a.attname = 'organization_id'
                    and a.attnum > 0 and not a.attisdropped)
     -- ...whose FK omits organization_id
     and not exists (select 1 from unnest(con.conkey) k
                       join pg_catalog.pg_attribute a
                         on a.attrelid = con.conrelid and a.attnum = k
                      where a.attname = 'organization_id')
     -- exemption 1: two platform-class tables, by name
     and c.relname not in ('jobs', 'audit_events')
     -- exemption 2: a target that has no organization_id column to carry
     and exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = con.confrelid and a.attname = 'organization_id'
                    and a.attnum > 0 and not a.attisdropped);

select is_empty(
  'select * from pg_temp.tenant_fk_violations',
  'every tenant→tenant foreign key carries organization_id (ADR-044.8)');

-- The narrower form the brief states verbatim: profiles and organizations are the only two targets
-- named as always-exempt. Anything else reaching the wider exemption above is listed here, so the
-- suite says out loud which non-tenant targets the schema currently references.
select set_eq(
  $$ select distinct con.confrelid::regclass::text
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class c on c.oid = con.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where con.contype = 'f' and n.nspname = 'public'
        and c.relname not in ('jobs', 'audit_events')
        and exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = con.conrelid and a.attname = 'organization_id'
                       and a.attnum > 0 and not a.attisdropped)
        and not exists (select 1 from unnest(con.conkey) k
                          join pg_catalog.pg_attribute a
                            on a.attrelid = con.conrelid and a.attnum = k
                         where a.attname = 'organization_id')
        and not exists (select 1 from pg_catalog.pg_attribute a
                         where a.attrelid = con.confrelid and a.attname = 'organization_id'
                           and a.attnum > 0 and not a.attisdropped) $$,
  $$ values ('profiles'), ('organizations'), ('platform_users') $$,
  'the only non-tenant foreign-key targets are profiles, organizations and platform_users');

-- The sweep is only meaningful if it is actually looking at something: assert it inspects the whole
-- Phase 4 surface rather than silently matching nothing.
select cmp_ok(
  (select count(*)::int
     from pg_catalog.pg_constraint con
     join pg_catalog.pg_class c on c.oid = con.conrelid
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f' and n.nspname = 'public'
      and exists (select 1 from unnest(con.conkey) k
                    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
                   where a.attname = 'organization_id')),
  '>=', 50, 'the schema declares at least fifty organization-scoped composite foreign keys');

-- Every Phase 4 tenant table offers `unique (organization_id, id)` — the target half of the rule.
-- The five excluded here are leaves: nothing in the schema points at them, so there is no composite
-- key for them to be the target of. (They are the ONLY five; adding a reference to one of them
-- without adding the key would fail the sweep above.)
select ok(
  exists (select 1 from pg_catalog.pg_constraint con
           where con.conrelid = ('public.' || t.relname)::regclass
             and con.contype in ('u', 'p')
             and (select array_agg(a.attname::text order by a.attname::text)
                    from unnest(con.conkey) k
                    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k)
                 = array['id', 'organization_id']),
  'public.' || t.relname || ' offers unique (organization_id, id) as a composite FK target')
  from pg_temp.phase4_tables t
 where t.relname not in ('record_status_events', 'metric_current', 'health_current',
                         'account_category_history', 'category_history')
 order by t.relname;

select * from finish();
rollback;
