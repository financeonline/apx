-- MOTION — pgTAP · The Phase 4 api.* / api_server.* surface.
-- Contract: DATABASE_ARCHITECTURE.md §14.1/§14.2; TEST_STRATEGY.md §3;
--           ADR-004 (the seeded standard chart), ADR-026 (writes only through api.*),
--           ADR-028 (transfer_kind is DERIVED, never asserted), ADR-032.5 (grounding gate),
--           ADR-034 (category history), ADR-043 (api_server is service-role only),
--           ADR-046/ADR-047.1 (supersession is a column plus an event),
--           SECURITY_MODEL.md §14 (NOT_FOUND, never PERMISSION_DENIED, for a foreign id).
--
-- Every failure below is asserted on SQLSTATE. Message text is not a contract; the code is.

begin;
create extension if not exists pgtap;

select plan(69);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('f7000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','api-owner@test.motion','x',now(),now(),now()),
  ('f7000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','api-client@test.motion','x',now(),now(),now()),
  ('f7000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','api-founder@test.motion','x',now(),now(),now()),
  ('f7000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','api-other@test.motion','x',now(),now(),now());

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

-- ===========================================================================
-- 1. api.create_organization seeds the standard chart and the period window (ADR-004)
-- ===========================================================================
call pg_temp.act_as('f7000000-0000-0000-0000-000000000003');
select lives_ok(
  $$ select api.create_organization('PGT-API Seeded Co') $$,
  'api.create_organization succeeds for a signed-in non-platform user');
call pg_temp.act_as_postgres();

create table pg_temp.seeded (org uuid);
insert into pg_temp.seeded
  select m.organization_id from public.organization_memberships m
   where m.user_id = 'f7000000-0000-0000-0000-000000000003';

select is((select count(*)::int from pg_temp.seeded), 1,
          'the creator is the owner of exactly one new organization');

select is(
  (select count(*)::int from public.accounts a
    where a.organization_id = (select org from pg_temp.seeded) and a.is_system),
  26, 'api.create_organization seeds exactly 26 system accounts — one per standard category');

select is(
  (select count(distinct a.standard_category)::int from public.accounts a
    where a.organization_id = (select org from pg_temp.seeded) and a.is_system),
  26, 'the 26 seeded accounts cover 26 DISTINCT standard categories');

select is_empty(
  $$ select c::text from unnest(enum_range(null::public.standard_category_enum)) c
      where not exists (select 1 from public.accounts a
                         where a.organization_id = (select org from pg_temp.seeded)
                           and a.is_system and a.standard_category = c) $$,
  'no standard category is left without a seeded system account');

select is(
  (select count(*)::int from public.accounts a
    where a.organization_id = (select org from pg_temp.seeded)
      and a.is_system and a.source <> 'seeded'),
  0, 'every seeded account is marked source = seeded');

select is(
  (select count(*)::int from public.fiscal_periods p
    where p.organization_id = (select org from pg_temp.seeded)),
  24, 'api.create_organization materialises exactly 24 fiscal periods (12 back, 12 forward)');

select is(
  (select count(*)::int from public.fiscal_periods p
    where p.organization_id = (select org from pg_temp.seeded)
      and p.period_start <> date_trunc('month', p.period_start)::date),
  0, 'every seeded fiscal period starts on the first of a month');

-- ---------------------------------------------------------------------------
-- The rest of this file uses hand-built organizations, so the assertions do not depend on
-- create_organization having succeeded and can name their own ids.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, slug, name) values
  ('f7a00000-0000-0000-0000-00000000000a','pgt-api-a','PGT-API Org A'),
  ('f7b00000-0000-0000-0000-00000000000b','pgt-api-b','PGT-API Org B');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('f7a00000-0000-0000-0000-00000000000a','f7000000-0000-0000-0000-000000000001','owner'),
  ('f7a00000-0000-0000-0000-00000000000a','f7000000-0000-0000-0000-000000000002','client'),
  ('f7b00000-0000-0000-0000-00000000000b','f7000000-0000-0000-0000-000000000004','owner');

create procedure pg_temp.seed_api_org(p_org uuid, p_tag text)
language plpgsql as $$
declare v_period uuid; v_acct uuid; v_run uuid; v_cur uuid; v_sav uuid; v_card uuid;
begin
  perform app.seed_standard_chart(p_org);

  insert into public.accounts (id, organization_id, name, normalized_name, account_type, standard_category)
  values (gen_random_uuid(), p_org, p_tag || ' Imported Costs', p_tag || ' imported costs',
          'expense', 'operating_expense')
  returning id into v_acct;

  -- The open history row api.remap_account must close is opened by `open_category_history`
  -- when the account is created (ADR-060), which is what the assertion below checks.

  insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount)
  values (p_org, '2026-02-10', v_acct, 'debit', 100) returning period_id into v_period;
  insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount)
  values (p_org, '2026-02-11', v_acct, 'debit', 110);

  insert into public.bank_accounts (organization_id, name, bank_name, account_type) values
    (p_org, p_tag || ' Current', 'PGT Bank', 'current'),
    (p_org, p_tag || ' Savings', 'PGT Bank', 'savings'),
    (p_org, p_tag || ' Card',    'PGT Bank', 'credit_card');
  select id into v_cur  from public.bank_accounts where organization_id = p_org and account_type = 'current';
  select id into v_sav  from public.bank_accounts where organization_id = p_org and account_type = 'savings';
  select id into v_card from public.bank_accounts where organization_id = p_org and account_type = 'credit_card';

  insert into public.bank_transactions (organization_id, bank_account_id, transaction_date, amount) values
    (p_org, v_cur,  '2026-02-12', -500),
    (p_org, v_sav,  '2026-02-12',  500),
    (p_org, v_cur,  '2026-02-20', -300),
    (p_org, v_card, '2026-02-20',  300);

  insert into public.calculation_runs
    (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
  values (p_org, 'recalc_manual', '1.0.0', v_period, v_period, '2026-02-28', 'succeeded')
  returning id into v_run;

  insert into public.alerts
    (organization_id, rule_key, rule_version, severity, period_id, title, explanation,
     dedupe_key, key_kind, calculation_run_id)
  values (p_org, 'pgt.api.rule', '1', 'high', v_period, 'title', 'explanation',
          p_tag || '-dedupe', 'state', v_run);

  insert into public.source_documents
    (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status)
  values (p_org, p_org::text || '/doc/' || p_tag || '.csv', p_tag || '.csv', 'text/csv', 10,
          extensions.digest(p_tag, 'sha256'), 'ready');
end $$;

call pg_temp.seed_api_org('f7a00000-0000-0000-0000-00000000000a', 'PGTA');
call pg_temp.seed_api_org('f7b00000-0000-0000-0000-00000000000b', 'PGTB');

-- Named handles for the ids the assertions need.
create table pg_temp.h (k text primary key, v uuid);
insert into pg_temp.h
  select 'acct_a', id from public.accounts
   where organization_id = 'f7a00000-0000-0000-0000-00000000000a' and not is_system;
insert into pg_temp.h
  select 'acct_b', id from public.accounts
   where organization_id = 'f7b00000-0000-0000-0000-00000000000b' and not is_system;
insert into pg_temp.h
  select 'sys_acct_a', id from public.accounts
   where organization_id = 'f7a00000-0000-0000-0000-00000000000a'
     and is_system and standard_category = 'payroll';
insert into pg_temp.h
  select 'alert_a', id from public.alerts where organization_id = 'f7a00000-0000-0000-0000-00000000000a';
insert into pg_temp.h
  select 'alert_b', id from public.alerts where organization_id = 'f7b00000-0000-0000-0000-00000000000b';
insert into pg_temp.h
  select 'doc_b', id from public.source_documents where organization_id = 'f7b00000-0000-0000-0000-00000000000b';
insert into pg_temp.h
  select 'txn_cur1_a', t.id from public.bank_transactions t join public.bank_accounts b
    on b.id = t.bank_account_id
   where t.organization_id = 'f7a00000-0000-0000-0000-00000000000a'
     and b.account_type = 'current' and t.transaction_date = '2026-02-12';
insert into pg_temp.h
  select 'txn_sav_a', t.id from public.bank_transactions t join public.bank_accounts b
    on b.id = t.bank_account_id
   where t.organization_id = 'f7a00000-0000-0000-0000-00000000000a' and b.account_type = 'savings';
insert into pg_temp.h
  select 'txn_cur2_a', t.id from public.bank_transactions t join public.bank_accounts b
    on b.id = t.bank_account_id
   where t.organization_id = 'f7a00000-0000-0000-0000-00000000000a'
     and b.account_type = 'current' and t.transaction_date = '2026-02-20';
insert into pg_temp.h
  select 'txn_card_a', t.id from public.bank_transactions t join public.bank_accounts b
    on b.id = t.bank_account_id
   where t.organization_id = 'f7a00000-0000-0000-0000-00000000000a' and b.account_type = 'credit_card';
insert into pg_temp.h
  select 'led1_a', id from public.ledger_entries
   where organization_id = 'f7a00000-0000-0000-0000-00000000000a' and entry_date = '2026-02-10';
insert into pg_temp.h
  select 'led2_a', id from public.ledger_entries
   where organization_id = 'f7a00000-0000-0000-0000-00000000000a' and entry_date = '2026-02-11';
insert into pg_temp.h
  select 'led1_b', id from public.ledger_entries
   where organization_id = 'f7b00000-0000-0000-0000-00000000000b' and entry_date = '2026-02-10';
insert into pg_temp.h
  select 'led2_b', id from public.ledger_entries
   where organization_id = 'f7b00000-0000-0000-0000-00000000000b' and entry_date = '2026-02-11';

create function pg_temp.h(p_key text) returns uuid
language sql stable as $$ select v from pg_temp.h where k = p_key $$;

-- The handle table is read while impersonating, so it must be readable by `authenticated`.
grant select on pg_temp.h to public;

-- ===========================================================================
-- 2. api.remap_account (ADR-004, ADR-034)
-- ===========================================================================
call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select throws_ok(
  format('select api.remap_account(%L, ''payroll''::public.standard_category_enum)',
         pg_temp.h('sys_acct_a')),
  '22023', null, 'api.remap_account refuses a SYSTEM account (a seeded account IS its category)');
call pg_temp.act_as_postgres();

select is((select count(*)::int from public.account_category_history
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a'
              and account_id = pg_temp.h('acct_a')),
          1, 'the imported account starts with one open history row');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select lives_ok(
  format('select api.remap_account(%L, ''payroll''::public.standard_category_enum)',
         pg_temp.h('acct_a')),
  'api.remap_account re-categorises an ordinary account');
call pg_temp.act_as_postgres();

select is((select standard_category::text from public.accounts where id = pg_temp.h('acct_a')),
          'payroll', 'api.remap_account moved accounts.standard_category');
select is((select account_type::text from public.accounts where id = pg_temp.h('acct_a')),
          'expense', 'api.remap_account re-derived account_type from the lookup function');
select is((select mapping_confidence::text from public.accounts where id = pg_temp.h('acct_a')),
          'confirmed', 'a deliberate remap marks the mapping confirmed');

select is((select count(*)::int from public.account_category_history
            where account_id = pg_temp.h('acct_a')),
          2, 'api.remap_account WROTE a new account_category_history row');
select is((select count(*)::int from public.account_category_history
            where account_id = pg_temp.h('acct_a') and valid_to is null),
          1, 'exactly one history row is left open');
select is((select standard_category::text from public.account_category_history
            where account_id = pg_temp.h('acct_a') and valid_to is null),
          'payroll', 'the open history row carries the NEW category');
select is((select standard_category::text from public.account_category_history
            where account_id = pg_temp.h('acct_a') and valid_to is not null),
          'operating_expense', 'the CLOSED history row still carries the old category (ADR-034)');

select is((select count(*)::int from public.jobs
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a'
              and job_type = 'calculation.run'),
          1, 'api.remap_account enqueued exactly one calculation.run job');
select is((select payload ->> 'trigger' from public.jobs
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a'
              and job_type = 'calculation.run'),
          'account_remapped', 'the queued job names account_remapped as its trigger');

-- A client holds financials.view but not financials.edit.
call pg_temp.act_as('f7000000-0000-0000-0000-000000000002');
select throws_ok(
  format('select api.remap_account(%L, ''marketing''::public.standard_category_enum)',
         pg_temp.h('acct_a')),
  '42501', null, 'a client cannot remap an account (financials.edit required)');
call pg_temp.act_as_postgres();

-- ===========================================================================
-- 3. api.mark_transfer — the kind is DERIVED, never accepted from the caller (ADR-028)
-- ===========================================================================
select is(
  (select pg_get_function_identity_arguments(p.oid) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.proname = 'mark_transfer'),
  'p_txn uuid, p_pair uuid',
  'api.mark_transfer takes only the two transactions: there is no parameter for the kind');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select lives_ok(
  format('select api.mark_transfer(%L, %L)', pg_temp.h('txn_cur1_a'), pg_temp.h('txn_sav_a')),
  'api.mark_transfer pairs a current-account leg with a savings-account leg');
call pg_temp.act_as_postgres();

select is((select transfer_kind::text from public.bank_transactions where id = pg_temp.h('txn_cur1_a')),
          'cash_transfer', 'current ↔ savings derives cash_transfer on the first leg');
select is((select transfer_kind::text from public.bank_transactions where id = pg_temp.h('txn_sav_a')),
          'cash_transfer', 'both legs carry the SAME verdict');
select is((select is_transfer from public.bank_transactions where id = pg_temp.h('txn_cur1_a')),
          true, 'the first leg is flagged as a transfer');
select is((select is_transfer from public.bank_transactions where id = pg_temp.h('txn_sav_a')),
          true, 'the second leg is flagged as a transfer');
select is((select transfer_pair_id from public.bank_transactions where id = pg_temp.h('txn_cur1_a')),
          pg_temp.h('txn_sav_a'), 'the first leg points at the second');
select is((select transfer_pair_id from public.bank_transactions where id = pg_temp.h('txn_sav_a')),
          pg_temp.h('txn_cur1_a'), 'the second leg points back at the first');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select lives_ok(
  format('select api.mark_transfer(%L, %L)', pg_temp.h('txn_cur2_a'), pg_temp.h('txn_card_a')),
  'api.mark_transfer pairs a current-account leg with a credit-card leg');
call pg_temp.act_as_postgres();

select is((select transfer_kind::text from public.bank_transactions where id = pg_temp.h('txn_cur2_a')),
          'card_repayment', 'current ↔ credit_card derives card_repayment, NOT cash_transfer (ADR-028)');
select is((select transfer_kind::text from public.bank_transactions where id = pg_temp.h('txn_card_a')),
          'card_repayment', 'both legs of the card repayment carry the same verdict');

-- The categorisation history records the derived verdict for both legs (ADR-034).
select is((select count(*)::int from public.category_history
            where organization_id = 'f7a00000-0000-0000-0000-00000000000a'
              and bank_transaction_id in (pg_temp.h('txn_cur2_a'), pg_temp.h('txn_card_a'))
              and transfer_kind = 'card_repayment' and valid_to is null),
          2, 'both legs get an open category_history row carrying the derived kind');

-- Unmarking returns the row to ordinary cash.
call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select lives_ok(
  format('select api.mark_transfer(%L, null)', pg_temp.h('txn_cur1_a')),
  'api.mark_transfer with a null pair unmarks the transfer');
call pg_temp.act_as_postgres();
select is((select transfer_kind::text from public.bank_transactions where id = pg_temp.h('txn_cur1_a')),
          'none', 'unmarking resets transfer_kind to none');
select is((select is_transfer from public.bank_transactions where id = pg_temp.h('txn_cur1_a')),
          false, 'unmarking clears is_transfer, so the row re-enters the cash metrics');

-- ===========================================================================
-- 4. api.set_alert_status — a client may acknowledge and nothing else (RBAC_MATRIX §2.1)
-- ===========================================================================
call pg_temp.act_as('f7000000-0000-0000-0000-000000000002');
select lives_ok(
  format('select api.set_alert_status(%L, ''acknowledged''::public.alert_status_enum)', pg_temp.h('alert_a')),
  'a client CAN acknowledge an alert');
select throws_ok(
  format('select api.set_alert_status(%L, ''resolved''::public.alert_status_enum)', pg_temp.h('alert_a')),
  '42501', null, 'a client cannot RESOLVE an alert');
select throws_ok(
  format('select api.set_alert_status(%L, ''dismissed''::public.alert_status_enum)', pg_temp.h('alert_a')),
  '42501', null, 'a client cannot DISMISS an alert');
call pg_temp.act_as_postgres();

select is((select status::text from public.alerts where id = pg_temp.h('alert_a')),
          'acknowledged', 'the acknowledgement actually landed');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select lives_ok(
  format('select api.set_alert_status(%L, ''resolved''::public.alert_status_enum)', pg_temp.h('alert_a')),
  'an owner CAN resolve an alert');
call pg_temp.act_as_postgres();

-- ===========================================================================
-- 5. api.create_action and the grounding gate (ADR-032.5)
-- ===========================================================================
insert into public.ai_conversations (id, organization_id, user_id)
values ('f7c00000-0000-0000-0000-00000000000c','f7a00000-0000-0000-0000-00000000000a',
        'f7000000-0000-0000-0000-000000000001');
insert into public.ai_messages (id, organization_id, conversation_id, role, structured_response, grounding_status)
values
  ('f7d00000-0000-0000-0000-00000000000f','f7a00000-0000-0000-0000-00000000000a',
   'f7c00000-0000-0000-0000-00000000000c','assistant','{"a":1}'::jsonb,'failed'),
  ('f7d00000-0000-0000-0000-00000000000e','f7a00000-0000-0000-0000-00000000000a',
   'f7c00000-0000-0000-0000-00000000000c','assistant','{"a":1}'::jsonb,'degraded'),
  ('f7d00000-0000-0000-0000-000000000010','f7a00000-0000-0000-0000-00000000000a',
   'f7c00000-0000-0000-0000-00000000000c','assistant','{"a":1}'::jsonb,'passed');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select api.create_action('f7a00000-0000-0000-0000-00000000000a',
       '{"title":"from a failed answer"}'::jsonb,
       '{"type":"ai","id":"f7d00000-0000-0000-0000-00000000000f"}'::jsonb) $$,
  '22023', null, 'api.create_action refuses an AI source whose grounding FAILED (ADR-032.5)');
select throws_ok(
  $$ select api.create_action('f7a00000-0000-0000-0000-00000000000a',
       '{"title":"from a degraded answer"}'::jsonb,
       '{"type":"ai","id":"f7d00000-0000-0000-0000-00000000000e"}'::jsonb) $$,
  '22023', null, 'api.create_action refuses an AI source whose grounding was DEGRADED');
select throws_ok(
  $$ select api.create_action('f7a00000-0000-0000-0000-00000000000a',
       '{"title":"from a message that does not exist"}'::jsonb,
       '{"type":"ai","id":"00000000-0000-0000-0000-0000000000ff"}'::jsonb) $$,
  'P0002', null, 'api.create_action raises NOT_FOUND for an AI source that does not exist');
select lives_ok(
  $$ select api.create_action('f7a00000-0000-0000-0000-00000000000a',
       '{"title":"from a grounded answer"}'::jsonb,
       '{"type":"ai","id":"f7d00000-0000-0000-0000-000000000010"}'::jsonb) $$,
  'api.create_action accepts an AI source whose grounding PASSED');
select throws_ok(
  $$ select api.create_action('f7a00000-0000-0000-0000-00000000000a', '{"title":""}'::jsonb) $$,
  '22023', null, 'api.create_action requires a title');
call pg_temp.act_as_postgres();

call pg_temp.act_as('f7000000-0000-0000-0000-000000000002');
select throws_ok(
  $$ select api.create_action('f7a00000-0000-0000-0000-00000000000a', '{"title":"nope"}'::jsonb) $$,
  '42501', null, 'a client cannot create an action (actions.create required)');
call pg_temp.act_as_postgres();

-- ===========================================================================
-- 6. api.supersede_record — the column AND the event, together (ADR-046, ADR-047.1)
-- ===========================================================================
call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select lives_ok(
  format('select api.supersede_record(''ledger_entries''::public.financial_record_table_enum, %L, %L)',
         pg_temp.h('led1_a'), pg_temp.h('led2_a')),
  'api.supersede_record points a ledger entry at its replacement');
call pg_temp.act_as_postgres();

select is((select superseded_by from public.ledger_entries where id = pg_temp.h('led1_a')),
          pg_temp.h('led2_a'), 'api.supersede_record wrote the superseded_by column');
select isnt((select superseded_at from public.ledger_entries where id = pg_temp.h('led1_a')),
            null, 'the superseded_at_set trigger stamped the instant');
select is(
  (select count(*)::int from public.record_status_events e
    where e.organization_id = 'f7a00000-0000-0000-0000-00000000000a'
      and e.record_table = 'ledger_entries' and e.record_id = pg_temp.h('led1_a')
      and e.event = 'superseded' and e.related_record_id = pg_temp.h('led2_a')),
  1, 'api.supersede_record ALSO appended a record_status_events row (the history, ADR-047.1)');

call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select throws_ok(
  format('select api.supersede_record(''ledger_entries''::public.financial_record_table_enum, %L, %L)',
         pg_temp.h('led1_a'), pg_temp.h('led2_a')),
  '40001', null, 'api.supersede_record raises CONFLICT on an ALREADY superseded row');
call pg_temp.act_as_postgres();

-- ===========================================================================
-- 7. Cross-tenant: NOT_FOUND, never PERMISSION_DENIED (SECURITY_MODEL.md §14)
-- ===========================================================================
-- A 42501 would be a confirmation that the row exists, which is exactly what the surface must not
-- give away. Each of these is called by the owner of A against an id belonging to B.
call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');

select throws_ok(
  format('select api.remap_account(%L, ''payroll''::public.standard_category_enum)', pg_temp.h('acct_b')),
  'P0002', null, 'api.remap_account raises NOT_FOUND for another organization''s account');
select throws_ok(
  format('select api.set_alert_status(%L, ''acknowledged''::public.alert_status_enum)', pg_temp.h('alert_b')),
  'P0002', null, 'api.set_alert_status raises NOT_FOUND for another organization''s alert');
select throws_ok(
  format('select api.supersede_record(''ledger_entries''::public.financial_record_table_enum, %L, %L)',
         pg_temp.h('led1_b'), pg_temp.h('led2_b')),
  'P0002', null, 'api.supersede_record raises NOT_FOUND for another organization''s record');
select throws_ok(
  format('select api.delete_document(%L)', pg_temp.h('doc_b')),
  'P0002', null, 'api.delete_document raises NOT_FOUND for another organization''s document');

-- A replacement in another organization is equally NOT_FOUND, not a validation error that would
-- confirm the id resolves somewhere.
select throws_ok(
  format('select api.supersede_record(''ledger_entries''::public.financial_record_table_enum, %L, %L)',
         pg_temp.h('led2_a'), pg_temp.h('led2_b')),
  'P0002', null, 'a replacement belonging to another organization is NOT_FOUND too');

-- The same shape for an id that resolves to nothing at all: indistinguishable from a foreign one.
select throws_ok(
  $$ select api.remap_account('00000000-0000-0000-0000-0000000000ff',
                              'payroll'::public.standard_category_enum) $$,
  'P0002', null, 'a wholly unknown account id gives the SAME error as a foreign one');
call pg_temp.act_as_postgres();

-- ===========================================================================
-- 8. api_server.* is service-role only (ADR-043)
-- ===========================================================================
-- Two ways to present a user: as the `authenticated` database role (no EXECUTE at all), and as a
-- service-role connection carrying a USER's JWT, which is the case the in-function guard exists for.
call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select api_server.record_access_event('f7000000-0000-0000-0000-000000000001',
       'f7a00000-0000-0000-0000-00000000000a', 'document.downloaded'::public.access_event_enum) $$,
  '42501', null, 'api_server.record_access_event is refused to a user (authenticated)');
select throws_ok(
  $$ select api_server.enqueue_job('f7000000-0000-0000-0000-000000000001',
       'f7a00000-0000-0000-0000-00000000000a', 'calculation.run'::public.job_type_enum, '{}'::jsonb) $$,
  '42501', null, 'api_server.enqueue_job is refused to a user (authenticated)');
select throws_ok(
  $$ select api_server.register_document('f7000000-0000-0000-0000-000000000001',
       'f7a00000-0000-0000-0000-00000000000a', '{}'::jsonb) $$,
  '42501', null, 'api_server.register_document is refused to a user (authenticated)');
select throws_ok(
  $$ select api_server.finalize_upload('f7000000-0000-0000-0000-000000000001',
       'f7a00000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001',
       1, '{}'::jsonb, 'ready'::public.document_status_enum) $$,
  '42501', null, 'api_server.finalize_upload is refused to a user (authenticated)');
call pg_temp.act_as_postgres();

-- The in-function guard: EXECUTE is held, but the JWT says `authenticated`, so the call is refused.
set local role service_role;
select set_config('request.jwt.claims',
  '{"sub":"f7000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1"}', true);
select throws_ok(
  $$ select api_server.record_access_event('f7000000-0000-0000-0000-000000000001',
       'f7a00000-0000-0000-0000-00000000000a', 'document.downloaded'::public.access_event_enum) $$,
  '42501', null, 'api_server.record_access_event refuses a USER JWT on a service-role connection');
select throws_ok(
  $$ select api_server.enqueue_job('f7000000-0000-0000-0000-000000000001',
       'f7a00000-0000-0000-0000-00000000000a', 'calculation.run'::public.job_type_enum, '{}'::jsonb) $$,
  '42501', null, 'api_server.enqueue_job refuses a USER JWT on a service-role connection');
select throws_ok(
  $$ select api_server.register_document('f7000000-0000-0000-0000-000000000001',
       'f7a00000-0000-0000-0000-00000000000a', '{}'::jsonb) $$,
  '42501', null, 'api_server.register_document refuses a USER JWT on a service-role connection');
select throws_ok(
  $$ select api_server.finalize_upload('f7000000-0000-0000-0000-000000000001',
       'f7a00000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001',
       1, '{}'::jsonb, 'ready'::public.document_status_enum) $$,
  '42501', null, 'api_server.finalize_upload refuses a USER JWT on a service-role connection');
reset role;
select set_config('request.jwt.claims', '', true);

-- The whole schema, not only the four asserted above.
select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_server'
      and p.prosrc not like '%api_server is callable only by the server%'),
  0, 'EVERY api_server.* function carries the service-role guard in its body (ADR-043)');

-- ---------------------------------------------------------------------------
-- 9. ADR-066: a metric bundle is built by the server from the figure's own tree. The api.* twin that
--    trusted its caller (PRODUCTION_AUDIT.md C2) is gone, not revoked.
-- ---------------------------------------------------------------------------
select hasnt_function('api', 'build_metric_bundle', array['uuid', 'jsonb'],
  'api.build_metric_bundle no longer exists: a user token has no bundle-writing surface (ADR-066)');
call pg_temp.act_as('f7000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select api_server.build_metric_bundle_as('f7000000-0000-0000-0000-000000000001',
                                             '00000000-0000-0000-0000-000000000000', '[]'::jsonb) $$,
  '42501', null, 'api_server.build_metric_bundle_as is refused to a user (authenticated)');
call pg_temp.act_as_postgres();

select * from finish();
rollback;
