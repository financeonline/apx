# Phase 14 — Commercial Intelligence: independent final audit

> Audit date: 2026-09-22. Scope: the repository as it stands after the Phase 14 implementation (uncommitted working tree on `main`). Method: code and migration reading against the contract documents; a fresh full regression on a clean database (`supabase db reset`); adversarial probes written for this audit in a scratch harness outside the repository (pure-rule cases, an AED organisation, an invoice-only organisation, an organisation with both bank statements and a full invoice list, an unassigned employee, a foreign-organisation tool context, a zero-subtotal invoice). **No code was modified.** The implementation report's gate results were re-run, not trusted.

## Executive summary

Phase 14 delivers what it says: six commercial tables behind `api.*` writes and forced RLS, deterministic attribution rules that name their denominators and print their gaps, pages and three AI tools that read the same view models, and tests that prove isolation, roles and the attribution rules. Nothing in it invents a cost, spreads revenue across channels, or creates a second financial truth. Currency is the organisation's throughout.

One finding blocks readiness, and it is not new code: the financial engine's **invoice-basis P&L is a covered zero**. Any organisation whose sales invoice list is imported as a full list gets `revenue = 0`, `net_profit = 0`, assurance `estimated`, from the `invoices` basis — **including organisations that also upload bank statements**, because `invoices` precedes `bank` in the P&L precedence. Phase 14 makes this visible on its own overview (revenue "£0.00 · Estimate" beside top customers summing to £8,000, a negative "Unattributed" top customer, no concentration), and a multi-client Adviser/CFO layer built on the same metric would report zero revenue for every such client. The engineering report recorded the gap as pre-existing and non-blocking; this audit disagrees on the second point.

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 6 |

## Scope

Inspected: `PRODUCT_REQUIREMENTS.md` (REQ-CI-01…14, REQ-FD-09, REQ-CA-11, REQ-AI-08), `ARCHITECTURE.md`, `FINANCIAL_ENGINE.md` (§2.1–2.3, §3.5), `EVIDENCE_MODEL.md`, `AI_ARCHITECTURE.md`, `SECURITY_MODEL.md`, `RBAC_MATRIX.md`, `TENANCY_MODEL.md`, `UX_ARCHITECTURE.md`, `TEST_STRATEGY.md`, `MVP_SCOPE.md`, `ARCHITECTURAL_DECISIONS.md` (ADR-102), `PHASE_11…14_IMPLEMENTATION.md`; migration `20260922000002_commercial.sql`; `src/modules/commercial/**`, `src/modules/dashboard/services/commercial.ts`, `src/modules/ai/domain/tools/commercial.ts`, `src/modules/ai/domain/prompt.ts`, the seven routes under `src/app/app/[orgSlug]/customers/**`; `test/unit/commercial.test.ts`, `test/integration/commercial.test.ts`, `test/integration/ai-tools.test.ts`, `supabase/tests/11_commercial.test.sql`, `test/fixtures/ai/corpus.ts`, `e2e/journey-14-commercial.spec.ts`.

## Customer intelligence

Counterparties remain the single customer record; nothing duplicates them (§1 of the brief: no second `customers`, `revenue`, `products`, `campaigns` or `opportunities` representation exists — one table each, all new). Customer revenue, share, contribution and concentration are read from `metric_current` (`loadCustomers`, `loadCommercialOverview`, `loadCustomerCommercial`); the customer page adds the engine's `customer_contribution` figure with the CD-08 sentence, the product mix from lines, the campaign the customer was won through, and their opportunities. No AI path computes profitability: tool 24–26 return view models, and tool 5 is unchanged.

**Observed limitation:** `customer_contribution` equals revenue for every organisation because nothing records a cost against a customer; the page says so. This is CD-08 as documented, not a defect.

## Products / services

`api.product_period_summary` sums accepted, current, non-void invoice lines by product and period, sales and purchase separately (credit notes subtract), reports the unattributed remainder per period, and the customer mix. `productContribution` refuses a contribution without at least one cost line ("Contribution unavailable — cost data is insufficient.") — verified on the page, in the view model and in tool 24. No cost is fabricated. Reconciliation: the integration suite asserts Σ product revenue + unattributed = Σ attributed `customer_revenue` rows for the month, to the penny; the audit reran it green.

**Finding MEDIUM-1 (net rule divergence).** The engine's net-of-tax rule (`sign.ts#invoiceNetOfTax`, FINANCIAL_ENGINE.md §3) treats a `subtotal` of 0 with `total_amount > 0` as absent and falls back to `total − tax`. Both `api.set_invoice_lines` and `api.product_period_summary` use `coalesce(subtotal, …)`, which takes the 0. Probe: an invoice with `subtotal = 0, tax = 50, total = 1050` — the engine's `customer_revenue` is 1,000.00; `set_invoice_lines` refuses any line ("the lines add up to more than the invoice"); the product summary's unattributed sales for that month is 0.00. The migration's comment claims "same rows, same net rule"; it is not the same rule on this edge, and VAT-inclusive invoice lists with a blank subtotal column are a realistic import.

## Sales pipeline

Five stages in one table; `won` requires a counterparty and a date (CHECK constraint and the function); `lost` requires a date. Estimated values are entered by a person and are summed only per stage; the page calls them "what you entered — not forecasts" and the Sales page's "Won against revenue" table prints won value and the engine's revenue in separate columns with the sentence "a win is a promise, revenue is an invoice". Tool 26 labels `estimated_value` as such. Stage changes are audited with `stage_from`/`stage_to`. Period behaviour: won/lost/created are bucketed by their own dates into fiscal periods; verified by the pure-rule probe.

## Campaigns

Campaigns carry a channel, dates, status; spend is one amount per campaign per fiscal period, stamped with the organisation's `base_currency` by the function (probe: an AED organisation stores `AED`). Recording a month again replaces the figure (unique constraint + upsert), audited.

## Channels

A channel is a name; nothing credits a channel with revenue. The marketing page shows channels as badges and campaigns per channel; revenue reaches a campaign only through §Attribution. Verified in code (`attributeCampaignRevenue` never reads `channelId`) and in the probe.

## Attribution

`wonCustomers` → `attributeCampaignRevenue` (pure). Verified by the audit's own probe against the brief's case list:

| Case | Result |
|---|---|
| Two wins of the same customer in the same campaign | one customer, revenue from the earlier month, CAC divides by 1 |
| Same customer won by two campaigns, later opportunity sorts first by id | earliest campaign credited; the later has `no_won_opportunities` |
| Lost, open, won-without-campaign, won-without-customer | nothing attributed |
| Win on the last day of a month | revenue credited from that month, none from earlier months |
| Multiple campaigns, one customer set | each campaign sees only its own wins |
| Input order reversed | identical output |

Attribution is presented as a rule, not as causation: the marketing page's note ("Revenue is credited to a campaign only through an opportunity marked won for a customer, from the month it was won. Nothing is assumed from timing alone."), the campaign page ("Attributed through won opportunities. Only revenue invoiced from the month an opportunity was won is credited, and only to the first campaign that won the customer."), the tool's `rule` and `attribution_status`, and ADR-102 all say the same thing.

## Attributed revenue vs financial revenue

Distinct in name and in path. Financial revenue is `metric_current.revenue`; attributed revenue is a sum over `customer_revenue` snapshots filtered by won customers, labelled "Revenue credited" / `revenue_credited` / "attributed", never "generated". The overview's marketing card says "{amount} attributed"; the Sales page separates "Won value" from "Revenue". No UI string or tool field says a campaign *generated* revenue. The prompt forbids treating attributed figures as verified and the corpus's `adv:attribution-estimated-as-verified` case refuses it.

## Customer profitability

The engine's, unchanged (`customer_contribution`, CD-08). Shown with its caveat; absent when the engine has no row. No AI calculation. See §Customer intelligence for the documented limitation.

## Campaign profitability

Credited revenue less recorded spend, labelled "Credited revenue less spend" on the campaign page, "contribution" nowhere and "profit" nowhere. Null when neither side exists. Appropriate.

## CAC

`acquisitionCost`: numerator = the campaign's spend in the window's periods; denominator = customers first won through that campaign whose `won_on` is inside the window; zero spend → `no_spend_recorded`, zero customers → `no_customers_won`, both printed. Probe: 0/0/1/2 customers, three campaigns, a win outside the window excluded, spend outside the window excluded. Tenant scope is RLS on `opportunities` and `campaign_spend` (an organisation cannot read another's rows, so no foreign denominator can enter). Currency: spend rows carry the organisation's currency and the page formats with it.

## Conversion

Cohort = opportunities created in the window; lead→opportunity = progressed ÷ created; opportunity→customer = won-from-cohort ÷ progressed; both denominators printed on the page ("Opportunities created between X and Y", "Created / Reached opportunity / Won"). Wins from older cohorts are reported as `wonInWindow` and never enter a rate (probe). Empty cohort → nulls with `no_leads_in_window`; only leads → `no_opportunities_in_window`. Populations are not mixed.

## Concentration

Top-1, top-5 (engine) and the twelve-month top-5 trend, printed as percentages with "The measurement, for you to weigh — a high share is not a verdict." No label judges it. (Under HIGH-1 the engine has no concentration figure at all for invoice-basis organisations, because the share denominator is a zero revenue — see below.)

## Sales performance

Won count, lost count, won value, created count per month from opportunities; the engine's revenue in a separate column. Not conflated.

## Financial truth

Every money figure on the commercial surfaces traces to one of two sources: `metric_current` (revenue, customer revenue/share/contribution, concentration) or aggregations of recorded rows (lines by product, spend by month, estimated values by stage). `src/modules/commercial` contains no invoice summation; `api.product_period_summary` sums *lines*; no new metric, job, fingerprint input or engine change exists (confirmed by `git status` on `src/modules/financial-engine`: only `services/run.ts` is modified, by Phase 13). The lint rules forbidding arithmetic in components pass. The reconciliation test is real and passes.

## Pre-existing engine gap — HIGH-1

**What it is.** In `financial-engine/domain/compose.ts`, `accountAmounts` folds aggregate cells into P&L categories only when a cell carries an `account_id`. Invoice cells from `app.aggregate_periods` carry `account_id = null` and `standard_category = null` (by design: an invoice has no account). On the `invoices` P&L basis every invoice cell is therefore skipped by `accountAmounts` and counted in full by `uncategorisedExposure`. The result for the month is `revenue = 0` (a "covered zero"), `net_profit = 0`, `assurance = estimated`, `missing: uncategorised_amounts_exceed_threshold`, while `customer_revenue` per counterparty is correct (it reads `invoice_type` directly) and the synthetic "Unattributed" remainder becomes **minus** the attributed total so that Σ still equals the zero headline. FINANCIAL_ENGINE.md §2.1 specifies the opposite ("`invoices` → `revenue` (sales, net of tax)"). Unchanged in HEAD; not Phase 14's code.

**Who it affects.** Any organisation whose P&L basis resolves to `invoices`: precedence is `period_balances → ledger → invoices → bank` (`coverage.ts`, `FAMILY_PRECEDENCE.pnl`), and the invoice basis covers a period as soon as a committed *full* sales-invoice batch spans it. The audit probed two organisations:

| Organisation | P&L basis chosen | `revenue` | `customer_revenue` rows |
|---|---|---|---|
| Full sales-invoice list only (AED) | `invoices` | 0.00 · estimated | Acme 6,000 · Beta 2,000 · Unattributed −8,000 |
| Same, plus a bank statement with a categorised receipt | `invoices` (bank loses precedence) | 0.00 · estimated; `net_profit` 0.00 | as above; `closing_cash` correct on `bank` |

The second row matters most: **a small business that uploads bank statements and a sales invoice list — the MVP's own "Retail Co" golden shape — gets a zero P&L instead of the bank proxy it would have had without the invoice list.** Organisations with a ledger or trial balance are unaffected.

**What it contaminates.**
- *Commercial overview (Phase 14):* the revenue card reads "£0.00 · Estimate" with the tooltip "Estimated from bank activity; may include VAT and timing differences" (the status mapper keys the tooltip on `estimated`, not on basis); "Top customers" lists "Unattributed −£8,000" as a customer row; both concentration cards are "not available" (`comparison_is_zero`); the customer-concentration trend is empty.
- *Sales page:* "Won against revenue" prints revenue £0 beside a £6,000 won deal — the page's own sentence about promises and invoices then reads as if no invoice existed.
- *Customer dashboards:* share of revenue is null for every customer (`customer_revenue_share` has `comparison_is_zero`); the `concentration.customer` alert and the customer-quality health dimension can never fire.
- *Home, Money › Profit & loss, Insights, Reports, Forecast, What-if:* all read the same headline metrics (pre-existing exposure, now confirmed for the bank+invoices shape).
- *AI:* tools 1–3 (`get_business_summary`, `get_metric`, `get_metric_trend`) return the zero with its status; the model would correctly call it an estimate, and incorrectly imply bank activity.
- *Phase 15 (Adviser/CFO, multi-client):* portfolio revenue, profit, margins and any ranking across clients would carry a zero for every invoice-basis client. That is misleading at the layer the brief names, so this audit classifies the gap as **HIGH and blocking**, pre-existing or not.

**Why the previous gates did not catch it.** No engine or page test seeds a full sales-invoice batch as the only P&L source; the golden organisations in `TEST_STRATEGY.md` (CD-30) are described but "Retail Co" is not exercised end to end. Phase 14's reconciliation test is the first to compute against that shape, which is how it surfaced.

**Remediation (for the engine's owner, not applied here).** In `compose.ts`, when the P&L source is `invoices`, fold each invoice cell into a category by `invoice_type`: sales and sales credit notes → `revenue` (the organisation's system revenue account), purchases and purchase credit notes → `counterparties.default_expense_category` else `uncategorised` — exactly FINANCIAL_ENGINE.md §2.1 — and count only the latter in `uncategorisedExposure`. Add a golden test for an invoice-only organisation and one for bank + full invoice list asserting revenue, net profit, and Σ `customer_revenue` + unattributed = revenue with a non-negative remainder. Phase 14 should then also stop listing the synthetic remainder among "Top customers" (MEDIUM-2).

## Evidence

Customer → revenue → snapshot: the revenue-by-customer table keeps its "Why" link (`toFigure(...).whyHref`). Product → revenue → lines → invoice record: the product page lists each line with "Where this came from" to `/evidence/record/invoice/[id]` (Phase 8 record page, `documents.view` gating unchanged). Campaign → attribution → customer → revenue: the campaign page links each won customer to the customer page, whose figures carry evidence. Opportunity → customer: linked on the Sales page. No new evidence kind, bundle or origin was added (`git diff` on `supabase/migrations` shows none). **LOW-1:** the overview's "Top customers" list carries `whyHref` in the view model but the page does not render it; the table below does.

## AI

Tools 24–26 read `loadProducts`, `loadMarketing`, `loadSales` — the pages' own view models — and return the rule and status fields (`contribution_status`, `attribution_status`, `cost_per_customer_note`, conversion `cohort`/`notes`). Inputs are `z.object` with `period` and `limit` only; a smuggled `organization_id` is stripped (probe: `safeParse({period, organization_id: B})` → `{period}`). The prompt (`analyst-v3.4`) names the rules and a fixed refusal opening; four adversarial corpus cases (assume a channel, cross-organisation CAC, estimated-as-verified, invented campaign revenue) pass. **Limitation, not a finding:** the eval corpus grades recorded golden submissions through the grounding pipeline; it does not call a live model. `npm run ai:eval:live` exists and was not run in this audit (no key in the environment). **LOW-2:** tool results carry `Money` values without a per-figure assurance marker; the attributed status is a sibling field rather than an assurance level, so a reader of the raw result must combine the two.

## RBAC

`RBAC_MATRIX.md` and `role_permissions` agree (permission sync: up to date, 121 grants). `customers.view`: all five roles; `customers.edit`: super_admin, employee, owner, admin — not client. Verified without relying on UI hiding: a client's `api.upsert_*`, `set_campaign_spend`, `set_invoice_lines` calls return `42501` (integration), `api.product_period_summary` is `customers.view`, and the three tools are `customers.view` (a client's call is authorised and returns data — audit probe). Forms render only for editors; the journey asserts a client sees no `<select>` on Sales. Exports: no commercial export exists; `data.export` unchanged. Evidence gating unchanged.

## Employee assignment

An assigned employee (aal2) reads and writes (integration). An unassigned employee: RLS returns zero rows from all six tables, `api.product_period_summary` returns `P0002`, every write returns `P0002`, and the three tools return `NO_DATA` without any organisation content (audit probe). Id manipulation: every reference is org-composite (`invoice_lines → invoices/products`, `opportunities → counterparties/campaigns/channels`, `campaign_spend → campaigns/fiscal_periods`) and the functions re-check each id under `p_org`; an A owner cannot attach B's campaign (integration). Evidence ids are outside Phase 14's surface and unchanged.

## Tenant isolation

Read paths: organisation B reads none of A's rows from any of the six tables (integration); B's owner with a forged `ctx.orgId = A` gets `NO_DATA` from all three tools because RLS hides A's periods before any commercial read (audit probe). Write paths: `upsert_product`, `set_invoice_lines`, `set_campaign_spend` with A's ids from B → `P0002`. Attribution, profitability and concentration read RLS-scoped tables only. Service layer + RLS both hold.

## Currency

Probe with an AED organisation: products "AED 6,000", unattributed "AED 2,000", campaign spend/credited/CAC "AED 400 / AED 6,000 / AED 400", pipeline "AED 0", top customers in AED; `campaign_spend.currency` and `opportunities.currency` stored as `AED`. No "£" or "GBP" anywhere in the commercial output. Lines have no currency of their own and inherit the invoice's; the import pipeline refuses an invoice whose currency differs from the organisation's (IMP-CUR-007), so no mixing can occur. INR and USD follow the same path (`base_currency` is the only source; nothing branches on the code). **LOW-3:** `baseCurrency()` in `dashboard/services/commercial.ts` falls back to `'GBP'` if the organisation row is unreadable — the same pattern as the banking tools; unreachable for a member, but a hard-coded default nonetheless. No FX exists.

## UX

Four tabs, one overview, forms at the foot of each tab for editors, the line split behind a disclosure. Labels are plain ("What it cost and what it brought in", "Customers won through it", "Not yet attributed"). Empty states name the next step. Attribution and unavailable-data sentences appear where the figure would be. All seven pages checked at 375 px in the implementer's probe and re-checked here from the screenshots: no page-level horizontal scroll (tables scroll inside their wrapper), no ids on screen, labelled inputs, keyboard-reachable `<details>`. **LOW-4:** the overview revenue card prints minor units ("£0.00") while every commercial figure prints whole units ("£6,000"), a mixed style on one page. **MEDIUM-2:** "Top customers" renders the synthetic Unattributed remainder as a customer row (negative under HIGH-1; on a healthy basis it appears as a positive row labelled "Unattributed" among the top five — the same convention as the table below, but the list is headed "Top customers").

## Performance

One aggregate read function (three grouped queries over lines for ≤ 12 periods), opportunities read once per loader (cap 2,000; list 100), spend by period set, parallel loads. Indexes match the access paths (org+invoice, org+product, org+campaign, org+stage, org+counterparty, org+created, spend unique per campaign/period). **LOW-5:** `loadCommercialOverview` composes `loadProducts`, `loadMarketing` and `loadSales`, so campaigns are read three times and opportunities twice per overview render — bounded, but avoidable. Tool payloads are capped by `limit` (≤ 50).

## Regression

Re-run by the audit on a clean database (`supabase db reset`), 2026-09-22:

| Gate | Result | vs Phase 13 |
|---|---|---|
| Typecheck | PASS | — |
| Lint (`eslint .`) | PASS | — |
| Unit | 68 files, 1,970 passed | +9 (`commercial.test.ts`) |
| Integration | 39 files, 643 passed | 634 → 643 |
| pgTAP | 15 files, 1,018 passed | +20 (`11_commercial.test.sql`) |
| AI eval | 170 passed | 166 → 170 |
| Schema drift | 54 tables, 118 api functions, RLS forced everywhere, no write grants | 48/111 → 54/118 |
| Permission matrix | up to date, 121 grants | unchanged |
| Production build | PASS | — |
| Playwright | 64 passed, 1 skipped (pre-existing skip in `evidence-provenance`) | 63 → 64 passed (+ `journey-14-commercial`) |

Phases 1–13 suites (financial engine, banking, evidence, AI, actions, scenarios, health, alerts, RBAC, isolation) all pass unchanged; no existing test was weakened (`git diff` on `test/` shows only additions and the two Phase 14 files). The financial engine's code is untouched by Phase 14.

## Test quality

The tests prove what they claim: attribution correctness (unit: earliest win, won month, open/unlinked ignored, order independence; audit probe adds duplicate wins, cross-campaign ordering, cross-month timing); financial reconciliation (integration, to the penny, against `customer_revenue`); authorization (client `42501` on every write, unassigned employee `P0002`, role × tool matrix at 26 tools, client × commercial tools); tenant isolation (six tables, three RPCs, a foreign campaign id); zero-denominator cases (unit and probe); missing attribution (`no_won_opportunities` asserted on page and tool); AI restrictions (four refusal cases at the recorded level). Not covered by the repository's tests: currency other than GBP (audit probe only), the zero-subtotal edge (MEDIUM-1), merged counterparties (MEDIUM-3), and a live model.

**Known pre-existing flake.** `ai-eval-record.test.ts` passed in both integration runs of this audit. Phase 14 appended three deterministic `NO_DATA` calls to its recording list; the intermittent cause identified in the Phase 12/13 records (alert-set ordering) is untouched and unrelated to Phase 14.

## Findings

| ID | Severity | Finding | Where | Fix |
|---|---|---|---|---|
| HIGH-1 | HIGH | Invoice-basis P&L is a covered zero: `revenue`/`net_profit` = 0 (`estimated`) whenever a full sales-invoice batch covers the period, including when bank statements also exist (invoices precede bank). Phase 14's overview, customer share, concentration, Sales table, Home/P&L/Reports/AI and any Phase 15 portfolio metric inherit it. Pre-existing engine defect (`compose.ts#accountAmounts` skips account-less cells), contradicting FINANCIAL_ENGINE.md §2.1. | `financial-engine/domain/compose.ts`, `coverage.ts` | Fold invoice cells by `invoice_type` into revenue / `default_expense_category` on the invoice basis; golden tests for invoice-only and bank+invoices organisations |
| MEDIUM-1 | MEDIUM | Net rule divergence on `subtotal = 0, total > 0`: engine counts `total − tax`, `api.set_invoice_lines` and `api.product_period_summary` count 0 — lines refused, unattributed understated; migration comment claims the same rule | `20260922000002_commercial.sql` | Use the engine's rule (`subtotal` unless 0 with total > 0) in both functions; add the edge to pgTAP and the integration suite |
| MEDIUM-2 | MEDIUM | "Top customers" on the overview renders the synthetic Unattributed remainder as a customer row (negative under HIGH-1) | `customers/page.tsx`, `loadCommercialOverview.topCustomers` | Exclude `dimension_id = null` from the list and print the remainder as a note |
| MEDIUM-3 | MEDIUM | Merged counterparties: the engine keys `customer_revenue` by `coalesce(merged_into_id, counterparty_id)`; the product summary's `customer_mix` and `wonCustomers` key by the raw id, so a customer merged after an opportunity or line was recorded silently loses product mix and campaign attribution | `product_period_summary`, `rules.ts#wonCustomers`, `commercial.ts` | Resolve `merged_into_id` in the summary and when reading opportunities; add a merge case to the integration suite |
| LOW-1 | LOW | Overview "Top customers" has no Why link although the view model provides one | `customers/page.tsx` | Render `whyHref` |
| LOW-2 | LOW | Tool 24–26 money values carry no per-figure assurance; status is a sibling field | `tools/commercial.ts` | Add `assurance_level: 'attributed'`-style marker or `meta.assurance_level` |
| LOW-3 | LOW | `baseCurrency()` falls back to `'GBP'` when the organisation row is unreadable | `dashboard/services/commercial.ts` | Throw instead of defaulting |
| LOW-4 | LOW | Mixed minor-unit style on the overview (revenue card vs commercial figures) | `customers/page.tsx` | One `showMinorUnits` policy per page |
| LOW-5 | LOW | Overview reads campaigns three times and opportunities twice | `loadCommercialOverview` | Load once and pass down |
| LOW-6 | LOW | No commercial page offers a path into the Action Centre; only the pre-existing concentration alert → action route exists. The Phase 14 brief asked for a link "without new architecture". | `customers/**` | Reuse the existing "create action from alert/recommendation" affordance on the overview's concentration card |

## Known limitations (documented, not findings)

Customer contribution equals revenue until customer costs are recorded (CD-08); product cost only from split purchase invoices; single-touch attribution; manual campaign spend; no traffic source; opportunities list capped at 100 without search; the eval corpus is recorded, not live.

## Phase 15 readiness

Phase 14's own work is sound: isolation, roles, currency, attribution rules and financial provenance all hold under adversarial probing, and no second financial truth exists. The blocker is HIGH-1: the headline P&L is zero for every organisation whose sales invoice list is imported as a full list — with or without bank statements — and Phase 15's multi-client Adviser/CFO layer would aggregate and rank those zeros. That is exactly the "misleading" condition the readiness rule names. The fix is confined to the engine's invoice-basis fold in `compose.ts` plus two golden tests, after which MEDIUM-1…3 should be closed in Phase 14's own code and this audit re-run.

## Final verdict

**NOT READY FOR PHASE 15**
