-- MOTION — Phase 5 (plan Phase 7) · A dimension that is not a row needs somewhere to live.
-- Contract: DATABASE_ARCHITECTURE.md §6 (`metric_snapshots`, `metric_current`);
-- FINANCIAL_ENGINE.md §3.1 (`expense_by_category`, dim `standard_category`).
--
-- `dimension_type` admits `standard_category`, but `dimension_id` is a `uuid` and a standard
-- category is a name, not a row — which is also why `same_org_ref` skips that discriminator. So the
-- schema declared a dimension it had nowhere to put: the engine writes `dimensionId: 'marketing'`
-- and Postgres rejects it as an invalid uuid. Nothing had written a category-dimensioned snapshot
-- before, so the defect surfaced only when the dashboard needed spending by category — a figure
-- Home level 4 and Insights both rest on.
--
-- `dimension_key` carries the non-uuid dimensions and joins both uniqueness keys. The alternative,
-- pointing `dimension_id` at the organisation's system account for that category, would have
-- silently turned a category breakdown into an account breakdown and made "spending by category"
-- disagree with "spending by account" for any organisation that also posts to a named account in
-- the same category.

alter table public.metric_snapshots add column dimension_key text;
alter table public.metric_current   add column dimension_key text;

comment on column public.metric_snapshots.dimension_key is
  'The dimension identifier when it is not a row: a standard category name. Exactly one of '
  'dimension_id and dimension_key is set for a dimensioned snapshot (DATABASE_ARCHITECTURE.md §6).';

alter table public.metric_snapshots
  add constraint metric_snapshots_dimension_shape check (
    (dimension_type = 'none' and dimension_id is null and dimension_key is null)
    or (dimension_type = 'standard_category' and dimension_id is null and dimension_key is not null)
    or (dimension_type in ('account', 'counterparty', 'bank_account') and dimension_key is null)
  );

-- The uniqueness rule gains the new column. NULLS NOT DISTINCT still matters: `dimension_id` is
-- NULL for the `none` dimension and for the synthetic "Unattributed" row, and under the default
-- those would be free to duplicate without limit.
drop index metric_snapshots_cell_unique;
create unique index metric_snapshots_cell_unique
  on public.metric_snapshots (organization_id, calculation_run_id, period_id, metric_key,
                              dimension_type, dimension_id, dimension_key) nulls not distinct;

drop index metric_current_cell_unique;
create unique index metric_current_cell_unique
  on public.metric_current (organization_id, period_id, metric_key,
                            dimension_type, dimension_id, dimension_key) nulls not distinct;
