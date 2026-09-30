# ADR-124 — Engine regression record (27 organisations, 2.0.0 → 3.0.0)

**An engine regression record, not an audit.** Generated, not written: the 27-organisation comparison set (`test/fixtures/adr120-orgs.ts` 7, `audit-orgs.ts` 11, `audit2-orgs.ts` 9) was seeded from an empty database and computed through the real queue (`calculation.run`, then `alerts.evaluate`, as of 2026-09-15) twice — once on the engine before ADR-124 (`b53a63a` code, engine 2.0.0), once on ADR-124 (engine 3.0.0) — with `npm run engine:compare`, and the two dumps were compared with `npx tsx scripts/engine-compare.ts before.json after.json`. Every headline cash, receivables, payables and working-capital figure (with its missing reasons), every Health dimension and rule result, and every alert (rule · severity · month · subject) is compared for every month. Nothing is suppressed: a line absent here did not change. The explanation of every change is in `docs/ADR-124.md` §6.

| Organisation | Figure changes | Health changes | Alerts added | Alerts removed |
|---|---|---|---|---|
| BANK | 1 | 0 | 0 | 0 |
| INVBANK | 1 | 0 | 0 | 0 |
| INVONLY | 0 | 0 | 0 | 0 |
| LEDGER | 1 | 0 | 0 | 0 |
| TB | 1 | 0 | 0 | 0 |
| EMPTY | 0 | 0 | 0 | 0 |
| HISTORY | 13 | 4 | 0 | 0 |
| GAP | 2 | 0 | 0 | 0 |
| MIDSTART | 5 | 35 | 1 | 0 |
| LEDGER2 | 0 | 0 | 0 | 0 |
| TBBS | 0 | 0 | 0 | 0 |
| MOVTB | 0 | 0 | 0 | 0 |
| CURRENT | 0 | 0 | 0 | 0 |
| CREDITHEAVY | 0 | 0 | 0 | 0 |
| PARTIALPD | 0 | 0 | 0 | 0 |
| LONG | 1 | 0 | 1 | 1 |
| BIGINV | 1 | 0 | 0 | 0 |
| BSREV | 0 | 0 | 0 | 0 |
| GAPGL | 4 | 4 | 0 | 0 |
| PARTJUL | 3 | 4 | 0 | 1 |
| NEWACCT | 20 | 146 | 4 | 0 |
| BSLIST | 2 | 0 | 0 | 0 |
| LEDGER3 | 1 | 0 | 0 | 0 |
| UNRECON | 1 | 0 | 0 | 0 |
| CNFUTURE | 0 | 0 | 0 | 0 |
| MIDTYPED | 6 | 30 | 1 | 0 |
| CYCLE | 10 | 84 | 4 | 0 |

# Engine regression record: 2.0.0 → 3.0.0

## BANK

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 11000.00 |


## INVBANK

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 4800.00 |


## INVONLY

No change.

## LEDGER

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 19100.00 |


## TB

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 3400.00 |


## EMPTY

No change.

## HISTORY

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-03 | closing_cash | NULL [no_opening_cash] | NULL [no_source_covers_period] |
| 2026-03 | net_cash_movement | 0.00 | NULL [no_source_covers_period] |
| 2026-03 | opening_cash | NULL [no_opening_cash] | NULL [no_source_covers_period] |
| 2026-03 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-04 | closing_cash | NULL [no_opening_cash] | NULL [no_source_covers_period] |
| 2026-04 | net_cash_movement | 0.00 | NULL [no_source_covers_period] |
| 2026-04 | opening_cash | NULL [no_opening_cash] | NULL [no_source_covers_period] |
| 2026-04 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-05 | closing_cash | NULL [no_opening_cash] | NULL [no_source_covers_period] |
| 2026-05 | net_cash_movement | 0.00 | NULL [no_source_covers_period] |
| 2026-05 | opening_cash | NULL [no_opening_cash] | NULL [no_source_covers_period] |
| 2026-05 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 10300.00 |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | cash_flow.C3 | positive in 1 of 3 0 | skipped 0 |
| 2026-07 | cash_flow | 75 | 60 |
| 2026-07 | cash_flow.C3 | positive in 2 of 3 15 | skipped 0 |
| 2026-07 | score | 75 (5 dims) | 71 (5 dims) |


## GAP

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-07 | opening_cash | NULL [no_source_covers_period] | 9000.00 |
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 3500.00 |


## MIDSTART

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-07 | closing_cash | NULL [no_opening_cash] | 5500.00 |
| 2026-07 | opening_cash | NULL [no_opening_cash] | 5000.00 |
| 2026-07 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-08 | cash_runway_months | NULL [insufficient_history] | 3.8 |
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 5600.00 |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | banking_health | — | 40 |
| 2026-06 | banking_health.B1 | — | skipped 0 |
| 2026-06 | banking_health.B2 | — | < 0.9 -15 |
| 2026-06 | banking_health.B3 | — | 1-2 -5 |
| 2026-06 | banking_health.B4 | — | full 10 |
| 2026-06 | cash_flow | — | 60 |
| 2026-06 | cash_flow.C1 | — | > 0 10 |
| 2026-06 | cash_flow.C2 | — | skipped 0 |
| 2026-06 | cash_flow.C3 | — | skipped 0 |
| 2026-06 | cash_flow.C4 | — | 0.5x to 2x 0 |
| 2026-06 | cost_control | — | excluded insufficient_completeness |
| 2026-06 | cost_control.K1 | — | skipped 0 |
| 2026-06 | cost_control.K2 | — | skipped 0 |
| 2026-06 | cost_control.K3 | — | skipped 0 |
| 2026-06 | customer_quality | — | excluded required_metric_missing |
| 2026-06 | customer_quality.Q1 | — | skipped 0 |
| 2026-06 | customer_quality.Q2 | — | skipped 0 |
| 2026-06 | customer_quality.Q3 | — | skipped 0 |
| 2026-06 | profitability | — | excluded required_metric_missing |
| 2026-06 | profitability.P1 | — | skipped 0 |
| 2026-06 | profitability.P2 | — | skipped 0 |
| 2026-06 | profitability.P3 | — | skipped 0 |
| 2026-06 | profitability.P4 | — | skipped 0 |
| 2026-06 | revenue_growth | — | excluded required_metric_missing |
| 2026-06 | revenue_growth.G1 | — | skipped 0 |
| 2026-06 | revenue_growth.G2 | — | skipped 0 |
| 2026-06 | revenue_growth.G3 | — | skipped 0 |
| 2026-06 | score | — | NULL (2 dims) |
| 2026-07 | cash_flow | excluded required_metric_missing | 60 |
| 2026-07 | cash_flow.C1 | skipped 0 | > 0 10 |
| 2026-07 | score | NULL (1 dims) | NULL (2 dims) |
| 2026-08 | banking_health | 70 | 85 |
| 2026-08 | banking_health.B1 | skipped 0 | rising for 3 months 15 |
| 2026-08 | cash_flow | 75 | 80 |
| 2026-08 | cash_flow.C2 | skipped 0 | 3 to 6 months 5 |

- alert added: bank.unusual_transaction · medium · 2026-06 · bank_transaction

## LEDGER2

No change.

## TBBS

No change.

## MOVTB

No change.

## CURRENT

No change.

## CREDITHEAVY

No change.

## PARTIALPD

No change.

## LONG

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 35000.00 |

- alert added: attention.overflow · info · 2026-09
- alert removed: attention.overflow · info · 2027-08

## BIGINV

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 970.00 |


## BSREV

No change.

## GAPGL

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-07 | closing_cash | 9000.00 | NULL [no_source_covers_period] |
| 2026-07 | net_cash_movement | 0.00 | NULL [no_source_covers_period] |
| 2026-07 | working_capital | 10000.00 | NULL [no_source_covers_period] |
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 3500.00 |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-08 | banking_health.B1 | no clear trend 0 | skipped 0 |
| 2026-08 | cash_flow | 45 | 65 |
| 2026-08 | cash_flow.C3 | negative in all 3 -20 | skipped 0 |
| 2026-08 | score | 52 (3 dims) | 62 (3 dims) |


## PARTJUL

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-07 | closing_cash | 7000.00 | NULL [no_source_covers_period] |
| 2026-07 | net_cash_movement | -2000.00 | NULL [no_source_covers_period] |
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 3500.00 |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-08 | banking_health | 40 | 55 |
| 2026-08 | banking_health.B1 | falling for 3 months -15 | skipped 0 |
| 2026-08 | cash_flow | 45 | 65 |
| 2026-08 | cash_flow.C3 | negative in all 3 -20 | skipped 0 |

- alert removed: cash.decline · high · 2026-08

## NEWACCT

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-04 | closing_cash | NULL [no_opening_cash] | 9000.00 |
| 2026-04 | opening_cash | NULL [no_opening_cash] | 9500.00 |
| 2026-04 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-05 | cash_runway_months | NULL [insufficient_history] | 17.0 |
| 2026-05 | closing_cash | NULL [no_opening_cash] | 8500.00 |
| 2026-05 | opening_cash | NULL [no_opening_cash] | 9000.00 |
| 2026-05 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-06 | cash_runway_months | NULL [insufficient_history] | 16.0 |
| 2026-06 | closing_cash | NULL [no_opening_cash] | 8000.00 |
| 2026-06 | opening_cash | NULL [no_opening_cash] | 8500.00 |
| 2026-06 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-07 | cash_runway_months | NULL [insufficient_history] | 15.0 |
| 2026-07 | closing_cash | NULL [no_opening_cash] | 7500.00 |
| 2026-07 | opening_cash | NULL [no_opening_cash] | 8000.00 |
| 2026-07 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-08 | cash_runway_months | NULL [insufficient_history] | 19.5 |
| 2026-08 | closing_cash | NULL [no_opening_cash] | 9100.00 |
| 2026-08 | opening_cash | NULL [no_opening_cash] | 9500.00 |
| 2026-08 | working_capital | NULL [no_opening_cash, no_source_covers_period] | NULL [no_source_covers_period] |
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 9100.00 |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-03 | banking_health | — | 55 |
| 2026-03 | banking_health.B1 | — | skipped 0 |
| 2026-03 | banking_health.B2 | — | < 0.9 -15 |
| 2026-03 | banking_health.B3 | — | 0 10 |
| 2026-03 | banking_health.B4 | — | full 10 |
| 2026-03 | cash_flow | — | 65 |
| 2026-03 | cash_flow.C1 | — | > 0 10 |
| 2026-03 | cash_flow.C2 | — | skipped 0 |
| 2026-03 | cash_flow.C3 | — | skipped 0 |
| 2026-03 | cash_flow.C4 | — | >= 2x 5 |
| 2026-03 | cost_control | — | excluded insufficient_completeness |
| 2026-03 | cost_control.K1 | — | skipped 0 |
| 2026-03 | cost_control.K2 | — | skipped 0 |
| 2026-03 | cost_control.K3 | — | skipped 0 |
| 2026-03 | customer_quality | — | excluded required_metric_missing |
| 2026-03 | customer_quality.Q1 | — | skipped 0 |
| 2026-03 | customer_quality.Q2 | — | skipped 0 |
| 2026-03 | customer_quality.Q3 | — | skipped 0 |
| 2026-03 | profitability | — | excluded required_metric_missing |
| 2026-03 | profitability.P1 | — | skipped 0 |
| 2026-03 | profitability.P2 | — | skipped 0 |
| 2026-03 | profitability.P3 | — | skipped 0 |
| 2026-03 | profitability.P4 | — | skipped 0 |
| 2026-03 | revenue_growth | — | excluded required_metric_missing |
| 2026-03 | revenue_growth.G1 | — | skipped 0 |
| 2026-03 | revenue_growth.G2 | — | skipped 0 |
| 2026-03 | revenue_growth.G3 | — | skipped 0 |
| 2026-03 | score | — | NULL (2 dims) |
| 2026-04 | banking_health | — | 55 |
| 2026-04 | banking_health.B1 | — | skipped 0 |
| 2026-04 | banking_health.B2 | — | < 0.9 -15 |
| 2026-04 | banking_health.B3 | — | 0 10 |
| 2026-04 | banking_health.B4 | — | full 10 |
| 2026-04 | cash_flow | — | 65 |
| 2026-04 | cash_flow.C1 | — | > 0 10 |
| 2026-04 | cash_flow.C2 | — | skipped 0 |
| 2026-04 | cash_flow.C3 | — | skipped 0 |
| 2026-04 | cash_flow.C4 | — | >= 2x 5 |
| 2026-04 | cost_control | — | excluded insufficient_completeness |
| 2026-04 | cost_control.K1 | — | skipped 0 |
| 2026-04 | cost_control.K2 | — | skipped 0 |
| 2026-04 | cost_control.K3 | — | skipped 0 |
| 2026-04 | customer_quality | — | excluded required_metric_missing |
| 2026-04 | customer_quality.Q1 | — | skipped 0 |
| 2026-04 | customer_quality.Q2 | — | skipped 0 |
| 2026-04 | customer_quality.Q3 | — | skipped 0 |
| 2026-04 | profitability | — | excluded required_metric_missing |
| 2026-04 | profitability.P1 | — | skipped 0 |
| 2026-04 | profitability.P2 | — | skipped 0 |
| 2026-04 | profitability.P3 | — | skipped 0 |
| 2026-04 | profitability.P4 | — | skipped 0 |
| 2026-04 | revenue_growth | — | excluded required_metric_missing |
| 2026-04 | revenue_growth.G1 | — | skipped 0 |
| 2026-04 | revenue_growth.G2 | — | skipped 0 |
| 2026-04 | revenue_growth.G3 | — | skipped 0 |
| 2026-04 | score | — | NULL (2 dims) |
| 2026-05 | banking_health | — | 40 |
| 2026-05 | banking_health.B1 | — | falling for 3 months -15 |
| 2026-05 | banking_health.B2 | — | < 0.9 -15 |
| 2026-05 | banking_health.B3 | — | 0 10 |
| 2026-05 | banking_health.B4 | — | full 10 |
| 2026-05 | cash_flow | — | 65 |
| 2026-05 | cash_flow.C1 | — | > 0 10 |
| 2026-05 | cash_flow.C2 | — | >= 6 months 20 |
| 2026-05 | cash_flow.C3 | — | negative in all 3 -20 |
| 2026-05 | cash_flow.C4 | — | >= 2x 5 |
| 2026-05 | cost_control | — | excluded insufficient_completeness |
| 2026-05 | cost_control.K1 | — | skipped 0 |
| 2026-05 | cost_control.K2 | — | skipped 0 |
| 2026-05 | cost_control.K3 | — | skipped 0 |
| 2026-05 | customer_quality | — | excluded required_metric_missing |
| 2026-05 | customer_quality.Q1 | — | skipped 0 |
| 2026-05 | customer_quality.Q2 | — | skipped 0 |
| 2026-05 | customer_quality.Q3 | — | skipped 0 |
| 2026-05 | profitability | — | excluded required_metric_missing |
| 2026-05 | profitability.P1 | — | skipped 0 |
| 2026-05 | profitability.P2 | — | skipped 0 |
| 2026-05 | profitability.P3 | — | skipped 0 |
| 2026-05 | profitability.P4 | — | skipped 0 |
| 2026-05 | revenue_growth | — | excluded required_metric_missing |
| 2026-05 | revenue_growth.G1 | — | skipped 0 |
| 2026-05 | revenue_growth.G2 | — | skipped 0 |
| 2026-05 | revenue_growth.G3 | — | skipped 0 |
| 2026-05 | score | — | NULL (2 dims) |
| 2026-06 | banking_health | — | 40 |
| 2026-06 | banking_health.B1 | — | falling for 3 months -15 |
| 2026-06 | banking_health.B2 | — | < 0.9 -15 |
| 2026-06 | banking_health.B3 | — | 0 10 |
| 2026-06 | banking_health.B4 | — | full 10 |
| 2026-06 | cash_flow | — | 65 |
| 2026-06 | cash_flow.C1 | — | > 0 10 |
| 2026-06 | cash_flow.C2 | — | >= 6 months 20 |
| 2026-06 | cash_flow.C3 | — | negative in all 3 -20 |
| 2026-06 | cash_flow.C4 | — | >= 2x 5 |
| 2026-06 | cost_control | — | excluded insufficient_completeness |
| 2026-06 | cost_control.K1 | — | skipped 0 |
| 2026-06 | cost_control.K2 | — | skipped 0 |
| 2026-06 | cost_control.K3 | — | skipped 0 |
| 2026-06 | customer_quality | — | excluded required_metric_missing |
| 2026-06 | customer_quality.Q1 | — | skipped 0 |
| 2026-06 | customer_quality.Q2 | — | skipped 0 |
| 2026-06 | customer_quality.Q3 | — | skipped 0 |
| 2026-06 | profitability | — | excluded required_metric_missing |
| 2026-06 | profitability.P1 | — | skipped 0 |
| 2026-06 | profitability.P2 | — | skipped 0 |
| 2026-06 | profitability.P3 | — | skipped 0 |
| 2026-06 | profitability.P4 | — | skipped 0 |
| 2026-06 | revenue_growth | — | excluded required_metric_missing |
| 2026-06 | revenue_growth.G1 | — | skipped 0 |
| 2026-06 | revenue_growth.G2 | — | skipped 0 |
| 2026-06 | revenue_growth.G3 | — | skipped 0 |
| 2026-06 | score | — | NULL (2 dims) |
| 2026-07 | banking_health | — | 40 |
| 2026-07 | banking_health.B1 | — | falling for 3 months -15 |
| 2026-07 | banking_health.B2 | — | < 0.9 -15 |
| 2026-07 | banking_health.B3 | — | 0 10 |
| 2026-07 | banking_health.B4 | — | full 10 |
| 2026-07 | cash_flow | — | 65 |
| 2026-07 | cash_flow.C1 | — | > 0 10 |
| 2026-07 | cash_flow.C2 | — | >= 6 months 20 |
| 2026-07 | cash_flow.C3 | — | negative in all 3 -20 |
| 2026-07 | cash_flow.C4 | — | >= 2x 5 |
| 2026-07 | cost_control | — | excluded insufficient_completeness |
| 2026-07 | cost_control.K1 | — | skipped 0 |
| 2026-07 | cost_control.K2 | — | skipped 0 |
| 2026-07 | cost_control.K3 | — | skipped 0 |
| 2026-07 | customer_quality | — | excluded required_metric_missing |
| 2026-07 | customer_quality.Q1 | — | skipped 0 |
| 2026-07 | customer_quality.Q2 | — | skipped 0 |
| 2026-07 | customer_quality.Q3 | — | skipped 0 |
| 2026-07 | profitability | — | excluded required_metric_missing |
| 2026-07 | profitability.P1 | — | skipped 0 |
| 2026-07 | profitability.P2 | — | skipped 0 |
| 2026-07 | profitability.P3 | — | skipped 0 |
| 2026-07 | profitability.P4 | — | skipped 0 |
| 2026-07 | revenue_growth | — | excluded required_metric_missing |
| 2026-07 | revenue_growth.G1 | — | skipped 0 |
| 2026-07 | revenue_growth.G2 | — | skipped 0 |
| 2026-07 | revenue_growth.G3 | — | skipped 0 |
| 2026-07 | score | — | NULL (2 dims) |
| 2026-08 | banking_health.B1 | skipped 0 | no clear trend 0 |
| 2026-08 | cash_flow | excluded required_metric_missing | 65 |
| 2026-08 | cash_flow.C1 | skipped 0 | > 0 10 |
| 2026-08 | cash_flow.C2 | skipped 0 | >= 6 months 20 |
| 2026-08 | cash_flow.C4 | skipped 0 | >= 2x 5 |
| 2026-08 | score | NULL (1 dims) | NULL (2 dims) |

- alert added: cash.decline · high · 2026-05
- alert added: cash.decline · high · 2026-06
- alert added: cash.decline · high · 2026-07
- alert added: cash.decline · high · 2026-08

## BSLIST

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-08 | receivables | 5000.00 | 3000.00 |
| 2026-08 | receivables_overdue | 5000.00 | NULL [no_due_dates] |


## LEDGER3

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-08 | receivables | 6000.00 | 5000.00 |


## UNRECON

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 700.00 |


## CNFUTURE

No change.

## MIDTYPED

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-07 | closing_cash | 10500.00 | 5500.00 |
| 2026-07 | opening_cash | 10000.00 | 5000.00 |
| 2026-08 | cash_runway_months | NULL [insufficient_history] | 3.8 |
| 2026-08 | closing_cash | 10600.00 | 5600.00 |
| 2026-08 | opening_cash | 10500.00 | 5500.00 |
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 5600.00 |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | banking_health | — | 40 |
| 2026-06 | banking_health.B1 | — | skipped 0 |
| 2026-06 | banking_health.B2 | — | < 0.9 -15 |
| 2026-06 | banking_health.B3 | — | 1-2 -5 |
| 2026-06 | banking_health.B4 | — | full 10 |
| 2026-06 | cash_flow | — | 60 |
| 2026-06 | cash_flow.C1 | — | > 0 10 |
| 2026-06 | cash_flow.C2 | — | skipped 0 |
| 2026-06 | cash_flow.C3 | — | skipped 0 |
| 2026-06 | cash_flow.C4 | — | 0.5x to 2x 0 |
| 2026-06 | cost_control | — | excluded insufficient_completeness |
| 2026-06 | cost_control.K1 | — | skipped 0 |
| 2026-06 | cost_control.K2 | — | skipped 0 |
| 2026-06 | cost_control.K3 | — | skipped 0 |
| 2026-06 | customer_quality | — | excluded required_metric_missing |
| 2026-06 | customer_quality.Q1 | — | skipped 0 |
| 2026-06 | customer_quality.Q2 | — | skipped 0 |
| 2026-06 | customer_quality.Q3 | — | skipped 0 |
| 2026-06 | profitability | — | excluded required_metric_missing |
| 2026-06 | profitability.P1 | — | skipped 0 |
| 2026-06 | profitability.P2 | — | skipped 0 |
| 2026-06 | profitability.P3 | — | skipped 0 |
| 2026-06 | profitability.P4 | — | skipped 0 |
| 2026-06 | revenue_growth | — | excluded required_metric_missing |
| 2026-06 | revenue_growth.G1 | — | skipped 0 |
| 2026-06 | revenue_growth.G2 | — | skipped 0 |
| 2026-06 | revenue_growth.G3 | — | skipped 0 |
| 2026-06 | score | — | NULL (2 dims) |
| 2026-08 | cash_flow | 75 | 80 |
| 2026-08 | cash_flow.C2 | skipped 0 | 3 to 6 months 5 |

- alert added: bank.unusual_transaction · medium · 2026-06 · bank_transaction

## CYCLE

| Month | Figure | Before | After |
|---|---|---|---|
| 2026-05 | closing_cash | 9000.00 | NULL [no_source_covers_period] |
| 2026-05 | net_cash_movement | -1000.00 | NULL [no_source_covers_period] |
| 2026-06 | closing_cash | 9000.00 | 8000.00 |
| 2026-06 | opening_cash | 10000.00 | 9000.00 |
| 2026-07 | closing_cash | 9000.00 | 7000.00 |
| 2026-07 | opening_cash | 10000.00 | 8000.00 |
| 2026-08 | cash_runway_months | NULL [insufficient_history] | 6.0 |
| 2026-08 | closing_cash | 9000.00 | 6000.00 |
| 2026-08 | opening_cash | 10000.00 | 7000.00 |
| 2026-09 | opening_cash | NULL [no_source_covers_period] | 6000.00 |

| Month | Health | Before | After |
|---|---|---|---|
| 2026-06 | banking_health | — | 40 |
| 2026-06 | banking_health.B1 | — | skipped 0 |
| 2026-06 | banking_health.B2 | — | < 0.9 -15 |
| 2026-06 | banking_health.B3 | — | 1-2 -5 |
| 2026-06 | banking_health.B4 | — | full 10 |
| 2026-06 | cash_flow | — | 65 |
| 2026-06 | cash_flow.C1 | — | > 0 10 |
| 2026-06 | cash_flow.C2 | — | skipped 0 |
| 2026-06 | cash_flow.C3 | — | skipped 0 |
| 2026-06 | cash_flow.C4 | — | >= 2x 5 |
| 2026-06 | cost_control | — | excluded insufficient_completeness |
| 2026-06 | cost_control.K1 | — | skipped 0 |
| 2026-06 | cost_control.K2 | — | skipped 0 |
| 2026-06 | cost_control.K3 | — | skipped 0 |
| 2026-06 | customer_quality | — | excluded required_metric_missing |
| 2026-06 | customer_quality.Q1 | — | skipped 0 |
| 2026-06 | customer_quality.Q2 | — | skipped 0 |
| 2026-06 | customer_quality.Q3 | — | skipped 0 |
| 2026-06 | profitability | — | excluded required_metric_missing |
| 2026-06 | profitability.P1 | — | skipped 0 |
| 2026-06 | profitability.P2 | — | skipped 0 |
| 2026-06 | profitability.P3 | — | skipped 0 |
| 2026-06 | profitability.P4 | — | skipped 0 |
| 2026-06 | revenue_growth | — | excluded required_metric_missing |
| 2026-06 | revenue_growth.G1 | — | skipped 0 |
| 2026-06 | revenue_growth.G2 | — | skipped 0 |
| 2026-06 | revenue_growth.G3 | — | skipped 0 |
| 2026-06 | score | — | NULL (2 dims) |
| 2026-07 | banking_health | — | 40 |
| 2026-07 | banking_health.B1 | — | skipped 0 |
| 2026-07 | banking_health.B2 | — | < 0.9 -15 |
| 2026-07 | banking_health.B3 | — | 1-2 -5 |
| 2026-07 | banking_health.B4 | — | full 10 |
| 2026-07 | cash_flow | — | 65 |
| 2026-07 | cash_flow.C1 | — | > 0 10 |
| 2026-07 | cash_flow.C2 | — | skipped 0 |
| 2026-07 | cash_flow.C3 | — | skipped 0 |
| 2026-07 | cash_flow.C4 | — | >= 2x 5 |
| 2026-07 | cost_control | — | excluded insufficient_completeness |
| 2026-07 | cost_control.K1 | — | skipped 0 |
| 2026-07 | cost_control.K2 | — | skipped 0 |
| 2026-07 | cost_control.K3 | — | skipped 0 |
| 2026-07 | customer_quality | — | excluded required_metric_missing |
| 2026-07 | customer_quality.Q1 | — | skipped 0 |
| 2026-07 | customer_quality.Q2 | — | skipped 0 |
| 2026-07 | customer_quality.Q3 | — | skipped 0 |
| 2026-07 | profitability | — | excluded required_metric_missing |
| 2026-07 | profitability.P1 | — | skipped 0 |
| 2026-07 | profitability.P2 | — | skipped 0 |
| 2026-07 | profitability.P3 | — | skipped 0 |
| 2026-07 | profitability.P4 | — | skipped 0 |
| 2026-07 | revenue_growth | — | excluded required_metric_missing |
| 2026-07 | revenue_growth.G1 | — | skipped 0 |
| 2026-07 | revenue_growth.G2 | — | skipped 0 |
| 2026-07 | revenue_growth.G3 | — | skipped 0 |
| 2026-07 | score | — | NULL (2 dims) |
| 2026-08 | banking_health | — | 25 |
| 2026-08 | banking_health.B1 | — | falling for 3 months -15 |
| 2026-08 | banking_health.B2 | — | < 0.9 -15 |
| 2026-08 | banking_health.B3 | — | 1-2 -5 |
| 2026-08 | banking_health.B4 | — | full 10 |
| 2026-08 | cash_flow | — | 65 |
| 2026-08 | cash_flow.C1 | — | > 0 10 |
| 2026-08 | cash_flow.C2 | — | >= 6 months 20 |
| 2026-08 | cash_flow.C3 | — | negative in all 3 -20 |
| 2026-08 | cash_flow.C4 | — | >= 2x 5 |
| 2026-08 | cost_control | — | excluded insufficient_completeness |
| 2026-08 | cost_control.K1 | — | skipped 0 |
| 2026-08 | cost_control.K2 | — | skipped 0 |
| 2026-08 | cost_control.K3 | — | skipped 0 |
| 2026-08 | customer_quality | — | excluded required_metric_missing |
| 2026-08 | customer_quality.Q1 | — | skipped 0 |
| 2026-08 | customer_quality.Q2 | — | skipped 0 |
| 2026-08 | customer_quality.Q3 | — | skipped 0 |
| 2026-08 | profitability | — | excluded required_metric_missing |
| 2026-08 | profitability.P1 | — | skipped 0 |
| 2026-08 | profitability.P2 | — | skipped 0 |
| 2026-08 | profitability.P3 | — | skipped 0 |
| 2026-08 | profitability.P4 | — | skipped 0 |
| 2026-08 | revenue_growth | — | excluded required_metric_missing |
| 2026-08 | revenue_growth.G1 | — | skipped 0 |
| 2026-08 | revenue_growth.G2 | — | skipped 0 |
| 2026-08 | revenue_growth.G3 | — | skipped 0 |
| 2026-08 | score | — | NULL (2 dims) |

- alert added: bank.unusual_transaction · high · 2026-07 · bank_transaction
- alert added: bank.unusual_transaction · high · 2026-08 · bank_transaction
- alert added: bank.unusual_transaction · medium · 2026-06 · bank_transaction
- alert added: cash.decline · high · 2026-08

