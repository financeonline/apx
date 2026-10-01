# FU-12 engine regression record — 4.0.0 → 5.0.0

Generated 2026-10-01 by `npm run engine:compare` over the 27 regression organisations (`adr120-orgs` 7, `audit-orgs` 11, `audit2-orgs` 9). Both snapshots were taken the same day, each on a clean database: **before** at 5797306 (engine 4.0.0) and **after** on the ADR-126 tree (engine 5.0.0). They are compared with `npx tsx scripts/engine-compare.ts before.json after.json`.

Same-day snapshots matter here. `api.create_organization` creates fiscal periods relative to `now()`, so a snapshot taken before the 1 October UTC rollover has a different month window (2025-09…2027-08 against 2025-10…2027-09). Comparing across the rollover reports every organisation as changed (ADR-127).

## Summary

- **19 organisations unchanged**: every ledger, trial-balance, balance-sheet and bank organisation, plus INVBANK and LONG (no costs that only a purchase list could state).
- **8 changed**: INVONLY, CURRENT, CREDITHEAVY, PARTIALPD, BIGINV, BSREV, BSLIST, CNFUTURE. Each has invoice lists with **no full purchase list**, so on engine 4.0.0 their costs came from purchases no list established, or were 0.00.
- **Every one of the 154 changed figures** is `cost_of_sales`, `gross_profit`, `gross_margin`, `operating_expenses`, `operating_profit`, `net_profit` or `net_margin`. Each is now NULL `no_source_covers_period`. None became a different number, and none became zero.
  - Before, 95 of them were stated values and 6 were negative values.
  - The other 53 were already NULL with another reason (44 `no_cost_of_sales_accounts`, 7 `comparison_is_zero`, 2 with no reason).
  - INVONLY, for example, stated net profit = revenue and net margin 1.0000 in every month.
- **Health.** Only profitability and cost control change: they are now excluded with `required_metric_missing`, because their figures rested on unestablished costs. No rule, weight or threshold changed. Every changed score follows from that (the table below):
  - Some months fall below the minimum number of dimensions and are no longer scored.
  - Others are re-scored from the remaining dimensions, e.g. INVONLY July 72 → 51 and CREDITHEAVY July 58 → 32.
- **Alerts.** One removed: INVONLY `variance.significant` (info, 2026-07), which rested on the invented profit. None added.
- **Unchanged:** revenue, cash, receivables, payables and working capital in every organisation.

### Health scores that changed

| Organisation | Month | Before | After |
|---|---|---|---|
| INVONLY | 2026-06 | 67 (4 dims) | NULL (2 dims) |
| INVONLY | 2026-07 | 72 (5 dims) | 51 (3 dims) |
| INVONLY | 2026-08 | 70 (5 dims) | 49 (3 dims) |
| CURRENT | 2026-06 | NULL (2 dims) | NULL (1 dims) |
| CURRENT | 2026-07 | 67 (4 dims) | NULL (2 dims) |
| CURRENT | 2026-08 | 45 (3 dims) | NULL (2 dims) |
| CREDITHEAVY | 2026-06 | 67 (4 dims) | NULL (2 dims) |
| CREDITHEAVY | 2026-07 | 58 (5 dims) | 32 (3 dims) |
| CREDITHEAVY | 2026-08 | NULL (2 dims) | NULL (1 dims) |
| PARTIALPD | 2026-06 | 67 (4 dims) | NULL (2 dims) |
| PARTIALPD | 2026-07 | 55 (5 dims) | 26 (3 dims) |
| PARTIALPD | 2026-08 | 45 (3 dims) | NULL (2 dims) |
| BIGINV | 2026-06 | 59 (3 dims) | NULL (2 dims) |
| BIGINV | 2026-07 | 76 (5 dims) | 67 (3 dims) |
| BIGINV | 2026-08 | 50 (4 dims) | 47 (3 dims) |
| BSREV | 2026-03 | 67 (4 dims) | NULL (2 dims) |
| BSLIST | 2026-06 | NULL (2 dims) | NULL (1 dims) |
| BSLIST | 2026-07 | 70 (4 dims) | NULL (2 dims) |
| CNFUTURE | 2026-06 | NULL (2 dims) | NULL (1 dims) |
| CNFUTURE | 2026-07 | 67 (4 dims) | NULL (2 dims) |
| CNFUTURE | 2026-08 | NULL (2 dims) | NULL (1 dims) |

## Full generated record

| Organisation | Figure changes | Health changes | Alerts added | Alerts removed |
|---|---|---|---|---|
| BANK | 0 | 0 | 0 | 0 |
| INVBANK | 0 | 0 | 0 | 0 |
| INVONLY | 21 | 22 | 0 | 1 |
| LEDGER | 0 | 0 | 0 | 0 |
| TB | 0 | 0 | 0 | 0 |
| EMPTY | 0 | 0 | 0 | 0 |
| HISTORY | 0 | 0 | 0 | 0 |
| GAP | 0 | 0 | 0 | 0 |
| MIDSTART | 0 | 0 | 0 | 0 |
| LEDGER2 | 0 | 0 | 0 | 0 |
| TBBS | 0 | 0 | 0 | 0 |
| MOVTB | 0 | 0 | 0 | 0 |
| CURRENT | 28 | 13 | 0 | 0 |
| CREDITHEAVY | 21 | 17 | 0 | 0 |
| PARTIALPD | 21 | 18 | 0 | 0 |
| LONG | 0 | 0 | 0 | 0 |
| BIGINV | 21 | 13 | 0 | 0 |
| BSREV | 7 | 6 | 0 | 0 |
| GAPGL | 0 | 0 | 0 | 0 |
| PARTJUL | 0 | 0 | 0 | 0 |
| NEWACCT | 0 | 0 | 0 | 0 |
| BSLIST | 14 | 9 | 0 | 0 |
| LEDGER3 | 0 | 0 | 0 | 0 |
| UNRECON | 0 | 0 | 0 | 0 |
| CNFUTURE | 21 | 12 | 0 | 0 |
| MIDTYPED | 0 | 0 | 0 | 0 |
| CYCLE | 0 | 0 | 0 | 0 |

# Engine regression record: 4.0.0 → 5.0.0

## BANK

No change.

## INVBANK

No change.

## INVONLY

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-06 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-06 | net_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_profit | 2000.00 | NULL [no_source_covers_period] |
| 2026-07 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-07 | net_profit | 2000.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_profit | 2000.00 | NULL [no_source_covers_period] |
| 2026-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_profit | 2500.00 | NULL [no_source_covers_period] |
| 2026-08 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-08 | net_profit | 2500.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_profit | 2500.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | cost_control | 70 | excluded required_metric_missing |
| 2026-06 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-06 | profitability | 90 | excluded required_metric_missing |
| 2026-06 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-06 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-06 | score | 67 (4 dims) | NULL (2 dims) |
| 2026-07 | cost_control | 80 | excluded required_metric_missing |
| 2026-07 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-07 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-07 | profitability | 95 | excluded required_metric_missing |
| 2026-07 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-07 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-07 | profitability.P4 | >= +0.10 5 | skipped 0 |
| 2026-07 | score | 72 (5 dims) | 51 (3 dims) |
| 2026-08 | cost_control | 80 | excluded required_metric_missing |
| 2026-08 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-08 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-08 | profitability | 95 | excluded required_metric_missing |
| 2026-08 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-08 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-08 | profitability.P4 | >= +0.10 5 | skipped 0 |
| 2026-08 | score | 70 (5 dims) | 49 (3 dims) |

- alert removed: variance.significant · info · 2026-07

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
| 2026-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-07 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-07 | net_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-09 | gross_profit | 500.00 | NULL [no_source_covers_period] |
| 2026-09 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-09 | net_profit | 500.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-09 | operating_profit | 500.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | cost_control | 60 | excluded required_metric_missing |
| 2026-06 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-06 | score | NULL (2 dims) | NULL (1 dims) |
| 2026-07 | cost_control | 70 | excluded required_metric_missing |
| 2026-07 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-07 | profitability | 90 | excluded required_metric_missing |
| 2026-07 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-07 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-07 | score | 67 (4 dims) | NULL (2 dims) |
| 2026-08 | cost_control | 60 | excluded required_metric_missing |
| 2026-08 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-08 | profitability.P4 | <= -0.20 -10 | skipped 0 |
| 2026-08 | score | 45 (3 dims) | NULL (2 dims) |


## CREDITHEAVY

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-06 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-06 | net_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_profit | 800.00 | NULL [no_source_covers_period] |
| 2026-07 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-07 | net_profit | 800.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_profit | 800.00 | NULL [no_source_covers_period] |
| 2026-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_profit | -2500.00 | NULL [no_source_covers_period] |
| 2026-08 | net_margin | NULL | NULL [no_source_covers_period] |
| 2026-08 | net_profit | -2500.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_profit | -2500.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | cost_control | 70 | excluded required_metric_missing |
| 2026-06 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-06 | profitability | 90 | excluded required_metric_missing |
| 2026-06 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-06 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-06 | score | 67 (4 dims) | NULL (2 dims) |
| 2026-07 | cost_control | 80 | excluded required_metric_missing |
| 2026-07 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-07 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-07 | profitability | 80 | excluded required_metric_missing |
| 2026-07 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-07 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-07 | profitability.P4 | <= -0.20 -10 | skipped 0 |
| 2026-07 | score | 58 (5 dims) | 32 (3 dims) |
| 2026-08 | cost_control | 60 | excluded required_metric_missing |
| 2026-08 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-08 | score | NULL (2 dims) | NULL (1 dims) |


## PARTIALPD

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-06 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-06 | net_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_profit | 500.00 | NULL [no_source_covers_period] |
| 2026-07 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-07 | net_profit | 500.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_profit | 500.00 | NULL [no_source_covers_period] |
| 2026-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | cost_control | 70 | excluded required_metric_missing |
| 2026-06 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-06 | profitability | 90 | excluded required_metric_missing |
| 2026-06 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-06 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-06 | score | 67 (4 dims) | NULL (2 dims) |
| 2026-07 | cost_control | 80 | excluded required_metric_missing |
| 2026-07 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-07 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-07 | profitability | 80 | excluded required_metric_missing |
| 2026-07 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-07 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-07 | profitability.P4 | <= -0.20 -10 | skipped 0 |
| 2026-07 | score | 55 (5 dims) | 26 (3 dims) |
| 2026-08 | cost_control | 60 | excluded required_metric_missing |
| 2026-08 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-08 | profitability.P4 | <= -0.20 -10 | skipped 0 |
| 2026-08 | score | 45 (3 dims) | NULL (2 dims) |


## LONG

No change.

## BIGINV

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_profit | 10500.00 | NULL [no_source_covers_period] |
| 2026-07 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-07 | net_profit | 10500.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_profit | 10500.00 | NULL [no_source_covers_period] |
| 2026-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-08 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-08 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_profit | 0.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | cost_control | 50 | excluded required_metric_missing |
| 2026-06 | score | 59 (3 dims) | NULL (2 dims) |
| 2026-07 | cost_control | 80 | excluded required_metric_missing |
| 2026-07 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-07 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-07 | profitability | 90 | excluded required_metric_missing |
| 2026-07 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-07 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-07 | score | 76 (5 dims) | 67 (3 dims) |
| 2026-08 | cost_control | 60 | excluded required_metric_missing |
| 2026-08 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-08 | profitability.P4 | <= -0.20 -10 | skipped 0 |
| 2026-08 | score | 50 (4 dims) | 47 (3 dims) |


## BSREV

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-03 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-03 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-03 | gross_profit | 3000.00 | NULL [no_source_covers_period] |
| 2026-03 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-03 | net_profit | 3000.00 | NULL [no_source_covers_period] |
| 2026-03 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-03 | operating_profit | 3000.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-03 | cost_control | 70 | excluded required_metric_missing |
| 2026-03 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-03 | profitability | 90 | excluded required_metric_missing |
| 2026-03 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-03 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-03 | score | 67 (4 dims) | NULL (2 dims) |


## GAPGL

No change.

## PARTJUL

No change.

## NEWACCT

No change.

## BSLIST

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_profit | 5000.00 | NULL [no_source_covers_period] |
| 2026-07 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-07 | net_profit | 5000.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_profit | 5000.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | cost_control | 50 | excluded required_metric_missing |
| 2026-06 | score | NULL (2 dims) | NULL (1 dims) |
| 2026-07 | cost_control | 80 | excluded required_metric_missing |
| 2026-07 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-07 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-07 | profitability | 90 | excluded required_metric_missing |
| 2026-07 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-07 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-07 | score | 70 (4 dims) | NULL (2 dims) |


## LEDGER3

No change.

## UNRECON

No change.

## CNFUTURE

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-06 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-06 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-06 | gross_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | net_margin | NULL [comparison_is_zero] | NULL [no_source_covers_period, comparison_is_zero] |
| 2026-06 | net_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-06 | operating_profit | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-07 | gross_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-07 | net_margin | 1.0000 | NULL [no_source_covers_period] |
| 2026-07 | net_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | operating_profit | 1000.00 | NULL [no_source_covers_period] |
| 2026-08 | cost_of_sales | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_margin | NULL [no_cost_of_sales_accounts] | NULL [no_source_covers_period] |
| 2026-08 | gross_profit | -800.00 | NULL [no_source_covers_period] |
| 2026-08 | net_margin | NULL | NULL [no_source_covers_period] |
| 2026-08 | net_profit | -800.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_expenses | 0.00 | NULL [no_source_covers_period] |
| 2026-08 | operating_profit | -800.00 | NULL [no_source_covers_period] |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | cost_control | 60 | excluded required_metric_missing |
| 2026-06 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-06 | score | NULL (2 dims) | NULL (1 dims) |
| 2026-07 | cost_control | 70 | excluded required_metric_missing |
| 2026-07 | cost_control.K1 | <= 0.60 20 | skipped 0 |
| 2026-07 | profitability | 90 | excluded required_metric_missing |
| 2026-07 | profitability.P1 | >= 0.15 30 | skipped 0 |
| 2026-07 | profitability.P2 | >= 0.50 10 | skipped 0 |
| 2026-07 | score | 67 (4 dims) | NULL (2 dims) |
| 2026-08 | cost_control | 60 | excluded required_metric_missing |
| 2026-08 | cost_control.K3 | 0 10 | skipped 0 |
| 2026-08 | score | NULL (2 dims) | NULL (1 dims) |


## MIDTYPED

No change.

## CYCLE

No change.

