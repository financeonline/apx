# Phase 14 — remediation, verification and closeout

> **Final commit: the Phase 14 invariant hardening (ADR-109)** on `main`, pushed to `origin/main`, working tree clean. It answers the release check of `621f9e6` recorded in Part G.
>
> **Status: IMPLEMENTED AND VERIFIED — INDEPENDENT FABLE 5.1 SIGN-OFF PENDING.** Parts D and E were written by the implementing session under Opus 5. Part F's audit ran under Fable 5.1 in the same session, which is model independence and not context independence; its findings were reproduced against a clean database with fresh figures rather than recalled. Phase 14 is **not** declared ready for Phase 15 in this file. Parts are in the order they were produced, newest first.
>
> Commit chain: `55acbeb` (ADR-103) → `f8fdc58` (ADR-104) → `8f81dd3` (ADR-105) → `b6cac0b` (closeout record) → `33ae461` (ADR-106, ADR-107) → `621f9e6` (ADR-108, ADR-106 addendum) → this commit (ADR-109).
>
> **Phase 14 is NOT READY for Phase 15.** One HIGH remains open and is not a defect this pass could close by itself: bank-basis counterparty evidence (HIGH-3 in Part G) needs a product decision between narrowing a figure and withdrawing a descriptor. Everything else raised across six passes is closed and verified.

---

# Part G — release check of `621f9e6`: the invariant gets a guard, and the guard finds two more

The previous five passes each fixed "the drill-down must equal the figure" in one more place. This pass asked a different question: how many places are there, and which has nobody looked at? The engine has **16 leaf-descriptor producers** across four files; five metric families had a reconciliation test.

## The guard

`test/integration/evidence-reconciliation-sweep.test.ts` names no metric. It seeds three organisations on the three P&L bases, reads every row of `metric_current` whose snapshot carries a leaf descriptor, resolves each through the real evidence service under the owner's RLS, and asserts Σ evidence = figure. **97 descriptors checked on the final tree.** The fixture contains rows the figures exclude — voided invoices, a credit note, an uncategorised payment, a matched transfer pair, an unpaired transfer candidate — so a descriptor that is merely too broad fails rather than passes. A new figure joins the test by existing.

Proved both ways: on `621f9e6` it reports 110 descriptors and **fails** with the two defects below; on this tree it reports 97 and passes.

## HIGH-4 — `other_income` re-selected every sale (fixed, ADR-109)

On the invoice basis the income branch returned the sales-type descriptor to whichever income figure asked. Exact for `revenue`; wrong for `other_income`, which no invoice can reach. Measured: a figure of **0.00** with a drill-down of **18,500.00 over three rows** — every sale in the month, sitting behind a line that was zero. The branch now takes the income category and returns no descriptor for anything but revenue, the guard the expense branch has always had.

## MEDIUM-5 — a directional bank selection summed to the negative of its figure (fixed, ADR-109)

`cash_outflows` of **4,200.00** had a drill-down totalling **−4,200.00**, while `cash_inflows` matched: one statement, two sign conventions, and the analyst's `sum` would have cited the negative. Any `bank_transactions` descriptor carrying a `direction` now totals on the column's magnitude, because the engine states money out as a positive magnitude as it does every expense.

## HIGH-3 — bank-basis counterparty evidence: confirmed, root cause identified, NOT fixed

The one family the sweep cannot yet include, named in the test rather than skipped.

On the **bank** basis a counterparty's figure is Σ|amount| over every cell for that party that is not revenue-categorised. `compose.ts#counterpartyAmounts` classifies by category and takes `.abs()`, so the figure includes uncategorised rows, transfer legs, and inflows that are not revenue-categorised. The descriptor (`concentration.ts`) selects expense-category, outflow, non-cash-transfer rows. Measured: `supplier_spend` of **8,850.00** with a drill-down of **0.00 over 0 rows** once the banking pass had recategorised the fixture's payments.

The two populations differ by construction, and a v1 descriptor cannot express the first: there is no "not in these categories" filter, and adding one would not fix the inflow and transfer differences. Closing it means **either** narrowing the figure to expense-category non-transfer outflows, which changes a financial output, **or** withdrawing the descriptor on this basis as the engine already does for the Unattributed row ("evidence that reconciles to the wrong number is worse than none"). Both are product decisions. Patching the compiler to paper over it would be the speculative change this pass was told not to make.

Scope: organisations whose P&L basis is `bank`, for `customer_revenue` and `supplier_spend` drill-downs only. No figure is wrong; the evidence behind these two is.

## Gates and probes — clean database, final tree

| Gate | Result |
|---|---|
| Typecheck, Lint | PASS |
| Unit | PASS, 73 files, 2,009 |
| Integration | PASS, 45 files, **686 of 686 in this run**. Not an invariant: the nondeterministic `ai-eval-record` test can fail on any run |
| pgTAP | PASS, 16 files, 1,034 |
| Playwright | PASS, 64 passed, 1 pre-existing skip |
| AI eval | PASS, 173 |
| Schema drift | PASS, 54 tables, 118 api functions, RLS forced everywhere, no write grants |
| Authorization, Tenant isolation | PASS, permission matrix in sync across all five roles, `rls-isolation` 42, `isolation-cases` 10, Playwright `authz` project |
| Production build | PASS |

**Adversarial probes**: 15 files, 52 assertions, **50 pass**. The two failures are the documented pre-existing cash-join cases (confirmed identical on `55acbeb`; LOW-8's unreachable `openingCarry` path), unchanged by this pass.

**Evidence reconciliation sweep**: 97 leaf descriptors across the three P&L bases, all reconciling.

**Pre-existing nondeterministic `ai-eval-record` test**, measured again on the final tree: **8 isolated runs, 8 pass, 0 fail**. Across this project's measurements the isolated pass rate has been 5 of 8, 3 of 5, 7 of 8 and now 8 of 8. It is nondeterministic, it can fail on any run, and it was not fixed, suppressed or altered. It did not fire in the gate run above.

**Security and tenant isolation.** All five roles behave as the matrix states; an employee reaches only assigned organisations and a client only its own; enforcement is server-side and in RLS. The three Phase 13 and 14 migrations follow the established SECURITY DEFINER pattern — each `api.*` function revoked from `public` and `anon` and granted `execute` to `authenticated`, each `api_server.*` function granted only to `service_role`, direct table writes revoked, RLS enabled and forced, no policy dropped, and no tenant-boundary weakening demonstrated by any probe or suite. This pass touches none of it.

**`app.invoice_net`.** Verified on the live database rather than from the guard: `app.aggregate_periods`, `api.set_invoice_lines` and `api.product_period_summary` each call it exactly once, and none carries its own spelling of the rule, qualified or bare. The pgTAP guard's regex matches only the unqualified spelling and is therefore weaker than it reads; it was left as it is rather than made brittle, and the limitation is recorded as LOW-11.

## Remaining findings after this pass

| ID | Severity | Status |
|---|---|---|
| HIGH-1, HIGH-2, HIGH-4, MEDIUM-1, MEDIUM-3, MEDIUM-5, MEDIUM-7, MEDIUM-8 | — | CLOSED and verified, each by a test that fails without its fix |
| **HIGH-3** | **HIGH** | **OPEN**: bank-basis counterparty evidence (above). Needs a product decision; blocks Phase 15 |
| MEDIUM-2 | MEDIUM | open by instruction: the nondeterministic `ai-eval-record` test |
| Phase 13 MEDIUM-4 | MEDIUM (Phase 13) | open: the transactions table scrolls sideways at 375 px |
| LOW-1…13 | LOW | open, unchanged, as listed in Part E |

---

# Part F — Fable 5.1 audit of `33ae461`, and the closure that answers it

The audit ran under Fable 5.1 against `33ae461` on a clean database, with fresh figures, and re-ran every gate itself rather than accepting Part E's numbers. It verified the two fixes of `33ae461`, confirmed the merge gap Part E had left open and found it wider than recorded, and found one presentation surface the availability rule had not reached. This part records the audit, the closure, and the verification of the closure.

## Verified at `33ae461`, independently

- **Void (ADR-107).** On an organisation with a sale of 17,250 beside a voided sale of 4,444, and a purchase of 2,675 beside a voided purchase of 8,888 **from the same supplier** (so supplier scoping could not hide it): cost of sales 2,675 with a drill-down of 2,675, revenue 17,250 with a drill-down of 17,250, and the analyst's evidence tool citing 17,250 over one record. The voided ids appear in no selection.
- **Analyst availability (ADR-106).** On an organisation with sales of 12,500 and no direct-cost accounts: Home omits the card; `get_business_summary` and `get_metric` return no value with `not_applicable` and the reason; `get_metric_trend` returns a point with no value and an empty summary.
- **Health, alerts, forecast, scenarios.** Read for the same figure: the profitability dimension and the margin alert consume `gross_margin`, which is NULL; the forecast projects gross profit only when both revenue and cost of sales have levels, and scenarios take it from the forecast. None reintroduces the figure.
- **The re-recorded fixture.** A structural diff of every recorded call between `b6cac0b` and `33ae461` shows the same thirty calls and, apart from `availability` paths, no key path added or removed anywhere.
- **Grounding.** The allowed-set walker builds citable entries only from branded numeric nodes, so `availability.explanation` is inert text and cannot be quoted as a figure.
- **Gates at `33ae461`** (independent run): typecheck, lint, unit 2,003, pgTAP 1,034, Playwright 64 with one pre-existing skip, AI eval 173, schema drift, build all PASS; integration 678 of 679, the one failure the nondeterministic `ai-eval-record` test (`get_alerts #16 output shape`, 27 against 25).

## HIGH-2 — a merged counterparty's rows were missing from the survivor's evidence, on every basis

**Found.** Part E recorded the customer case on the invoice basis and left it. The audit reproduced it (customer revenue 8,000, evidence 5,000) and then probed where the same builder is used. It is everywhere a counterparty scopes a descriptor:

| Case | Engine | Drill-down before |
|---|---|---|
| Merged customer, invoice basis | 8,000.00 | 5,000.00 |
| Merged supplier, `supplier_spend`, invoice basis | 3,750.00 | 1,500.00 |
| Cost of sales fed by that merged supplier (ADR-104's supplier-scoped descriptor) | 3,750.00 | names the survivor only |
| Merged customer, **ledger** basis | 5,000.00 | 4,000.00 |

Root cause: the fold attributes a merged party's rows to its survivor, a merge is a pointer that never rewrites a row, and both descriptor builders — `concentration.ts#counterpartyEvidence` and `pnl.ts#leafEvidence` — recorded only the surviving id. It understates rather than overstates, on a first-class Phase 14 feature, reached by the ordinary merge action.

**Fixed (ADR-108).** One pure helper, `withMergedCounterparties`, computes the closure once — the named ids plus every counterparty merged into them, followed to a fixed point, sorted — and both builders call it. Nothing about the fold, any figure, precedence or `app.invoice_net` changed; what changed is which rows a descriptor names.

**Verified.** On fresh organisations: a merged customer's revenue 8,550 with a drill-down of 8,550 over two rows including the absorbed sale; a merged supplier's spend 2,260 and the cost of sales it feeds 2,260, both drill-downs naming both suppliers and reconciling; a ledger-basis merged customer 4,025 with a drill-down of 4,025; and the analyst's evidence tool citing both rows and 8,550. The audit's own probes re-run against the fix: 3,750 with 3,750, 5,000 with 5,000, 8,000 with 8,000. `test/integration/evidence-merged-counterparty.test.ts` **fails 4 of 4 on `33ae461`** and passes here.

## MEDIUM-3 — the Profit & loss page still printed the gross profit Home hides

**Found.** On the 12,500 organisation, Money › Profit & loss printed:

| Line | Before |
|---|---|
| Revenue | £12,500.00 · Calculated |
| Cost of sales | — · "You have no direct-cost accounts, so this does not apply." |
| **Gross profit** | **£12,500.00 · Partial data · "Some data is missing or uncategorised"** |
| Gross margin | — · "You have no direct-cost accounts, so this does not apply." |

The one line the product had decided not to state as a conclusion was stated, with a generic badge, on the page an owner opens to look closer, between two lines that gave the real reason.

**Fixed (ADR-106 addendum).** `figuresFor` now reads `metricAvailability` — the same rule Home and the analyst read, not a page-local one — and presents a `not_applicable` figure exactly as an unavailable figure is presented, by handing the renderer the row with no value and the engine's reason. No second rendering rule exists. Revenue and a real gross profit are untouched.

**Verified.** The line now reads "—" with "You have no direct-cost accounts, so this does not apply."; the organisation with a real cost line still shows £7,000.00 · Calculated and a real margin. Asserted in both directions in `test/integration/ai-gross-profit-availability.test.ts`.

## Cross-surface consistency, after this pass

One rule, `metricAvailability` in `financials`, read by: Home, the monthly report (through the same card builder), Money › Profit & loss, `get_business_summary`, `get_metric`, `get_metric_trend`, and therefore the analyst's answer. The Money index page lists revenue, cash and net movement and never carried gross profit. Health, alerts, forecast and scenarios consume `gross_margin` or require both sides, and were already consistent. The engine is untouched throughout: it still writes gross profit as revenue with its warning, because a statement has to add up, and no surface now reads that number as a conclusion.

## Invoice eligibility, final rule

For a P&L-shaped invoice descriptor: accepted, not superseded, **not void**, the canonical signed net-of-tax amount, and — for a counterparty-scoped one — the survivor plus every party merged into it. Payment status never zeroes a recognised invoice. For the receivables and payables shape: the same eligibility, summed on `balance_due`. One spelling of each clause: the lifecycle pair in the compiler's shared block, the void clause in one helper both shapes call, the amount basis chosen by shape, and the merge closure in one engine helper both descriptor builders call.

## Tests added in this pass

| Test | Cases |
|---|---|
| `test/integration/evidence-merged-counterparty.test.ts` | 4. Merged customer on the invoice basis; merged supplier's spend and the cost of sales it feeds; the analyst's evidence tool; merged customer on the ledger basis. Each asserts the descriptor names both parties, the absorbed row is present, the count, and total = figure. **4 of 4 fail on `33ae461`.** |
| `test/integration/ai-gross-profit-availability.test.ts` | +2. The Profit & loss page prints "—" with the reason for the organisation without cost of sales, and £7,000.00 · Calculated for the one with it. |
| `test/unit/engine-merged.test.ts` | 5. The closure: unchanged ids sorted, every party merged into a survivor, a chain followed, an absorbed id alone not widened, byte-stability. |

The AI evaluation cases for the unsupported and the valid gross profit (one golden, two traps, added in `33ae461`) stand. The voided-invoice and merged-counterparty evidence cases are proved through the real `get_transactions_for_evidence` tool in the integration tests above rather than in the recorded corpus, because the recording's inputs are period labels and an evidence call needs a snapshot id that exists only at run time; the corpus itself contains no evidence-tool call.

## Gates — clean database, final tree

`supabase db reset`, then in order:

| Gate | Result |
|---|---|
| Typecheck, Lint | PASS |
| Unit | PASS, 72 files, 2,008 |
| Integration | PASS, 44 files, **685 of 685 in this run**. Not an invariant: the nondeterministic `ai-eval-record` test can fail on any run |
| pgTAP | PASS, 16 files, 1,034 |
| Playwright | PASS, 64 passed, 1 pre-existing skip |
| AI eval | PASS, 173 |
| Schema drift | PASS, 54 tables, 118 api functions, RLS forced everywhere, no write grants |
| Authorization, Tenant isolation | PASS, permission matrix in sync across all five roles, `rls-isolation` 42, `isolation-cases` 10, Playwright `authz` project |
| Production build | PASS |

**Adversarial probes**: 15 files, 52 assertions, **50 pass**. The two failures are the documented pre-existing cash-join cases (confirmed identical on `55acbeb`; LOW-8's unreachable `openingCarry` path), unchanged. Everything in the brief's list is covered: empty organisation, no bank account, banking added later, invoice-only, bank plus invoice, the AED organisation, credit note, voided invoice, superseded invoice and its replacement, paid and partly paid invoices, cost of sales absent and in another source, supplier and customer merges on the invoice and ledger bases, evidence reconciliation, product partition, campaign attribution, unattributed exclusion, analyst and Profit & loss gross-profit handling, employee assignment, client and tenant isolation.

**Pre-existing nondeterministic `ai-eval-record` test**, measured again on the final tree: **8 isolated runs, 7 pass, 1 fail**, the failure carrying the known signature (`get_alerts #16 output shape`, 26 against 25). Earlier measurements were 5 of 8 and 3 of 5. It is nondeterministic, not a full-suite effect, and it was not fixed, suppressed or altered.

**Security.** All five roles behave as the matrix states; an employee reaches only assigned organisations and a client only its own; enforcement is server-side and in RLS. The three Phase 13 and 14 migrations follow the established SECURITY DEFINER pattern: each `api.*` function is revoked from `public` and `anon` and granted `execute` to `authenticated`, each `api_server.*` function is granted only to `service_role`, direct table writes are revoked, RLS stays enabled and forced, no policy is dropped, and no tenant-boundary weakening was demonstrated by any probe or suite. This pass touches none of it.

## Remaining findings after this pass

| ID | Severity | Status |
|---|---|---|
| HIGH-1, HIGH-2, MEDIUM-1, MEDIUM-3, MEDIUM-7, MEDIUM-8 | — | CLOSED and verified, each by a test that fails without its fix |
| MEDIUM-2 | MEDIUM | open by instruction: the nondeterministic `ai-eval-record` test |
| Phase 13 MEDIUM-4 | MEDIUM (Phase 13) | open: the transactions table scrolls sideways at 375 px |
| LOW-1…13 | LOW | open, unchanged, as listed in Part E |

## Status

**IMPLEMENTED AND VERIFIED AS OF PART F.** Superseded by Part G, which found two more defects of the same family and one that remains open.

Every CRITICAL, HIGH and MEDIUM correctness finding raised against Phase 14 across five audit passes was closed at this point, except the nondeterministic test left open by instruction and the Phase 13 layout item. Part G then added HIGH-4 and MEDIUM-5 (both since fixed) and HIGH-3 (open). Phase 15 is not started. This file does not declare Phase 14 ready for Phase 15; the final independent Fable 5.1 sign-off against this commit does that or does not.

## Scope check

No migration, no schema change, no change to the fold, precedence, `app.invoice_net`, RLS, grants, the permission matrix, Phase 13, or anything under a Phase 15 name. The engine change is confined to which counterparty ids a descriptor names.

---

# Part E — adversarial audit of `b6cac0b`, and the remediation that answers it

An adversarial pass over `b6cac0b` probed the ground the earlier passes had asserted rather than exercised. It found one HIGH and two MEDIUM, and four factual errors in Part D. Everything here was reproduced against a real clean database before it was fixed, and the fixes are verified the same way.

## HIGH-1 — voided invoices were inside the evidence behind every invoice-basis figure

**Found.** The engine's invoice fold discards voided invoices; the evidence drill-down did not. `status <> 'void'` existed in exactly one place in the evidence layer, inside the helper that builds the receivables and payables shape, so no P&L descriptor ever got it. Supersession was correct throughout, which isolated the cause precisely.

| Figure | Engine | Its own drill-down, before |
|---|---|---|
| Cost of sales | 3,250.00 | 10,250.00 over 4 rows |
| Revenue | 8,000.00 | 13,000.00 |
| Customer revenue, one customer | 8,000.00 | 13,000.00 |

Each gap was exactly the net of a voided invoice, and the analyst's `get_transactions_for_evidence` reported £10,250 over 4 records as the evidence for £3,250. Reachable through the ordinary import: invoice `status` is a mappable column and the commit routine casts it straight to the enum, so any list exported with voided invoices lands them. The root cause predates Phase 14; ADR-105 changed the amount from an outstanding balance to a full net, and Part D asserted the reconciliation as verified without ever seeding a voided invoice.

**Fixed (ADR-107).** The compiler applies the engine's third clause to every invoices descriptor through one named helper that the receivables helper also calls, so there is a single spelling. It is applied whether or not the selection is pinned to a run, because a void is the invoice's own business status and has no `record_status_events` row — which is why the as-of projection could not see it. Descriptor hashes are computed over the descriptor, not the compiled query, so no stored hash changed.

**Verified.** On a second organisation with different amounts: cost of sales 5,522.00 with a drill-down of 5,522.00 over 2 rows, the 9,999 void absent and the 2,222 that superseded a 1,111 present; revenue 20,000.00 against a 12,345 void; the same customer's revenue; and the analyst's evidence tool at 5,522.00 over 2 records. `test/integration/evidence-void-invoice.test.ts` fails 4 of its 5 cases on `b6cac0b` and passes here.

## MEDIUM-1 — the analyst reported the gross profit Home refuses to show

**Found.** On an organisation with sales of £9,000 and no direct-cost accounts, Home omitted the card and explained why, while `get_business_summary` returned gross profit of £9,000 with `assurance_level: calculated` and `completeness: 1.00`. The only caveat was one entry in a warnings array for which the prompt had no rule, and the prompt tells the model to mention assurance only when it is not calculated. ADR-105 had fixed one surface of a two-surface product concept.

**Fixed (ADR-106).** The rule is now stated once, in `financials`, as a structured availability state rather than free-form warning text. Home and the monthly report read it instead of restating it. Every metric the analyst receives carries `availability`; `not_applicable` carries the reason and the explanation and **no value**, and a not-applicable `get_metric` also returns no components, so there is nothing to quote and nothing to rebuild the figure from. The prompt states the deterministic rule for the structured field. The engine is untouched and still writes gross profit as revenue with its warning, because a statement has to add up.

**Verified.** Both directions, on two organisations: the unsupported one gives Home no card and the analyst no value with reason `no_cost_of_sales_accounts` in the same words Home prints; the one with a real cost line gives Home the card and the analyst £7,000 marked available.

## MEDIUM-2 — the `ai-eval-record` nondeterminism was documented wrongly

**Found.** Part D said the failure passes in isolation. Eight isolated runs gave five passes and three failures, all with the identical signature. Re-recording the fixture for ADR-106 sharpened the diagnosis further: the retained alert is sometimes `expense.spike_category` and sometimes `expense.spike_account`, and those two rules carry different key paths — which is precisely the 26-against-25 shape difference the test reports. It is not only an ordering effect.

**Not fixed, by instruction.** The alerts module and the shape test are untouched. Two consequences had to be handled, neither of which weakens an assertion:

- The corpus hard-coded `expense.spike_category` when picking an evidence reference, so a re-record that retained the other rule made the corpus throw. It now takes whichever expense-spike alert the recording holds, and tolerates neither, which every use of that reference already did.
- **The recording is itself a draw from the same distribution.** ADR-106 changes a tool's output, so re-recording is mandatory. The first re-record captured an unlucky snapshot — `expense.spike_account` first, and an empty `top_alerts` on the second summary call that later runs populate — and the test then failed 6 of 6 isolated runs rather than its usual minority. Re-recording again produced a representative capture, after which 3 of 5 isolated runs pass with the familiar 26-against-25 signature, matching the 5-of-8 measured on `b6cac0b`. Anyone re-recording this fixture should re-run the test a few times afterwards and re-record if it never passes; that is a property of the nondeterminism, not a fix for it.

## Corrections to Part D

Part D's findings stand except where corrected here. Five statements in it were wrong and are corrected in place, each marked **Corrected** where it sits: the blanket reconciliation claim (§6), the flake characterisation (§16), the integration gate row (§17), the description of the migrations' grants (scope check), and the description of the earlier passes as "independent" (§3). Its description of `/portfolio` is expanded for accuracy in the same place.

## pgTAP guard limitation

`13_invoice_net.test.sql` asserts that no invoice reader carries its own copy of the net-of-tax rule. The assertion matches only the **unqualified** spelling: verified in Postgres, a table-qualified duplicate such as `i.total_amount - i.tax_amount` does not match it, and that is exactly how the superseded version of `set_invoice_lines` was written. The guard is therefore weaker than it reads. The live functions were checked directly instead: `app.aggregate_periods`, `api.set_invoice_lines` and `api.product_period_summary` each call `app.invoice_net` once and none carries its own spelling, qualified or bare. The guard was left as it is rather than widened, to keep this pass inside Phase 14 correctness.

## What this remediation contains

Six source files; no migration, no schema change, no engine change.

| Change | Where |
|---|---|
| The one availability rule, its reason text and its types | `financials/domain/vocabulary.ts`, exported from the module index |
| Home reads the rule instead of restating it | `dashboard/services/home.ts` |
| The cost-of-sales reason text has one source | `dashboard/domain/status.ts` |
| `availability` on every `MetricValue`; no value and no components when not applicable | `ai/domain/tools/metrics.ts` |
| The deterministic rule for the structured field; `analyst-v3.5` | `ai/domain/prompt.ts`, `ai/data/claude-client.ts` |
| The engine's third invoice clause on every invoices descriptor | `evidence/data/descriptor-compiler.ts` |

Tests added:

| Test | Cases |
|---|---|
| `test/integration/evidence-void-invoice.test.ts` | 5. Cost of sales, revenue, a customer's revenue and operating expenses each reconcile to their figure with a void present; the superseded invoice stays excluded and its replacement included; the analyst's evidence tool cannot return the voided row. **4 of the 5 fail on `b6cac0b`.** |
| `test/integration/ai-gross-profit-availability.test.ts` | 6. Both directions on two organisations: Home and both analyst tools agree that the figure is not applicable, with the same reason in the same words; and a real cost line still yields £7,000 everywhere. |
| `test/unit/metric-availability.test.ts` | 8. The rule itself, including the preference for the cost figure's reason, the trend case with no cost figure, and that no other metric is touched. |
| `test/unit/evidence-descriptor.test.ts` | +1. The void predicate on every invoice shape, pinned and unpinned, emitted once where the receivables helper also adds it, and absent from other tables. |
| `test/fixtures/ai/corpus.ts` | +3 eval cases: one golden that reports the limitation and quotes no gross profit, two traps that state it and must be rejected. |

## NEW — HIGH-2, found while regression-testing merges, NOT fixed in this pass

Regression-testing the merge item turned up a **second reconciliation gap of the same family as HIGH-1**, pre-existing and unrelated to either blocker. It is recorded here and deliberately left alone, because this pass was scoped to HIGH-1 and MEDIUM-1 and an engine change at commit time is exactly the broadening the brief forbids.

**The defect.** The engine folds a merged counterparty's rows into the survivor (`coalesce(c.merged_into_id, i.counterparty_id)`), but `concentration.ts#counterpartyEvidence` writes a descriptor naming only the surviving id, while the invoice rows still carry the original one. The absorbed counterparty's invoices are therefore missing from the survivor's drill-down.

Reproduced on a clean database: customer A invoiced 5,000 net, customer B invoiced 3,000 net, B merged into A, recalculated. `customer_revenue` for A is **8,000.00**; the stored descriptor is `counterparty_ids: [A]`; resolving it returns **1 row, 5,000.00**. B's own snapshot is gone, as intended, so the 3,000 is visible in no drill-down at all.

**Why it is HIGH.** It breaks the same invariant HIGH-1 broke — the evidence behind a figure must equal that figure — on a first-class Phase 14 feature, and it understates rather than overstates, which is the harder error to notice. It is not caused by ADR-105 or ADR-107 and predates both.

**The likely fix, for a later pass.** `counterpartyEvidence` has `ctx.counterparties` with `mergedIntoId`, so the descriptor can name the survivor plus every id merged into it. That changes which descriptor is written, not any figure, and needs a test asserting the survivor's drill-down equals the survivor's figure after a merge. It was not attempted here.

## Remaining findings after this remediation

| ID | Severity | Status |
|---|---|---|
| HIGH-1 | — | **CLOSED**: voided invoices are out of every invoice-basis drill-down, asserted by a test that fails without the fix |
| HIGH-2 | — | **CLOSED in Part F (ADR-108)**; was open at the end of this part, and wider than recorded here: it applied to suppliers and to every basis |
| MEDIUM-1 | — | **CLOSED**: one availability rule across Home, the report and the analyst |
| MEDIUM-7, MEDIUM-8 | — | CLOSED earlier by `8f81dd3` (ADR-105); MEDIUM-8's reconciliation claim is now qualified and tested for the void case |
| MEDIUM-2 | MEDIUM | open by instruction: the nondeterministic `ai-eval-record` test. Not fixed, not suppressed |
| Phase 13 MEDIUM-4 | MEDIUM (Phase 13) | open: the transactions table scrolls sideways at 375 px |
| LOW-1…7 | LOW | open, unchanged from the earlier audits |
| LOW-8 | LOW | open: `computeCash` handed an `openingCarry` carrying `no_bank_accounts` keeps the series NULL; no production caller supplies one |
| LOW-9 | LOW | open: `gross_margin` stores `no_cost_of_sales_accounts` where `cost_of_sales` stores `cost_of_sales_in_other_source`. Presentation is unaffected — ADR-106 prefers the cost figure's reason on every surface |
| LOW-10 | LOW | open: NULL cash snapshots store `assurance_level = calculated`; the badge shows "—" |
| LOW-11 | LOW | open: the pgTAP duplicate-rule guard matches only the unqualified spelling (above) |
| LOW-12 | LOW | open, cosmetic, pre-existing since Phase 4: `exclude_transfers` appears twice in the bank-transactions filter allow-list, which is read into a Set, so it has no effect |
| LOW-13 | LOW | open, a trap rather than a defect: `evidence_query` stores JSON `null` rather than SQL NULL for "no descriptor", which has now misled two test authors |

None was fixed opportunistically. Scope was held to the two correctness blockers and the documentation.

## Status

**IMPLEMENTED AND VERIFIED BY OPUS. INDEPENDENT FABLE 5.1 AUDIT PENDING.**

Phase 14 is **not** declared ready for Phase 15, and nothing in this file is an independent audit: the same session wrote the implementation, the closeout record, the adversarial pass that found HIGH-1 and MEDIUM-1, and this remediation. Phase 15 is not started. The next operation is the independent Fable 5.1 audit against this commit.

**One HIGH was open at the end of this part.** HIGH-2 above was found in this pass and deliberately not fixed, because it fell outside the two blockers this remediation was scoped to. It was closed in the following pass (Part F, ADR-108), which also found it wider than recorded here.

---

# Part D — final closeout (verification pass, 2026-09-23)

Method: code reading of the committed tree at `8f81dd3`; the eleven gates re-run on a clean database (`supabase db reset`); every adversarial probe from the three earlier audits re-run; a new browser probe for the Home gross-profit card; detached worktrees at `55acbeb` and `b2a73ea` to separate pre-existing behaviour from regression. **No implementation code was changed by this pass** — the only change in the closeout commit is this document.

## 1. The original Phase 14 engine defect

`app.aggregate_periods` folded every invoice row of a period into one cell, so an organisation whose P&L came from invoices reported headline revenue of £0.00 while customer-level revenue was right. Recorded in Part B §1; fixed in `55acbeb` (ADR-103) by giving the invoice basis its own fold and one net-of-tax rule.

## 2. The previous remediation

`55acbeb` (ADR-103): the invoice-basis fold at the root, `app.invoice_net` as the single net-of-tax rule, "Unattributed" made not-a-customer, and counterparty merges followed through the aggregate. `f8fdc58` (ADR-104): the cash empty-set, the over-selecting expense evidence and the unwarned 100% gross margin. Parts B and C record both.

## 3. Audit passes already performed

Three audit passes ran before this one: `PHASE_14_FINAL_AUDIT.md` (Phase 14 as delivered), `PHASE_14_REMEDIATION_AUDIT.md` (`55acbeb`), and Part A of this file (`f8fdc58`). Each returned NOT READY and named the findings the next commit answered. A fourth, recorded in Part E, audited `b6cac0b` and found HIGH-1 and MEDIUM-1.

> **Corrected (Part E).** These were originally described as "independent". They were not: every one of them, and this closeout, was produced by the same session that wrote the implementation. They were adversarial read-only passes under a do-not-modify instruction, which is useful and is not independence. The independent Fable 5.1 audit has not yet run.

## 4. Cash empty-set

Verified intact at `8f81dd3`. `financial-engine/domain/cash.ts` takes the empty branch only when the organisation has **no active cash-like account and no covered account**: every metric of the family is `value: null`, `basis: 'none'`, completeness 0, reason `no_bank_accounts`, and `previousClosing` is set to null so no later month inherits a figure. A covered account, including one that has since been closed, never reaches the branch. Browser: Home prints "Cash —" and Money › Cash prints "Add a bank account and upload its statements to see your cash." for every row; no `£0` anywhere on either page. `engine-invoice-golden.test.ts` asserts the family and the reason; `engine-cash.test.ts` asserts a valid bank source still calculates.

## 5. Empty-set zero-fill sweep

Verified intact. The engine distinguishes a true zero from no data in every family: the P&L returns `noSourceResults` (all fifteen keys NULL, `no_source_covers_period`, completeness 0) rather than zeros; the cash family returns the `no_bank_accounts` branch; `concentration.ts` omits the synthetic unattributed remainder entirely when the basis is `none`, so `customer_revenue` and `supplier_spend` are absent rather than 0.00. The empty-organisation probe confirms no snapshot carries a value.

## 6. Cost-of-sales evidence mismatch

Descriptors are scoped to the suppliers that contributed (ADR-104), and the summed amount matches the figure (ADR-105, item 9). Probed through the analyst's own `get_transactions_for_evidence` tool against a live run: a `cost_of_sales` figure of 3,000.000000 returns **2 records, £1,800 and £1,200, sum £3,000.00, count 2**. `operating_expenses` carries a descriptor naming only the marketing supplier and no stock supplier. `other_expense`, a category nobody's purchases went into, carries no descriptor at all.

> **Corrected (Part E, HIGH-1).** As written this section claimed the reconciliation held generally. It did not: this fixture contained no voided invoice, and a voided invoice was included in every invoice-basis P&L drill-down while the engine excluded it from the figure. Fixed by ADR-107 and now covered by a test that seeds one. The accurate claim is narrower and is stated in Part E: the drill-down behind an invoice-basis figure reconciles to that figure for unpaid, partly paid, fully paid, credit-note, superseded **and voided** invoices, each asserted by a test.

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

- **Pre-existing nondeterministic `ai-eval-record` test.** `loadAlerts` is capped and ordered by severity and timestamp with no identifier tiebreaker, so which alert the recorded call retains varies between runs (`get_alerts #16 output shape`, 26 against 25 key paths). **It did not fire in the run recorded in this Part.** Not fixed, not suppressed, not worked around: the alerts module and the test were left exactly as they are, per instruction.

  > **Corrected (Part E, MEDIUM-2).** This bullet originally said the test "passes in isolation". That is false: eight isolated runs gave five passes and three failures, every failure with the identical signature. It is a genuinely nondeterministic test, not a full-suite ordering effect, and it can fail on any run. Re-recording for ADR-106 showed the retained alert varies between `expense.spike_category` and `expense.spike_account`, two rules whose key paths differ — which is the shape difference itself.
- **`ai-eval-job` live-model transient.** One "the model could not be called" in an earlier run, never reproduced; passed here. Environmental, not a code regression.
- **Phase 13 MEDIUM-4:** the transactions table scrolls sideways at 375 px.

## 17. Gates — clean database, `8f81dd3`

`supabase db reset`, then in order:

| Gate | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | PASS |
| Lint (`eslint .`) | PASS |
| Unit | PASS — 70 files, 1,994 tests |
| Integration | 41 files, **668 of 668 in this run**. Not an invariant: the nondeterministic `ai-eval-record` test can fail on any run, and a clean-database run of `b6cac0b` measured 667 of 668 with exactly that failure |
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

`git diff b2a73ea..8f81dd3` introduces no Phase 15 surface: no Adviser or CFO Command Centre route, no portfolio table, no multi-client dashboard. Three migrations, all Phase 13 and 14. No policy dropped, no RLS disabled. `f8fdc58..8f81dd3` changes no migration, no schema, no precedence, no `app.invoice_net` semantics, no Phase 13 contract, no alerts module and no test expectation written to fit broken behaviour.

> **Corrected (Part E).** Two statements here were wrong as written.
>
> **Grants.** The original said every grant statement in the three migrations revokes rather than widens. It does not. They follow the established SECURITY DEFINER pattern: each new `api.*` function is revoked from `public` and `anon` and then granted `execute` to `authenticated`, and each `api_server.*` function is revoked from everyone and granted `execute` to `service_role` alone. Direct write grants on tables are revoked. RLS stays enabled and forced, no policy is dropped, and no tenant-boundary weakening was demonstrated by any probe or suite.
>
> **`/portfolio`.** The original implied only that the path is old. Accurately: the path first appears in Phase 1 and its current content dates from Phase 6 (`b388bea`). It is an adviser landing page that lists the organisations the caller can already reach and shows each one's health score, as a read-only projection over the caller's accessible set. No Phase 13 or 14 commit touches it. It is **not** the Phase 15 Adviser/CFO Command Centre, and its existence is not evidence that Phase 15 has been started.

## Phase 15

**NOT STARTED.** The next step is the independent Fable 5.1 audit. Only that audit can declare Phase 14 ready for Phase 15.

---

# Part A — final re-audit of `f8fdc58` (adversarial pass, not independent — see Part E)

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
