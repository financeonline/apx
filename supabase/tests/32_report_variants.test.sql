-- APX — pgTAP · The Monthly Management Report's two editions (ADR-172 addendum, the owner's decision
-- of 2026-10-14; migration 20261018000036; RBAC_MATRIX.md §8.3).
--
-- The FULL report (its stored PDF carries the month's alerts and open action titles) is detail:
-- `reports.view` AND `financials.view`. The SUMMARY EDITION (headline figures, Business Health Score,
-- the report's words) is rendered on request from the overview and never stored; its download is
-- recorded against the MONTH. What the database must guarantee, each asserted against a row that
-- exists so every refusal is a refusal and not an empty table:
--
--   A. Nobody without `financials.view` can read the full report's stored file, or have its download
--      recorded — and so signed (ADR-043.5): a 3rd party, and a client whose switch is off. Whoever
--      holds it can: the owner, a client, an accountant, a 3rd party whose switch is ON.
--   B. The summary edition: any `reports.view` reader may have it recorded for a COMPLETE month of
--      their own organisation (a full reader too — they read both); and everything it is built from
--      is readable by a 3rd party, while the detail it leaves out is not.
--   C. Isolation across organisations.
--   D. Composed reports' files and the no-target downloads keep their rules.

begin;
create extension if not exists pgtap;

select plan(48);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select ('e6000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'rv-' || n || '@variants.motion', 'x', now(), now(), now()
  from generate_series(1, 9) n;

insert into public.organizations (id, slug, name) values
  ('e6a00000-0000-0000-0000-00000000000a', 'rv-x', 'RV Org X'),
  ('e6b00000-0000-0000-0000-00000000000b', 'rv-y', 'RV Org Y');

-- X: 01 owner, 02 client, 03 3rd party, 04 client whose financials.view is switched OFF,
--    05 3rd party whose financials.view is switched ON, 06 accountant.
-- Y: 07 owner, 08 3rd party.   09 a stranger.
insert into public.organization_memberships (organization_id, user_id, role, status) values
  ('e6a00000-0000-0000-0000-00000000000a', 'e6000000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('e6a00000-0000-0000-0000-00000000000a', 'e6000000-0000-0000-0000-000000000002', 'client', 'active'),
  ('e6a00000-0000-0000-0000-00000000000a', 'e6000000-0000-0000-0000-000000000003', 'third_party', 'active'),
  ('e6a00000-0000-0000-0000-00000000000a', 'e6000000-0000-0000-0000-000000000004', 'client', 'active'),
  ('e6a00000-0000-0000-0000-00000000000a', 'e6000000-0000-0000-0000-000000000005', 'third_party', 'active'),
  ('e6a00000-0000-0000-0000-00000000000a', 'e6000000-0000-0000-0000-000000000006', 'accountant', 'active'),
  ('e6b00000-0000-0000-0000-00000000000b', 'e6000000-0000-0000-0000-000000000007', 'owner', 'active'),
  ('e6b00000-0000-0000-0000-00000000000b', 'e6000000-0000-0000-0000-000000000008', 'third_party', 'active');

-- Per organisation: a complete March and an unfinished April; NAMED detail where the full report
-- would print it (an alert sentence naming a customer, an action title, a bank account, a per-customer
-- figure, a health condition naming a supplier); the overview the summary edition is made of; the
-- full report's stored PDF, a deleted earlier one, and a daily brief's PDF.
create procedure pg_temp.seed_org(p_org uuid, p_tag text)
language plpgsql as $$
declare
  v_march uuid; v_april uuid; v_run uuid; v_cp uuid; v_snap uuid; v_cp_snap uuid; v_health uuid; v_daily uuid;
begin
  perform app.ensure_periods(p_org, '2026-03-01', '2026-04-30');
  select id into v_march from public.fiscal_periods where organization_id = p_org and period_start = '2026-03-01';
  select id into v_april from public.fiscal_periods where organization_id = p_org and period_start = '2026-04-01';
  update public.fiscal_periods set is_complete = true where id = v_march;

  insert into public.counterparties (organization_id, name, normalized_name)
  values (p_org, p_tag || ' Customer Ltd', lower(p_tag) || ' customer ltd') returning id into v_cp;
  insert into public.bank_accounts (organization_id, name, bank_name, account_type)
  values (p_org, p_tag || ' Savings 4471', 'PGT Bank', 'savings');
  insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
  values (p_org, 'recalc_manual', '1.0.0', v_march, v_march, '2026-03-31', 'succeeded') returning id into v_run;

  insert into public.metric_snapshots
    (organization_id, calculation_run_id, period_id, metric_key, unit, basis, assurance_level, value, currency, data_quality)
  values (p_org, v_run, v_march, 'revenue', 'money', 'ledger', 'verified', 40000, 'GBP',
          '{"completeness": 1, "warnings": [], "missing": []}') returning id into v_snap;
  insert into public.metric_current (organization_id, period_id, metric_key, snapshot_id, calculation_run_id)
  values (p_org, v_march, 'revenue', v_snap, v_run);
  insert into public.metric_snapshots
    (organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id, unit, basis, assurance_level, value)
  values (p_org, v_run, v_march, 'customer_revenue', 'counterparty', v_cp, 'money', 'ledger', 'verified', 25000)
  returning id into v_cp_snap;
  insert into public.metric_current (organization_id, period_id, metric_key, dimension_type, dimension_id, snapshot_id, calculation_run_id)
  values (p_org, v_march, 'customer_revenue', 'counterparty', v_cp, v_cp_snap, v_run);

  insert into public.health_scores
    (organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version, breakdown)
  values (p_org, v_run, v_march, 68, 3, 4, 'v1',
          jsonb_build_array(jsonb_build_object(
            'key', 'banking_health', 'score', 70, 'weight_config', 20, 'weight_applied', 20, 'included', true,
            'exclusion_reason', null, 'capped', false, 'cap_reason', null,
            'positives', '["The bank balance has risen for three months"]'::jsonb, 'negatives', '[]'::jsonb,
            'metrics', jsonb_build_array(jsonb_build_object('metric_key', 'revenue', 'value', '40000.00', 'snapshot_id', v_snap)),
            'rules', '[]'::jsonb,
            'conditions', jsonb_build_array(jsonb_build_object('rule_key', 'recurring.amount_changed',
                            'subject_id', v_cp, 'subject_key', 'fps ' || lower(p_tag) || ' supplier haulage',
                            'snapshot_ids', jsonb_build_array(v_snap), 'record_ids', '[]'::jsonb)),
            'positives_structured', '[]'::jsonb, 'negatives_structured', '[]'::jsonb,
            'data_quality', '{"completeness": 1, "warnings": []}'::jsonb)))
  returning id into v_health;
  insert into public.health_current (organization_id, period_id, health_score_id) values (p_org, v_march, v_health);

  insert into public.alerts (organization_id, rule_key, rule_version, severity, period_id, title, explanation,
                             dedupe_key, key_kind, calculation_run_id)
  values (p_org, 'concentration.customer', '1', 'high', v_march, 'One customer is 62% of revenue',
          p_tag || ' Customer Ltd is 62% of revenue this month.', p_tag || '-rv', 'state', v_run);
  insert into public.actions (organization_id, title)
  values (p_org, 'Chase ' || p_tag || ' Customer Ltd for the March invoice');

  -- The full report's stored PDF, an earlier one since deleted, and a composed report's PDF.
  insert into public.report_files (organization_id, report_kind, period_id, storage_path)
  values (p_org, 'monthly_management', v_march, p_org::text || '/' || v_march::text || '/full.pdf');
  insert into public.report_files (organization_id, report_kind, period_id, storage_path, deleted_at)
  values (p_org, 'monthly_management', v_march, p_org::text || '/' || v_march::text || '/old.pdf', now());
  insert into public.reports (organization_id, report_kind, window_start, window_end, origin, content, content_version)
  values (p_org, 'daily_brief', '2026-03-31', '2026-03-31', 'scheduled', '{}'::jsonb, 'brief.v1') returning id into v_daily;
  insert into public.report_files (organization_id, report_kind, report_id, storage_path)
  values (p_org, 'daily_brief', v_daily, p_org::text || '/r/' || v_daily::text || '/daily.pdf');
end $$;
call pg_temp.seed_org('e6a00000-0000-0000-0000-00000000000a', 'RVX');
call pg_temp.seed_org('e6b00000-0000-0000-0000-00000000000b', 'RVY');

-- ---------------------------------------------------------------------------
-- Impersonation helpers (the house pattern of 31_member_access_hardening).
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
create function pg_temp.val_as(p_user uuid, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  call pg_temp.act_as(p_user);
  execute p_sql into v;
  call pg_temp.act_as_postgres();
  return v;
end $$;
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

-- How many of an organisation's FULL monthly report files (live or deleted) a person can read.
create function pg_temp.full_files(p_user uuid, p_org uuid) returns integer
language plpgsql as $$
begin
  return pg_temp.val_as(p_user, format(
    'select count(*) from public.report_files where organization_id = %L and report_kind = ''monthly_management''', p_org))::integer;
end $$;
-- The SQLSTATE of recording a download of the live full monthly file of `p_file_org`, under `p_org`.
create function pg_temp.download_full(p_user uuid, p_org uuid, p_file_org uuid) returns text
language plpgsql as $$
begin
  return pg_temp.try_server(format(
    $f$select api_server.record_access_event(%L, %L, 'report.downloaded', 'report_files',
         (select id from public.report_files where organization_id = %L and report_kind = 'monthly_management' and deleted_at is null))$f$,
    p_user, p_org, p_file_org));
end $$;
-- The SQLSTATE of recording a summary-edition download of `p_period_org`'s month, under `p_org`.
create function pg_temp.download_summary(p_user uuid, p_org uuid, p_period_org uuid, p_month date) returns text
language plpgsql as $$
begin
  return pg_temp.try_server(format(
    $f$select api_server.record_access_event(%L, %L, 'report.downloaded', 'fiscal_periods',
         (select id from public.fiscal_periods where organization_id = %L and period_start = %L),
         jsonb_build_object('period_id', (select id from public.fiscal_periods where organization_id = %L and period_start = %L),
                            'surface', 'summary_edition'))$f$,
    p_user, p_org, p_period_org, p_month, p_period_org, p_month));
end $$;

-- The owner switches the two members whose answer is not their role's default.
select is(pg_temp.try_as('e6000000-0000-0000-0000-000000000001', $$select api.set_member_permission('e6a00000-0000-0000-0000-00000000000a', 'e6000000-0000-0000-0000-000000000004', 'financials.view', false)$$),
          'ok', 'fixture: the owner switches a client''s financials.view OFF');
select is(pg_temp.try_as('e6000000-0000-0000-0000-000000000001', $$select api.set_member_permission('e6a00000-0000-0000-0000-00000000000a', 'e6000000-0000-0000-0000-000000000005', 'financials.view', true)$$),
          'ok', 'fixture: the owner switches a 3rd party''s financials.view ON');

-- ===========================================================================
-- A. The FULL report's stored file: financials.view
-- ===========================================================================
select is((select count(*)::int from public.report_files where organization_id = 'e6a00000-0000-0000-0000-00000000000a'
            and report_kind = 'monthly_management' and deleted_at is null), 1,
          'fixture: X has one live full monthly PDF (and one deleted)');

select is(pg_temp.full_files('e6000000-0000-0000-0000-000000000003', 'e6a00000-0000-0000-0000-00000000000a'), 0,
          'a 3rd party cannot read the full monthly report''s file');
select is(pg_temp.download_full('e6000000-0000-0000-0000-000000000003', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a'),
          'P0002', '… nor have its download recorded — so the signer has no audit id to sign with (NOT FOUND)');
select is(pg_temp.full_files('e6000000-0000-0000-0000-000000000004', 'e6a00000-0000-0000-0000-00000000000a'), 0,
          'a client whose financials.view is switched off cannot read it');
select is(pg_temp.download_full('e6000000-0000-0000-0000-000000000004', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a'),
          'P0002', '… nor have its download recorded');

select is(pg_temp.full_files('e6000000-0000-0000-0000-000000000001', 'e6a00000-0000-0000-0000-00000000000a'), 1,
          'the owner reads the full file (the live one only)');
select is(pg_temp.download_full('e6000000-0000-0000-0000-000000000001', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a'),
          'ok', '… and may download it');
select is(pg_temp.full_files('e6000000-0000-0000-0000-000000000002', 'e6a00000-0000-0000-0000-00000000000a'), 1,
          'a client (financials.view by role) reads it');
select is(pg_temp.download_full('e6000000-0000-0000-0000-000000000002', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a'),
          'ok', '… and may download it');
select is(pg_temp.full_files('e6000000-0000-0000-0000-000000000006', 'e6a00000-0000-0000-0000-00000000000a'), 1,
          'an accountant reads it');
select is(pg_temp.full_files('e6000000-0000-0000-0000-000000000005', 'e6a00000-0000-0000-0000-00000000000a'), 1,
          'a 3rd party whose financials.view the owner switched ON reads it — the rule is the permission, not the role');
select is(pg_temp.download_full('e6000000-0000-0000-0000-000000000005', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a'),
          'ok', '… and may download it');
select is(pg_temp.try_server($$select api_server.record_access_event('e6000000-0000-0000-0000-000000000001', 'e6a00000-0000-0000-0000-00000000000a', 'report.downloaded', 'report_files',
            (select id from public.report_files where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and deleted_at is not null))$$),
          'P0002', 'a deleted full file cannot be downloaded, even by the owner');
select ok(position('financials.view' in (select qual from pg_policies where tablename = 'report_files' and policyname = 'report_files_select')) > 0,
          'report_files_select names financials.view');

-- ===========================================================================
-- B. The SUMMARY EDITION: recorded against a complete month; built from what a 3rd party reads
-- ===========================================================================
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000003', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a', '2026-03-01'),
          'ok', 'a 3rd party may download the summary edition of a complete month');
select is((select count(*)::int from public.audit_events
            where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and action = 'report.downloaded'
              and actor_user_id = 'e6000000-0000-0000-0000-000000000003' and target_table = 'fiscal_periods'
              and metadata ->> 'surface' = 'summary_edition'), 1,
          '… recorded against the month, as the summary edition');
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000003', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a', '2026-04-01'),
          'P0002', '… not of a month that has not finished (ADR-030.4)');
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000004', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a', '2026-03-01'),
          'ok', 'a client without financials.view may download the summary edition');
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000001', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a', '2026-03-01'),
          'ok', 'a full reader (the owner) may download the summary edition too — they read both');
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000002', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a', '2026-03-01'),
          'ok', '… and a client');
select is(pg_temp.try_server($$select api_server.record_access_event('e6000000-0000-0000-0000-000000000003', 'e6a00000-0000-0000-0000-00000000000a', 'report.downloaded', 'reports',
            (select id from public.reports where organization_id = 'e6a00000-0000-0000-0000-00000000000a'))$$),
          '22023', 'a download naming anything but a report file or a month is refused (deny by default)');

-- What the summary edition is made of — the overview — is there for a 3rd party …
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.health_current where organization_id = 'e6a00000-0000-0000-0000-00000000000a'$$)::int,
          1, 'its sources: a 3rd party reads the Business Health Score');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.health_score_breakdowns where organization_id = 'e6a00000-0000-0000-0000-00000000000a'$$)::int,
          1, '… and its breakdown');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.health_score_breakdowns where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and breakdown::text like '%supplier haulage%'$$)::int,
          0, '… redacted: the condition naming a supplier is not in it');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.metric_snapshots where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and dimension_type = 'none'$$)::int,
          1, '… the headline figure');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.metric_current where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and dimension_type = 'none'$$)::int,
          1, '… its pointer');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.fiscal_periods where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and is_complete$$)::int,
          1, '… the month');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.calculation_runs where organization_id = 'e6a00000-0000-0000-0000-00000000000a'$$)::int,
          1, '… the run the figures came from (the provenance line)');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select name from public.organizations where id = 'e6a00000-0000-0000-0000-00000000000a'$$),
          'RV Org X', '… and the organisation''s name');
-- … and what it leaves out is not, so the reader's own client cannot build anything more.
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.metric_snapshots where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and dimension_type = 'counterparty'$$)::int,
          0, 'left out: a 3rd party reads no per-customer figure');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.alerts where organization_id = 'e6a00000-0000-0000-0000-00000000000a'$$)::int,
          0, '… no alert (whose sentence names a customer)');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.actions where organization_id = 'e6a00000-0000-0000-0000-00000000000a'$$)::int,
          0, '… no action title');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.bank_accounts where organization_id = 'e6a00000-0000-0000-0000-00000000000a'$$)::int,
          0, '… no bank account name');
select is((select count(*)::int from public.alerts a join public.actions x on x.organization_id = a.organization_id
            join public.bank_accounts b on b.organization_id = a.organization_id
            where a.organization_id = 'e6a00000-0000-0000-0000-00000000000a'), 1,
          '(each of which exists: the alert, the action and the bank account are there to be withheld)');

-- ===========================================================================
-- C. Isolation across organisations
-- ===========================================================================
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000008', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a', '2026-03-01'),
          '42501', 'Y''s 3rd party cannot download X''s summary edition under X (no reports.view there)');
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000008', 'e6b00000-0000-0000-0000-00000000000b', 'e6a00000-0000-0000-0000-00000000000a', '2026-03-01'),
          'P0002', '… nor under Y, naming X''s month (NOT FOUND: not Y''s month)');
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000001', 'e6a00000-0000-0000-0000-00000000000a', 'e6b00000-0000-0000-0000-00000000000b', '2026-03-01'),
          'P0002', 'X''s owner cannot record Y''s month under X');
select is(pg_temp.full_files('e6000000-0000-0000-0000-000000000007', 'e6a00000-0000-0000-0000-00000000000a'), 0,
          'Y''s owner reads none of X''s full files');
select is(pg_temp.download_full('e6000000-0000-0000-0000-000000000007', 'e6b00000-0000-0000-0000-00000000000b', 'e6a00000-0000-0000-0000-00000000000a'),
          'P0002', '… and cannot record X''s full file under Y');
select is(pg_temp.download_full('e6000000-0000-0000-0000-000000000001', 'e6a00000-0000-0000-0000-00000000000a', 'e6b00000-0000-0000-0000-00000000000b'),
          'P0002', 'X''s owner cannot record Y''s full file under X');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.health_current where organization_id = 'e6b00000-0000-0000-0000-00000000000b'$$)::int,
          0, 'X''s 3rd party reads none of Y''s overview');
select is(pg_temp.download_summary('e6000000-0000-0000-0000-000000000009', 'e6a00000-0000-0000-0000-00000000000a', 'e6a00000-0000-0000-0000-00000000000a', '2026-03-01'),
          '42501', 'a stranger cannot download X''s summary edition');

-- ===========================================================================
-- D. Unchanged: composed reports' files and downloads with no target
-- ===========================================================================
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000003', $$select count(*) from public.report_files where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and report_kind = 'daily_brief'$$)::int,
          0, 'a 3rd party still reads no daily brief PDF');
select is(pg_temp.val_as('e6000000-0000-0000-0000-000000000001', $$select count(*) from public.report_files where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and report_kind = 'daily_brief'$$)::int,
          1, '… the owner does');
select is(pg_temp.try_server($$select api_server.record_access_event('e6000000-0000-0000-0000-000000000003', 'e6a00000-0000-0000-0000-00000000000a', 'report.downloaded', null, null, '{"surface": "marketing"}'::jsonb)$$),
          'ok', 'a report rendered on request with no month (Marketing, Investment) keeps reports.view');
select is(pg_temp.try_as('e6000000-0000-0000-0000-000000000001', $$select api_server.record_access_event('e6000000-0000-0000-0000-000000000001', 'e6a00000-0000-0000-0000-00000000000a', 'report.downloaded', 'fiscal_periods',
            (select id from public.fiscal_periods where organization_id = 'e6a00000-0000-0000-0000-00000000000a' and period_start = '2026-03-01'))$$),
          '42501', 'a user JWT cannot record an access event itself (api_server is the server''s)');

select * from finish();
rollback;
