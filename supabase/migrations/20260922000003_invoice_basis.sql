-- MOTION — Phase 14 remediation · one net-of-tax rule, and the invoice basis carries its VAT signal.
-- Contract: FINANCIAL_ENGINE.md §2.1, §3, §3.1; ADR-027.4; ADR-047.5; ADR-103.
--
-- Two defects, one family.
--
-- (1) The net-of-tax rule existed three times and agreed twice. `app.aggregate_periods` and
--     `sign.ts#invoiceNetOfTax` both treat a `subtotal` of 0 beside a positive total as ABSENT (an
--     exporter that leaves the column blank writes 0), and fall back to `total − tax`. Phase 14's
--     `api.set_invoice_lines` and `api.product_period_summary` used a plain `coalesce(subtotal, …)`,
--     which takes that 0 — so on such an invoice the engine counted `total − tax` while the line
--     functions counted nothing: every line was refused as "more than the invoice" and the month's
--     unattributed sales read 0.00. The rule now lives in ONE place, `app.invoice_net`, and every
--     SQL caller uses it. `sign.ts#invoiceNetOfTax` is its TypeScript mirror and is tested against
--     the same table of cases.
--
-- (2) The invoice basis could not report VAT exposure. §3 requires the metric to carry
--     `vat_inclusive` when a contributing row fell back to `total_amount`, and to drop to
--     `estimated` past a 10% share of rows — a figure standing in for a net one is an overstatement
--     of revenue. The aggregate summed the nets but never said how many rows had no tax to remove,
--     so `PnlInput.invoiceVat` could never be populated. The aggregate now carries
--     `fallback_rows` per cell, and the engine folds it into the figure's data quality.

-- ---------------------------------------------------------------------------------------------
-- 1. The one rule
-- ---------------------------------------------------------------------------------------------
-- Pure arithmetic on its arguments: no table, no GUC, no clock (the ADR-049 narrowing, mirrored in
-- `scripts/check-schema-drift.ts`). `immutable` so it can sit in an index or a grouped expression.
create function app.invoice_net(p_subtotal numeric, p_tax numeric, p_total numeric)
returns numeric language sql immutable set search_path = '' as $$
  select case
           when p_subtotal is not null and not (p_subtotal = 0 and p_total > 0) then p_subtotal
           when p_tax is not null then p_total - p_tax
           else p_total
         end;
$$;
comment on function app.invoice_net(numeric, numeric, numeric) is
  'The net-of-tax amount of one invoice header (FINANCIAL_ENGINE.md §3): `subtotal`, else '
  '`total_amount − tax_amount`, else `total_amount`. A `subtotal` of 0 beside a positive total '
  'counts as ABSENT — exporters that do not carry the column write 0. Mirrored in TypeScript by '
  '`financial-engine/domain/sign.ts#invoiceNetOfTax`; both are tested against the same cases.';

-- True exactly when the rule had to stand `total_amount` in for a net figure — the row is
-- VAT-inclusive if the organisation charges VAT, which §3 reports rather than silently accepts.
create function app.invoice_net_is_vat_fallback(p_subtotal numeric, p_tax numeric, p_total numeric)
returns boolean language sql immutable set search_path = '' as $$
  select not (p_subtotal is not null and not (p_subtotal = 0 and p_total > 0)) and p_tax is null;
$$;

alter function app.invoice_net(numeric, numeric, numeric) owner to motion_definer;
alter function app.invoice_net_is_vat_fallback(numeric, numeric, numeric) owner to motion_definer;
revoke all on function app.invoice_net(numeric, numeric, numeric) from public, authenticated, anon;
revoke all on function app.invoice_net_is_vat_fallback(numeric, numeric, numeric) from public, authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- 2. The aggregate: same shape plus `fallback_rows`, and the rule by name
-- ---------------------------------------------------------------------------------------------
drop function if exists api_server.aggregate_periods(uuid, date, date, timestamptz);
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
  max_date          date,
  -- Contributing rows whose net had to fall back to `total_amount` (§3). Always 0 outside the
  -- invoice source, which has no such rule.
  fallback_rows     bigint
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
           count(*), min(e.entry_date), max(e.entry_date), 0::bigint
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
           sum(b.closing_balance), count(*), min(b.period_start), max(b.period_start), 0::bigint
      from public.period_balances b
      join periods p on p.id = b.period_id
      join public.accounts a on a.organization_id = b.organization_id and a.id = b.account_id
     where b.organization_id = p_org and b.record_status = 'accepted'
       and b.superseded_by is null and b.created_at <= p_aggregated_at
     group by b.period_id, a.standard_category, b.account_id, b.balance_kind, b.balance_basis
  ),
  invoices as (
    -- `standard_category` and `account_id` stay NULL: an invoice header has no account, and
    -- inventing one here would put the chart's rule in two places. The engine derives the category
    -- from `invoice_type` and the counterparty's `default_expense_category` (§2.1, ADR-103).
    select i.period_id, 'invoices'::public.aggregate_source_enum,
           null::public.standard_category_enum, null::uuid,
           coalesce(c.merged_into_id, i.counterparty_id), null::uuid,
           null::public.balance_kind_enum, null::public.balance_basis_enum, i.invoice_type,
           null::public.transfer_kind_enum, false,
           sum(coalesce(i.tax_amount, 0)), sum(coalesce(i.amount_paid, 0)),
           sum(app.invoice_net(i.subtotal, i.tax_amount, i.total_amount)),
           count(*), min(i.issue_date), max(i.issue_date),
           count(*) filter (
             where app.invoice_net_is_vat_fallback(i.subtotal, i.tax_amount, i.total_amount))
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
           sum(t.amount), count(*), min(t.transaction_date), max(t.transaction_date), 0::bigint
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

create function api_server.aggregate_periods(
  p_org uuid, p_from date, p_to date, p_aggregated_at timestamptz default now()
) returns table (
  period_id uuid, source public.aggregate_source_enum,
  standard_category public.standard_category_enum, account_id uuid, counterparty_id uuid,
  bank_account_id uuid, balance_kind public.balance_kind_enum,
  balance_basis public.balance_basis_enum, invoice_type public.invoice_type_enum,
  transfer_kind public.transfer_kind_enum, unpaired_transfer boolean,
  debit numeric, credit numeric, amount numeric, row_count bigint,
  min_date date, max_date date, fallback_rows bigint
)
language plpgsql security definer set search_path = '' as $$
begin
  if app.role_claim() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: api_server is callable only by the server' using errcode = '42501';
  end if;
  return query select * from app.aggregate_periods(p_org, p_from, p_to, p_aggregated_at);
end $$;

alter function api_server.aggregate_periods(uuid, date, date, timestamptz) owner to motion_definer;
revoke all on function api_server.aggregate_periods(uuid, date, date, timestamptz)
  from public, authenticated, anon;
grant execute on function api_server.aggregate_periods(uuid, date, date, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Phase 14's two invoice readers take the same rule (MEDIUM-1)
-- ---------------------------------------------------------------------------------------------
create or replace function api.set_invoice_lines(p_invoice uuid, p_lines jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid; v_net numeric; v_status public.record_status_enum; v_superseded uuid;
  v_sum numeric := 0; v_count integer := 0; l jsonb; v_product uuid;
begin
  select i.organization_id, app.invoice_net(i.subtotal, i.tax_amount, i.total_amount),
         i.record_status, i.superseded_by
    into v_org, v_net, v_status, v_superseded
    from public.invoices i where i.id = p_invoice;
  if v_org is null or v_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_commercial_edit(v_org);
  if v_status <> 'accepted' or v_superseded is not null then
    raise exception 'CONFLICT: only a current, accepted invoice can be split into lines' using errcode = '40001';
  end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_product := nullif(l ->> 'product_id', '')::uuid;
    if v_product is not null and not exists (
      select 1 from public.products p where p.organization_id = v_org and p.id = v_product
    ) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    if (l ->> 'amount') is null or (l ->> 'amount')::numeric < 0 then
      raise exception 'VALIDATION: every line needs an amount of zero or more' using errcode = '22023';
    end if;
    v_sum := v_sum + (l ->> 'amount')::numeric;
  end loop;
  if v_sum > abs(v_net) + 0.005 then
    raise exception 'VALIDATION: the lines add up to more than the invoice' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('invoice:' || p_invoice::text));
  delete from public.invoice_lines where organization_id = v_org and invoice_id = p_invoice;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    insert into public.invoice_lines (organization_id, invoice_id, product_id, description, quantity, amount, sort_order, created_by)
    values (v_org, p_invoice, nullif(l ->> 'product_id', '')::uuid, nullif(l ->> 'description', ''),
            nullif(l ->> 'quantity', '')::numeric, (l ->> 'amount')::numeric, v_count, app.uid());
    v_count := v_count + 1;
  end loop;
  perform app.audit(v_org, 'invoice.lines_set', 'invoices', p_invoice, null,
                    jsonb_build_object('lines', v_count, 'attributed', v_sum, 'net', v_net), '{}'::jsonb);
  return v_count;
end $$;

-- Product figures: the same rows, the same net rule, and the customer mix keyed by the SURVIVING
-- counterparty so a merge cannot silently drop a product's customers (MEDIUM-3, ADR-103).
create or replace function api.product_period_summary(p_org uuid, p_period_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_products jsonb; v_unattributed jsonb; v_mix jsonb;
begin
  if p_org not in (select app.accessible_org_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_permission(p_org, 'customers.view');

  with lines as (
    select l.product_id, i.period_id, coalesce(c.merged_into_id, i.counterparty_id) as counterparty_id,
           i.invoice_type, l.invoice_id,
           case when i.invoice_type in ('sales', 'sales_credit_note')
                then case when i.invoice_type = 'sales' then l.amount else -l.amount end end as sales,
           case when i.invoice_type in ('purchase', 'purchase_credit_note')
                then case when i.invoice_type = 'purchase' then l.amount else -l.amount end end as cost
      from public.invoice_lines l
      join public.invoices i on i.organization_id = l.organization_id and i.id = l.invoice_id
      left join public.counterparties c
        on c.organization_id = i.organization_id and c.id = i.counterparty_id
     where l.organization_id = p_org and i.period_id = any(p_period_ids)
       and i.record_status = 'accepted' and i.superseded_by is null and i.status <> 'void'
  )
  select coalesce(jsonb_agg(row_to_json(x) order by x.product_id, x.period_id), '[]'::jsonb) into v_products
    from (
      select product_id, period_id,
             sum(coalesce(sales, 0))::text as sales, sum(coalesce(cost, 0))::text as cost,
             count(*) filter (where sales is not null)::int as sales_lines,
             count(*) filter (where cost is not null)::int as cost_lines,
             count(distinct invoice_id)::int as invoices
        from lines group by product_id, period_id
    ) x;

  select coalesce(jsonb_agg(row_to_json(u) order by u.period_id), '[]'::jsonb) into v_unattributed
    from (
      select i.period_id,
             sum(case when i.invoice_type = 'sales' then 1 else -1 end
                 * app.invoice_net(i.subtotal, i.tax_amount, i.total_amount))::text as sales_net,
             coalesce((select sum(case when j.invoice_type = 'sales' then l.amount else -l.amount end)
                         from public.invoice_lines l join public.invoices j on j.organization_id = l.organization_id and j.id = l.invoice_id
                        where l.organization_id = p_org and j.period_id = i.period_id and l.product_id is not null
                          and j.invoice_type in ('sales', 'sales_credit_note')
                          and j.record_status = 'accepted' and j.superseded_by is null and j.status <> 'void'), 0)::text as attributed,
             count(*)::int as invoices,
             count(*) filter (where not exists (select 1 from public.invoice_lines l where l.organization_id = i.organization_id and l.invoice_id = i.id))::int as invoices_without_lines
        from public.invoices i
       where i.organization_id = p_org and i.period_id = any(p_period_ids)
         and i.invoice_type in ('sales', 'sales_credit_note')
         and i.record_status = 'accepted' and i.superseded_by is null and i.status <> 'void'
       group by i.period_id
    ) u;

  with lines as (
    select l.product_id, coalesce(c.merged_into_id, i.counterparty_id) as counterparty_id,
           case when i.invoice_type = 'sales' then l.amount when i.invoice_type = 'sales_credit_note' then -l.amount end as sales
      from public.invoice_lines l
      join public.invoices i on i.organization_id = l.organization_id and i.id = l.invoice_id
      left join public.counterparties c
        on c.organization_id = i.organization_id and c.id = i.counterparty_id
     where l.organization_id = p_org and i.period_id = any(p_period_ids) and l.product_id is not null
       and i.invoice_type in ('sales', 'sales_credit_note')
       and i.record_status = 'accepted' and i.superseded_by is null and i.status <> 'void'
  )
  select coalesce(jsonb_agg(row_to_json(m) order by m.product_id, m.sales desc), '[]'::jsonb) into v_mix
    from (select product_id, counterparty_id, sum(sales) as sales, count(*)::int as lines from lines group by product_id, counterparty_id) m;

  return jsonb_build_object('products', v_products, 'unattributed', v_unattributed, 'customer_mix', v_mix);
end $$;
