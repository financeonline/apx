# Phase 14 — final remediation record

> Date: 2026-09-22. Answers the independent re-audit `PHASE_14_REMEDIATION_AUDIT.md` (verdict NOT READY: HIGH-2, MEDIUM-4, MEDIUM-5, MEDIUM-6). Decision record: ADR-104. Phase 15 was not started. Nothing in Phase 13 or Phase 14's commercial logic, in invoice precedence, in `app.invoice_net`, in customer attribution, in the alerts module or in the dashboard's arithmetic was changed.

## 1. The original Phase 14 engine defect

Phase 14's reconciliation test surfaced that the invoice P&L basis reported a **covered zero**: `revenue = 0`, `net_profit = 0`, assurance `estimated`, while `customer_revenue` per counterparty was correct. Cause: invoice aggregate cells carry no account (an invoice header has none) and `compose.ts#accountAmounts` folded per account, so on that basis it folded nothing; `uncategorisedExposure` then counted every cell as uncategorised. The first audit (`PHASE_14_FINAL_AUDIT.md`) classified it HIGH, having shown it also struck organisations that upload bank statements beside a full invoice list, because invoices outrank bank in the P&L precedence.

## 2. The previous remediation (55acbeb, ADR-103)

The composition now derives an invoice cell's category from its type and the supplier's `default_expense_category`, applies the type's sign once (credit notes subtract), reports under the organisation's system account for the category, measures the uncategorised share on what is reported, carries the VAT-fallback row count from the aggregate, and signs the customer family the same way. The net-of-tax rule gained one home, `app.invoice_net`, used by the aggregate and both Phase 14 invoice readers and mirrored in TypeScript. "Unattributed" left every customer ranking, including the analyst's, and a counterparty merge now carries product mix, campaign attribution and opportunities to the surviving identity.

## 3. Independent verification

The re-audit reproduced every claim with different data: the invoice-only P&L (13,000 / 4,000 / 9,000 / 7,500), Calculated where every row is net and Estimate where one is gross, invoices outranking bank with cash on the bank basis and no double count, credit notes reducing the customer (12,000 − 2,000), twelve net-of-tax cases agreeing between SQL and TypeScript with three callers and zero copies, the VAT signal firing at 1 of 6 rows, cost of sales communicating its limitation when there are no purchases, "unattributed" absent from every ranking, and merge attribution surviving. It found the fix architectural — four engine files, nothing in the dashboard — and then found four more things, remediated here.

## 4. HIGH-2 — cash was a confident zero where nothing could establish it

**Defect.** `cash.ts#openingFor` summed opening balances over the accounts it was given. With no cash-like account the loop never ran, `missingAccounts` stayed empty, and the vacuous sum returned 0: `opening_cash = 0`, `closing_cash = 0`, `cash_inflows = 0`, completeness 1, assurance `calculated`. Home showed **Cash £0 · Calculated** for a business whose statements had never been uploaded. Latent since Phase 4; reachable in earnest only once invoice-only organisations had a profit and loss.

**Fix** (`financial-engine/domain/cash.ts`, in `computeCash`): when the organisation has no active cash-like account and none was covered this period, the whole family — `opening_cash`, `closing_cash`, `cash_inflows`, `cash_outflows`, `net_cash_movement` — is written NULL with the new reason `no_bank_accounts`, basis `none`, completeness 0; `cash_runway_months` follows as NULL; a later period inherits the reason through the carried opening exactly as `no_opening_cash` does. A since-closed account still counts for the months a statement covered it. The reason text a reader sees: **"Add a bank account and upload its statements to see your cash."** (`dashboard/domain/status.ts`, the same map every other reason uses — a presentation of the engine's reason, not a workaround.)

**The test that encoded the defect.** `engine-cash.test.ts` had a case "reports zero opening cash for an organization with no cash-like accounts at all" whose comment read "Zero here is knowledge, not a gap". It asserted the vacuous sum. It is replaced by the rule (§8).

**Related empty-set sweep (brief test 8).** An organisation with no data at all was found to write `customer_revenue = 0.00` and `supplier_spend = 0.00` (basis `none`) for every period — the synthetic Unattributed row being emitted with nothing to reconcile against. `concentration.ts` no longer writes the synthetic row when no source covers the family. No other family zero-fills: on an organisation with nothing, no snapshot carries a value at all (golden, §8).

## 5. MEDIUM-4 — invoice-basis expense evidence over-selected

**Defect.** `pnl.ts#leafEvidence` built the invoice-basis descriptor from the side only (`invoice_types`), so `cost_of_sales`, `operating_expenses` and every `expense_by_category` / `expense_by_account` row shared one descriptor re-selecting every purchase in the period: drilling into cost of sales of 3,000 listed 4,000.

**Fix** (descriptor, not display): the composition records, per category, the counterparties whose purchases were folded into it (`compose.ts#invoiceCounterpartiesByCategory`, the same cells and the same category rule as the fold) and passes them as `PnlInput.invoiceCounterparties`. The expense-side leaf descriptor now carries `counterparty_ids` beside the purchase types — a v1 filter the evidence compiler already honours for `invoices` and the counterparty family already uses. A figure no supplier's purchases went into gets **no** descriptor rather than one that re-selects everything. Revenue keeps the sales types, which are exactly the figure.

## 6. MEDIUM-5 — a ledger organisation could show a 100% gross margin with no warning

**Defect.** ADR-103 widened `loadCostOfSalesEverUsed` to count purchase invoices from a `cost_of_sales` supplier. Right on the invoice basis; on a ledger basis it turned a line the ledger never stated into a covered zero: `cost_of_sales = 0.00`, `gross_margin = 1.00`, no warning, and Home showed the gross-profit card CD-05 exists to suppress.

**Fix**: the account-bearing fact and the invoice fact are loaded separately (`loadCostOfSalesEverUsed` reverted to ledger/balance evidence; new `loadCostOfSalesInInvoices`; both on `EngineContext`). The composition counts invoice evidence **only when the invoices are the P&L basis**. On any other basis with invoice evidence and no account evidence, `cost_of_sales` is NULL with the new reason `cost_of_sales_in_other_source`, `gross_profit` carries `no_cost_of_sales`, `gross_margin` is NULL, and Home hides the gross-profit card as it does for `no_cost_of_sales_accounts`. Reader text: "Your purchase invoices show direct costs, but the source this month's figures come from does not, so this cannot be established." No cost is invented in either direction.

## 7. MEDIUM-6 — the pre-existing `ai-eval-record` flake

Recorded, not touched. `ai-eval-record.test.ts` compares each tool result's shape; `keyPaths` samples only the first element of an array, and `loadAlerts` orders by `severity, last_evaluated_at` with no identifier tiebreaker, so equally-ranked alerts return in either order. The re-audit saw it fail 3 of 3 full-suite runs and pass 4 of 4 in isolation. The recording organisation contains no invoices, the alerts module is not in either remediation commit, and Phase 7's alert behaviour was not altered. It remains a pre-existing flaky gate; the one-line ordering fix belongs to Phase 7's owner.

## 8. The tests that prove each remediation

| Item | Test | What it proves |
|---|---|---|
| Cash, no accounts | `test/unit/engine-cash.test.ts` "reports cash as unavailable, not zero, for an organization with no cash-like account at all" | with no accounts, and with only a credit card: every cash metric NULL, `no_bank_accounts`, completeness 0, basis `none`, in the first and a later period; runway NULL |
| Cash, closed account | same file, "still computes the months a since-closed account was covered for" | an inactive account with a covering statement still yields closing cash |
| Cash, multiple accounts | same file, "aggregates valid balances across several accounts, and refuses when one is missing" | 1,000 + 500 openings aggregate to 1,560 after movements; one missing balance → NULL with `no_opening_cash` (no silent zero) |
| Cash, bank organisation | `test/integration/engine-invoice-golden.test.ts` (org B) | `closing_cash 8,800.00` on basis `bank`, revenue 4,000.00 on basis `invoices` — unchanged |
| Cash, invoice-only | same file, "an invoice-only organisation has no cash figure, not a zero one, and says why" | five cash metrics NULL with `no_bank_accounts`, basis `none`; the verified P&L (8,550.00 / 7,650.00) untouched |
| Empty-set sweep | same file, "an organisation with nothing at all writes no zero anywhere" | on an organisation with no data, no snapshot carries a value |
| Evidence scoping | `test/unit/engine-invoice-basis.test.ts` "evidence on the invoice basis re-selects the rows behind THAT figure"; `engine-pnl.test.ts` descriptor case; golden "cost of sales names the cost-of-sales supplier" | `cost_of_sales` → `counterparty_ids: [stock supplier]`; marketing → `[ads supplier]`; a category with no purchases → no descriptor; revenue unchanged; the stored descriptor on a real run names exactly the one supplier |
| Cost of sales source | `engine-invoice-basis.test.ts` "cost of sales that lives only in invoices does not become a zero on another basis"; golden org C | ledger basis + invoice evidence → NULL `cost_of_sales_in_other_source`, `gross_margin` NULL, `gross_profit` warns; invoice basis → 2,500.00 cost, 6,500.00 gross; no evidence anywhere → `no_cost_of_sales_accounts` |
| Precedence, no double count | golden org B (unchanged) | revenue from invoices, cash from bank, bank rent not in the accrual P&L |
| AI: cash unavailable | `test/fixtures/ai/corpus.ts` `golden:cash` (four roles), `test/eval/ai-eval.test.ts` | the analyst's golden for "How is our cash?" on a bank-less organisation states that cash cannot be established, cites the NULL snapshot, carries `no_bank_accounts`, and `£0` must not appear |
| Report = Home | `test/integration/reporting.test.ts` "names the same month and the same comparison month as Home" | the report's comparison month follows Home's previous-month-with-data rule |
| Isolation and roles | `commercial.test.ts` (11), `rls-isolation.test.ts` (42), `isolation-cases.test.ts` (10), `ai-tools.test.ts` (23) | unchanged and green |

## 9. Final gate results (clean database, `supabase db reset`)

Two full runs were made: the first, before the last change below, failed three tests; two of those — `ai-eval-job` (a transient "the model could not be called" from the live model during the ten live questions; passes in isolation and in every other run) and `reporting` — are addressed in the notes; the second is the run recorded here.

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint (`eslint .`) | PASS |
| Unit | PASS — 69 files, 1,989 tests (+9 over 55acbeb) |
| Integration | PASS — 40 files, 661 tests on the final run (after the fixture re-record below). The clean-database run before it reached 660 of 661, the one failure being the documented pre-existing `ai-eval-record` ordering flake (§7). Green throughout: `engine-invoice-golden` (15), `commercial` (11), `reporting` (16), `ai-tools` (23), `rls-isolation` (42), `isolation-cases` (10), `ai-eval-job` (2) |
| pgTAP | PASS — 16 files, 1,034 assertions |
| Playwright | PASS — 64 passed, 1 pre-existing skip |
| AI eval | PASS — 170 cases |
| Schema drift | PASS — 54 tables, 118 api functions, RLS forced everywhere, no write grants (no schema change in this remediation) |
| Permission matrix | PASS — 121 grants, in sync |
| Authorization | PASS — role × tool matrix, commercial roles, client × write functions |
| Tenant isolation | PASS — `rls-isolation`, `isolation-cases`, commercial isolation, golden organisations under RLS |
| Production build | PASS |

**Two consequences caught by the suite and fixed in this pass.** First, the AI evaluation recording (`test/fixtures/ai/recorded-tools.json`) is taken from an organisation with a ledger and no bank account; call 9, `get_metric closing_cash`, had recorded the old `£0` with completeness 1, and the corpus's `golden:cash` case repeated that zero as a fact ("Cash was £0 at the end of May 2026"). With the engine now returning NULL with `no_bank_accounts`, `ai-eval-record` failed on that call's shape — correctly — so the recording was re-taken and the golden rewritten to the honest answer: "We cannot show your cash for May 2026: no bank account has been added yet, so there is no statement to establish it from", citing the NULL snapshot as its evidence, with `no_bank_accounts` in its data-quality notes and `absent: ['£0']` asserted. The corpus is still 170 cases and passes. Second, The monthly report chose its comparison month as "the previous calendar month", Home as "the previous month with data". They agreed only while every month carried a value — which the empty cash family guaranteed by writing zeros. With the zeros gone, `reporting.test.ts` ("names the same month and the same comparison month as Home") failed deterministically. The report now uses Home's rule (`loadPeriodsWithData`, already imported there), which is a consistency correction in the reporting module, not a change to any figure.

**Browser check (scratch harness, not committed).** An invoice-only organisation's Home shows "Cash — · no comparison yet" among headline figures that read correctly (Sales £6,000 Calculated), and Money › Cash shows "Money in — … Add a bank account and upload its statements to see your cash." Nowhere shows £0.

**Adversarial probes from both audits re-run: 23 of 23 pass** — attribution rule cases, the AED organisation, the invoice-only overview (revenue Calculated, real customers only), the zero-subtotal invoice, the unassigned employee and foreign-organisation tool contexts, the evidence descriptors (cost of sales names its supplier only), the invoice-only cash family (all NULL with `no_bank_accounts`), the ledger organisation with invoice-only cost of sales (`cost_of_sales_in_other_source`), and the empty organisation (no snapshot carries a value).

**Exact source changes (no migration, no schema change):** `financial-engine/domain/cash.ts` (empty-set → NULL family), `domain/concentration.ts` (no synthetic remainder on an uncovered family), `domain/pnl.ts` (supplier-scoped invoice evidence; `cost_of_sales_in_other_source`), `domain/compose.ts` (counterparties-by-category; per-basis cost-of-sales flag), `domain/types.ts` (two reason codes; `costOfSalesInInvoices`), `data/repository.ts` (`loadCostOfSalesEverUsed` reverted to account evidence; `loadCostOfSalesInInvoices` added), `services/run.ts` (loads both), `dashboard/domain/status.ts` (two reason texts), `dashboard/services/home.ts` (hide gross profit on the new code too), `reporting/services/index.ts` (comparison month = previous month with data); `test/fixtures/ai/recorded-tools.json` re-recorded and `test/fixtures/ai/corpus.ts` `golden:cash` rewritten. Untouched: precedence, `app.invoice_net`, attribution, Phase 13, Phase 14 commercial logic, the alerts module, the `ai-eval-record` test.

## 10. Readiness

Every financial-integrity item the re-audit raised is fixed at the engine layer and verified by tests that fail against the previous behaviour: cash is unavailable with a reason where nothing can establish it; an empty organisation writes no zero anywhere; invoice-basis expense evidence reconciles to its figure; a ledger organisation with invoice-only cost of sales gets an unavailable figure with the reason, never a 100% margin. The verified invoice-basis P&L, the bank-plus-invoice precedence, the one net-of-tax rule and customer attribution are exactly as the re-audit confirmed them.

What remains open is not financial integrity: the pre-existing `ai-eval-record` ordering flake (§7, documented, for Phase 7's owner), and the six LOW findings of the first audit plus the re-audit's LOW-7 (the VAT-fallback share counts purchase rows against revenue, which over-flags and never understates).

**READY FOR PHASE 15** — subject to the independent re-audit this project runs before each phase. Phase 15 has not been started.
