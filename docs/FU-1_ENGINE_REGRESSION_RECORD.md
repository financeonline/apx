# ADR-125 (FU-1) — Engine regression record (27 organisations, 3.0.0 → 4.0.0)

**This is an engine regression record, not an audit.** It was generated, not written.

**Method.** The method is the one used for `docs/ADR-124_ENGINE_REGRESSION_RECORD.md`:
- The 27-organisation comparison set (`test/fixtures/adr120-orgs.ts` 7, `audit-orgs.ts` 11, `audit2-orgs.ts` 9) was seeded from an empty database.
- It was computed through the real queue as of 2026-09-15 (`calculation.run`, then `alerts.evaluate`) with `npm run engine:compare`.
- This was done twice: once on `df9db4a` (ADR-124, engine 3.0.0) and once on ADR-125 (engine 4.0.0).
- The two dumps were compared with `npx tsx scripts/engine-compare.ts before.json after.json`.

**What is compared.** The comparison now follows the P&L family too: `revenue`, `cost_of_sales`, gross, operating and net profit, `operating_expenses`, the margins and `customer_concentration_top1`. It also covers every headline cash, receivables, payables and working-capital figure (with its missing reasons), every Health dimension and rule result, and every alert. Nothing is suppressed: a line absent here did not change.

**Reading it.**
- Every figure change is of one kind: a month no full sales list establishes goes from a manufactured P&L 0.00 to NULL `no_source_covers_period`. For the margins, the reason changes from `comparison_is_zero` / `no_cost_of_sales_accounts` to `no_source_covers_period`.
- CURRENT's September does not appear. Its value is unchanged; it is still revenue to date, but its warning is now `partial_month` instead of `open_items_only`, and warnings are not compared.
- BSREV's Health lines are February's score being withdrawn.
- No alert was added or removed.
- The explanation is in `docs/FU-1_IMPLEMENTATION.md` §7 and in `ARCHITECTURAL_DECISIONS.md` ADR-125.

---

| Organisation | Figure changes | Health changes | Alerts added | Alerts removed |
|---|---|---|---|---|
| BANK | 0 | 0 | 0 | 0 |
| INVBANK | 96 | 0 | 0 | 0 |
| INVONLY | 96 | 0 | 0 | 0 |
| LEDGER | 0 | 0 | 0 | 0 |
| TB | 0 | 0 | 0 | 0 |
| EMPTY | 0 | 0 | 0 | 0 |
| HISTORY | 0 | 0 | 0 | 0 |
| GAP | 0 | 0 | 0 | 0 |
| MIDSTART | 0 | 0 | 0 | 0 |
| LEDGER2 | 0 | 0 | 0 | 0 |
| TBBS | 0 | 0 | 0 | 0 |
| MOVTB | 0 | 0 | 0 | 0 |
| CURRENT | 88 | 0 | 0 | 0 |
| CREDITHEAVY | 96 | 0 | 0 | 0 |
| PARTIALPD | 96 | 0 | 0 | 0 |
| LONG | 96 | 0 | 0 | 0 |
| BIGINV | 96 | 0 | 0 | 0 |
| BSREV | 144 | 28 | 0 | 0 |
| GAPGL | 0 | 0 | 0 | 0 |
| PARTJUL | 0 | 0 | 0 | 0 |
| NEWACCT | 0 | 0 | 0 | 0 |
| BSLIST | 104 | 0 | 0 | 0 |
| LEDGER3 | 0 | 0 | 0 | 0 |
| UNRECON | 0 | 0 | 0 | 0 |
| CNFUTURE | 96 | 0 | 0 | 0 |
| MIDTYPED | 0 | 0 | 0 | 0 |
| CYCLE | 0 | 0 | 0 | 0 |

# Engine regression record: 3.0.0 → 4.0.0

## BANK

No change.

## INVBANK

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## INVONLY

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## LEDGER

No change.

## TB

No change.

## EMPTY

No change.

## HISTORY

No change.

## GAP

No change.

## MIDSTART

No change.

## LEDGER2

No change.

## TBBS

No change.

## MOVTB

No change.

## CURRENT

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-10 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## CREDITHEAVY

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## PARTIALPD

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## LONG

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## BIGINV

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## BSREV

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-02 | banking_health | 60 | — |
| 2026-02 | banking_health.B1 | skipped 0 | — |
| 2026-02 | banking_health.B2 | skipped 0 | — |
| 2026-02 | banking_health.B3 | skipped 0 | — |
| 2026-02 | banking_health.B4 | full 10 | — |
| 2026-02 | cash_flow | excluded required_metric_missing | — |
| 2026-02 | cash_flow.C1 | skipped 0 | — |
| 2026-02 | cash_flow.C2 | skipped 0 | — |
| 2026-02 | cash_flow.C3 | skipped 0 | — |
| 2026-02 | cash_flow.C4 | skipped 0 | — |
| 2026-02 | cost_control | 60 | — |
| 2026-02 | cost_control.K1 | skipped 0 | — |
| 2026-02 | cost_control.K2 | skipped 0 | — |
| 2026-02 | cost_control.K3 | 0 10 | — |
| 2026-02 | customer_quality | excluded required_metric_missing | — |
| 2026-02 | customer_quality.Q1 | skipped 0 | — |
| 2026-02 | customer_quality.Q2 | skipped 0 | — |
| 2026-02 | customer_quality.Q3 | skipped 0 | — |
| 2026-02 | profitability | excluded required_metric_missing | — |
| 2026-02 | profitability.P1 | skipped 0 | — |
| 2026-02 | profitability.P2 | skipped 0 | — |
| 2026-02 | profitability.P3 | skipped 0 | — |
| 2026-02 | profitability.P4 | skipped 0 | — |
| 2026-02 | revenue_growth | excluded required_metric_missing | — |
| 2026-02 | revenue_growth.G1 | skipped 0 | — |
| 2026-02 | revenue_growth.G2 | skipped 0 | — |
| 2026-02 | revenue_growth.G3 | skipped 0 | — |
| 2026-02 | score | NULL (2 dims) | — |


## GAPGL

No change.

## PARTJUL

No change.

## NEWACCT

No change.

## BSLIST

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## LEDGER3

No change.

## UNRECON

No change.

## CNFUTURE

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-10 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-10 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-10 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-11 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-11 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-11 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-12 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2026-12 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-12 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-01 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-01 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-01 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-02 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-02 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-02 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-03 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-03 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-03 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-04 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-04 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-04 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-05 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-05 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-05 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-06 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-07 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-07 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-07 | revenue | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2027-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period] |
| 2027-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2027-08 | revenue | 0.00 | NULL [no_source_covers_period] |


## MIDTYPED

No change.

## CYCLE

No change.

