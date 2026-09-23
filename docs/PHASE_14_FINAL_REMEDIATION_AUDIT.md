# Phase 14 — remediation, verification and closeout

> **Final commit: `8f81dd3`** — "Phase 14 — Home gross-profit card and invoice-basis evidence amount (ADR-105)", on `main`, pushed to `origin/main`, working tree clean.
>
> **Status: IMPLEMENTATION VERIFIED BY OPUS — INDEPENDENT FABLE 5.1 AUDIT PENDING.** Part D records what this closeout pass verified against the committed tree. It is *not* an independent audit and does not declare Phase 15 readiness. Only the independent Fable 5.1 audit can do that. Parts A, C and B below are kept as written, in the order they were produced.

---

# Part D — final closeout (verification pass, 2026-09-23)

Method: code reading of the committed tree at `8f81dd3`; the eleven gates re-run on a clean database (`supabase db reset`); every adversarial probe from the three earlier audits re-run; a new browser probe for the Home gross-profit card; detached worktrees at `55acbeb` and `b2a73ea` to separate pre-existing behaviour from regression. **No implementation code was changed by this pass** — the only change in the closeout commit is this document.

## 1. The original Phase 14 engine defect

`app.aggregate_periods` folded every invoice row of a period into one cell, so an organisation whose P&L came from invoices reported headline revenue of £0.00 while customer-level revenue was right. Recorded in Part B §1; fixed in `55acbeb` (ADR-103) by giving the invoice basis its own fold and one net-of-tax rule.

## 2. The previous remediation

`55acbeb` (ADR-103): the invoice-basis fold at the root, `app.invoice_net` as the single net-of-tax rule, "Unattributed" made not-a-customer, and counterparty merges followed through the aggregate. `f8fdc58` (ADR-104): the cash empty-set, the over-selecting expense evidence and the unwarned 100% gross margin. Parts B and C record both.

## 3. Independent verification already performed

Three independent audits ran before this pass: `PHASE_14_FINAL_AUDIT.md` (Phase 14 as delivered), `PHASE_14_REMEDIATION_AUDIT.md` (`55acbeb`), and Part A of this file (`f8fdc58`). Each returned NOT READY and named the findings the next commit answered.

## 4. Cash empty-set

Verified intact at `8f81dd3`. `financial-engine/domain/cash.ts` takes the empty branch only when the organisation has **no active cash-like account and no covered account**: every metric of the family is `value: null`, `basis: 'none'`, completeness 0, reason `no_bank_accounts`, and `previousClosing` is set to null so no later month inherits a figure. A covered account, including one that has since been closed, never reaches the branch. Browser: Home prints "Cash —" and Money › Cash prints "Add a bank account and upload its statements to see your cash." for every row; no `£0` anywhere on either page. `engine-invoice-golden.test.ts` asserts the family and the reason; `engine-cash.test.ts` asserts a valid bank source still calculates.

## 5. Empty-set zero-fill sweep

Verified intact. The engine distinguishes a true zero from no data in every family: the P&L returns `noSourceResults` (all fifteen keys NULL, `no_source_covers_period`, completeness 0) rather than zeros; the cash family returns the `no_bank_accounts` branch; `concentration.ts` omits the synthetic unattributed remainder entirely when the basis is `none`, so `customer_revenue` and `supplier_spend` are absent rather than 0.00. The empty-organisation probe confirms no snapshot carries a value.

## 6. Cost-of-sales evidence mismatch

Fixed and verified. Descriptors are scoped to the suppliers that contributed (ADR-104), and the summed amount now matches the figure (ADR-105, item 9). Probed through the analyst's own `get_transactions_for_evidence` tool against a live run: a `cost_of_sales` figure of 3,000.000000 returns **2 records, £1,800 and £1,200, sum £3,000.00, count 2**. `operating_expenses` carries a descriptor naming only the marketing supplier and no stock supplier. `other_expense`, a category nobody's purchases went into, carries no descriptor at all.

## 7. Gross-margin assurance

Verified. `pnl.ts#buildGrossMargin` returns NULL whenever cost of sales is absent by design, so no 100% margin is ever published, and `gross_margin` is not a Home card. Measured on the ledger organisation whose purchases exist only as invoices: `cost_of_sales = NULL ["cost_of_sales_in_other_source"]`, `gross_margin = NULL`, and Home reports `hidesGrossProfit: true`. No cost is invented. The reason code `gross_margin` itself stores remains `no_cost_of_sales_accounts` where `cost_of_sales` stores `cost_of_sales_in_other_source` — LOW-9, open and unchanged; Home reads `cost_of_sales`'s own reason, so the reader is told the right one.

## 8. Home gross-profit card

Fixed in `8f81dd3` and verified in the browser. `buildHeadlineCards` now reads what the engine emits — the `no_cost_of_sales` warning on `gross_profit`, or a `cost_of_sales` that is NULL with `no_cost_of_sales_accounts` or `cost_of_sales_in_other_source` — instead of the `gross_profit.missing` field `pnl.ts#buildGrossProfit` deliberately empties.

| Case | Result at `8f81dd3` |
|---|---|
| A · invoice-only, no direct-cost purchases | **no card.** Home shows Sales £9,000, Profit £9,000, Cash —, then "Profit after direct costs isn't shown: You have no direct-cost accounts, so this does not apply." Console clean (browser probe) |
| B · ledger basis, costs only in invoices | **no card.** `hidesGrossProfit: true`; cards are revenue, operating profit, cash only; the reason carried is `cost_of_sales_in_other_source` (probe) |
| C · cost-of-sales purchase present | **card shown**, "Profit after direct costs · Calculated · £7,000" on revenue 9,000 less cost 2,000, and no note (browser probe) |
| D · NULL revenue | no card and no zero: a NULL value renders as an em-dash; `home-headline-cards.test.ts` asserts it |
| E · monthly report | the report calls the same `buildHeadlineCards` and destructures the already-filtered `cards`; it has no gross-profit rule of its own, so it cannot disagree with Home |

## 9. Invoice-basis evidence correction

Fixed in `8f81dd3` and verified against the compiled descriptor, not only the test. A `CompiledQuery` carries `amountBasis`. An invoices descriptor with `open_as_of` or `overdue_as_of` — the receivables and payables shape — keeps `column` with `amountColumn: 'balance_due'`. Every other invoices descriptor compiles to `invoice_net`, and the resolver reads each row through `invoiceNetOfTax` signed by `invoiceSignFor`, so credit notes subtract. The two bases are not collapsed. `invoiceNetOfTax` is imported from the financial engine, so no second implementation of the rule was created.

## 10. Regression tests

Added with the fix and green in this run: `home-headline-cards.test.ts` (4 unit cases, using the shape the engine really writes); `evidence-descriptor.test.ts` (+1: a P&L descriptor compiles to `invoice_net` with the money columns and the supplier filter intact, an as-of descriptor stays on `balance_due`); `engine-invoice-golden.test.ts` (+2 `loadHome` cases, card shown and card hidden with the reason); `evidence-invoice-basis.test.ts` (5 integration cases against a real run under the owner's RLS: unpaid 1,800, partly paid 1,200 and fully paid 500 each show their net and **sum to the displayed 3,500.00**; a fully paid 10,000 sale still reports 10,000, not 0; operating expenses names the marketing supplier only; two categories with no purchases have no descriptor; a receivables-shaped descriptor still sums `balance_due` to 4,100.00 with the paid invoice at 0).

## 11. Adversarial probes

13 probe files, 45 assertions: **40 pass, 5 fail, and every failure is accounted for as a probe artefact or a documented pre-existing item.** None is a regression in shipped behaviour.

| Probe | Result |
|---|---|
| Empty organisation, invoice-only, bank + invoice, AED organisation, credit note, fully paid, partly paid, no-cost-of-sales, ledger with invoice-only costs, history-first banking, counterparty merge, tenant boundary, employee assignment boundary, client isolation | pass |
| Evidence drill-down (`evidence13b`, `evidence13c`, `evidence14`) | pass |
| `evidence13` (superseded) | 1 failure — the fixture omits the invoice `record_status_events` a real commit writes and the as-of projection reads. Re-run with them added, the substantive assertions pass (2 records, £3,000 sum against a £3,000 figure); the residual failure is the probe comparing the JSON `null` in `evidence_query` to the string `'NULL'`. Probe defect, not a product defect |
| `cashjoin` / `cashjoin55`, test 1 (account active from the series start, opening balance dated later) | 2 failures — `no_opening_cash`, NULL. **Re-run in a detached worktree at `55acbeb`: identical.** Pre-existing, recoverable through the opening-balance form on Money › Cash |
| `cashjoin` / `cashjoin55`, test 2 (a `no_bank_accounts` NULL handed forward as `openingCarry`) | 2 failures — LOW-8. At `55acbeb` the same probe passed only because the source-less months fabricated `0.00`, which is HIGH-2 itself. `openingCarry` has no production caller: `src` contains only its declaration and its read, and no caller sets `cashOptions`. Both end-to-end history-first probes, which drive the real queue, pass |

Browser probes: Home gross-profit card (new, pass), cash unavailable never £0 (pass), commercial pages at 375 px with no ids on screen (pass), Phase 13 banking pages (one soft failure, item 14).

## 12. Security

PASS. The permission matrix is in sync across all five roles (OWNER, SUPER ADMIN, ADMIN, EMPLOYEE, CLIENT) and is checked in pgTAP against the TypeScript matrix. pgTAP 1,034 assertions green, including `06_financial_rls`. Playwright's `authorization-*` project signs in as three separate callers and checks the route → status matrix. `rls-isolation` (42) and `isolation-cases` (10) green: an employee reaches only assigned client organisations, a client reaches only its own, and organisation B is blind to A across six tables and three functions. Enforcement is server-side and database-level, not UI hiding. Schema drift reports RLS forced everywhere, no write grants and no reachable server functions. Nothing in `8f81dd3` touches RLS, grants, composite FKs or tenant context.

## 13. Tenant isolation

PASS, covered by the suites named in item 12 and by the commercial isolation cases (a client gets `42501` on every commercial write, an unassigned employee `P0002`).

## 14. Phase 13 regression

PASS with one pre-existing exception. `banking.test.ts` (20) green; `journey-13-banking` green inside the Playwright suite; `10_banking_intelligence` pgTAP green. The Phase 13 browser probe re-run at `8f81dd3`: the vocabulary never claims a live bank connection, the source sentence and last-statement line are present, unusual-payment and uncategorised notices render, the transaction detail opens by keyboard and shows category, counted status and printed balance, a malformed id returns 404, and a client sees no add-account, no add-data call to action, no category control and no transfer control. The one soft failure is the Phase 13 audit's own MEDIUM-4: the transactions table forces horizontal scroll at 375 px (scrollWidth 553 against 375). Pre-existing, outside this remediation, and unchanged.

## 15. AI integrity

PASS. The Phase 14 commercial tools call the same `loadProducts`, `loadMarketing` and `loadSales` the screens call, so the AI reads deterministic engine output and is never a source of financial truth. The envelope helpers return `null` for a null value rather than a zero, so an unavailable figure cannot become £0 in a tool result. No tool computes a margin. Evidence references resolve to the same descriptors whose rows now sum to the figure (item 6). Attribution refusal is intact and "Unattributed" is a synthetic engine row the AI reports separately, never a ranked customer. The corrected bank-less fixture is in the committed corpus: `get_metric closing_cash` returns `value: null`, `basis: none`, `no_bank_accounts`, and the `golden:cash` case asserts `£0` is **absent** from the answer. The eval suite passes 170 of 170.

## 16. Known pre-existing issues

- **`ai-eval-record` ordering flake.** `loadAlerts` orders by severity and timestamp with no identifier tiebreaker, and the shape comparison samples only the first array element, so equally ranked alerts can arrive in either order (`get_alerts #16 output shape`, 26 against 25 key paths). **It did not fire in this run** — integration was 668 of 668 — and it passes in isolation. Not fixed, not suppressed, not worked around: the alerts module and the test were left exactly as they are, per instruction.
- **`ai-eval-job` live-model transient.** One "the model could not be called" in an earlier run, never reproduced; passed here. Environmental, not a code regression.
- **Phase 13 MEDIUM-4:** the transactions table scrolls sideways at 375 px.

## 17. Gates — clean database, `8f81dd3`

`supabase db reset`, then in order:

| Gate | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | PASS |
| Lint (`eslint .`) | PASS |
| Unit | PASS — 70 files, 1,994 tests |
| Integration | PASS — 41 files, **668 of 668** |
| pgTAP | PASS — 16 files, 1,034 tests |
| Playwright | PASS — 64 passed, 1 pre-existing skip |
| AI eval | PASS — 170 |
| Schema drift | PASS — 54 tables, 118 api functions, RLS forced, no write grants, no reachable server functions |
| Authorization | PASS — permission matrix in sync, pgTAP RLS, Playwright `authz` project |
| Tenant isolation | PASS — `rls-isolation` 42, `isolation-cases` 10 |
| Production build | PASS |

No gate is called PASS with an unexplained failure inside it.

## Remaining findings

| ID | Severity | Status |
|---|---|---|
| MEDIUM-7 | — | **CLOSED** by `8f81dd3`: Home hides the gross-profit card and gives the engine's reason |
| MEDIUM-8 | — | **CLOSED** by `8f81dd3`: invoice-basis P&L evidence sums the net, and reconciles |
| LOW-1…6 | LOW | open, unchanged (overview Why link not rendered; tool money values without per-figure assurance; GBP fallback; mixed minor units; duplicate reads; no Action Centre link) |
| LOW-7 | LOW | open: VAT-fallback share counts purchase rows against revenue; over-flags, never understates |
| LOW-8 | LOW | open: `computeCash` handed an `openingCarry` carrying `no_bank_accounts` keeps the series NULL; no production caller supplies one |
| LOW-9 | LOW | open: `gross_margin` stores `no_cost_of_sales_accounts` where `cost_of_sales` stores `cost_of_sales_in_other_source` |
| LOW-10 | LOW | open: NULL cash snapshots store `assurance_level = calculated`; the badge shows "—" |
| Phase 13 MEDIUM-4 | MEDIUM (Phase 13) | open: transactions table scrolls sideways at 375 px |
| `ai-eval-record` flake | — | open, deliberately untouched |

## Scope check on the final tree

`git diff b2a73ea..8f81dd3` introduces no Phase 15 surface: no Adviser or CFO Command Centre route, no portfolio table, no multi-client dashboard (`/portfolio` has existed since Phase 1 and no Phase 13 or 14 commit touches it). Three migrations, all Phase 13 and 14, and every grant statement in them revokes rather than widens. No policy dropped, no RLS disabled. `f8fdc58..8f81dd3` changes no migration, no schema, no precedence, no `app.invoice_net` semantics, no Phase 13 contract, no alerts module and no test expectation written to fit broken behaviour.

## Phase 15

**NOT STARTED.** The next step is the independent Fable 5.1 audit. Only that audit can declare Phase 14 ready for Phase 15.

---

# Part A — final independent re-audit of `f8fdc58`

> **Commit audited: `f8fdc58`** on `main` (`HEAD`, `origin/main` and the working tree agree; `git status --porcelain` empty). Audit date: 2026-09-23. Method: code reading of the committed tree; the full gate suite on a clean database (`supabase db reset`); every adversarial probe from the two earlier audits re-run; new probes for the three previous blockers, for a business that imports history before adding banking, for the analyst's evidence tool, and for Home; a detached worktree at 55acbeb for before/after comparison. **No implementation code was modified.** Part B below is the implementation team's record, kept as submitted.

## Verdict

**NOT READY FOR PHASE 15.**

The three blockers from the previous audit are **independently resolved** — cash is unavailable with its reason where nothing can establish it, the cost-of-sales drill-down selects exactly its suppliers, and a ledger organisation with invoice-only purchases no longer gets a silent 100% margin — and every gate is green on a clean database, including a 661-of-661 integration run in which the known flake did not fire. The verdict turns on two findings that are pre-existing in origin but stand between the reader and an honest figure: Home has never hidden the "Profit after direct costs" card when cost of sales is absent by design (the rule it relies on reads a field the engine deliberately empties), so an organisation with no cost data is shown profit after direct costs equal to its sales; and the evidence drill-down behind an invoice-basis P&L figure sums the invoices' *outstanding balance*, not their net amount, so "Cost of sales £3,000" lists rows totalling £3,600 and a fully paid invoice would appear as £0 under revenue. Both are small to fix and precisely located below. Under the stated bar — no new MEDIUM correctness issue — the honest answer is not yet.

| Severity | Count | |
|---|---|---|
| CRITICAL | 0 | |
| HIGH | 0 | |
| MEDIUM | 2 | both pre-existing in origin; one newly reachable because of ADR-103, one a dead rule the remediation report describes as working |
| LOW | 3 new, plus the 7 carried from earlier audits and the Phase 13 mobile-scroll item |

## A. Cash engine

Reproduced end to end (real queue, real aggregate) and at unit level.

| Check | Result |
|---|---|
| No bank account, no statement | `opening_cash`, `closing_cash`, `cash_inflows`, `cash_outflows`, `net_cash_movement` all **NULL**; basis `none`; completeness 0; reason `no_bank_accounts` — on an invoice-only organisation (revenue 7,000 on `invoices`), and on every period of an organisation with nothing |
| Not zero | no cash metric carries a value for such an organisation (`select … where value is not null` returns nothing across the family) |
| Home | "Cash — · no comparison yet" beside correct headline figures; no "£0" anywhere on the page |
| Money › Cash | "Money in — … Add a bank account and upload its statements to see your cash." for every cash row; no "£0" |
| Assurance | the badge is "—" with the reason tooltip; `statusFor` short-circuits on a NULL value before assurance is considered. The stored `assurance_level` column still reads `calculated` on the NULL row (LOW-10 below) |
| Valid account and balance | golden org B: `closing_cash` 8,800.00 on basis `bank`, inflows 4,800.00, outflows 1,000.00; the repository's cash unit suite (multi-account aggregation 1,000 + 500 → 1,560; one missing balance → NULL `no_opening_cash`) green |
| Closed account | unit: an inactive account with a covering statement still yields that month's closing cash |
| Later periods | no fabricated zero is inherited: months without a source stay NULL `no_bank_accounts`; the first month with a statement computes from the statement/opening balance |
| History first, banking later | **the case most likely to regress, probed end to end through the app's own `import_commit` trigger:** three months of invoices then a bank account and August statement → August `opening 5,000 / inflows 1,000 / closing 6,000`, June still NULL `no_bank_accounts`; fourteen months of invoices then banking in November → November 6,000, October NULL; a subsequent full `recalc_manual` leaves both unchanged. Before f8fdc58 the same organisations reached 6,000 by carrying a fabricated 0 through the empty months — the number was the same, the path was not |

Two observations from the unit level, neither reachable through the run (which never passes an `openingCarry`): a `computeCash` caller that DOES carry a `no_bank_accounts` NULL into a later chunk poisons the series (LOW-8); and an account that is active from the series start but only covered later returns `no_opening_cash` from the first period onward until an opening balance dated at the series start is entered — identical on 55acbeb, so pre-existing and by the comment's design, recoverable through the opening-balance form on Money › Cash (observation, not a finding).

## B. Empty-set zero-fill sweep

An organisation with no records at all, calculated: **no snapshot carries a value** — `customer_revenue`, `supplier_spend` and the synthetic concentration remainder, which 55acbeb wrote as 0.00 with basis `none` for every period, are gone. A ledger-only organisation: cash NULL `no_bank_accounts`, `cost_of_sales` NULL `no_cost_of_sales_accounts`, concentration NULL `no_counterparty_data`, `gross_margin` NULL — no zero where the source stated nothing. The never-zero-fill principle holds across the P&L, cash and counterparty families.

## C. Evidence

Reproduced with a 10,000 sale, cost-of-sales purchases of 1,800 + 1,200 from two suppliers, a 1,000 marketing purchase and a 600 uncategorised purchase:

- the stored `cost_of_sales` descriptor carries `counterparty_ids` = the two stock suppliers only; `operating_expenses` names the ads supplier only; `other_expense` (no purchases) carries **no** descriptor rather than a generic one; `revenue` keeps the sales types.
- resolved under the owner's RLS through the evidence service: cost of sales → **exactly 2 rows** (the stock invoices), operating expenses → 1 row, revenue → 1 row. (A first run returned nothing because my fixture had omitted the `record_status_events` a real commit writes and the as-of projection reads; with the events present the descriptors resolve as above. That is a fixture fact, not a defect.)
- **MEDIUM-8 — the amount does not reconcile.** The resolver sums the invoices table's `amountColumn`, which is `balance_due` (`evidence/data/descriptor-compiler.ts`, with a comment that the v1 invoice filters were written for receivables and payables). So the rows behind "Cost of sales £3,000" total **£3,600** (gross, all unpaid), and a fully paid sale would show as **£0** under "Revenue". Until ADR-103 no invoice-basis P&L figure existed to drill into, so this projection was only ever used where Σ `balance_due` is the figure. It is now the drill-down for revenue, cost of sales and every expense category on the invoice basis. Fix: an amount projection per figure family — `app.invoice_net(subtotal, tax_amount, total_amount)` for P&L descriptors, `balance_due` for AR/AP — selected by the descriptor's purpose rather than its table.

## D. Gross margin

| Case | Engine | Home |
|---|---|---|
| Invoice basis with cost lines | `cost_of_sales` 4,000, `gross_profit` 9,000, `gross_margin` 0.69 — normal | card shown, correctly |
| Invoice basis, no purchases | `cost_of_sales` NULL `no_cost_of_sales_accounts`, `gross_margin` NULL, `gross_profit` warns `no_cost_of_sales` | **card shown**: "Profit after direct costs · Partial data · £6,000" (browser probe) |
| Ledger basis, purchases only as invoices | `cost_of_sales` NULL **`cost_of_sales_in_other_source`**, `gross_margin` NULL, `gross_profit` warns | **card shown**: "£9,000 [partial]", `hidesGrossProfit = false` |
| Ledger basis, no cost of sales anywhere | NULL `no_cost_of_sales_accounts` | **card shown**: "£4,000 [partial]" |

No cost is invented anywhere, and no margin is shown: `gross_margin` is NULL in every absent case and is not a Home card. But **MEDIUM-7 — Home does not hide the gross-profit card, and never has.** `buildHeadlineCards` hides it when `gross_profit.dataQuality.missing` contains the absent-by-design code, and `pnl.ts#buildGrossProfit` deliberately **filters that code out** of `gross_profit.missing` (present since Phase 4, `b2a73ea`), replacing it with the warning `no_cost_of_sales`. The rule therefore never fires; f8fdc58 extended a dead rule to the new code and its record states that Home hides the card. What a reader sees is "Profit after direct costs" equal to sales with a "Partial data" badge — exactly the impression CD-05 exists to prevent, for every organisation without cost-of-sales data, which is the commonest state of a small business in MOTION. Fix: test the warning the engine actually emits (`no_cost_of_sales`) or the `cost_of_sales` snapshot's own `missing`, and add the assertion the suite lacks. Also **LOW-9:** `buildGrossMargin` hard-codes `no_cost_of_sales_accounts` as its reason, so the ledger-with-invoices case reports the wrong reason on the margin ("You have no direct-cost accounts").

## E. Phase 14 financial truth

Re-run from the committed tree, independent probes and the repository's suites:

1. **Invoice-only:** revenue 13,000 / cost of sales 4,000 / gross 9,000 / opex 1,500 / net 7,500 (probe); 8,550 / 900 / 7,650 (golden). Σ `customer_revenue` = revenue to the penny.
2. **Bank + invoice:** revenue from invoices (4,000; 8,000), cash from bank (8,800; 6,800), no double count; `FAMILY_PRECEDENCE` unchanged.
3. **Credit notes:** 12,000 − 2,000 → customer 10,000.
4. **`app.invoice_net`:** twelve cases agree between SQL and TypeScript on value and fallback flag; callers `app.aggregate_periods`, `api.set_invoice_lines`, `api.product_period_summary`; no copies of the old expression.
5. **VAT fallback:** 1 of 6 rows → `vat_inclusive`, `estimated`; an all-net organisation → Calculated.
6. **Unattributed:** absent from the overview's top customers, from the engine's top-1/top-5 (attributed rows only), and from `get_customer_profitability.rows` (moved to `not_attributed_to_a_customer`).
7. **Merges:** `commercial.test.ts` "keeps product mix, campaign attribution and revenue under the surviving customer" and the merge refusals — green; total credited revenue across campaigns equals the customer's revenue once.

## F. Phase 13 regression

`banking.test.ts` (20) green; the Phase 13 audit's ten integration probes (tools per role, B against A → NO_DATA, client categorise → 42501, stored identity masked) 10 of 10; `journey-13-banking` green inside the Playwright suite; the Phase 13 browser probe re-run: vocabulary never claims a connection, notices, categories, reconciliation copy, statement freshness, client controls absent, malformed and foreign ids 404 — all intact. The one soft assertion that fails is the Phase 13 audit's own MEDIUM-4 (transactions table forces horizontal scroll at 375 px), pre-existing and outside this remediation.

## G. Security

Permission matrix in sync (121 grants, all five roles). `rls-isolation` (42), `isolation-cases` (10), `ai-tools` role × tool matrix at 26 tools (23), `commercial.test.ts` roles and isolation (client `42501` on every commercial write, unassigned employee `P0002`, organisation B blind to A across six tables and three functions) — all green. Audit probes: an unassigned employee reads nothing and every tool answers with no organisation content; a forged `ctx.orgId` yields `NO_DATA`; a smuggled `organization_id` is stripped by the schema. Nothing in f8fdc58 touches RLS, grants or tenant context.

## H. AI

- `get_metric closing_cash` on the bank-less recording organisation returns `value: null`, `basis: none`, `data_quality.missing: [no_bank_accounts]` (recorded fixture, call 9) — the AI layer receives the NULL and does not manufacture a zero.
- The rewritten `golden:cash` states "We cannot show your cash for May 2026: no bank account has been added yet, so there is no statement to establish it from", cites the NULL snapshot, carries `no_bank_accounts`, and asserts `£0` absent — verified in the committed corpus; the eval suite passes 170 of 170 in every run.
- No tool computes a margin; `get_metric gross_margin` would return the engine's NULL with its reason.
- Evidence references cite the same descriptors whose row set now reconciles (§C) — and whose summed amount does not (MEDIUM-8), which tool 13 would report as `sum`.

## I. Gates — clean database, f8fdc58

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS |
| Unit | PASS — 69 files, 1,989 |
| Integration | PASS — 40 files, **661 of 661** (the known flake did not fire this run) |
| pgTAP | PASS — 16 files, 1,034 |
| Playwright | PASS — 64 passed, 1 pre-existing skip |
| AI eval | PASS — 170 |
| Schema drift | PASS — 54 tables, 118 api functions, RLS forced, no write grants |
| Authorization | PASS |
| Tenant isolation | PASS |
| Production build | PASS |
| Phase 14 adversarial probes | 23 of 23; plus history-first (2), evidence (2), banking (10), browser (Home, Cash, banking pages) |

**Known pre-existing flakes.** `ai-eval-record`: the ordering nondeterminism in `loadAlerts` (no identifier tiebreaker) sampled by a first-element shape comparison — did not fire in this run; fired in 3 of 3 full-suite runs of the previous audit; not introduced or changed by f8fdc58 (alerts module untouched, recording organisation has no invoices). `ai-eval-job`: one transient "the model could not be called" from the live model in one earlier run; passed in isolation and in every other run including this one; treated as environmental.

## J. Remaining findings

| ID | Severity | Status |
|---|---|---|
| MEDIUM-7 | MEDIUM | NEW (pre-existing since Phase 4/5): Home's gross-profit hide rule reads a field the engine empties; "Profit after direct costs" = sales is shown with a Partial badge whenever cost of sales is absent by design |
| MEDIUM-8 | MEDIUM | NEW (pre-existing, newly reachable): invoice-basis P&L evidence sums `balance_due`; rows reconcile, amounts do not |
| LOW-8 | LOW | NEW: `computeCash` poisons the series when handed an `openingCarry` carrying `no_bank_accounts`; the run passes no carry, so unreachable today |
| LOW-9 | LOW | NEW: `gross_margin` reports `no_cost_of_sales_accounts` where `cost_of_sales` reports `cost_of_sales_in_other_source` |
| LOW-10 | LOW | NEW: NULL cash snapshots store `assurance_level = calculated` (the badge is "—"; consistent with the `no_opening_cash` convention) |
| LOW-1…6 | LOW | open, unchanged (overview Why link not rendered; tool money values without per-figure assurance; GBP fallback; mixed minor units; duplicate reads; no Action Centre link) |
| LOW-7 | LOW | open: VAT-fallback share counts purchase rows against revenue; over-flags, never understates |
| Phase 13 MEDIUM-4 | MEDIUM (Phase 13) | open: transactions table scrolls horizontally at 375 px |

## Closed by f8fdc58 (verified)

HIGH-2 cash empty-set zero · MEDIUM-4 evidence row set · MEDIUM-5 gross-margin source rule · the empty-organisation `customer_revenue`/`supplier_spend` zeros · the report/Home comparison-month disagreement · the recorded `£0` cash fixture and golden.

## What readiness needs

Two contained changes and a test each: make Home's hide rule read what the engine emits (and assert it for the invoice-only, ledger-only and ledger-with-invoice-cost cases), and give invoice-basis P&L descriptors a net amount projection distinct from the receivables one (and assert that the drill-down's sum equals the figure). Neither touches precedence, `app.invoice_net`, attribution, the alerts module or the cash rule verified above.

---

# Part C — remediation of MEDIUM-7 and MEDIUM-8 (ADR-105)

> Date: 2026-09-23. Answers Part A above. The three earlier blockers were verified closed there and were not touched; nothing changed in the cash rule, `no_bank_accounts`, precedence, `app.invoice_net`, the VAT fallback, attribution, the unattributed handling, merges, Phase 13 banking, the alerts module, tenancy, employee permissions or the AI architecture. The `ai-eval-record` ordering flake is documented, not touched.

## MEDIUM-7 — Home gross-profit card

**Defect.** `buildHeadlineCards` hid the card when `gross_profit.dataQuality.missing` carried the absent-by-design code; `pnl.ts#buildGrossProfit` has always removed that code from `gross_profit.missing` and written gross profit as revenue with the warning `no_cost_of_sales`. The rule was dead: "Profit after direct costs · Partial data · £4,000" showed for every organisation without cost data.

**Fix** (`dashboard/services/home.ts`, presentation only — the engine is unchanged): the rule now reads the engine's actual contract — the `no_cost_of_sales` warning on `gross_profit`, and a `cost_of_sales` that is NULL with `no_cost_of_sales_accounts` or `cost_of_sales_in_other_source` (the old `missing` check is kept for completeness). The card is omitted and Home prints the engine's reason beneath the headline figures in the shared reason words ("Profit after direct costs isn't shown: You have no direct-cost accounts, so this does not apply." / "… Your purchase invoices show direct costs, but the source this month's figures come from does not …"). The monthly report builds its cards through the same function, so it omits the card too. No value is manufactured, no NULL becomes zero, and a valid gross profit still shows with its figure.

**Tests.** `test/unit/home-headline-cards.test.ts` (4): shown with 7,650 when a cost line exists; omitted with the reason for `no_cost_of_sales_accounts` **using the shape the engine really writes** (revenue value, warning, empty `missing`); omitted for `cost_of_sales_in_other_source`; a NULL revenue produces no card and no zero. `test/integration/engine-invoice-golden.test.ts` (+2): the invoice-only organisation with a cost line shows the card at 7,650 through `loadHome`; the ledger organisation with invoice-only cost of sales hides it and carries the reason. The pre-existing `home-figures.test.ts` case still passes.

## MEDIUM-8 — invoice-basis evidence amount

**Defect.** The invoices projection in `evidence/data/descriptor-compiler.ts` summed `balance_due`, written for receivables and payables. Behind "Cost of sales £3,000" the rows totalled the £3,600 still owed; a paid sale appeared under "Revenue" as £0.

**Fix** (descriptor resolution, not display): a compiled query now carries `amountBasis`. An invoice descriptor with `open_as_of` / `overdue_as_of` — the receivables and payables shape — keeps `column` = `balance_due`. Every other invoice descriptor (revenue, cost of sales, an expense category, a customer's revenue on the invoice basis) is `invoice_net`: each row's amount is `invoiceNetOfTax` (the TypeScript mirror of `app.invoice_net`) signed by invoice type, so credit notes subtract and Σ rows equals the figure whatever has been paid. `subtotal` and `tax_amount` join the invoice column allow-list for that purpose. The supplier scoping of ADR-104 is untouched and a category nobody's purchases went into still carries no descriptor.

**Tests.** `test/unit/evidence-descriptor.test.ts` (+1): a P&L invoice descriptor compiles to `amountBasis: invoice_net` with the money columns selected and the supplier filter intact; an `open_as_of` descriptor stays on `balance_due`. `test/integration/evidence-invoice-basis.test.ts` (5), resolved under the owner's RLS through the real evidence service against a real run: **unpaid** (1,800 net, not the 2,160 owed), **partly paid** (1,200, not the 740 still owed), **fully paid** (500, not 0) — three suppliers summing to the displayed 3,500.00; **revenue** of a fully paid sale still 10,000.00, not 0; **operating expenses** only the marketing supplier at 1,000.00; **a category with no purchases** (`other_expense`, `interest_expense`) has no descriptor; and a receivables/payables-shaped descriptor still sums `balance_due` (4,100.00, the paid one 0).

## Gate results after remediation

Clean database (`supabase db reset`), 2026-09-23:

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint (`eslint .`) | PASS |
| Unit | PASS — 70 files, 1,994 tests (+5: Home cards, descriptor basis) |
| Integration | 667 of 668 — the one failure is the documented `ai-eval-record` ordering flake (`get_alerts #16 output shape`, 26 vs 25 key paths); it passes in isolation, and the alerts module and recording organisation are untouched by this commit. Green: `evidence-invoice-basis` (5, new), `engine-invoice-golden` (17), `home-figures`, `reporting` (16), `commercial` (11), `banking` (20), `ai-tools` (23), `rls-isolation` (42), `isolation-cases` (10), `ai-eval-job` (2) |
| pgTAP | PASS — 16 files, 1,034 |
| Playwright | PASS — 64 passed, 1 pre-existing skip |
| AI eval | PASS — 170 |
| Schema drift | PASS — 54 tables, 118 api functions (no schema change) |
| Authorization / Tenant isolation | PASS |
| Production build | PASS |

> Corrected by Part D item 11: the probe suite is 13 files and 45 assertions, of which 40 pass; the "37 of 37" below counted only the assertions this pass re-ran by hand. The five failures are itemised there — one probe-fixture failure and four pre-existing cases (two assertions, each in a duplicated probe file), none a regression.

**Re-verification of A–J from the brief, probes re-run against the remediated tree (37 of 37):** invoice-only P&L reconciles (13,000 / 4,000 / 9,000 / 7,500; golden 8,550 / 900 / 7,650); invoice-only without a cost basis keeps `cost_of_sales` NULL and Home shows no gross-profit card but the sentence "Profit after direct costs isn't shown: You have no direct-cost accounts, so this does not apply." (browser); the cost-of-sales drill-down now totals 3,000.00 behind a 3,000.00 figure and 10,000.00 behind a fully paid 10,000.00 sale; a partly paid invoice shows its net; bank + invoice precedence and cash unchanged (8,800 on bank, 4,000 on invoices); no bank account → cash NULL `no_bank_accounts`, "Cash —" on Home; history first then banking later still reaches 6,000; commercial rules, currency, isolation and the analyst's tool contexts unchanged; Phase 13 banking probes 10 of 10; RBAC and tenant suites green.

**Remaining findings (unchanged, none blocking):** LOW-1…7 from earlier audits, LOW-8 (`computeCash` with a `no_bank_accounts` carry; unreachable through the run), LOW-9 (`gross_margin` reason code), LOW-10 (NULL cash snapshots store `assurance_level = calculated`), the Phase 13 transactions-page 375 px scroll (Phase 13 MEDIUM-4), and the pre-existing `ai-eval-record` flake.

Readiness is for the independent audit to declare; this record claims only that the two findings are fixed and verified.

# Part B — implementation record, as submitted with f8fdc58

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
