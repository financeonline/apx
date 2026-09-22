# Phase 14 — Commercial Intelligence: implementation record

> Status: **implemented** (2026-09-22). Governs: REQ-CI-01…12, REQ-FD-09, REQ-CA-11, REQ-AI-08; SOW §16; CD-01, CD-08, CD-26. Decision record: ADR-102. Phases 15–17, CRM replacement, lender marketplace, partner ecosystem, ESG and knowledge-base work were not touched.

Phase 14 connects commercial activity to financial outcomes — Traffic → Lead → Opportunity → Customer → Revenue → Cost → Contribution — without inventing any link in that chain. Every commercial figure is either the engine's (`metric_current`) or an aggregation of rows a person recorded, and every gap is printed as a gap.

## 1. Commercial architecture

- **One new module**, `src/modules/commercial` (`domain/rules.ts` pure attribution rules; `data/repository.ts` reads and `api.*` writes; `services/index.ts` Zod-validated write services). View models live in `src/modules/dashboard/services/commercial.ts` beside the other page loaders; the Customers routes render them. AI tools 24–26 read the same view models.
- **One migration**, `supabase/migrations/20260922000002_commercial.sql`: six tables, one edit guard, six write functions, one read function. No new permission, no new job, no new engine metric, no change to the calculation run.
- **Attribution is deterministic and rule-named** (§7): the same inputs give the same output, and each output carries a status or reason a page prints verbatim. Nothing is estimated; nothing is spread pro rata.
- **The financial truth stays in the engine** (§14): customer revenue, share, contribution and concentration are read from `metric_current`; product and campaign figures are SQL aggregations over accepted invoice lines and recorded spend, and the integration suite asserts the product side reconciles to the engine's attributed customer revenue to the penny.

## 2. Customer model

`counterparties` remains the customer record (CD-01); nothing duplicates it. Phase 14 adds to a customer: the products they bought (from invoice lines), the campaign they were won through (from a won opportunity), their open opportunities, and — on the customer page — the engine's `customer_contribution` figure beside revenue and share, with the CD-08 caveat stated on the page: contribution is revenue less the costs recorded against the customer; shared overhead is never allocated, so it is not profit.

## 3. Product/service model

`products` (name, kind `product|service`, code, active flag; unique per organisation on the normalised name). Products exist only when a person records them. Revenue per product comes only from `invoice_lines` a person attributed; the Products page shows, next to the attributed rows, how much of the month's sales is not attributed to any product and how many invoices carry no lines. An invoice's lines may not exceed its net amount (`api.set_invoice_lines` refuses); whatever is left stays "not yet attributed" rather than being pushed onto a product. Lines follow their invoice: a rejected or superseded invoice contributes nothing.

## 4. Sales pipeline

`opportunities` with five stages — lead, qualified, proposal, won, lost — a counterparty (required once won), an optional campaign, an estimated value (a person's entry, never a forecast), `created_on`, `won_on`/`lost_on`. Moving to won stamps `won_on` (defaulting to today) and refuses without a customer; the stage change is audited with `stage_from`/`stage_to`. The Sales page shows the pipeline by stage, the open total, conversion (§11) and, month by month, what was marked won beside the revenue the engine recorded — labelled as different things. This is not a CRM: one list, five stages, no activities, no contacts, no tasks.

## 5. Campaigns

`campaigns` (name, optional channel, optional dates, status) and `campaign_spend` (one amount per campaign per fiscal period, in the organisation's currency; recording a month again replaces the earlier figure). A campaign is credited with revenue only through §7.

## 6. Marketing channels

`marketing_channels` are the organisation's own words ("Instagram", "Referrals"). A channel groups campaigns and can be named on an opportunity. No channel is ever credited with revenue directly — only a campaign is, and only through a won opportunity — so "how much came from Instagram" is answered as the sum over Instagram's campaigns, never by spreading revenue across channels.

## 7. Attribution

`attributeCampaignRevenue` (`commercial/domain/rules.ts`), pure:

1. A customer counts as won through a campaign when an opportunity in stage `won` names both the campaign and the customer. If a customer was won more than once, the **earliest** win wins; a later opportunity for the same customer credits nothing.
2. Revenue credited to the campaign is the engine's `customer_revenue` for that customer in fiscal periods starting **on or after the won month**, inside the twelve-month window shown. Revenue invoiced before the win is not credited.
3. A campaign with no won opportunity has status `no_won_opportunities`; the page and the tool say "No revenue attributed — no opportunity has been won through this campaign".

Nothing is attributed by channel, by date proximity, by first touch, or by share of spend. The status is printed on every surface (page, tool result, journey assertion).

## 8. Customer profitability

Read from `metric_current` (`customer_contribution`, CD-08). The engine subtracts only costs recorded against the customer; nothing in the MVP populates those (`customerAttributableCosts` is empty for every organisation), so contribution equals revenue with the `no_cost_allocation` warning. Phase 14 does not change that: it shows the figure with its note ("shared overhead is never allocated, so this is not profit") and, where the engine has no figure, shows nothing rather than a guess.

## 9. Campaign profitability

Credited revenue less recorded spend, shown as "Credited revenue less spend" — never as profit, because no direct cost other than spend is attributable to a campaign today, and the page says so. Absent credited revenue and absent spend, the line reads "Needs credited revenue".

## 10. CAC

`acquisitionCost`, pure: **numerator** = the campaign's recorded spend in the window; **denominator** = customers won through that campaign (§7 rule 1) whose `won_on` falls in the window; **scope** = the twelve months shown, stated on the page. Zero spend → "No spend recorded, so acquisition cost cannot be worked out."; zero customers → "No customer was won through this campaign in the period, so acquisition cost cannot be worked out." Never marketing spend ÷ all customers; never across organisations (the denominator is the organisation's own opportunities, read under RLS).

## 11. Conversion

`conversion`, pure, over the **cohort of opportunities created in the window** (three months on the Sales page, twelve on a campaign page), with both denominators named on the page: lead → opportunity = progressed past lead ÷ created; opportunity → customer = won from the cohort ÷ progressed. Empty denominators give null and a reason (`no_leads_in_window`, `no_opportunities_in_window`) the page prints. Won-in-window (whenever created) is reported separately and never divided.

## 12. Concentration

Measured, not judged. The overview keeps the engine's top-1 and top-5 shares (REQ-CA-12) and adds the twelve-month trend of the top-5 share, formatted by the service. No page calls a share "too high"; the `concentration.customer` alert (Phase 6) is unchanged.

## 13. Sales performance

`salesByPeriod`: won and lost counts and won value per month for twelve months, printed next to the engine's revenue for the same month with the sentence "a win is a promise, revenue is an invoice". No win rate is inferred from revenue.

## 14. Financial integration

- Customer revenue, share, contribution, top-1/top-5 and the customer-quality health dimension: the engine's, unchanged.
- Product figures: `api.product_period_summary` sums accepted, non-superseded invoice lines by product and period (sales lines, purchase lines) and reports the unattributed remainder per period; `test/integration/commercial.test.ts` asserts Σ product revenue + unattributed = Σ attributed `customer_revenue` rows for the month, to the penny.
- Campaign figures read `customer_revenue` snapshots; they never re-sum invoices.
- No calculation-run change, no fingerprint change, no new metric family. Recording a product, line, campaign or opportunity does not enqueue a run.

## 15. Evidence

Every figure links to what it rests on with the Phase 8 system: a product page lists the invoice lines behind it, each with a "Where this came from" link to the invoice's record page (`/evidence/record/invoice/[id]`); a customer page lists the invoices and their lines; the campaign page lists the won opportunities and the customers. Customer revenue and contribution rows keep their "Why" links to the snapshot. No new evidence kind was added.

## 16. AI integration

Tools 24 `get_product_contribution`, 25 `get_campaign_performance`, 26 `get_sales_pipeline` (`customers.view`, organisation from the session, period from `period_context`), reading the Customers pages' own view models. Each result states its rule and its status (`contribution_status: 'unavailable'`, `attribution_status`, `cost_per_customer_note`, conversion `cohort` and `notes`). The prompt (`analyst-v3.4`) tells the model these are available, what each rule is, and to refuse — with the `attribution` template — any ask to assume where revenue came from, spread revenue across channels, compute an acquisition cost or a conversion rate itself or with a foreign denominator, treat attributed or estimated figures as verified, or supply a campaign or product figure a tool did not return. Four adversarial corpus cases cover exactly those asks; the recording was re-taken at `analyst-v3.4` (170 eval cases pass). The registry is closed at twenty-six.

## 17. RBAC

No new permission. `customers.view` (every role, client included) reads every commercial page and tool; `customers.edit` (owner, admin, super_admin, assigned employee; not client) records products, lines, channels, campaigns, spend and opportunities. Forms render only for `customers.edit`; the server actions re-check with `assertCan`; the database re-checks in `app.require_commercial_edit`. A client on the Sales page sees stages as text and no `<select>` at all (journey 14 asserts the count is zero).

## 18. Tenant isolation

All six tables carry `organization_id` with org-composite foreign keys (an invoice line can only name an invoice and a product of the same organisation; an opportunity only its organisation's counterparty, campaign and channel); RLS is forced with the standard select policy; authenticated users hold no write grant. `api.set_invoice_lines` and `api.upsert_opportunity` refuse ids from another organisation. Integration tests prove organisation B sees none of A's rows, cannot write to them, and cannot use A's ids; the journey proves a foreign or malformed id is the uniform 404.

## 19. Employee assignment

An assigned employee (`organization_assignments.active`, aal2) reads and writes like an admin; an unassigned employee is refused at `app.accessible_org_ids()` before any row is touched. Both are in `test/integration/commercial.test.ts`.

## 20. UX

`/customers` gains tabs — Customers · Products · Sales · Marketing — and becomes the Commercial overview: revenue this month, top customers (with the contribution note), top products (with "contribution unavailable" where so), marketing (spend and credited revenue), the pipeline, concentration, then the unchanged revenue-by-customer table. Progressive disclosure: the invoice-line split lives under a `<details>` on the customer page; forms sit at the bottom of each tab for editors only. The empty state is unchanged. All seven pages were checked at 375 px: no page scrolls sideways (tables scroll inside their own wrapper), no id appears on screen.

## 21. Performance

One read function for product figures (`api.product_period_summary`, three aggregate queries per call, twelve periods at most); opportunities read once per page (capped at 2,000, the list shows 100); campaign spend read by period set; the overview issues its loads in parallel. No page reads more than a few hundred rows. Indexes: products by organisation/name, invoice lines by invoice and by product, spend unique per campaign/period, opportunities by organisation/stage and by counterparty.

## 22. Testing

| Layer | File | Covers |
|---|---|---|
| Unit | `test/unit/commercial.test.ts` (9) | product contribution sufficiency, earliest-win attribution and won-month rule, CAC denominators and zero handling, conversion cohort and reasons, pipeline and sales-by-period, determinism |
| pgTAP | `supabase/tests/11_commercial.test.sql` (20) | RLS forced, no write grants, org-composite FKs, edit guard, Σ lines ≤ net, won needs a customer, cross-org ids refused, audit rows |
| Integration | `test/integration/commercial.test.ts` (8) | reconciliation to the engine, contribution unavailable → available, line validation, attribution + CAC + conversion, overview and customer view, roles, isolation |
| Integration | `test/integration/ai-tools.test.ts` (+1) | twenty-six tools; a client may call the three commercial tools |
| Eval | `test/fixtures/ai/corpus.ts` (+4) | assume-a-channel, cross-organisation CAC, estimated-as-verified, invented campaign revenue — all refused with the `attribution` opening, no digits |
| Playwright | `e2e/journey-14-commercial.spec.ts` | owner records product → line split → channel → campaign → spend → won opportunity; marketing credits £6,000 and CAC £300 by rule; client reads with no forms; 404s |

**Regression on a clean database (`supabase db reset`), 2026-09-22:**

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint (`eslint .`) | PASS |
| Unit | 68 files, 1,970 passed |
| Integration | 39 files, 643 passed (incl. `commercial.test.ts` 8, `ai-tools.test.ts` 23, `isolation-cases.test.ts`, `rls-isolation.test.ts`) |
| pgTAP | 15 files, 1,018 passed (incl. `11_commercial.test.sql` 20) |
| Playwright | 64 passed, 1 skipped (pre-existing skip), incl. `journey-14-commercial` |
| AI eval | 170 passed (+4), recording at `analyst-v3.4` |
| Schema drift | 54 tables, 118 api functions, RLS forced everywhere, no write grants |
| Permission matrix | up to date, 121 grants |
| Production build | PASS |

**A pre-existing engine gap surfaced by the reconciliation test — since FIXED in remediation (ADR-103, `PHASE_14_REMEDIATION.md`).** On the invoice P&L basis the headline `revenue` metric was a covered zero with `uncategorised_amounts` warnings, because invoice aggregate cells carry no account and `accountAmounts` skipped them, while `customer_revenue` per counterparty was correct. The independent audit found it also struck organisations that upload bank statements *and* a full invoice list, since invoices outrank bank, and classified it HIGH and blocking. The engine now folds invoice cells into their categories, and this suite asserts the full identity: Σ product revenue + unattributed = Σ `customer_revenue` = headline `revenue`.

## 23. Known limitations

1. Customer contribution equals revenue (CD-08): nothing records a cost against a customer yet.
2. Product cost exists only where a purchase invoice is split into lines naming the product; there is no cost of sales per product otherwise, so "contribution unavailable" is the common state until purchases are split.
3. Attribution is single-touch (earliest won opportunity), by design; no multi-touch or time-decay models.
4. Campaign spend is entered by hand per month; no ad-platform import.
5. Traffic (the first link of the chain) has no source: a lead is the earliest recorded stage.
6. ~~Engine gap on a pure invoice basis (§22), pre-existing.~~ **Fixed** in the Phase 14 remediation (ADR-103): the invoice basis now reports a P&L, with one net-of-tax rule and the §3 VAT signal. See `PHASE_14_REMEDIATION.md`.
7. Opportunities list is capped at the latest 100 on the page (2,000 read); no search or pagination yet.

## 24. Architectural decisions

ADR-103 (Phase 14 remediation) corrects the engine's invoice basis, gives the net-of-tax rule one home, takes the unattributed remainder out of every customer ranking and makes a merge carry commercial history to the surviving customer; `PHASE_14_REMEDIATION.md` records it in full.

ADR-102 (in `ARCHITECTURAL_DECISIONS.md`) records the one genuinely new decision of the phase itself: commercial figures are either the engine's or rule-named aggregations of recorded rows, with attribution only through won opportunities and no new permission, engine metric or job. Everything else follows existing decisions: CD-01 (counterparties are the seam), CD-08 (contribution without overhead), ADR-006 (money as strings), ADR-026 (writes through `api.*`), ADR-032/ADR-096 (evidence links), ADR-043 (no service role on the request path).
