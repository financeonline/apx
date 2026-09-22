# PLAN — Phase 14: Commercial Intelligence (REQ-CI-01…12, REQ-FD-09, REQ-CA-11)

Stack: fixed by the repo — Next.js 16 App Router, TypeScript strict, Supabase/Postgres with RLS, Vitest + pgTAP + Playwright. New module `src/modules/commercial`; one migration; no new permission (`customers.view` reads, `customers.edit` writes).

Brief (from the pre-flight inventory):
- EXISTS: `counterparties`, `invoices`, the engine's `customer_revenue` / `customer_contribution` / shares / top1 / top5 / HHI / `supplier_spend`, the `concentration.customer` alert, the customer-quality health dimension, AI tool 5, two customer pages.
- ABSENT: products/services, invoice lines, campaigns, channels, campaign spend, leads/opportunities. Nothing populates `customerAttributableCosts`, so customer contribution = revenue with `no_cost_allocation` (CD-08) — a fact to state, not paper over.
- Attribution rules must be explicit and deterministic; nothing invented: product figures come only from invoice lines a person recorded; campaign revenue only through WON opportunities linked to the campaign; CAC = campaign spend ÷ customers won through it in the window; conversion with named denominators; every gap says so.
Done when: an owner can record products, split an invoice into product lines, record a channel, a campaign and its monthly spend, move an opportunity from lead to won against a customer — and read Commercial (revenue, top customers with contribution, top products, marketing with attributed revenue/CAC, pipeline) with every figure either the engine's or an aggregation of recorded rows; every role fenced; every organisation isolated; the analyst answering only through tools.
Riskiest thing: a second financial truth. Mitigation: customer revenue/contribution/concentration are read from `metric_current` only; product and campaign figures are SQL aggregations of accepted invoice lines and recorded spend, asserted in tests to reconcile to the engine's invoice-basis revenue (Σ lines + unattributed = customer revenue); no cost is allocated without a recorded line; no revenue is attributed without a won opportunity.

1. [x] Migration `20260922000002_commercial.sql`: `products`, `invoice_lines`, `marketing_channels`, `campaigns`, `campaign_spend`, `opportunities` (org-composite, RLS, no user write grants); `api.upsert_product`, `api.set_invoice_lines`, `api.upsert_channel`, `api.upsert_campaign`, `api.set_campaign_spend`, `api.upsert_opportunity` (all `customers.edit`); reads `api.product_period_summary`, `api.commercial_pipeline_summary`; catalogue rows; pgTAP.
   Verify by: `npx supabase db reset && npx supabase test db` PASS; drift reports 54 tables / 118 functions.
2. [x] `commercial/domain`: pure attribution — product contribution with sufficiency, campaign attribution via won opportunities, CAC and conversion with explicit denominators and zero handling, concentration trend, sales performance.
   Verify by: new `test/unit/commercial.test.ts` green incl. zero leads, zero opportunities, no spend, no won customers, no lines, determinism.
3. [x] `commercial/data` + `services`: writes through `api.*`, reads for products, campaigns, channels, pipeline, lines; `dashboard/services/commercial.ts` view models (overview, product, campaign, pipeline, customer extensions) from `metric_current` + summaries.
   Verify by: `test/integration/commercial.test.ts` — Σ product lines + unattributed = engine `customer_revenue` for the invoice's customer; campaign attributed revenue = Σ `customer_revenue` of won customers from the won month; CAC and conversion denominators; contribution "unavailable" without cost lines.
4. [x] Routes under `/customers`: tabs Customers · Products · Sales · Marketing; overview per brief §20; `/customers/products[/[productId]]`, `/customers/sales`, `/customers/marketing[/[campaignId]]`; customer detail gains contribution, product mix, campaign attribution, invoice-line split; forms for `customers.edit` only; wizard-free.
   Verify by: `npm run build` lists the routes; `npx playwright test journey-14` green.
5. [x] AI: tools 24 `get_product_contribution`, 25 `get_campaign_performance`, 26 `get_sales_pipeline` (`customers.view`, read-only, org from context); prompt banking→commercial rules; `PROMPT_VERSION` → `analyst-v3.4`; corpus cases; re-record.
   Verify by: `npm run ai:eval` green with recording at `analyst-v3.4`; role × tool matrix passes with 26 tools.
6. [x] Adversarial + isolation: cross-org product/campaign/opportunity/customer/evidence ids; browser-supplied org; unassigned employee; client cannot write; no attribution without a won link; no CAC across organisations.
   Verify by: integration cases green; journey asserts client sees no forms and attribution status is stated.
7. [x] Docs: `docs/PHASE_14_IMPLEMENTATION.md`, ADR-102, DATABASE/AI/ROUTE/RBAC/PRD/MVP/UX updates; all eleven gates PASS on a clean database.
   Verify by: drift exit 0; final regression table.
