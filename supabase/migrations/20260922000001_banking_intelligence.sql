-- MOTION — Phase 13 · Banking Intelligence (ADR-101).
-- Contract: FINANCIAL_ENGINE.md §2.4 step 5, §4.1–4.3; DATABASE_ARCHITECTURE.md §4, §14;
--           SERVICE_ARCHITECTURE.md §4.7; SECURITY_MODEL.md §6; RBAC_MATRIX.md §2.1.
--
-- No new table. Three things the schema was missing for the banking rules that already existed:
--
--  1. `api_server.apply_banking_pass` — the writer for the "banking job" §4 has described since
--     Phase 4. The three pure rules (categorisation, transfer pairing, recurring detection) were
--     built and tested in Phase 6 but nothing ever applied their output: no row was categorised by a
--     rule, no transfer was paired by a rule, `recurring_payment_groups` was never written. The
--     calculation run now plans a pass in TypeScript (`banking/domain/pass.ts`, pure) and hands the
--     plan here. This function is IDEMPOTENT — it changes only rows whose state differs and writes
--     `category_history` only on change — and it never overrides a person: a row with
--     `category_source = 'user'` is skipped whatever the plan says (§4.1 point 1). The transfer kind
--     is derived HERE from the two account types, exactly as `api.mark_transfer` does; the plan
--     cannot assert it (ADR-028).
--
--  2. `api.bank_period_summary` — one read that gives the Banking page its per-account and
--     per-category figures for a month, its statement freshness and its reconciliation facts,
--     without loading the month's rows into the browser (Phase 13 brief §26) and without a second
--     definition of cash: `cash_transfer` legs are excluded from money in/out exactly as
--     `app.aggregate_periods` excludes them for the cash family, and `test/integration/banking.test.ts`
--     asserts the per-account sums add up to the engine's `cash_inflows`/`cash_outflows` to the penny.
--     Statement facts come from `import_batches`, which the client role cannot read directly
--     (`imports.review`), so they are served from here under `banking.view` with the raw text and
--     the file itself still out of reach.
--
--  3. Currency. `api.create_bank_account` defaulted a new account to 'GBP' whatever the
--     organisation reports in, and a statement row whose file has no currency column was committed
--     as 'GBP' by the same default. The import pipeline now stamps every row with the organisation's
--     currency before commit (IMP-CUR-007 already refuses any other currency, so no row can
--     legitimately differ), the account default follows `organizations.base_currency`, and the rows
--     and accounts already written wrongly are put right below — a one-off, exact by construction.

-- ---------------------------------------------------------------------------------------------
-- 1. api_server.apply_banking_pass
-- ---------------------------------------------------------------------------------------------
create function api_server.apply_banking_pass(p_org uuid, p_run uuid, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c            jsonb;
  v_row        public.bank_transactions%rowtype;
  v_new_cat    uuid;
  v_new_src    public.category_source_enum;
  v_out        public.bank_transactions%rowtype;
  v_in         public.bank_transactions%rowtype;
  v_out_type   public.bank_account_type_enum;
  v_in_type    public.bank_account_type_enum;
  v_kind       public.transfer_kind_enum;
  v_category   public.standard_category_enum;
  v_account    uuid;
  v_group      uuid;
  v_members    uuid[];
  v_touched    uuid[] := '{}';
  v_categorised integer := 0;
  v_paired      integer := 0;
  v_groups      integer := 0;
  v_members_set integer := 0;
  v_stopped     integer := 0;
  v_rows        integer;
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  perform app.require_scope(p_org);
  if p_run is not null and not exists (
    select 1 from public.calculation_runs r where r.organization_id = p_org and r.id = p_run
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- One writer per organisation at a time: the same lock the user-intent edits take, so a person
  -- re-categorising a row and the pass cannot interleave.
  perform pg_advisory_xact_lock(hashtext('org:' || p_org::text));

  -- ---- Categories: only rows a person has not decided, only when something differs. ----------
  for c in select * from jsonb_array_elements(coalesce(p_plan -> 'categorisations', '[]'::jsonb))
  loop
    select * into v_row from public.bank_transactions t
     where t.organization_id = p_org and t.id = (c ->> 'transactionId')::uuid
       and t.record_status = 'accepted' and t.superseded_by is null;
    if not found or v_row.category_source = 'user' then
      continue;
    end if;
    v_new_cat := nullif(c ->> 'categoryAccountId', '')::uuid;
    v_new_src := (c ->> 'categorySource')::public.category_source_enum;
    if v_new_src not in ('rule', 'none') then
      raise exception 'VALIDATION: a pass may only write rule or none' using errcode = '22023';
    end if;
    if v_new_cat is not null and not exists (
      select 1 from public.accounts a where a.organization_id = p_org and a.id = v_new_cat
    ) then
      continue; -- an account this organisation does not have is not written, whatever the plan says
    end if;
    if v_row.category_account_id is not distinct from v_new_cat
       and v_row.category_source = v_new_src then
      continue;
    end if;
    update public.bank_transactions
       set category_account_id = v_new_cat, category_source = v_new_src
     where organization_id = p_org and id = v_row.id;
    perform app.write_category_history(p_org, v_row.id, v_new_cat, v_row.is_transfer,
                                       v_row.transfer_kind, v_new_src);
    v_categorised := v_categorised + 1;
  end loop;

  -- ---- Transfers: both legs unpaired, neither decided by a person; the KIND is derived here. ----
  for c in select * from jsonb_array_elements(coalesce(p_plan -> 'pairs', '[]'::jsonb))
  loop
    select * into v_out from public.bank_transactions t
     where t.organization_id = p_org and t.id = (c ->> 'outflowTransactionId')::uuid
       and t.record_status = 'accepted' and t.superseded_by is null;
    if not found then continue; end if;
    select * into v_in from public.bank_transactions t
     where t.organization_id = p_org and t.id = (c ->> 'inflowTransactionId')::uuid
       and t.record_status = 'accepted' and t.superseded_by is null;
    if not found then continue; end if;
    if v_out.id = v_in.id or v_out.is_transfer or v_in.is_transfer
       or v_out.category_source = 'user' or v_in.category_source = 'user'
       or v_out.bank_account_id = v_in.bank_account_id
       or v_out.amount >= 0 or v_in.amount <= 0 or -v_out.amount <> v_in.amount then
      continue;
    end if;

    select b.account_type into v_out_type from public.bank_accounts b
     where b.organization_id = p_org and b.id = v_out.bank_account_id;
    select b.account_type into v_in_type from public.bank_accounts b
     where b.organization_id = p_org and b.id = v_in.bank_account_id;
    -- ADR-028, the same derivation as api.mark_transfer: only cash-like ↔ cash-like cancels out of
    -- cash. Letting the plan name the kind would let a real outflow vanish from the cash figures.
    v_kind := case
      when v_out_type in ('current', 'savings') and v_in_type in ('current', 'savings')
        then 'cash_transfer'
      when v_out_type = 'credit_card' or v_in_type = 'credit_card' then 'card_repayment'
      when v_out_type = 'loan' or v_in_type = 'loan' then 'loan_repayment'
      else 'other_transfer' end;
    v_category := case v_kind
      when 'card_repayment' then 'credit_card'::public.standard_category_enum
      when 'loan_repayment' then 'loan'::public.standard_category_enum
      else 'transfer'::public.standard_category_enum end;
    -- Lowest id wins, the ladder's own tie-break, so the choice is the same on every run.
    select a.id into v_account from public.accounts a
     where a.organization_id = p_org and a.standard_category = v_category
     order by a.id limit 1;

    update public.bank_transactions
       set transfer_pair_id = v_in.id, transfer_kind = v_kind, is_transfer = true,
           category_account_id = coalesce(v_account, category_account_id),
           category_source = case when v_account is null then category_source else 'rule' end
     where organization_id = p_org and id = v_out.id;
    update public.bank_transactions
       set transfer_pair_id = v_out.id, transfer_kind = v_kind, is_transfer = true,
           category_account_id = coalesce(v_account, category_account_id),
           category_source = case when v_account is null then category_source else 'rule' end
     where organization_id = p_org and id = v_in.id;
    perform app.write_category_history(p_org, v_out.id, coalesce(v_account, v_out.category_account_id), true, v_kind, 'rule');
    perform app.write_category_history(p_org, v_in.id, coalesce(v_account, v_in.category_account_id), true, v_kind, 'rule');
    v_paired := v_paired + 1;
  end loop;

  -- ---- Recurring groups: upsert on the stable key; members follow; the rest are stopped. -------
  for c in select * from jsonb_array_elements(coalesce(p_plan -> 'groups', '[]'::jsonb))
  loop
    if not exists (select 1 from public.bank_accounts b
                    where b.organization_id = p_org and b.id = (c ->> 'bankAccountId')::uuid) then
      continue;
    end if;
    insert into public.recurring_payment_groups as g
           (organization_id, bank_account_id, counterparty_key, direction, cadence, expected_amount,
            amount_tolerance_ratio, first_seen, last_seen, occurrence_count, next_expected, status,
            detector_version)
    values (p_org, (c ->> 'bankAccountId')::uuid, c ->> 'counterpartyKey',
            (c ->> 'direction')::public.recurring_direction_enum,
            (c ->> 'cadence')::public.recurring_cadence_enum,
            (c ->> 'expectedAmount')::numeric, (c ->> 'amountToleranceRatio')::numeric,
            (c ->> 'firstSeen')::date, (c ->> 'lastSeen')::date, (c ->> 'occurrenceCount')::integer,
            nullif(c ->> 'nextExpected', '')::date,
            (c ->> 'status')::public.recurring_status_enum, c ->> 'detectorVersion')
    on conflict (organization_id, bank_account_id, counterparty_key, direction) do update
       set cadence = excluded.cadence, expected_amount = excluded.expected_amount,
           amount_tolerance_ratio = excluded.amount_tolerance_ratio, first_seen = excluded.first_seen,
           last_seen = excluded.last_seen, occurrence_count = excluded.occurrence_count,
           next_expected = excluded.next_expected, status = excluded.status,
           detector_version = excluded.detector_version, updated_at = now()
     where (g.cadence, g.expected_amount, g.amount_tolerance_ratio, g.first_seen, g.last_seen,
            g.occurrence_count, g.next_expected, g.status, g.detector_version)
        is distinct from
           (excluded.cadence, excluded.expected_amount, excluded.amount_tolerance_ratio,
            excluded.first_seen, excluded.last_seen, excluded.occurrence_count, excluded.next_expected,
            excluded.status, excluded.detector_version)
    returning id into v_group;
    -- `on conflict … where` returns nothing when the row was already identical; fetch the id then.
    if v_group is null then
      select g.id into v_group from public.recurring_payment_groups g
       where g.organization_id = p_org and g.bank_account_id = (c ->> 'bankAccountId')::uuid
         and g.counterparty_key = c ->> 'counterpartyKey'
         and g.direction = (c ->> 'direction')::public.recurring_direction_enum;
    end if;
    v_touched := v_touched || v_group;
    v_groups := v_groups + 1;

    select coalesce(array_agg(x::uuid), '{}') into v_members
      from jsonb_array_elements_text(coalesce(c -> 'transactionIds', '[]'::jsonb)) x;
    update public.bank_transactions
       set recurring_group_id = v_group
     where organization_id = p_org and id = any(v_members)
       and recurring_group_id is distinct from v_group;
    get diagnostics v_rows = row_count;
    v_members_set := v_members_set + v_rows;
    update public.bank_transactions
       set recurring_group_id = null
     where organization_id = p_org and recurring_group_id = v_group and not (id = any(v_members));
    v_group := null;
  end loop;

  -- A group the detector no longer finds is not deleted — alerts and evidence may cite it — it is
  -- marked stopped, which is what a reader should be told about it.
  update public.recurring_payment_groups g
     set status = 'stopped', updated_at = now()
   where g.organization_id = p_org and g.status <> 'stopped' and not (g.id = any(v_touched));
  get diagnostics v_stopped = row_count;

  perform app.audit(p_org, 'banking.pass_applied', 'calculation_runs', p_run, null,
                    jsonb_build_object('categorised', v_categorised, 'paired', v_paired,
                                       'groups', v_groups, 'members_set', v_members_set,
                                       'stopped', v_stopped),
                    jsonb_build_object('versions', p_plan -> 'versions'));

  return jsonb_build_object('categorised', v_categorised, 'paired', v_paired, 'groups', v_groups,
                            'members_set', v_members_set, 'stopped', v_stopped);
end $$;

alter function api_server.apply_banking_pass(uuid, uuid, jsonb) owner to motion_definer;
revoke all on function api_server.apply_banking_pass(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function api_server.apply_banking_pass(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. api.bank_period_summary
-- ---------------------------------------------------------------------------------------------
create function api.bank_period_summary(p_org uuid, p_period uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_start date;
  v_end   date;
  v_accounts   jsonb;
  v_categories jsonb;
  v_statements jsonb;
  v_latest     jsonb;
begin
  if p_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(p_org, 'banking.view');

  select f.period_start, f.period_end into v_start, v_end
    from public.fiscal_periods f where f.organization_id = p_org and f.id = p_period;
  if v_start is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Per account. `cash_transfer` legs leave money in/out exactly as they leave the engine's cash
  -- family (ADR-028); they are reported separately so the page can still say what moved between
  -- the organisation's own accounts.
  select coalesce(jsonb_agg(row_to_json(a) order by a.bank_account_id), '[]'::jsonb) into v_accounts
    from (
      select t.bank_account_id,
             sum(case when t.amount > 0 and t.transfer_kind <> 'cash_transfer' then t.amount else 0 end)::text as inflow,
             sum(case when t.amount < 0 and t.transfer_kind <> 'cash_transfer' then -t.amount else 0 end)::text as outflow,
             sum(case when t.amount > 0 and t.transfer_kind = 'cash_transfer' then t.amount else 0 end)::text as transfers_in,
             sum(case when t.amount < 0 and t.transfer_kind = 'cash_transfer' then -t.amount else 0 end)::text as transfers_out,
             count(*)::int as row_count,
             count(*) filter (where t.category_account_id is null
                                 or a.standard_category = 'uncategorised')::int as uncategorised_count,
             count(*) filter (where t.is_transfer)::int as transfer_count,
             min(t.transaction_date)::text as first_date,
             max(t.transaction_date)::text as last_date,
             (select l.balance_after::text from public.bank_transactions l
               where l.organization_id = p_org and l.bank_account_id = t.bank_account_id
                 and l.period_id = p_period and l.record_status = 'accepted' and l.superseded_by is null
                 and l.balance_after is not null
               order by l.transaction_date desc, l.id desc limit 1) as last_balance_after,
             (select l.transaction_date::text from public.bank_transactions l
               where l.organization_id = p_org and l.bank_account_id = t.bank_account_id
                 and l.period_id = p_period and l.record_status = 'accepted' and l.superseded_by is null
                 and l.balance_after is not null
               order by l.transaction_date desc, l.id desc limit 1) as last_balance_date
        from public.bank_transactions t
        left join public.accounts a on a.organization_id = t.organization_id and a.id = t.category_account_id
       where t.organization_id = p_org and t.period_id = p_period
         and t.record_status = 'accepted' and t.superseded_by is null
       group by t.bank_account_id
    ) a;

  -- Per category: where money went, third parties only. Every transfer kind is left out — the
  -- repayment of a card is not spending, the purchases on the card were (ADR-047.12).
  select coalesce(jsonb_agg(row_to_json(c) order by c.standard_category), '[]'::jsonb) into v_categories
    from (
      select coalesce(a.standard_category::text, 'uncategorised') as standard_category,
             sum(case when t.amount > 0 then t.amount else 0 end)::text as inflow,
             sum(case when t.amount < 0 then -t.amount else 0 end)::text as outflow,
             count(*)::int as row_count
        from public.bank_transactions t
        left join public.accounts a on a.organization_id = t.organization_id and a.id = t.category_account_id
       where t.organization_id = p_org and t.period_id = p_period
         and t.record_status = 'accepted' and t.superseded_by is null and not t.is_transfer
       group by coalesce(a.standard_category::text, 'uncategorised')
    ) c;

  -- Statements covering the month, with the two facts reconciliation rests on: were the printed
  -- balances captured, and did the rows reconcile to them at import (IMP-BAL-006/007).
  select coalesce(jsonb_agg(row_to_json(s) order by s.committed_at desc), '[]'::jsonb) into v_statements
    from (
      select b.id as batch_id, b.bank_account_id, b.period_start::text, b.period_end::text,
             b.committed_at::text, b.statement_opening_balance::text, b.statement_closing_balance::text,
             b.extraction_method::text,
             exists (select 1 from jsonb_array_elements(coalesce(b.batch_issues, '[]'::jsonb)) i
                      where i ->> 'code' in ('IMP-BAL-006', 'IMP-BAL-007')) as unreconciled
        from public.import_batches b
       where b.organization_id = p_org and b.target_table = 'bank_transactions'
         and b.status = 'committed' and b.rolled_back_at is null
         and b.period_start <= v_end and b.period_end >= v_start
    ) s;

  select to_jsonb(l) into v_latest
    from (
      select b.committed_at::text, b.period_end::text, b.bank_account_id
        from public.import_batches b
       where b.organization_id = p_org and b.target_table = 'bank_transactions'
         and b.status = 'committed' and b.rolled_back_at is null
       order by b.committed_at desc limit 1
    ) l;

  return jsonb_build_object(
    'period', jsonb_build_object('id', p_period, 'start', v_start, 'end', v_end),
    'accounts', v_accounts,
    'categories', v_categories,
    'statements', v_statements,
    'latest_statement', v_latest,
    -- No live provider exists. This is stated by the database so no page can drift into
    -- claiming otherwise (CD-21, REQ-BK-10).
    'source', 'imported_statements'
  );
end $$;

alter function api.bank_period_summary(uuid, uuid) owner to motion_definer;
revoke all on function api.bank_period_summary(uuid, uuid) from public, anon;
grant execute on function api.bank_period_summary(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Currency: the organisation's, never a literal.
-- ---------------------------------------------------------------------------------------------
create or replace function api.create_bank_account(p_org uuid, p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_currency char(3);
begin
  perform app.throttle(app.uid(), 'rpc', 120, interval '1 minute');
  perform app.require_permission(p_org, 'financials.edit');

  if coalesce(trim(p_input ->> 'name'), '') = ''
     or coalesce(trim(p_input ->> 'bank_name'), '') = '' then
    raise exception 'VALIDATION: a name and bank name are required' using errcode = '22023';
  end if;

  select o.base_currency into v_currency from public.organizations o where o.id = p_org;

  insert into public.bank_accounts
         (organization_id, name, bank_name, account_number_masked, sort_code_masked,
          currency, account_type, ledger_account_id)
  values (p_org, trim(p_input ->> 'name'), trim(p_input ->> 'bank_name'),
          p_input ->> 'account_number_masked', p_input ->> 'sort_code_masked',
          coalesce(nullif(p_input ->> 'currency', ''), v_currency, 'GBP'),
          coalesce((p_input ->> 'account_type')::public.bank_account_type_enum, 'current'),
          (p_input ->> 'ledger_account_id')::uuid)
  returning id into v_id;

  perform app.audit(p_org, 'bank_account.created', 'bank_accounts', v_id, null, p_input, '{}'::jsonb);
  return v_id;
exception
  -- ADR-029.4: a second account with the same masked identity is refused, and the UI offers the
  -- existing one. Two rows for one real account would double every cash figure.
  when unique_violation then
    raise exception 'CONFLICT: an account with those details already exists' using errcode = '23505';
end $$;

-- One-off correction. IMP-CUR-007 refuses any row not in the organisation's currency, so a stored
-- currency that differs from `organizations.base_currency` can only be the old 'GBP' default on a
-- file with no currency column. Amounts are untouched; only the label they carried was wrong.
update public.bank_accounts b
   set currency = o.base_currency
  from public.organizations o
 where o.id = b.organization_id and b.currency <> o.base_currency;

update public.bank_transactions t
   set currency = o.base_currency
  from public.organizations o
 where o.id = t.organization_id and t.currency <> o.base_currency;

-- ---------------------------------------------------------------------------------------------
-- 4. A column a reader was always meant to see
-- ---------------------------------------------------------------------------------------------
-- `bank_transactions` is granted column by column because two columns are withheld (ADR-044.2).
-- `rejected_reason` arrived later (IMPORT_ENGINE.md §12) without joining the grant, so the record
-- provenance read — which selects it for every record table — failed on a bank row for every
-- role, owner included. The Banking transaction page links there from every line, so the grant is
-- made here. The two raw columns stay withheld.
grant select (rejected_reason) on public.bank_transactions to authenticated;
