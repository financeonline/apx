# Phase 14 — remediation before Phase 15

> Date: 2026-09-22. Answers `PHASE_14_FINAL_AUDIT.md`: HIGH-1 (invoice-basis P&L), MEDIUM-1 (net-of-tax divergence), MEDIUM-2 (unattributed ranked as a customer), MEDIUM-3 (merged counterparties lose commercial attribution). Decision record: ADR-103. Phase 15 was not started; no CRM, lender, partner, ESG or knowledge-base work was touched.

## 1. Root cause of the invoice-basis defect

Traced end to end before anything was changed, from `invoices` to the dashboard:

| Step | What happens | Verdict |
|---|---|---|
| Import commits an invoice | header row in `public.invoices` with `subtotal`, `tax_amount`, `total_amount` | correct |
| `app.aggregate_periods` | emits one invoice cell per period × counterparty × `invoice_type`, with `account_id` and `standard_category` **NULL** (an invoice header has no account) and `amount` = Σ net-of-tax | correct by design |
| `compose.ts#accountAmounts` | `if (!cell.accountId) continue;` — it walks ACCOUNTS | **the defect**: on the invoice basis it folded nothing |
| `pnl.ts#coveredTotal('revenue')` | the category is not `present`, and the source covers the period, so it returns a **covered zero** (§3.1's rule that a covered source with no line means zero) | correct given a wrong input |
| `compose.ts#uncategorisedExposure` | counts every cell whose `standardCategory` is NULL as uncategorised → 100% of the month | **second half of the defect** |
| `buildRevenue` | `uncategorised / |revenue|` exceeds both thresholds → `uncategorised_amounts`, `uncategorised_amounts_exceed_threshold`, assurance `estimated` | correct given a wrong input |
| `compose.ts#counterpartyAmounts` | reads `invoice_type` DIRECTLY, so it never depended on the account | why customer revenue was right |

Two further faults in the same family, found while tracing:

- `counterpartyAmounts` took each invoice cell's **magnitude**, which is right for a ledger or bank cell (the sign is the account's) and wrong for an invoice, where ADR-047.5 stores every money field positive and puts the sign in the type. A sales credit note therefore **increased** a customer's revenue.
- `PnlInput.invoiceVat` existed and was never populated: the aggregate summed nets but never said how many rows had no tax to remove, so §3's `vat_inclusive` warning and its 10% `estimated` threshold could not fire on the only basis that needs them.
- `loadCostOfSalesEverUsed` asked only `ledger_entries` and `period_balances` whether the system cost-of-sales account had "ever carried a figure". Invoices carry figures without an account, so an invoice-only business was told it does not track cost of sales and `gross_profit` silently became revenue (CD-05, ADR-063).

**Precedence is not the defect and was not changed.** `period_balances → ledger → invoices → bank` is intended: an accrual source outranks a cash proxy. What made it look wrong is that the invoice fold produced nothing, so an organisation with invoices *and* bank statements lost the bank proxy and gained a zero. With the fold working, precedence gives the accrual answer, which is the right one.

## 2. Corrected financial behaviour

`compose.ts` now folds the invoice source (ADR-103):

- **Category** — sales and sales credit notes → `revenue`; purchases and purchase credit notes → the counterparty's `default_expense_category`, else `uncategorised` (FINANCIAL_ENGINE.md §2.1).
- **Sign** — `invoiceSignFor` applied exactly once, so credit notes subtract.
- **Home** — the organisation's system account for the category; a category missing from the chart falls back to `uncategorised` so the money stays visible.
- **Uncategorised share** — measured on what the figure REPORTS, so a purchase nobody has categorised raises §3.1's warning and, past 25%, marks the month `estimated`.
- **VAT** — `fallback_rows` from the aggregate drives `vat_inclusive`, and past a tenth of contributing rows the figure is `estimated`.
- **Customer family** — invoice cells are signed by type there too, so `Σ customer_revenue + unattributed = revenue` holds with credit notes in the month.
- **Cost of sales** — a purchase from a supplier whose default category is `cost_of_sales` counts as the system account having carried a figure.

Nothing else moved: no new metric, no new job, no fingerprint input beyond the aggregate's own contents, no change to any other basis. Ledger, trial-balance and bank organisations compute exactly as before (their suites are unchanged and green).

## 3. Invoice-only golden case

`test/integration/engine-invoice-golden.test.ts`, organisation A — a full sales-invoice list and a purchase list, no bank, driven through the real queue:

| Row | Net |
|---|---|
| Acme A-001 | 6,000.00 (+1,200.00 VAT) |
| Acme A-C01 credit note | −500.00 |
| Beta B-001 | 2,000.00 |
| Beta B-002, `subtotal = 0` beside a 1,260.00 gross with 210.00 VAT | 1,050.00 |
| Parts P-001 purchase, supplier's default category `cost_of_sales` | 900.00 |

Asserted: `revenue = 8,550.00` on basis `invoices`; `cost_of_sales = 900.00`; `gross_profit = 7,650.00`; `net_profit = 7,650.00`; `customer_revenue` Acme 5,500.00 · Beta 3,050.00 · unattributed 0.00, summing to revenue to the penny; `customer_concentration_top1 = 0.643275`; no `uncategorised_amounts_exceed_threshold`. Every one of those fails against the old behaviour (revenue 0.00, cost of sales NULL, no concentration). The unit-level golden is `test/unit/engine-invoice-basis.test.ts` (10 cases, including the VAT threshold and a chart missing a category).

## 4. Bank + invoice golden case

Same file, organisation B — one 4,000.00 net invoice and a bank statement carrying the 4,800.00 gross receipt for it plus 1,000.00 of rent:

- `revenue = 4,000.00`, basis `invoices` — the approved precedence, not a changed expectation. Explicitly **not** 4,800.00 (the gross receipt) and **not** 8,800.00 (receipt plus anything).
- `closing_cash = 8,800.00`, basis `bank`; `cash_inflows = 4,800.00`; `cash_outflows = 1,000.00`.
- `operating_expenses = 0.00` and `net_profit = 4,000.00`: the bank's rent does not enter the accrual P&L the invoice list defines (§2.3 — one basis per family, never a mixture).
- The customer family reconciles to the same 4,000.00.

Nothing is double-counted, and a bank inflow never becomes revenue on its own.

## 5. Net-of-tax alignment (MEDIUM-1)

One authoritative rule, `app.invoice_net(subtotal, tax, total)`: `subtotal`, else `total − tax`, else `total`, with a `subtotal` of 0 beside a positive total counted as ABSENT. `app.aggregate_periods`, `api.set_invoice_lines` and `api.product_period_summary` all call it; `sign.ts#invoiceNetOfTax` is its TypeScript mirror. `app.invoice_net_is_vat_fallback` names the one case where a gross total stood in for a net one.

Golden coverage: `supabase/tests/13_invoice_net.test.sql` (16 assertions — subtotal present/absent, tax present/absent, zero subtotal with and without tax, a genuinely zero invoice, negatively stored rows, the fallback flag, and two catalogue assertions that no invoice reader carries its own copy of the rule). The invoice-only golden proves invoice-level and line-level agree on the zero-subtotal row: the engine counts 1,050.00 and `api.set_invoice_lines` now accepts lines up to 1,050.00 on the same invoice, where before it refused every line and the product summary reported 0.00 unattributed.

## 6. Unattributed remainder (MEDIUM-2)

The synthetic `dimension_id = NULL` snapshot stays — it is what makes `Σ customer_revenue + unattributed = revenue` exact — and is now presented as a data-quality state everywhere:

| Surface | Before | Now |
|---|---|---|
| Commercial overview "Top customers" | ranked among customers, negative under the old defect | real customers only; the remainder printed beneath as "… of this month's revenue is not attributed to any customer" |
| Revenue-by-customer table | ranked by size, labelled "Unattributed" | sorted last whatever its size, labelled "Not attributed to a customer" |
| `get_customer_profitability` | a row with `subject.id = 'unattributed'` inside the ranked rows | `not_attributed_to_a_customer[]`, with a note telling the model it is a gap in the data and must not be named or ranked as a customer |
| Engine concentration | already excluded it from top-1/top-5 (ranking runs over attributed rows only) | unchanged |

Tests: `test/integration/commercial.test.ts` ("never ranks the unattributed remainder as a customer, and reports it as the gap it is" — including a real orphan invoice that produces a remainder, then removes it).

## 7. Counterparty merge (MEDIUM-3)

Option A, preserving history through the canonical identity — the least invasive correct behaviour, and the one the engine already implements. `api.merge_counterparties` is unchanged: it stays a pointer, keeps the evidence trail, and still enqueues a recalculation.

- `api.product_period_summary` keys the product/customer mix by `coalesce(merged_into_id, counterparty_id)`.
- `listOpportunities` returns the surviving counterparty (and keeps the recorded one as `recordedCounterpartyId`); filtering by a customer also returns the rows merged into them.
- `loadCustomerCommercial` reads contribution, product mix and win path under the survivor, so the merged-away page shows the survivor's history rather than an empty month.

Where a merge leaves one identity with two won opportunities, the earliest win decides which campaign is credited — the existing no-double-counting rule, applied to the merged identity. The integration test asserts exactly that, and that the total revenue credited across all campaigns equals the customer's revenue once, not twice. Duplicate merges still raise `CONFLICT`; a cross-organisation merge still raises `NOT_FOUND` in both directions.

## 8. Phase 14 reconciliation after the fix

`test/integration/commercial.test.ts` now asserts the full identity rather than half of it:

```
Σ product revenue + unattributed  =  Σ customer_revenue  =  headline revenue
```

to the penny, on the same month. Product attributed revenue cannot exceed the supported customer revenue (lines are capped at the invoice's net by `api.set_invoice_lines`, which now uses the same rule the engine does), campaign attributed revenue still comes only from `customer_revenue` snapshots of won customers, and unattributed amounts remain identified on every surface.

## 9. Evidence

No evidence architecture was added or changed. A repaired revenue figure keeps its `EQ(invoices, {period_ids, invoice_types})` descriptor, so revenue → calculation → the invoice rows → their source document still resolves through the Phase 8 record and document pages; product lines still link to their invoice's record page. The `customer_revenue` rows keep their per-counterparty invoice descriptors; the unattributed row still carries none, because a v1 descriptor cannot express "rows with no counterparty" and evidence that reconciles to the wrong number is worse than none.

## 10. AI

The prompt was **not** touched to conceal or compensate for the defect; the model now receives the corrected figures because the engine produces them. Two things did change:

- `get_customer_profitability` reports the unattributed remainder separately, with a note forbidding the model to treat it as a customer (§6).
- The recorded tool outputs the eval corpus rests on were re-taken at `analyst-v3.4`; the corpus is 170 cases and passes, including the four Phase 14 adversarial attribution refusals.

The commercial tools (24–26) are unchanged and still read the same view models.

## 11. Tests

| Layer | File | Added |
|---|---|---|
| Unit | `test/unit/engine-invoice-basis.test.ts` | 10 — the invoice fold, credit notes, uncategorised purchases, the VAT threshold, a chart missing a category |
| Integration | `test/integration/engine-invoice-golden.test.ts` | 9 — the two golden organisations |
| Integration | `test/integration/commercial.test.ts` | +3 — full reconciliation, unattributed-is-not-a-customer, merge attribution (and the merge refusals) |
| pgTAP | `supabase/tests/13_invoice_net.test.sql` | 16 — the net-of-tax table and the one-rule catalogue checks |

Existing tests were extended, never weakened: the engine's own constructors gained `fallbackRows`/`defaultExpenseCategory`, `00_structure.test.sql` gained the two pure helpers in its allow-list, and the Phase 14 reconciliation assertion was strengthened from "Σ attributed customer revenue" to the headline figure.

## 12. Regression

The full gate suite on a clean database (`supabase db reset`) is recorded in the final report of this remediation. The pre-existing intermittent `ai-eval-record.test.ts` was not touched and Phase 7's alert ordering was not altered.

## 13. Known limitations after this remediation

1. Purchases from suppliers with no `default_expense_category` are `uncategorised`, and past §3.1's thresholds they mark the month's revenue `estimated`. That is the specification; the remedy is the per-supplier confirmation the import already offers (IMPORT_ENGINE.md §6.5).
2. Customer contribution still equals revenue (CD-08): nothing records a cost against a customer.
3. Attribution remains single-touch (earliest won opportunity), including after a merge.
4. A merged-away counterparty's own page shows the survivor's figures; it does not redirect.
5. The eval corpus is recorded, not live.
