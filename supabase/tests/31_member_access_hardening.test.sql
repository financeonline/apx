-- APX — pgTAP · the ADR-172 hardening (independent security review, 2026-10-14).
-- Migrations 20261018000032 – 20261018000035; RBAC_MATRIX.md rev 1.4 §3, §7, §8; SECURITY_MODEL.md §6.4.
--
-- Each block reproduces a finding of the review (its probe scripts p2 … p11) and asserts it CLOSED.
-- Every "cannot" is asserted against a row that exists, so each refusal is a refusal, not an empty
-- table:
--
--   A. HIGH 2 — never beyond one's own rights, on every path that sets a person's access: no change
--      of one's own role; an owner's switch survives a role change and is locked against admins; a
--      role change and an invitation switch off what the actor lacks; an owner withholds nothing.
--   B. HIGH 1 — a detail permission switched off hides the detail everywhere it is stored: the audit
--      trail's row copies, the raw bank text and import rows outside review, contact details without
--      `customers.view`.
--   C. MEDIUM 3 — the overview carries no named detail: payload columns not selectable; the payload
--      views redact for an overview reader, are whole for a detail reader, and admit exactly the rows
--      the tables' policies admit; per-customer pointers hidden.
--   D. MEDIUM 4 — a suspended company shows each person what they saw before, no more.
--   E. LOW 5, LOW 6 — server-asserted writes check the actor as narrowly as the reads.
--   F. Action owners named at creation obey `api.assign_action`'s rule (20261018000035).

begin;
create extension if not exists pgtap;

select plan(105);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select ('e4000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'mh-' || n || '@hardening.motion', 'x', now(), now(), now()
  from generate_series(1, 22) n;

insert into public.organizations (id, slug, name, features) values
  ('e4a00000-0000-0000-0000-00000000000a', 'mh-x', 'MH Org X', '{"funding_readiness": true}'),
  ('e4b00000-0000-0000-0000-00000000000b', 'mh-y', 'MH Org Y', '{}'),
  ('e4500000-0000-0000-0000-000000000005', 'mh-s', 'MH Suspended', '{}');

-- X: 01 owner, 02 admin1 (the owner narrows), 03 accountant, 04 client, 05 3rd party,
--    06 admin2 (holds everything), 10 client2, 11 3rd party2, 12 3rd party3, 20 client3.
-- Y: 07 owner.   S: 18 owner, 17 client, 16 3rd party, 19 3rd party with alerts.manage on.
-- 13, 14 invitees; 15 a stranger; 09 an assigned Financial Analyst of X.
insert into public.organization_memberships (organization_id, user_id, role, status) values
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000002', 'admin', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000003', 'accountant', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000004', 'client', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000005', 'third_party', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000006', 'admin', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000010', 'client', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000011', 'third_party', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000012', 'third_party', 'active'),
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000020', 'client', 'active'),
  ('e4b00000-0000-0000-0000-00000000000b', 'e4000000-0000-0000-0000-000000000007', 'owner', 'active'),
  ('e4500000-0000-0000-0000-000000000005', 'e4000000-0000-0000-0000-000000000018', 'owner', 'active'),
  ('e4500000-0000-0000-0000-000000000005', 'e4000000-0000-0000-0000-000000000017', 'client', 'active'),
  ('e4500000-0000-0000-0000-000000000005', 'e4000000-0000-0000-0000-000000000016', 'third_party', 'active'),
  ('e4500000-0000-0000-0000-000000000005', 'e4000000-0000-0000-0000-000000000019', 'third_party', 'active');
insert into public.platform_users (user_id, platform_role) values
  ('e4000000-0000-0000-0000-000000000009', 'employee');
insert into public.organization_assignments (organization_id, employee_user_id, status, ends_at) values
  ('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000009', 'active', now() + interval '6 months');

-- One of everything each finding needs, per organisation, holding NAMED detail where the review
-- found it: a closing-cash snapshot whose components name a bank account, a per-customer figure, a
-- health breakdown whose condition names a supplier, an alert sentence naming a customer.
create procedure pg_temp.seed_org(p_org uuid, p_tag text)
language plpgsql as $$
declare
  v_period uuid; v_acct uuid; v_cp uuid; v_bank uuid; v_run uuid; v_doc uuid; v_inv uuid;
  v_batch uuid; v_health uuid; v_snap uuid; v_cp_snap uuid; v_txn uuid; v_alert uuid;
  v_hist uuid; v_daily uuid; v_custom uuid;
begin
  insert into public.accounts (organization_id, name, normalized_name, account_type, standard_category)
  values (p_org, p_tag || ' Sales', p_tag || ' sales', 'income', 'revenue') returning id into v_acct;
  insert into public.counterparties (organization_id, name, normalized_name, email, notes)
  values (p_org, p_tag || ' Customer', p_tag || ' customer', 'buyer@customer.test', 'pays late') returning id into v_cp;
  insert into public.bank_accounts (organization_id, name, bank_name, account_type)
  values (p_org, p_tag || ' Current', 'PGT Bank', 'current') returning id into v_bank;
  insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount)
  values (p_org, '2026-03-10', v_acct, 'debit', 100) returning period_id into v_period;
  insert into public.invoices (organization_id, invoice_type, counterparty_id, invoice_number, issue_date, total_amount)
  values (p_org, 'sales', v_cp, p_tag || '-INV-1', '2026-03-12', 250) returning id into v_inv;
  insert into public.bank_transactions (organization_id, bank_account_id, transaction_date, amount, description_raw)
  values (p_org, v_bank, '2026-03-14', -30, 'FPS ' || p_tag || ' SUPPLIER 12345678') returning id into v_txn;
  insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
  values (p_org, 'recalc_manual', '1.0.0', v_period, v_period, '2026-03-31', 'succeeded') returning id into v_run;

  -- The headline figure, current, with named detail in its payload.
  insert into public.metric_snapshots
    (organization_id, calculation_run_id, period_id, metric_key, unit, basis, assurance_level, value,
     components, evidence_query, data_quality)
  values (p_org, v_run, v_period, 'closing_cash', 'money', 'bank', 'verified', -30,
          jsonb_build_object('opening_cash', '0.00', 'pct_change', '0.0512', 'as_of', '2026-03-31',
                             'source', 'bank', 'comparison_period_id', v_period,
                             'per_account', jsonb_build_array(jsonb_build_object('account_id', v_bank, 'value', '-30.00')),
                             'missing_bank_accounts', jsonb_build_array(jsonb_build_object('account_id', v_bank, 'name', p_tag || ' Savings 4471')),
                             'top_counterparty_id', v_cp),
          jsonb_build_object('kind', 'leaf', 'descriptor', jsonb_build_object('table', 'bank_transactions', 'filters', jsonb_build_object('bank_account_ids', jsonb_build_array(v_bank)))),
          '{"completeness": 1, "proxy": false, "warnings": [], "missing": []}')
  returning id into v_snap;
  insert into public.metric_current (organization_id, period_id, metric_key, snapshot_id, calculation_run_id)
  values (p_org, v_period, 'closing_cash', v_snap, v_run);
  -- An older, superseded run of the same figure: history only `financials.view` reads.
  insert into public.metric_snapshots
    (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id, unit, basis, assurance_level, value)
  values (p_org, v_run, v_period, 'closing_cash', 'bank_account', v_bank, 'money', 'bank', 'verified', -30)
  returning id into v_hist;
  -- A per-customer figure, current.
  insert into public.metric_snapshots
    (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id, unit, basis, assurance_level, value)
  values (p_org, v_run, v_period, 'customer_revenue', 'counterparty', v_cp, 'money', 'ledger', 'verified', 250)
  returning id into v_cp_snap;
  insert into public.metric_current (organization_id, period_id, metric_key, dimension_type, dimension_id, snapshot_id, calculation_run_id)
  values (p_org, v_period, 'customer_revenue', 'counterparty', v_cp, v_cp_snap, v_run);

  insert into public.health_scores
    (organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version, breakdown)
  values (p_org, v_run, v_period, 70, 5, 5, 'v1',
          jsonb_build_array(jsonb_build_object(
            'key', 'banking', 'score', 70, 'weight_config', 20, 'weight_applied', 20, 'included', true,
            'exclusion_reason', null, 'capped', false, 'cap_reason', null,
            'positives', '["The bank balance has risen for three months"]'::jsonb, 'negatives', '[]'::jsonb,
            'metrics', jsonb_build_array(jsonb_build_object('metric_key', 'closing_cash', 'value', '-30.00', 'snapshot_id', v_snap)),
            'rules', '[{"rule": "B1", "result": "rising", "points": 10, "value": "3", "skipped_reason": null}]'::jsonb,
            'conditions', jsonb_build_array(jsonb_build_object('rule_key', 'recurring.amount_changed',
                            'subject_id', v_cp, 'subject_key', 'fps credit ' || lower(p_tag) || ' supplier inv',
                            'snapshot_ids', jsonb_build_array(v_snap), 'record_ids', jsonb_build_array(v_txn))),
            'positives_structured', jsonb_build_array(jsonb_build_object('template_id', 'bank_balance_rising',
                            'text', 'The bank balance has risen for three months', 'values', '{}'::jsonb,
                            'snapshot_ids', jsonb_build_array(v_snap))),
            'negatives_structured', '[]'::jsonb,
            'data_quality', '{"completeness": 1, "warnings": []}'::jsonb,
            'secret_future_key', 'must not be copied')))
  returning id into v_health;
  insert into public.health_current (organization_id, period_id, health_score_id) values (p_org, v_period, v_health);

  insert into public.alerts (organization_id, rule_key, rule_version, severity, period_id, title, explanation,
                             dedupe_key, key_kind, calculation_run_id)
  values (p_org, 'pgt.mh.rule', '1', 'high', v_period, 'title', p_tag || ' Customer is overdue',
          p_tag || '-dedupe', 'state', v_run) returning id into v_alert;

  insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status)
  values (p_org, p_org::text || '/doc/' || p_tag || '.csv', p_tag || '.csv', 'text/csv', 10,
          extensions.digest(p_tag, 'sha256'), 'ready') returning id into v_doc;
  insert into public.import_batches (organization_id, source_document_id, import_type, target_table, bank_account_id, period_start, period_end, status)
  values (p_org, v_doc, 'bank_statement', 'bank_transactions', v_bank, '2026-03-01', '2026-03-31', 'awaiting_review')
  returning id into v_batch;
  -- A line under review that duplicates the committed bank line: the comparison a reviewer makes.
  insert into public.import_rows (organization_id, batch_id, row_number, raw_data, mapped_data,
                                  duplicate_of_table, duplicate_of_id, status)
  values (p_org, v_batch, 1, '{"Description": "FPS SUPPLIER 12345678"}', '{"description": "FPS SUPPLIER 12345678"}',
          'bank_transactions', v_txn, 'duplicate');

  -- Reports: the daily brief (internal), Funding Readiness (outward), a custom AI report (the
  -- owner's own), and a file for each, plus the Monthly Management PDF (no report row).
  insert into public.reports (organization_id, report_kind, window_start, window_end, origin, content, content_version)
  values (p_org, 'daily_brief', '2026-03-31', '2026-03-31', 'scheduled', '{}'::jsonb, 'brief.v1') returning id into v_daily;
  insert into public.reports (organization_id, report_kind, window_start, window_end, period_id, origin, requested_by, content, content_version)
  values (p_org, 'custom_ai', '2026-03-01', '2026-03-31', v_period, 'requested',
          (select m.user_id from public.organization_memberships m where m.organization_id = p_org and m.role = 'owner' limit 1),
          '{}'::jsonb, 'custom.v1') returning id into v_custom;
  insert into public.report_files (organization_id, report_kind, report_id, storage_path)
  values (p_org, 'daily_brief', v_daily, p_org::text || '/daily.pdf'),
         (p_org, 'custom_ai', v_custom, p_org::text || '/custom.pdf');
  insert into public.report_files (organization_id, report_kind, period_id, storage_path)
  values (p_org, 'monthly_management', v_period, p_org::text || '/monthly.pdf');

  insert into public.ai_conversations (organization_id, user_id)
  values (p_org, (select m.user_id from public.organization_memberships m where m.organization_id = p_org and m.role = 'owner' limit 1));
  insert into public.ai_messages (organization_id, conversation_id, role, structured_response, grounding_status)
  select p_org, c.id, 'assistant', '{}'::jsonb, 'passed' from public.ai_conversations c where c.organization_id = p_org;
end $$;
call pg_temp.seed_org('e4a00000-0000-0000-0000-00000000000a', 'MHX');
call pg_temp.seed_org('e4b00000-0000-0000-0000-00000000000b', 'MHY');
call pg_temp.seed_org('e4500000-0000-0000-0000-000000000005', 'MHS');

-- ---------------------------------------------------------------------------
-- Impersonation helpers (the house pattern; aal2 so the Financial Analyst resolves).
-- ---------------------------------------------------------------------------
create procedure pg_temp.act_as(p_user uuid)
language plpgsql as $$
declare v_email text;
begin
  perform set_config('role', 'postgres', true);
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'email', v_email, 'aal', 'aal2',
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
create procedure pg_temp.act_as_server()
language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- One value from a query run as a user (NULL on no row).
create function pg_temp.val_as(p_user uuid, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  call pg_temp.act_as(p_user);
  execute p_sql into v;
  call pg_temp.act_as_postgres();
  return v;
end $$;
-- The SQLSTATE a statement raised as a user, or 'ok'.
create function pg_temp.try_as(p_user uuid, p_sql text) returns text
language plpgsql as $$
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
-- The same, as the service role (api_server.*).
create function pg_temp.try_server(p_sql text) returns text
language plpgsql as $$
declare v text := 'ok';
begin
  call pg_temp.act_as_server();
  begin
    execute p_sql;
  exception when others then
    v := sqlstate;
  end;
  call pg_temp.act_as_postgres();
  return v;
end $$;
create function pg_temp.has_perm(p_user uuid, p_org uuid, p_perm text) returns boolean
language plpgsql as $$
declare v boolean;
begin
  call pg_temp.act_as(p_user);
  v := app.has_permission(p_org, p_perm);
  call pg_temp.act_as_postgres();
  return v;
end $$;
create function pg_temp.rows_of(p_user uuid, p_table text, p_org uuid) returns integer
language plpgsql as $$
begin
  return pg_temp.val_as(p_user, format('select count(*) from public.%I where organization_id = %L', p_table, p_org))::integer;
end $$;
-- Invite as a user; the raw token (returned once, never stored).
create function pg_temp.invite_as(p_user uuid, p_org uuid, p_email text, p_role text) returns text
language plpgsql as $$
declare v text;
begin
  call pg_temp.act_as(p_user);
  select t.token into v from api.invite_member_with_token(p_org, p_email, p_role::public.membership_role_enum) t;
  call pg_temp.act_as_postgres();
  return v;
end $$;
-- The rows a person reads in two relations that should agree, as |A Δ B|.
create function pg_temp.disagreement(p_user uuid, p_a text, p_b text) returns integer
language plpgsql as $$
declare v integer;
begin
  call pg_temp.act_as(p_user);
  execute format('select count(*) from ((select id from public.%I except select id from public.%I)
                                         union all (select id from public.%I except select id from public.%I)) d',
                 p_a, p_b, p_b, p_a) into v;
  call pg_temp.act_as_postgres();
  return v;
end $$;


-- The owner narrows admin1: no ledger, no audit trail detail beyond the log (audit.view kept).
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000002', 'financials.view', false)$$),
          'ok', 'fixture: the owner switches admin1''s financials.view off');

-- ===========================================================================
-- A. HIGH 2 — never beyond one's own rights
-- ===========================================================================
-- A (probe p2 "A"): no change of one's own role.
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000002', $$select api.change_member_role('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000002', 'accountant')$$),
          '42501', 'an admin cannot change their own role (a self-demotion used to clear the owner''s switches)');
select ok(not pg_temp.has_perm('e4000000-0000-0000-0000-000000000002', 'e4a00000-0000-0000-0000-00000000000a', 'financials.view'), '… and the owner''s switch-off stands');
select is(pg_temp.rows_of('e4000000-0000-0000-0000-000000000002', 'ledger_entries', 'e4a00000-0000-0000-0000-00000000000a'), 0, '… so the ledger stays closed to them');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.change_member_role('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000001', 'admin')$$),
          '42501', 'nor may an owner change their own role (stepping down is the ownership transfer)');

-- The owner's switch is the owner's.
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000004', 'financials.view', false)$$),
          'ok', 'fixture: the owner switches the client''s financials.view off');
select is((select set_by_owner from public.member_permission_overrides
            where user_id = 'e4000000-0000-0000-0000-000000000004' and permission = 'financials.view'),
          true, 'a switch records that an owner set it, at the time it was set');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000006', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000004', 'financials.view', null)$$),
          '42501', 'an admin who HOLDS the permission still cannot reset an owner''s switch');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000006', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000004', 'financials.view', true)$$),
          '42501', '… nor switch it the other way');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000006', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000004', 'ai.use', false)$$),
          'ok', '… while a switch nobody owns is still theirs to set');
select is((select set_by_owner from public.member_permission_overrides
            where user_id = 'e4000000-0000-0000-0000-000000000004' and permission = 'ai.use'),
          false, '… and records that an admin set it');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000006', $$select (select (o->>'set_by_owner') from api.org_member_permissions('e4a00000-0000-0000-0000-00000000000a') m, jsonb_array_elements(m.overrides) o
                                       where m.user_id = 'e4000000-0000-0000-0000-000000000004' and o->>'permission' = 'financials.view')$$),
          'true', 'the team page is told which switches an owner set');

-- B (probe p2 "B"): a role round trip by an admin who lacks the permission gives nothing back.
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000002', $$select api.change_member_role('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000004', 'accountant')$$),
          'ok', 'admin1 (financials.view off) moves the client to accountant');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000002', $$select api.change_member_role('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000004', 'client')$$),
          'ok', '… and back to client');
select ok(not pg_temp.has_perm('e4000000-0000-0000-0000-000000000004', 'e4a00000-0000-0000-0000-00000000000a', 'financials.view'), '… and the client still lacks financials.view');
select is(pg_temp.rows_of('e4000000-0000-0000-0000-000000000004', 'ledger_entries', 'e4a00000-0000-0000-0000-00000000000a'), 0, '… and reads no ledger row');
select is((select count(*)::int from public.member_permission_overrides
            where user_id = 'e4000000-0000-0000-0000-000000000004' and permission = 'financials.view' and set_by_owner),
          1, 'the owner''s switch was CARRIED through both role changes');
select is((select count(*)::int from public.member_permission_overrides
            where user_id = 'e4000000-0000-0000-0000-000000000004' and permission = 'ai.use'),
          0, 'an admin''s switch was cleared by the role change, as ADR-172 always did');

-- B2 (probe p2 "B2"): the new role's defaults beyond the actor are withheld.
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000002', $$select api.change_member_role('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000012', 'accountant')$$),
          'ok', 'admin1 (financials.view off) makes a 3rd party an accountant');
select ok(not pg_temp.has_perm('e4000000-0000-0000-0000-000000000012', 'e4a00000-0000-0000-0000-00000000000a', 'financials.view'),
          '… who does NOT get financials.view, which admin1 lacks');
select is(pg_temp.rows_of('e4000000-0000-0000-0000-000000000012', 'ledger_entries', 'e4a00000-0000-0000-0000-00000000000a'), 0, '… and reads no ledger row');
select ok(pg_temp.has_perm('e4000000-0000-0000-0000-000000000012', 'e4a00000-0000-0000-0000-00000000000a', 'documents.view'),
          '… but does get what admin1 holds (documents.view)');
select is((select ceiling_withhold::text || ' ' || granted::text || ' ' || (set_by = 'e4000000-0000-0000-0000-000000000002')::text
             from public.member_permission_overrides
            where user_id = 'e4000000-0000-0000-0000-000000000012' and permission = 'financials.view'),
          'true false true', '… stored as a ceiling withhold set by admin1');
select ok((select (metadata -> 'withheld') ? 'financials.view' from public.audit_events
            where organization_id = 'e4a00000-0000-0000-0000-00000000000a' and action = 'member.permissions_reset'
              and target_id = 'e4000000-0000-0000-0000-000000000012'),
          'audited member.permissions_reset, naming what was withheld');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000006', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000012', 'financials.view', true)$$),
          'ok', 'an admin who holds it may switch a withheld permission on — within their rights');

-- An owner withholds nothing; promotion to owner drops every switch.
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.change_member_role('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000011', 'accountant')$$),
          'ok', 'the owner makes another 3rd party an accountant');
select is((select count(*)::int from public.member_permission_overrides where user_id = 'e4000000-0000-0000-0000-000000000011'),
          0, '… withholding nothing (an owner holds everything)');
select ok(pg_temp.has_perm('e4000000-0000-0000-0000-000000000011', 'e4a00000-0000-0000-0000-00000000000a', 'financials.view'), '… so they hold the accountant''s defaults');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000020', 'ai.use', false)$$),
          'ok', 'fixture: the owner switches client3''s ai.use off');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.change_member_role('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000020', 'owner')$$),
          'ok', 'the owner makes client3 an owner');
select is((select count(*)::int from public.member_permission_overrides where user_id = 'e4000000-0000-0000-0000-000000000020'),
          0, '… which drops their switches (an owner takes none; a kept one would return on a demotion)');

-- C (probe p2 "C"), revised by ADR-174: only the company's owner adds anyone. An admin invites
-- nobody and creates no login, whatever the role; the owner holds everything, so an owner's
-- invitation withholds nothing. The raw token is kept for the acceptance below (returned once).
create temp table tokens (who text primary key, token text) on commit drop;
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000002', $$select api.invite_member_with_token('e4a00000-0000-0000-0000-00000000000a', 'mh-13@hardening.motion', 'admin')$$),
          '42501', 'admin1 cannot invite an admin (ADR-174)');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000006', $$select api.invite_member_with_token('e4a00000-0000-0000-0000-00000000000a', 'mh-13@hardening.motion', 'accountant')$$),
          '42501', 'admin2 cannot invite an accountant');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000006', $$select api.invite_member_with_token('e4a00000-0000-0000-0000-00000000000a', 'mh-13@hardening.motion', 'third_party')$$),
          '42501', '… nor a 3rd party');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000006', $$select api.begin_member_login('e4a00000-0000-0000-0000-00000000000a', 'mh-13@hardening.motion', 'client', '{}', null)$$),
          '42501', '… nor start a login for a team member');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000002', $$select api.begin_member_login('e4a00000-0000-0000-0000-00000000000a', 'mh-13@hardening.motion', 'accountant', '{}', null)$$),
          '42501', 'admin1 cannot start a login for an accountant');
select is((select count(*)::int from public.invitations where email = 'mh-13@hardening.motion')
          + (select count(*)::int from public.member_login_claims where email = 'mh-13@hardening.motion'),
          0, '… and nothing was recorded for any of those');
insert into tokens values
  ('14', pg_temp.invite_as('e4000000-0000-0000-0000-000000000001', 'e4a00000-0000-0000-0000-00000000000a', 'mh-14@hardening.motion', 'accountant'));
select ok((select token from tokens where who = '14') is not null, 'the owner invites an accountant');
select is((select withheld_permissions from public.invitations where email = 'mh-14@hardening.motion'),
          '{}'::text[], '… withholding nothing');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000014', format('select api.accept_invitation(%L)', (select token from tokens where who = '14'))),
          'ok', 'the invited accountant accepts');
select ok(pg_temp.has_perm('e4000000-0000-0000-0000-000000000014', 'e4a00000-0000-0000-0000-00000000000a', 'documents.view'),
          '… and holds the accountant''s documents.view');
select ok(pg_temp.has_perm('e4000000-0000-0000-0000-000000000014', 'e4a00000-0000-0000-0000-00000000000a', 'financials.view'), '… and financials.view');

-- ===========================================================================
-- B. HIGH 1 — the detail, wherever it is stored
-- ===========================================================================
-- 1a (probe p6): the audit trail names the change, never carries the row.
select ok(not has_column_privilege('authenticated', 'public.audit_events', 'before', 'select')
          and not has_column_privilege('authenticated', 'public.audit_events', 'after', 'select')
          and not has_column_privilege('authenticated', 'public.audit_events', 'ip', 'select')
          and not has_column_privilege('authenticated', 'public.audit_events', 'user_agent', 'select'),
          'audit_events.before/after/ip/user_agent are not selectable by authenticated');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000002', $$select after from public.audit_events limit 1$$), '42501',
          'an admin with audit.view but the detail switched off cannot read a row copy (db.bank_transactions.insert …)');
select ok(pg_temp.rows_of('e4000000-0000-0000-0000-000000000002', 'audit_events', 'e4a00000-0000-0000-0000-00000000000a') > 0, '… still reads the log itself (who, what, which row, when)');
select ok(pg_temp.val_as('e4000000-0000-0000-0000-000000000002', $$select count(*) from api.org_audit_events('e4a00000-0000-0000-0000-00000000000a', 500, 0)$$)::int > 0,
          '… and the audit page''s function still serves it');
-- 1b (probe p7): raw text only in review, only to who reads the lines.
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000001', $$select count(*) from public.bank_transactions_raw where organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$)::int,
          1, 'the owner reads the raw text of the committed line a row UNDER REVIEW duplicates');
update public.import_batches set status = 'committed' where organization_id = 'e4a00000-0000-0000-0000-00000000000a';
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000001', $$select count(*) from public.bank_transactions_raw where organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$)::int,
          0, '… and none once nothing is in review: after commit only the masked text is read');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000001', $$select count(*) from public.import_rows_review where organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$)::int,
          0, 'nor the import rows'' file text once the batch is committed');
update public.import_batches set status = 'awaiting_review' where organization_id = 'e4a00000-0000-0000-0000-00000000000a';
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000001', $$select raw_data->>'Description' from public.import_rows_review where organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$),
          'FPS SUPPLIER 12345678', 'in review, the reviewer reads the file text through import_rows_review');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select raw_data from public.import_rows limit 1$$), '42501',
          'import_rows.raw_data is not selectable on the table, even by an owner');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select mapped_data from public.import_rows limit 1$$), '42501',
          '… nor mapped_data');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000005', 'imports.review', true)$$),
          'ok', 'fixture: the owner switches imports.review ON for the 3rd party');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select count(*) from public.bank_transactions_raw where organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$)::int,
          0, 'a 3rd party with imports.review alone reads no raw bank text (was every line of the company)');
select is(pg_temp.rows_of('e4000000-0000-0000-0000-000000000005', 'import_rows', 'e4a00000-0000-0000-0000-00000000000a'), 0, '… no import row');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select count(*) from public.import_rows_review where organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$)::int,
          0, '… and no file text');
-- 1c: contact details need customers.view as well as customers.edit.
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.set_member_permission('e4a00000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000005', 'customers.edit', true)$$),
          'ok', 'fixture: the owner switches customers.edit ON for the 3rd party');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select count(*) from public.counterparties_contact where organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$)::int,
          0, 'customers.edit without customers.view reads no e-mail address or note');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000006', $$select email from public.counterparties_contact where organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$),
          'buyer@customer.test', 'an admin holding both still does');

-- ===========================================================================
-- C. MEDIUM 3 — the overview carries no named detail
-- ===========================================================================
select ok(not has_column_privilege('authenticated', 'public.metric_snapshots', 'components', 'select')
          and not has_column_privilege('authenticated', 'public.metric_snapshots', 'evidence_query', 'select')
          and not has_column_privilege('authenticated', 'public.health_scores', 'breakdown', 'select'),
          'components, evidence_query and breakdown are not selectable on the tables');
select ok(has_column_privilege('authenticated', 'public.metric_snapshots', 'data_quality', 'select')
          and has_column_privilege('authenticated', 'public.metric_snapshots', 'value', 'select'),
          '… the figure and its data-quality codes still are');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000005', $$select components from public.metric_snapshots limit 1$$), '42501',
          'a 3rd party cannot select the components (probe p4)');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000005', $$select breakdown from public.health_scores limit 1$$), '42501',
          '… nor the breakdown');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select components::text from public.metric_snapshot_payloads
                                 where organization_id = 'e4a00000-0000-0000-0000-00000000000a' and metric_key = 'closing_cash' and is_current$$),
          '{"as_of": "2026-03-31", "pct_change": "0.0512", "opening_cash": "0.00"}',
          'the overview reader gets the headline''s components as numbers and dates only: no account, no name, no id');
select ok(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select evidence_query is null from public.metric_snapshot_payloads
                                 where organization_id = 'e4a00000-0000-0000-0000-00000000000a' and metric_key = 'closing_cash' and is_current$$)::boolean,
          '… and no evidence descriptor');
select ok(pg_temp.val_as('e4000000-0000-0000-0000-000000000001', $$select components ? 'missing_bank_accounts' and evidence_query is not null from public.metric_snapshot_payloads
                                    where organization_id = 'e4a00000-0000-0000-0000-00000000000a' and metric_key = 'closing_cash' and is_current$$)::boolean,
          'a financials.view reader gets the whole payload');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select count(*) from public.metric_snapshot_payloads
                                 where organization_id = 'e4a00000-0000-0000-0000-00000000000a' and dimension_type <> 'none'$$)::int,
          0, 'the overview reader gets no per-customer or per-account payload');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select string_agg(c->>'subject_key', ',') from public.health_score_breakdowns h,
                                   jsonb_array_elements(h.breakdown) d, jsonb_array_elements(d->'conditions') c
                                 where h.organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$),
          null, 'the overview reader''s breakdown names no supplier (probe p4)');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select (d->>'score') || ' ' || jsonb_array_length(d->'conditions') || ' ' || (d->'conditions'->0->>'rule_key') || ' ' || (d ? 'secret_future_key')::text
                                  from public.health_score_breakdowns h, jsonb_array_elements(h.breakdown) d
                                 where h.organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$),
          '70 1 recurring.amount_changed false', '… yet keeps the score, the condition''s rule, and copies no unknown key');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000001', $$select string_agg(c->>'subject_key', ',') from public.health_score_breakdowns h,
                                      jsonb_array_elements(h.breakdown) d, jsonb_array_elements(d->'conditions') c
                                    where h.organization_id = 'e4a00000-0000-0000-0000-00000000000a'$$),
          'fps credit mhx supplier inv', 'a financials.view reader gets the whole breakdown');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000005', $$select count(*) from public.metric_current where organization_id = 'e4a00000-0000-0000-0000-00000000000a' and dimension_type = 'counterparty'$$)::int,
          0, 'a 3rd party reads no per-customer pointer (counterparty ids, probe p4)');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000004', $$select count(*) from public.metric_current where organization_id = 'e4a00000-0000-0000-0000-00000000000a' and dimension_type = 'counterparty'$$)::int,
          1, 'a client (customers.view) still does');
-- The payload views admit exactly the rows the tables' policies admit.
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000001', 'metric_snapshots', 'metric_snapshot_payloads'), 0, 'payload rows = snapshot rows: owner');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000002', 'metric_snapshots', 'metric_snapshot_payloads'), 0, '… admin without financials.view');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000004', 'metric_snapshots', 'metric_snapshot_payloads'), 0, '… client without financials.view (customers.view)');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000005', 'metric_snapshots', 'metric_snapshot_payloads'), 0, '… 3rd party');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000009', 'metric_snapshots', 'metric_snapshot_payloads'), 0, '… Financial Analyst');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000015', 'metric_snapshots', 'metric_snapshot_payloads'), 0, '… stranger');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000005', 'health_scores', 'health_score_breakdowns'), 0, 'breakdown rows = score rows: 3rd party');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000001', 'health_scores', 'health_score_breakdowns'), 0, '… owner');
-- The redaction itself, on a payload with everything in it.
select is(app.redact_metric_components('{"a_id": "x", "b_ids": [1], "id": 1, "n": 2, "s": "12.50", "d": "2026-01-31", "name": "Acme Ltd", "code": "bank", "t": true, "z": null, "o": {"x": 1}, "l": [1]}'::jsonb),
          '{"d": "2026-01-31", "n": 2, "s": "12.50", "t": true, "z": null}'::jsonb,
          'redact_metric_components keeps numbers, dates, booleans and nulls; drops ids, names, codes, lists and objects');

-- ===========================================================================
-- D. MEDIUM 4 — a frozen company shows each person what they saw before
-- ===========================================================================
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000018', $$select api.set_member_permission('e4500000-0000-0000-0000-000000000005', 'e4000000-0000-0000-0000-000000000019', 'alerts.manage', true)$$),
          'ok', 'fixture: before the suspension, the owner switches alerts.manage ON for one 3rd party');
update public.organizations set status = 'suspended' where id = 'e4500000-0000-0000-0000-000000000005';
select is(pg_temp.rows_of('e4000000-0000-0000-0000-000000000016', 'alerts', 'e4500000-0000-0000-0000-000000000005'), 0,
          'suspended: a 3rd party reads no alert sentence (probe p10)');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000016', $$select count(*) from public.metric_snapshots where organization_id = 'e4500000-0000-0000-0000-000000000005' and dimension_type = 'counterparty'$$)::int,
          0, '… no per-customer figure');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000016', $$select count(*) from public.metric_current where organization_id = 'e4500000-0000-0000-0000-000000000005' and dimension_type = 'counterparty'$$)::int,
          0, '… no per-customer pointer');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000016', $$select count(*) from public.metric_snapshots where organization_id = 'e4500000-0000-0000-0000-000000000005' and dimension_type = 'none'$$)::int,
          1, '… but still the frozen headline');
select is(pg_temp.rows_of('e4000000-0000-0000-0000-000000000019', 'alerts', 'e4500000-0000-0000-0000-000000000005'), 1,
          'suspended: the 3rd party who had alerts.manage still reads the alerts (what they saw before)');
select is(pg_temp.rows_of('e4000000-0000-0000-0000-000000000017', 'alerts', 'e4500000-0000-0000-0000-000000000005'), 1,
          'suspended: a client (financials.view by role) keeps the frozen alerts');
select is(pg_temp.val_as('e4000000-0000-0000-0000-000000000018', $$select count(*) from public.metric_snapshots where organization_id = 'e4500000-0000-0000-0000-000000000005' and dimension_type = 'counterparty'$$)::int,
          1, 'suspended: the owner keeps the current per-customer figure');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000016', 'metric_snapshots', 'metric_snapshot_payloads'), 0,
          'payload rows = snapshot rows in a frozen company: 3rd party');
select is(pg_temp.disagreement('e4000000-0000-0000-0000-000000000018', 'metric_snapshots', 'metric_snapshot_payloads'), 0,
          '… owner');

-- ===========================================================================
-- E. LOW 5, LOW 6 — server-asserted writes
-- ===========================================================================
select is(pg_temp.try_server($$select api_server.finish_forecast('e4000000-0000-0000-0000-000000000005', 'e4a00000-0000-0000-0000-00000000000a',
            '{"method":"x","config_version":"v1","horizon_months":1,"periods_used":0,"breakdown":[],"unavailable":[]}'::jsonb, '[]'::jsonb)$$),
          'P0002', 'a forecast cannot be stored for a 3rd party (probe p8)');
select is(pg_temp.try_server($$select api_server.finish_forecast('e4000000-0000-0000-0000-000000000003', 'e4a00000-0000-0000-0000-00000000000a',
            '{"method":"x","config_version":"v1","horizon_months":1,"periods_used":0,"breakdown":[],"unavailable":[]}'::jsonb, '[]'::jsonb)$$),
          'ok', '… and can for an accountant (financials.view)');
select is(pg_temp.try_server($$select api_server.record_access_event('e4000000-0000-0000-0000-000000000005', 'e4a00000-0000-0000-0000-00000000000a', 'report.downloaded', 'report_files',
            (select id from public.report_files where storage_path = 'e4a00000-0000-0000-0000-00000000000a/daily.pdf'))$$),
          'P0002', 'a 3rd party (reports.view alone) cannot record a download of the daily brief');
select is(pg_temp.try_server($$select api_server.record_access_event('e4000000-0000-0000-0000-000000000004', 'e4a00000-0000-0000-0000-00000000000a', 'report.downloaded', 'report_files',
            (select id from public.report_files where storage_path = 'e4a00000-0000-0000-0000-00000000000a/custom.pdf'))$$),
          'P0002', 'a client cannot record a download of the owner''s custom AI report');
select is(pg_temp.try_server($$select api_server.record_access_event('e4000000-0000-0000-0000-000000000001', 'e4a00000-0000-0000-0000-00000000000a', 'report.downloaded', 'report_files',
            (select id from public.report_files where storage_path = 'e4a00000-0000-0000-0000-00000000000a/custom.pdf'))$$),
          'ok', '… its author can');
select is(pg_temp.try_server($$select api_server.record_access_event('e4000000-0000-0000-0000-000000000005', 'e4a00000-0000-0000-0000-00000000000a', 'report.downloaded', 'report_files',
            (select id from public.report_files where storage_path = 'e4a00000-0000-0000-0000-00000000000a/monthly.pdf'))$$),
          -- Was 'ok' until the ADR-172 addendum (20261018000036): the stored PDF is the FULL report
          -- and needs financials.view; a 3rd party gets the summary edition (32_report_variants).
          'P0002', 'a 3rd party may NOT record a download of the full Monthly Management Report PDF (ADR-172 addendum)');
select is(pg_temp.try_server($$select api_server.record_access_event('e4000000-0000-0000-0000-000000000005', 'e4a00000-0000-0000-0000-00000000000a', 'report.downloaded', null, null, '{"surface": "marketing"}'::jsonb)$$),
          'ok', '… and of a report rendered on request (Marketing, Investment), as before');

-- ===========================================================================
-- F. Action owners named at creation (20261018000035)
-- ===========================================================================
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.create_action('e4a00000-0000-0000-0000-00000000000a', '{"title": "t", "owner_user_id": "e4000000-0000-0000-0000-000000000005"}'::jsonb)$$),
          '22023', 'create_action refuses a 3rd party as the owner (no actions.view)');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.create_action('e4a00000-0000-0000-0000-00000000000a', '{"title": "t", "owner_user_id": "e4000000-0000-0000-0000-000000000015"}'::jsonb)$$),
          '22023', '… and a stranger');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000003', $$select api.create_action('e4a00000-0000-0000-0000-00000000000a', '{"title": "t", "owner_user_id": "e4000000-0000-0000-0000-000000000006"}'::jsonb)$$),
          '42501', 'an accountant (no actions.assign) cannot give a new action to somebody else');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000003', $$select api.create_action('e4a00000-0000-0000-0000-00000000000a', '{"title": "t", "owner_user_id": "e4000000-0000-0000-0000-000000000003"}'::jsonb)$$),
          'ok', '… but may take one on themselves');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', $$select api.create_action('e4a00000-0000-0000-0000-00000000000a', '{"title": "t", "owner_user_id": "e4000000-0000-0000-0000-000000000009"}'::jsonb)$$),
          'ok', 'the owner may give one to the assigned Financial Analyst');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', format($$select api.create_action_from_alert(%L, '{"owner_user_id": "e4000000-0000-0000-0000-000000000015"}'::jsonb)$$,
            (select id from public.alerts where organization_id = 'e4a00000-0000-0000-0000-00000000000a'))),
          '22023', 'create_action_from_alert refuses a stranger as the owner (was: no check at all)');
select is(pg_temp.try_as('e4000000-0000-0000-0000-000000000001', format($$select api.create_action_from_recommendation(%L, 0, '{"owner_user_id": "e4000000-0000-0000-0000-000000000005"}'::jsonb)$$,
            (select id from public.ai_messages where organization_id = 'e4a00000-0000-0000-0000-00000000000a'))),
          '22023', 'create_action_from_recommendation refuses a 3rd party as the owner (was: no check at all)');

select * from finish();
rollback;
