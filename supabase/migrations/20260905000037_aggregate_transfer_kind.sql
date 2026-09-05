-- MOTION — Phase 4 (plan Phase 6) · `transfer_kind` becomes a dimension of the bank aggregate.
-- Contract: FINANCIAL_ENGINE.md §2.4 step 4, §3.3; ADR-028.
--
-- The first version grouped transfer and non-transfer rows together, which made the correct answer
-- unrecoverable: a cash-like↔cash-like pair must cancel out of cash, while a card repayment on the
-- same account and in the same category must stay in it (ADR-028). With both folded into one cell
-- the engine cannot tell them apart, and a £3,000 repayment would either vanish from cash or a
-- genuine internal transfer would be counted as spending. Found while composing the cash module.
--
-- Adding the column to the group-by multiplies bank cells by at most the six transfer kinds, and in
-- practice by two, so the chunk budget is unaffected.

drop function if exists app.aggregate_periods(uuid, date, date, timestamptz);

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
  transfer_kind     public.transfer_kind_enum,
  unpaired_transfer boolean,
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
  ledger as (
    select e.period_id, 'ledger'::public.aggregate_source_enum, a.standard_category,
           e.account_id, e.counterparty_id, null::uuid, null::public.balance_kind_enum,
           null::public.balance_basis_enum, null::public.invoice_type_enum,
           null::public.transfer_kind_enum, false,
           sum(case when e.direction = 'debit' then e.amount else 0 end),
           sum(case when e.direction = 'credit' then e.amount else 0 end),
           sum(case when e.direction = 'debit' then e.amount else -e.amount end),
           count(*), min(e.entry_date), max(e.entry_date)
      from public.ledger_entries e
      join periods p on p.id = e.period_id
      join public.accounts a on a.organization_id = e.organization_id and a.id = e.account_id
     where e.organization_id = p_org and e.record_status = 'accepted'
       and e.superseded_by is null and e.created_at <= p_aggregated_at
     group by e.period_id, a.standard_category, e.account_id, e.counterparty_id
  ),
  balances as (
    select b.period_id, 'period_balances'::public.aggregate_source_enum, a.standard_category,
           b.account_id, null::uuid, null::uuid, b.balance_kind, b.balance_basis,
           null::public.invoice_type_enum, null::public.transfer_kind_enum, false,
           sum(coalesce(b.debit_total, 0)), sum(coalesce(b.credit_total, 0)),
           sum(b.closing_balance), count(*), min(b.period_start), max(b.period_start)
      from public.period_balances b
      join periods p on p.id = b.period_id
      join public.accounts a on a.organization_id = b.organization_id and a.id = b.account_id
     where b.organization_id = p_org and b.record_status = 'accepted'
       and b.superseded_by is null and b.created_at <= p_aggregated_at
     group by b.period_id, a.standard_category, b.account_id, b.balance_kind, b.balance_basis
  ),
  invoices as (
    select i.period_id, 'invoices'::public.aggregate_source_enum,
           null::public.standard_category_enum, null::uuid,
           coalesce(c.merged_into_id, i.counterparty_id), null::uuid,
           null::public.balance_kind_enum, null::public.balance_basis_enum, i.invoice_type,
           null::public.transfer_kind_enum, false,
           sum(coalesce(i.tax_amount, 0)), sum(coalesce(i.amount_paid, 0)),
           sum(case
                 when i.subtotal is not null and i.subtotal <> 0 then i.subtotal
                 when i.tax_amount is not null then i.total_amount - i.tax_amount
                 else i.total_amount
               end),
           count(*), min(i.issue_date), max(i.issue_date)
      from public.invoices i
      join periods p on p.id = i.period_id
      left join public.counterparties c
        on c.organization_id = i.organization_id and c.id = i.counterparty_id
     where i.organization_id = p_org and i.record_status = 'accepted'
       and i.superseded_by is null and i.status <> 'void' and i.created_at <= p_aggregated_at
     group by i.period_id, coalesce(c.merged_into_id, i.counterparty_id), i.invoice_type
  ),
  bank as (
    -- `transfer_kind` is a DIMENSION here, not a filter. Which legs count depends on the family
    -- asking: a cash_transfer pair cancels out of cash, a card_repayment does not, and the P&L
    -- excludes every kind (ADR-028). Filtering here would make the correct answer unrecoverable.
    select t.period_id, 'bank'::public.aggregate_source_enum, a.standard_category,
           t.category_account_id, coalesce(c.merged_into_id, t.counterparty_id), t.bank_account_id,
           null::public.balance_kind_enum, null::public.balance_basis_enum,
           null::public.invoice_type_enum,
           t.transfer_kind,
           -- A row that reads like a transfer but was never paired stays in the sums and raises a
           -- warning; making a real movement vanish on a description match would be worse.
           bool_or(t.is_transfer and t.transfer_pair_id is null),
           sum(case when t.amount > 0 then t.amount else 0 end),
           sum(case when t.amount < 0 then -t.amount else 0 end),
           sum(t.amount), count(*), min(t.transaction_date), max(t.transaction_date)
      from public.bank_transactions t
      join periods p on p.id = t.period_id
      left join public.accounts a
        on a.organization_id = t.organization_id and a.id = t.category_account_id
      left join public.counterparties c
        on c.organization_id = t.organization_id and c.id = t.counterparty_id
     where t.organization_id = p_org and t.record_status = 'accepted'
       and t.superseded_by is null and t.created_at <= p_aggregated_at
     group by t.period_id, a.standard_category, t.category_account_id,
              coalesce(c.merged_into_id, t.counterparty_id), t.bank_account_id, t.transfer_kind
  )
  select * from ledger
  union all select * from balances
  union all select * from invoices
  union all select * from bank
  order by 1, 2, 3, 4, 5, 6, 10;
$$;

alter function app.aggregate_periods(uuid, date, date, timestamptz) owner to motion_definer;
revoke all on function app.aggregate_periods(uuid, date, date, timestamptz)
  from public, authenticated, anon;
