# ADR-126 (FU-12) — Implementation record

**Status: IMPLEMENTED (engine 5.0.0). Not independently audited.**
- FU-12 is fixed, together with the defects two rounds of adversarial review found in the first cut: one blocker (variance), one major (current-month windows) and several minor findings.
- The owner approved fixing FU-12 before Phase 16 (2026-10-01). The comprehensive independent audit stays deferred until the remaining approved phases are built.
- **Nothing here is an audit approval, and nothing here declares the system production-ready.**
- Phase 16 (Funding Readiness) has not been started.

The decisions are in `ARCHITECTURAL_DECISIONS.md` ADR-126. The rule is in `FINANCIAL_ENGINE.md` §2.2 (costs) and §3.2 (dimension variances). The generated record is `docs/FU-12_ENGINE_REGRESSION_RECORD.md`. ADR-127 (same commit series) records three pre-existing date- and load-sensitive test failures found while gating, and the `finish_chunk` performance fix.

---

## 1. Root cause

FU-1 (ADR-125) made the invoices source cover a month's P&L only when full SALES lists establish it. Once covered, §2.3 hands that source the whole P&L, and the invoice basis builds every cost line from PURCHASE invoices folded by the supplier's default category (`compose.ts` `invoiceAccountAmounts`). Nothing asked whether any list established the purchases.

`pnl.ts` `coveredTotal` returns ZERO for a category with no cells, which is correct only when the source covers the period. With a sales list alone:
- `cost_of_sales`, every expense category and `operating_expenses` came out 0.00, calculated and complete;
- gross, operating and net profit equalled revenue;
- every margin was 100%;
- supplier concentration was stated over whatever stray purchase cells existed.

## 2. The fix (engine 5.0.0)

| Piece | Where | What |
|---|---|---|
| Purchase coverage | `coverage.ts` `invoiceListCoverage(…, side)`, `invoiceCostCoverage`, `PeriodCoverage.invoiceCosts` | FU-1's rules applied to full PURCHASE lists (`purchase_invoices` / `purchase_report`): effective range, combining, completed / current / future months. |
| Same days in the current month | `computeCoverage` | Current-month costs are covered only when the purchase reach equals the sales reach (equal completeness); otherwise NULL. |
| Cost side NULL when uncovered | `pnl.ts` (`costsUncovered`), `compose.ts` (`purchaseCoverage`) | Every expense line, profit, margin and contribution is NULL `no_source_covers_period`, ahead of the no-cost-of-sales-account path, and no expense category is written. |
| Unestablished purchases out of the fold | `compose.ts` `pnlCells` | No income category, no uncategorised share and no VAT counts from purchases no list establishes. |
| Supplier family | `concentration.ts` (`supplierCoverage`) | When uncovered: no `supplier_spend` rows, and supplier concentration NULL. When covered to date: `partial_month`. |
| Variance | `variance.ts` (`absentUnknown`), `variance-pass.ts` (`absentUnknownFor`) | An absent expense category in a month whose `operating_expenses` is NULL `no_source_covers_period` is unknown on either side, never a known zero; `other_income` follows `revenue`. |
| Days denominators | `receivables-input.ts` | `payablesExpenseBase` is NULL when costs are uncovered or stated only to date (the latter is defence in depth). |
| P&L page | `money.ts` `spendingKnown`, `profit-and-loss/page.tsx` | "This month's spending isn't known…" replaces "Nothing was recorded…" when nothing establishes the spending. |
| Version | `version.ts` | 5.0.0 (major). The golden was re-recorded; the corpus carries 11 FU-12 cases and an FU-12 variance case. |

## 3. Review findings and what was done

| # | Severity | Finding | Resolution |
|---|---|---|---|
| R1-1 | BLOCKER | A suppressed category row read as a known 0.00 by the variance pass ("Marketing −100%, favourable" in Insights and `get_expense_changes`) | Fixed (variance `absentUnknown`), with unit tests through the real `composePeriod` and `variancesForPeriod`, an integration check (PURCHSHORT) and a golden case |
| R1-2 | MAJOR | In the current month, revenue to the 25th against costs to the 3rd gave a 94% margin | Fixed: equal reach is required |
| R1-3 | MINOR | `payablesExpenseBase` from costs stated only to date | Guarded (now unreachable while R1-2 holds) |
| R1-4 | MINOR | `payables_days` gives `insufficient_history`, not `no_source_covers_period` | Kept: consistent with `receivables_days` when revenue is unknown; recorded |
| R1-5/6 | MINOR | Purchases defaulting to an income category reached `other_income` / revenue; unestablished purchases moved revenue's uncategorised share | Fixed (`pnlCells`) |
| R1-7 | MINOR | Uncovered cost lines keep descriptive components | Recorded (evidence is null) |
| R1-8 | MINOR | Mixed bases: a ledger P&L with an invoice counterparty basis leaves the supplier side NULL | Recorded in ADR-126 (follows §2.3) |
| R1-9 | MINOR | P&L page copy implied zero | Fixed |
| R2-1 | MINOR | Page copy assumed one cause | Copy covers both causes |
| R2-2 | MINOR | The variance change on every basis was undeclared | Declared in version.ts, ADR-126 and §3.2 |
| R2-3 | MINOR | One integration check was vacuous; the golden did not hash the invoice variance | August trailing-average check added; golden variance case added |
| R2-4 | MINOR | Dead guard | Comment says so |

## 4. Tests

New tests:
- `test/unit/fu12-cost-coverage.test.ts` (C1–C6, both directions of unequal reach)
- `test/unit/fu12-review.test.ts` (13: variance, the fold, denominators)
- `test/integration/fu12-remediation.test.ts` (24 over the 7 organisations in `test/fixtures/fu12-orgs.ts`, through the real queue, including the stale-engine sweep and the P&L page)
- golden: FU-12 cases and the variance case

Existing invoice-basis integration fixtures (`ai-gross-profit-availability`, `engine-invoice-golden`, `evidence-invoice-basis`, `evidence-merged-counterparty`, `evidence-reconciliation-sweep`, `evidence-void-invoice`) now commit the full purchase list their costs always assumed. No assertion changed.

## 5. Gates

All on the final tree, run one at a time on a clean database (2026-10-01):

| Gate | Result |
|---|---|
| tsc, eslint, `next build` | pass |
| Unit | 2,200 / 2,200, coverage gate met (financial-engine/domain ≥ 95% on every measure) |
| Eval | 253 / 253 |
| Integration | 893 / 893, the full suite with no failures (the `ai-eval-record` flake passed this run) |
| pgTAP | 1,102 / 1,102 |
| Schema drift | pass (55 tables, 127 api functions) |
| Playwright | 69 passed, 1 skipped |
| Meaningfulness | 7 of the 24 FU-12 integration tests fail on the 4.0.0 engine (5797306); the C2/C3 unit tests were mutation-checked (10 of the first 21 fail with the rule disabled); the golden guard fails with the rule reverted |
| 27-organisation record | `docs/FU-12_ENGINE_REGRESSION_RECORD.md`: 19 unchanged; 8 invoice-list organisations change, every changed figure from a value to NULL `no_source_covers_period` |

During the integration run the slowest statement was a `finish_chunk` call at 6.5 s against the 8 s statement timeout (load average about 10–15 on the gating machine). ADR-127's set-based lookup took the worst case from 5–9 s, but the chunk's row-by-row snapshot insert still scales with a month's cells. **Recorded as a residual risk** for organisations with several thousand customers.

## 6. Remaining

- FU-15 (AR/AP commit-date limit): open.
- FU-6 (no daily scheduled run; month rollover).
- FU-14's failed-run restore limit.
- R1-4, R1-7 and R1-8 above.
- The `finish_chunk` snapshot insert under load (section 5).
- FU-2, FU-3, FU-5 and FU-7 to FU-11: unchanged.

