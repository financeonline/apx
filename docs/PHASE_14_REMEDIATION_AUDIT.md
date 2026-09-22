# Phase 14 — re-audit after the financial remediation

> Audit date: 2026-09-22. Subject: the committed state at **55acbeb** on `main` (local `HEAD`, `origin/main` and the working tree all agree; `git status --porcelain` is empty). The whole commit was audited, not only the remediation diff: it carries Phase 13 (Banking Intelligence), Phase 14 (Commercial Intelligence) and the remediation, because Phases 13 and 14 had never been committed. Method: code reading against the contract documents; a full gate suite on a clean database; and independent probes written for this audit in a scratch harness outside the repository, using numbers deliberately different from the implementation's own goldens. **No code was modified.**

## Executive summary

The reported root cause is the real one, and the fix is where it belongs. Invoice cells arrive with no account because an invoice header has none; the composition folded per account and therefore folded nothing on the invoice basis. The repair is in `financial-engine/domain/compose.ts` — the engine's pure composition layer — not in a view model, a dashboard service or a route. Nothing in `src/modules/dashboard` or `src/app` knows the invoice basis exists.

Every claim in the remediation report was reproduced independently: the invoice-only P&L, the bank-plus-invoice precedence, credit notes reducing customer revenue, one net-of-tax rule shared by three SQL callers and its TypeScript mirror, the VAT-fallback signal firing, cost of sales communicating its limitation, "unattributed" out of every customer ranking, and a merge carrying commercial history to the surviving identity.

Three new findings came out of the probing. One is HIGH and is **not** a regression from this remediation: an organisation with no bank account at all is told its cash is **£0, Calculated**, because the opening-cash sum over an empty set of accounts reads as a known zero. That is the engine's own "never zero-fill" rule broken on the cash family, it is visible on Home today, and it is exactly the shape of error that a multi-client portfolio would repeat per client. It has been latent since Phase 4; this audit is the first to exercise an organisation that has invoices and no bank data, which is now a viable organisation precisely because the remediation gave it a profit and loss.

| Severity | Count | |
|---|---|---|
| CRITICAL | 0 | |
| HIGH | 1 | pre-existing (Phase 4 cash module), untouched by 55acbeb |
| MEDIUM | 3 | one introduced by the remediation, two pre-existing (one newly reachable, one that fails a gate) |
| LOW | 1 | plus the six LOW findings of the first audit, still open |

## Verification of the root-cause fix

Traced end to end in the committed tree:

| Stage | Committed behaviour | Verdict |
|---|---|---|
| `app.aggregate_periods` | invoice cells carry `account_id` / `standard_category` NULL, `amount` = Σ `app.invoice_net(...)`, plus the new `fallback_rows` | unchanged where it should be, extended where it must be |
| `compose.ts#invoiceCategoryOf` | sales and sales credit notes → `revenue`; purchase → counterparty's `default_expense_category`, else `uncategorised` | matches FINANCIAL_ENGINE.md §2.1 |
| `compose.ts#invoiceCellAmount` | `invoiceSignFor` applied once; credit notes negate | matches ADR-047.5 |
| `compose.ts#homeAccountFor` | the organisation's system account for the category, falling back to `uncategorised` | money stays visible; same home a categorised bank line uses |
| `compose.ts#uncategorisedExposure` | measured on the category the figure REPORTS | a purchase with no category still raises §3.1's warning |
| `compose.ts#counterpartyAmounts` | invoice cells signed by type; other sources unchanged | fixes credit notes without touching ledger or bank |
| `computePnl` | ordinary path, no invoice special-casing | the fold happens before the metrics, not inside them |
| `src/modules/dashboard`, `src/app` | no reference to basis, fold, `fallbackRows` or `invoiceVat` | **no dashboard patch**; the dashboards still read `metric_current` |

Engine files changed by the commit: `data/repository.ts`, `domain/compose.ts`, `domain/types.ts`, `services/run.ts`. `coverage.ts`, `pnl.ts`, `cash.ts`, `concentration.ts` and `sign.ts` are untouched, so precedence, the metric definitions and the sign rules are as they were.

## Golden test 1 — invoice only

Reproduced independently with different data (three sales rows including a credit note and a gross-only row, three purchases in three categories):

| Figure | Expected | Reported |
|---|---|---|
| revenue | 12,000 − 2,000 + 3,000 = **13,000.00** | 13,000.00 |
| cost_of_sales | **4,000.00** | 4,000.00 |
| gross_profit | **9,000.00** | 9,000.00 |
| operating_expenses (marketing) | **1,500.00** | 1,500.00 |
| net_profit | **7,500.00** | 7,500.00 |
| basis | `invoices` | `invoices` |
| Σ customer_revenue | = revenue | 10,000 + 3,000 + 0 = 13,000.00 |

Net profit is not artificially zero, and customer revenue reconciles to the headline to the penny.

**Calculated vs Estimated.** In this organisation one of the six invoice rows carried neither a subtotal nor a tax column, so the figure is correctly `estimated` with `vat_inclusive` — the §3 rule doing its job, not a downgrade. An organisation whose rows all state their tax reports **Calculated**: a separate probe (an AED organisation, all rows net) returns `revenue AED 8,000.00` with status `calculated` and `completeness 1`. Both states were observed, and each for the right reason.

## Golden test 2 — bank + invoice

Two independent organisations (the repository's own golden, and my AED probe) agree:

- revenue comes from the invoices and is **not zero**: 4,000.00 and 8,000.00 respectively, basis `invoices`.
- the bank receipt for the same sale does **not** add to revenue (never 4,800.00, never 8,800.00).
- cash stays the bank's: `closing_cash` 8,800.00 / 6,800.00, basis `bank`, with inflows and outflows from the statement.
- a bank-categorised expense does not enter the accrual P&L the invoice list defines.
- `FAMILY_PRECEDENCE` is byte-identical to its pre-remediation definition: `pnl: period_balances → ledger → invoices → bank`, `cash: bank → ledger → period_balances`. Precedence was not changed.

An invoice does not become cash by existing: on an invoice-only organisation, cash metrics carry basis `none` — though see HIGH-2 for what they carry as a value.

## Credit notes

`sales_credit_note` reduces the customer and the headline. Probe: a 12,000.00 sale and a 2,000.00 credit note for the same customer give `customer_revenue = 10,000.00`, and Σ `customer_revenue` equals `revenue`. Before the remediation the magnitude was taken, so the credit note would have produced 14,000.00.

## Net-of-tax

`app.invoice_net(subtotal, tax, total)` compared against `sign.ts#invoiceNetOfTax` across twelve cases — subtotal present / absent / zero, tax present / absent / zero, a genuinely zero invoice, negatively stored rows, and the gross-only row:

- **every case agrees on the net**, and every case agrees on the VAT-fallback flag.
- callers of the one rule, read from `pg_proc`: `app.aggregate_periods`, `api.set_invoice_lines`, `api.product_period_summary`.
- functions still carrying their own `total_amount - tax_amount`: **none**.
- line level and invoice level agree: on a `subtotal = 0, tax = 210, total = 1,260` invoice the engine counts 1,050.00, `api.set_invoice_lines` accepts lines up to 1,050.00, and the product summary reports 1,050.00 of sales — where before the reader counted 0.00 and refused every line.

## VAT fallback

It fires. With one gross-only row in six, the aggregate reports `fallback_rows = 1` against `row_count = 6`, and the revenue figure carries `vat_inclusive` with assurance `estimated` — 16.7% being past the 10% threshold. Nothing is silently downgraded: the warning and the assurance move together, and the value itself is unchanged.

## Cost of sales and gross profit

Three shapes probed:

| Organisation | cost_of_sales | gross_profit | margin | What it says |
|---|---|---|---|---|
| Invoice-only, purchases from a cost-of-sales supplier | 4,000.00 | 9,000.00 | 0.69 | correct, from the invoices |
| Invoice-only, **no purchases at all** | NULL, `no_cost_of_sales_accounts` | 5,000.00 with warning `no_cost_of_sales` | NULL | communicates the limitation; Home hides the gross-profit card on exactly this missing code |
| **Ledger basis**, ledger states no cost of sales, but purchase invoices from a cost-of-sales supplier exist | **0.00, no warning** | 9,000.00 | **1.00** | see MEDIUM-5 |

The second row is the behaviour the brief asked for: no manufactured cost, no silent completeness. The third is a new consequence of widening "cost of sales ever used" to invoice evidence, and is reported below.

## Unattributed

- Engine: `customer_concentration_top1/top5` rank `rolled.attributed` only — the synthetic row never was a customer there.
- Commercial overview: real customers only; the remainder is printed beneath as "… of this month's revenue is not attributed to any customer".
- Revenue-by-customer table: sorted last whatever its size, named "Not attributed to a customer".
- `get_customer_profitability`: the remainder has left `rows[]` and appears as `not_attributed_to_a_customer`, with a note telling the model it is a gap in the data and must not be named or ranked as a customer. The recorded corpus fixture reflects the new shape and the eval suite passes.

## Merge

`api.merge_counterparties` is unchanged (a pointer, evidence preserved, recalculation enqueued). The readers now resolve the survivor: `api.product_period_summary` keys both its line CTE and its customer mix by `coalesce(merged_into_id, counterparty_id)`, `listOpportunities` returns the surviving counterparty and, when filtering by a customer, also returns the rows merged into them. The repository's integration case proves product mix and campaign attribution survive a merge, that total credited revenue across campaigns equals the customer's revenue exactly once, and that a duplicate merge and a cross-organisation merge are still refused.

## Regression on a clean database

`supabase db reset`, then every gate, from the committed tree:

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS |
| Unit | PASS — 69 files, 1,980 tests |
| Integration | **FAIL — 654 of 655.** `ai-eval-record.test.ts` failed on all three full-suite runs of this audit, and passes 4 of 4 in isolation. See MEDIUM-6 |
| pgTAP | PASS — 16 files, 1,034 assertions |
| Playwright | PASS — 64 passed, 1 pre-existing skip |
| AI eval | PASS — 170 cases, recording at `analyst-v3.4` |
| Schema drift | PASS — 54 tables, 118 api functions, RLS forced, no write grants |
| Permission matrix | PASS — 121 grants, in sync |
| Production build | PASS |

**The failing test is the documented pre-existing one, and it is not Phase 14's — but it is not as rare as "intermittent" suggests.** Details and mechanism are in MEDIUM-6. In short: `ai-eval-record.test.ts` compares the shape of each recorded tool result, `keyPaths` samples only the FIRST element of an array, and the lists it samples are not totally ordered — `loadAlerts` orders by `severity, last_evaluated_at` with no id tiebreaker, so two alerts written by one evaluation pass tie and come back in either order. Two of my three runs failed on `get_alerts #16` (a `threshold_summary.revenue` that is null on one alert and a money object on the other) and the third on `get_business_summary #20`. Nothing in the remediation can reach it: the alerts module is not in the commit, the recording organisation contains zero invoice rows (`insert into public.invoices` appears nowhere in that file), and the two alert entries in the fixture are byte-identical to the pre-remediation fixture in the respect that flips. The test was not modified and Phase 7's alert behaviour was not touched.

## Findings

### HIGH-2 — an organisation with no bank account is told its cash is zero, confidently (pre-existing)

`cash.ts#openingFor` sums opening balances over the accounts it is given. With **no** cash-like bank accounts, the loop never runs, `missingAccounts` stays empty, and the vacuous sum returns 0 — so opening cash is 0, closing cash is 0, `completeness = 1`, `missing = []`, assurance `calculated`. Probed on an invoice-only organisation:

```
closing_cash = 0.000000 [none/calculated] {"missing": [], "warnings": [], "completeness": 1}
cash_inflows = 0.000000 · cash_outflows = 0.000000 · net_cash_movement = 0.000000
revenue      = 7000.000000 [invoices/calculated]
```

`statusFor` maps that to the badge **Calculated**, and `closing_cash` is in Home's headline order, so Home shows "Cash £0 · Calculated" for a business whose bank statements simply have not been uploaded. FINANCIAL_ENGINE.md §1.5 and §2.3 say the opposite in terms: a family nothing covers is NULL with a reason, never zero — and the sibling path proves the rule is understood, because an organisation that HAS a bank account without an opening balance correctly returns NULL with `no_opening_cash` (asserted in `engine-cash.test.ts`). The untested case is "no accounts at all".

- **Not a regression.** `cash.ts` has not changed since Phase 4 (`b2a6861`) and is not in this commit. The remediation neither caused nor worsened it.
- **Newly reachable in practice.** Before this commit an invoice-only organisation had no P&L worth looking at, so nobody would have opened its Home. Now it has one, and the cash card beside it is a confident zero.
- **Portfolio impact.** Phase 15 aggregates per-client figures. Every client without bank statements would contribute £0 of cash, marked as calculated rather than unknown, and any practice-level cash total would be understated with no signal.
- **Fix, for the engine's owner:** treat an empty covered-and-active account set as unknown — `openingFor` should return `value: null` with `no_opening_cash` (or a new `no_bank_accounts`) when it is handed no accounts, exactly as it does when the accounts it is handed have no candidates; add the case to `engine-cash.test.ts` and to a golden invoice-only organisation.

### MEDIUM-4 — invoice-basis expense figures carry evidence that does not reconcile

On the invoice basis, `leafEvidence` builds the descriptor from the SIDE (`sales` / `purchase` types) and ignores the account ids it is given, because an invoice has no account. With the fold now producing real expense figures, several figures share one descriptor. Probed on an organisation with a 3,000.00 cost-of-sales purchase and a 1,000.00 marketing purchase:

```
cost_of_sales                    3000.00  → filters {period_ids, invoice_types:[purchase, purchase_credit_note]}
expense_by_category[cost_of_sales] 3000.00 → the same filters
expense_by_category[marketing]     1000.00 → the same filters
operating_expenses               1000.00  → the same filters
```

Re-selecting any of them returns all 4,000.00 of purchases. `revenue` is unaffected (sales and their credit notes are exactly the figure). The evidence drawer and AI tool 13 both resolve these descriptors, so a reader — or the analyst — verifying "Cost of sales £3,000" is shown £4,000 of invoices. The code's own standard is stated in `concentration.ts`: evidence that reconciles to the wrong number is worse than none.

- **Latent, newly reachable**: the descriptor was always this shape, but the figures it hangs off were covered zeros until this commit.
- **Fix:** on the invoice basis, add `counterparty_ids` (the suppliers whose `default_expense_category` is that category) to the expense-side leaf descriptor — a v1 filter the descriptor already supports and which `concentration.ts` already uses for the counterparty family.

### MEDIUM-5 — a ledger organisation with cost-of-sales purchase invoices now reports a silent zero and a 100% margin

`loadCostOfSalesEverUsed` was widened so that a purchase invoice from a supplier defaulted to `cost_of_sales` counts as the system account having carried a figure. That is right for the invoice basis and is what makes gross profit work there. But the flag is a fact about the ORGANISATION (ADR-063) and is consumed whatever basis wins, so an organisation whose P&L comes from a general ledger that states no cost of sales now reports:

```
basis ledger · revenue 9,000.00 · cost_of_sales 0.00 · gross_profit 9,000.00 · gross_margin 1.00
cost_of_sales data_quality: {"missing": [], "warnings": [], "completeness": 1}
```

Before the widening the same organisation returned `cost_of_sales = NULL` with `no_cost_of_sales_accounts`, and Home suppressed the gross-profit card on exactly that code (CD-05, `buildHeadlineCards`). Now the card appears with a 100% margin and no warning, for a business holding 2,500.00 of cost-of-sales purchase invoices the ledger does not contain. §3.1's covered-zero rule defends "the ledger stated no cost of sales, so it is zero", but CD-05 exists to stop a 100% margin being presented as fact, and the evidence that the organisation does track cost of sales comes from a source the figure is not using.

- **Introduced by this remediation**, in the same function that fixes the invoice-basis case.
- **Fix:** scope the widening to the basis actually chosen (count invoice evidence only when the P&L basis is `invoices`), or keep the flag organisation-wide but raise `no_cost_of_sales` when the chosen basis reports no cost of sales while another source has it.

### MEDIUM-6 — the recorded-shape gate is order-sensitive, so the integration gate fails more often than it passes (pre-existing)

`test/integration/ai-eval-record.test.ts` asserts that every tool's output SHAPE still matches the recording. `keyPaths` reduces an array to the key paths of `value[0]`, so the assertion is sensitive to which element happens to come first — and two of the lists it samples are not totally ordered:

```
src/modules/alerts/data/repository.ts
  .order('severity', { ascending: false })
  .order('last_evaluated_at', { ascending: false })     // no id tiebreaker
```

Alerts written by the same evaluation pass share `last_evaluated_at`; when they also share a severity the order is whatever the plan returns. The recorded `get_alerts` call has `expense.spike_category` first (its `threshold_summary.revenue` is null, one key path) and `concentration.customer` second (a money object, three key paths); when the order flips, the shape "changes" and the gate fails. The same sampling makes other tools order-sensitive: my third run failed on `get_business_summary` instead.

Observed: **3 failures in 3 full-suite runs** in this audit, against **4 passes in 4 isolated runs**, on the same commit and machine. The implementation's own final regression recorded one full-suite pass. So the gate reports PASS or FAIL essentially by chance, and the "Integration PASS" in the remediation report was a fortunate run rather than a wrong claim.

- **Pre-existing and not Phase 14's**: the alerts module is untouched by 55acbeb, and the recording organisation has no invoices, so no remediated code path can reach it.
- **It is also a product fact, not only a test fact**: the alert list a page renders, and the list the analyst is handed, are in an arbitrary order among equally-ranked alerts.
- **Fix, for the owner of Phase 7:** add a final `.order('id')` to `loadAlerts` (and to any other list the recording samples), then re-record. Making the order total costs nothing and turns a coin-flip gate back into a gate. I was instructed not to fix or suppress it, and have not.

### LOW-7 — the VAT-fallback share counts purchase rows against the revenue figure

`invoiceVatExposure` sums `rowCount` and `fallbackRows` over every invoice cell of the period, and `buildRevenue` divides one by the other. A month of fully-net sales rows and a handful of gross-only PURCHASE rows can therefore mark **revenue** `vat_inclusive` and `estimated`. It over-flags and never understates, so it is conservative rather than misleading; the signal should still be taken over the rows that feed the figure (sales and their credit notes).

### Previous findings, still open

LOW-1 (no Why link on the overview's top customers — the view model carries `whyHref`, the page does not render it), LOW-2 (tool money values carry no per-figure assurance), LOW-3 (`baseCurrency` falls back to GBP if the organisation row is unreadable), LOW-4 (mixed minor-unit style on the overview), LOW-5 (the overview loads campaigns three times), LOW-6 (no Action Centre link from a commercial page). None was in the remediation's scope; none is a blocker. MEDIUM-1, MEDIUM-2 and MEDIUM-3 of the first audit are **closed**, verified independently above.

## Phase 15 readiness

The remediation did what it set out to do, and did it at the root: the invoice basis reports a profit and loss, one net-of-tax rule governs every reader, credit notes subtract, the VAT signal fires, "unattributed" is a data-quality state everywhere including in the analyst's hands, and a merge carries commercial history to the surviving customer. Every gate passes on a clean database except the integration suite, whose single failure is the documented pre-existing flake in a fixture that contains no invoices at all — though that flake now fails far more often than it passes, which is a finding in its own right.

Readiness fails on one figure, and it is not the one that was fixed. A client with no bank statements is reported as holding £0 in cash, labelled Calculated rather than unknown — the same class of misleading zero as the blocker just closed, on the cash family instead of the P&L, and squarely in the path of a multi-client cash view. The fix is small and local to `cash.ts#openingFor`, and it needs a golden organisation of the shape this audit used. MEDIUM-4 and MEDIUM-5 should be closed in the same pass: one hands a reader evidence that contradicts the figure, the other prints a 100% gross margin without a word of warning. MEDIUM-6 is a one-line ordering fix that restores a gate the project currently cannot rely on.

## Final verdict

**NOT READY FOR PHASE 15**
