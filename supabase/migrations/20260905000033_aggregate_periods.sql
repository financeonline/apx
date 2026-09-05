-- MOTION — Phase 4 (plan Phase 6) · L0: the single SQL aggregation the engine computes from.
-- Contract: FINANCIAL_ENGINE.md §2.4 step 4; ADR-031.4, ADR-047.1.
--
-- Why this exists at all. The TypeScript engine never iterates raw records: it receives one row per
-- period × source × category × account × counterparty × bank account. Chunk cost is therefore
-- proportional to periods × dimensions, not to rows, which is what keeps a ten-year general ledger
-- inside the 1,500 CPU-ms budget (NFR-04). It also means the sums are computed by Postgres in exact
-- NUMERIC, once, rather than by summing a large array in JavaScript.
--
-- Three rules are enforced here and nowhere else, because every caller depends on them:
--
--   1. ONLY ACCEPTED, NON-SUPERSEDED RECORDS (§1.3). `superseded_by IS NULL` is the CURRENT state:
--      a rollback resets the column, so restored data is visible immediately without consulting the
--      event log. `record_status_events` is history and belongs to evidence as-of resolution alone.
--
--   2. TRANSFERS ARE EXCLUDED FROM P&L ENTIRELY, and from cash only when both legs sit on cash-like
--      accounts (ADR-028). A card repayment from a current account is a real movement of the
--      company's money and must stay in the cash figures; treating it as a transfer would make
--      £3,000 leave the bank and vanish from the numbers.
--
--   3. `aggregated_at` PINS THE READ. Every chunk records the instant it aggregated, and the
--      descriptors of that chunk's snapshots carry it, so the evidence resolver can reproduce
--      exactly this selection later (ADR-046.2, ADR-047.7).

create type public.aggregate_source_enum as enum
  ('period_balances', 'ledger', 'invoices', 'bank');

create function app.aggregate_periods(
  p_org           uuid,
  p_from          date,
  p_to            date,
  p_aggregated_at timestamptz default now()
)
returns table (
  period_id         uuid,
  source            public.aggregate_source_enum,
  standard_category public.standard_category_enum,
  account_id        uuid,
  counterparty_id   uuid,
  bank_account_id   uuid,
  balance_kind      public.balance_kind_enum,
  balance_basis     public.balance_basis_enum,
  invoice_type      public.invoice_type_enum,
  debit             numeric,
  credit            numeric,
  amount            numeric,
  row_count         bigint,
  min_date          date,
  max_date          date
)
language sql stable security definer set search_path = '' as $$
  with periods as (
    select f.id, f.period_start, f.period_end
      from public.fiscal_periods f
     where f.organization_id = p_org
       and f.period_start >= date_trunc('month', p_from)::date
       and f.period_start <= date_trunc('month', p_to)::date
  ),

  -- ---------------------------------------------------------------------------------------------
  -- Ledger. Debit and credit are kept separate: the sign convention is a property of the ACCOUNT
  -- TYPE (§3), and applying it here would bake one interpretation into the aggregate.
  -- Opening-balance journals are excluded from P&L by the engine, so the flag travels as a
  -- separate dimension would be wrong — instead they are simply summed and the engine filters,
  -- which is why `is_opening_balance` rows are aggregated under their own account like any other.
  -- ---------------------------------------------------------------------------------------------
  ledger as (
    select e.period_id,
           'ledger'::public.aggregate_source_enum as source,
           a.standard_category,
           e.account_id,
           e.counterparty_id,
           null::uuid as bank_account_id,
           null::public.balance_kind_enum as balance_kind,
           null::public.balance_basis_enum as balance_basis,
           null::public.invoice_type_enum as invoice_type,
           sum(case when e.direction = 'debit' then e.amount else 0 end) as debit,
           sum(case when e.direction = 'credit' then e.amount else 0 end) as credit,
           sum(case when e.direction = 'debit' then e.amount else -e.amount end) as amount,
           count(*) as row_count,
           min(e.entry_date) as min_date,
           max(e.entry_date) as max_date
      from public.ledger_entries e
      join periods p on p.id = e.period_id
      join public.accounts a on a.organization_id = e.organization_id and a.id = e.account_id
     where e.organization_id = p_org
       and e.record_status = 'accepted'
       and e.superseded_by is null
       and e.created_at <= p_aggregated_at
     group by e.period_id, a.standard_category, e.account_id, e.counterparty_id
  ),

  -- ---------------------------------------------------------------------------------------------
  -- Period balances. `closing_balance` is stored in natural sign (debit − credit); the engine
  -- applies the account-type rule. `balance_kind` and `balance_basis` travel with the row because
  -- cumulative differencing needs to match kind AND basis to the immediately preceding fiscal month
  -- (ADR-047.4) — mixing a cumulative month with a movement month would produce a nonsense delta.
  -- ---------------------------------------------------------------------------------------------
  balances as (
    select b.period_id,
           'period_balances'::public.aggregate_source_enum as source,
           a.standard_category,
           b.account_id,
           null::uuid as counterparty_id,
           null::uuid as bank_account_id,
           b.balance_kind,
           b.balance_basis,
           null::public.invoice_type_enum as invoice_type,
           sum(coalesce(b.debit_total, 0)) as debit,
           sum(coalesce(b.credit_total, 0)) as credit,
           sum(b.closing_balance) as amount,
           count(*) as row_count,
           min(b.period_start) as min_date,
           max(b.period_start) as max_date
      from public.period_balances b
      join periods p on p.id = b.period_id
      join public.accounts a on a.organization_id = b.organization_id and a.id = b.account_id
     where b.organization_id = p_org
       and b.record_status = 'accepted'
       and b.superseded_by is null
       and b.created_at <= p_aggregated_at
     group by b.period_id, a.standard_category, b.account_id, b.balance_kind, b.balance_basis
  ),

  -- ---------------------------------------------------------------------------------------------
  -- Invoices. Net of tax per row (§3): subtotal, else total − tax, else total. A subtotal of zero
  -- alongside a positive total counts as ABSENT, not as a zero-rated invoice — many exports leave
  -- it blank as 0, and treating that as "no VAT" would overstate revenue.
  -- Credit notes are stored with all four money fields positive and are subtracted BY TYPE, which
  -- the engine does; here each type is aggregated separately so it can.
  -- `void` invoices are excluded outright.
  -- ---------------------------------------------------------------------------------------------
  invoices as (
    select i.period_id,
           'invoices'::public.aggregate_source_enum as source,
           null::public.standard_category_enum as standard_category,
           null::uuid as account_id,
           -- A merged counterparty rolls up to its survivor, so a merge does not split a customer's
           -- history across two dimensions (§3.5).
           coalesce(c.merged_into_id, i.counterparty_id) as counterparty_id,
           null::uuid as bank_account_id,
           null::public.balance_kind_enum as balance_kind,
           null::public.balance_basis_enum as balance_basis,
           i.invoice_type,
           sum(coalesce(i.tax_amount, 0)) as debit,     -- carried so the engine can report VAT
           sum(coalesce(i.amount_paid, 0)) as credit,   -- carried for aging
           sum(case
                 when i.subtotal is not null and i.subtotal <> 0 then i.subtotal
                 when i.tax_amount is not null then i.total_amount - i.tax_amount
                 else i.total_amount
               end) as amount,
           count(*) as row_count,
           min(i.issue_date) as min_date,
           max(i.issue_date) as max_date
      from public.invoices i
      join periods p on p.id = i.period_id
      left join public.counterparties c
        on c.organization_id = i.organization_id and c.id = i.counterparty_id
     where i.organization_id = p_org
       and i.record_status = 'accepted'
       and i.superseded_by is null
       and i.status <> 'void'
       and i.created_at <= p_aggregated_at
     group by i.period_id, coalesce(c.merged_into_id, i.counterparty_id), i.invoice_type
  ),

  -- ---------------------------------------------------------------------------------------------
  -- Bank. `amount` is signed: positive is an inflow.
  --
  -- The transfer exclusion is deliberately NOT applied here. Whether a transfer leg counts depends
  -- on which family is asking — a `cash_transfer` pair cancels out of cash but a `card_repayment`
  -- does not, and P&L excludes every kind (ADR-028). The aggregate therefore carries `transfer_kind`
  -- as part of the category dimension by mapping it onto the row's category account, and the engine
  -- applies the family rule. Excluding here would make the correct answer unrecoverable.
  -- ---------------------------------------------------------------------------------------------
  bank as (
    select t.period_id,
           'bank'::public.aggregate_source_enum as source,
           a.standard_category,
           t.category_account_id as account_id,
           coalesce(c.merged_into_id, t.counterparty_id) as counterparty_id,
           t.bank_account_id,
           null::public.balance_kind_enum as balance_kind,
           null::public.balance_basis_enum as balance_basis,
           null::public.invoice_type_enum as invoice_type,
           sum(case when t.amount > 0 then t.amount else 0 end) as debit,   -- inflows
           sum(case when t.amount < 0 then -t.amount else 0 end) as credit, -- outflows, positive
           sum(t.amount) as amount,
           count(*) as row_count,
           min(t.transaction_date) as min_date,
           max(t.transaction_date) as max_date
      from public.bank_transactions t
      join periods p on p.id = t.period_id
      left join public.accounts a
        on a.organization_id = t.organization_id and a.id = t.category_account_id
      left join public.counterparties c
        on c.organization_id = t.organization_id and c.id = t.counterparty_id
     where t.organization_id = p_org
       and t.record_status = 'accepted'
       and t.superseded_by is null
       and t.created_at <= p_aggregated_at
     group by t.period_id, a.standard_category, t.category_account_id,
              coalesce(c.merged_into_id, t.counterparty_id), t.bank_account_id
  )

  select * from ledger
  union all select * from balances
  union all select * from invoices
  union all select * from bank
  order by 1, 2, 3, 4, 5, 6;
$$;

-- The transfer dimension the engine needs alongside the aggregate: which bank rows are transfer legs
-- of which kind, per period and account. Kept separate from the aggregate rather than widening it,
-- because it is a small set and widening the group-by would multiply every bank cell.
create function app.aggregate_transfer_legs(
  p_org           uuid,
  p_from          date,
  p_to            date,
  p_aggregated_at timestamptz default now()
)
returns table (
  period_id       uuid,
  bank_account_id uuid,
  transfer_kind   public.transfer_kind_enum,
  inflow          numeric,
  outflow         numeric,
  row_count       bigint
)
language sql stable security definer set search_path = '' as $$
  select t.period_id,
         t.bank_account_id,
         t.transfer_kind,
         sum(case when t.amount > 0 then t.amount else 0 end),
         sum(case when t.amount < 0 then -t.amount else 0 end),
         count(*)
    from public.bank_transactions t
    join public.fiscal_periods f
      on f.organization_id = t.organization_id and f.id = t.period_id
   where t.organization_id = p_org
     and t.record_status = 'accepted'
     and t.superseded_by is null
     and t.is_transfer
     and t.created_at <= p_aggregated_at
     and f.period_start >= date_trunc('month', p_from)::date
     and f.period_start <= date_trunc('month', p_to)::date
   group by t.period_id, t.bank_account_id, t.transfer_kind
   order by 1, 2, 3;
$$;

-- Declared coverage per source, which §2.2 defines entirely in terms of committed batches and their
-- DECLARED export ranges — never the last posting date, so a month whose last working day is the
-- 28th is still covered by an export declared to the 31st (ADR-047.6).
create function app.batch_coverage(p_org uuid, p_from date, p_to date)
returns table (
  target_table    public.import_target_enum,
  import_type     public.import_type_enum,
  balance_kind    public.balance_kind_enum,
  bank_account_id uuid,
  invoice_list_kind public.invoice_list_kind_enum,
  period_start    date,
  period_end      date,
  committed_at    timestamptz,
  batch_id        uuid
)
language sql stable security definer set search_path = '' as $$
  select b.target_table,
         b.import_type,
         case b.import_type
           when 'trial_balance' then 'trial_balance'
           when 'pnl_report'    then 'pnl_report'
           when 'balance_sheet' then 'balance_sheet'
         end::public.balance_kind_enum,
         b.bank_account_id,
         b.invoice_list_kind,
         b.period_start,
         b.period_end,
         b.committed_at,
         b.id
    from public.import_batches b
   where b.organization_id = p_org
     and b.status = 'committed'
     and b.period_start is not null
     and b.period_end is not null
     and b.period_end >= date_trunc('month', p_from)::date
     and b.period_start <= (date_trunc('month', p_to) + interval '1 month - 1 day')::date
   order by b.committed_at desc;
$$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and p.proname in ('aggregate_periods', 'aggregate_transfer_legs', 'batch_coverage')
  loop
    execute format('alter function %s owner to motion_definer', f.sig);
    execute format('revoke all on function %s from public, authenticated, anon', f.sig);
  end loop;
end $$;
