# MOTION — MVP Scope

Depends on: `SOW_v2_extracted.md §21–23`, `ARCHITECTURAL_DECISIONS.md`
Consumed by: `PRODUCT_REQUIREMENTS.md` (MVP flags), `IMPLEMENTATION_PLAN.md`, `UX_ARCHITECTURE.md`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026, ADR-027, ADR-029, ADR-030, ADR-033, ADR-037, ADR-038, CD-32. Findings addressed: F-A-01, F-A-11, F-A-12, F-B-03, F-B-04, F-B-15, F-D-10, and the sales/purchase report gap. See `RED_TEAM_REVIEW.md`.

## 1. The MVP journey, and nothing outside it

SOW §22: **Upload → Validate → Calculate → Dashboard → Health Score → Alerts → AI Analyst → Evidence → Action.**

The MVP is the smallest product in which an owner of a small business can, unaided, upload their own financial files, get correct numbers, understand what changed and why, ask the analyst a question, click through to the transaction that proves the answer, and assign someone to do something about it. Anything not on that path is post-MVP unless listed as a hard dependency in §3.

## 2. MVP capability list

Each line is a capability, its SOW anchor, and the reason it is inside the line.

### 2.1 Identity, tenancy, roles (SOW §5, §21 Phase 1, §23)
- Email + password and magic-link sign-in via Supabase Auth; password reset; session refresh. *(Journey entry.)*
- Organization creation (self-serve and platform-created), org switcher, last-active org.
- All five roles resolved exactly as `RBAC_MATRIX.md`; invitations by email; membership management; last-owner guard; ownership transfer flow.
- Employee assignments (super admin creates, owner revokes) and the employee `/portfolio` list page (organization cards with health score and open alerts). *(Hard dependency for the My Employee role to be usable at all; the full CFO Command Centre is not included.)*
- RLS on every tenant table; `role_permissions` mirror; audit events for governance changes.
- No table-level write privilege for `authenticated`; every mutation is an `api.*` SECURITY DEFINER function with its own pgTAP test (ADR-026).
- TOTP multi-factor authentication mandatory for every platform user (super admin and employee) before `/platform` or `/portfolio` is reachable (ADR-038.8).

### 2.2 Platform administration (SOW §5, §23)
- `/platform`: organizations list/create/suspend/feature flags; platform users (grant/revoke roles); assignments; jobs monitor; AI feedback queue; global audit search. *(Without this a super admin cannot onboard the first customer.)*

### 2.3 Import engine (SOW §6, §21 Phase 3, §23)
- File types: **CSV, XLSX** (full); **PDF** per CD-11 (store, text extraction, deterministic table parse, Claude-assisted extraction with mandatory review, scanned = store only).
- Import types: general ledger, trial balance (cumulative or movement basis confirmed per batch, ADR-027), P&L report, balance sheet, bank statement, sales invoices, purchase invoices, sales report and purchase report (SOW §6; mapped onto the invoice and ledger targets). (Receipts = store as source document + optional manual ledger entry; no OCR.)
- Full staged pipeline: upload → scan/validate file → parse → map columns (saved mappings, suggestions) → map accounts to standard categories → preview → validate rows → duplicate detection (file + record + fuzzy, re-checked at commit) → review queue → commit (transactional) → recalculation → import history → roll back or **replace** (ADR-029.3).
- Invoice re-exports update existing invoices (payment status, due dates) by supersession instead of being skipped as duplicates (ADR-029.1).
- Bank statement wizard captures the statement opening balance ("I don't know" allowed) so cash balances are available from the first import (ADR-035).
- All row outcomes retained and visible; nothing silently discarded.

### 2.4 Financial data model (SOW §6, §21 Phase 2)
- `accounts` with seeded standard chart; `counterparties`; `ledger_entries`; `period_balances`; `invoices` (header level); `bank_accounts`; `bank_transactions`; `fiscal_periods`; `source_documents`.
- Record lifecycle and assurance statuses on every record.

### 2.5 Calculation engine (SOW §7, §21 Phase 4, §23)
- Every metric family the SOW §7 lists (the full key registry in `FINANCIAL_ENGINE.md §3`, roughly 40 keys plus variance keys), with these MVP qualifications: customer contribution = revenue contribution (CD-08); product/service contribution excluded (needs invoice lines); budget/forecast variance excluded (no budget data, CD-27).
- Monthly periods only; quarter/year views are post-MVP (ADR-030.6). Period-over-period variance (vs previous month, same month last year, trailing 3-month average). Defaults, alerts and the health score operate on complete months only (ADR-030).
- Materialised runs and snapshots; basis and data-quality on every value; deterministic golden-dataset tests.

### 2.6 Banking (SOW §15, subset)
- Bank accounts, statement import, signed transactions, rule-based categorisation to standard categories with user override, transfer detection, recurring payment detection, balances and cash trend, inflow/outflow, coverage status (CD-20).
- **Not** included: transaction-to-ledger matching, live feeds, liquidity ratios beyond cash runway.

### 2.7 Dashboard — Home (SOW §8, §21 Phase 5, §23)
- Health score, headline cards per CD-32 (revenue; gross profit when cost-of-sales accounts exist; operating profit with net profit visibly beneath; closing cash; receivables; payables), trends (12 months), major expense movements, top risks (alerts), top opportunities (positive variances), outstanding actions, data quality and last-import status; bank-only variant for organizations with only bank data (ADR-035).
- Drill-down chain Dashboard → Analysis → Account/Customer/Category → Transaction → Source Document (the evidence UI).

### 2.8 Health Score (SOW §9, §21 Phase 6, §23)
- Six dimensions (CD-19), explainability panel per dimension (metrics, rules, positives, negatives, data quality), monthly history.

### 2.9 Alerts (SOW §13, §21 Phase 7, §23)
- The 13 rule families in `FINANCIAL_ENGINE.md §8` (Alert Engine), platform defaults, severity, explanation, evidence, recommended next step, statuses, convert-to-action.

### 2.10 AI Analyst (SOW §10–11, §21 Phase 8, §23)
- Conversational analyst over the 15 read-only tools in `AI_ARCHITECTURE.md §3`, response contract, grounding check, evidence bundle per answer, period resolution, refusal of unsupported question types (scenario/affordability/forecast questions answer with "not available yet" and the nearest supported facts), report-incorrect-insight, quotas.

### 2.11 Evidence (SOW §12, §21 Phase 9, §23)
- Evidence bundles and items for metrics, alerts, health score dimensions, AI answers and actions; evidence drawer UI; source-document viewer with page reference.

### 2.12 Actions (SOW §17, §21 Phase 10, §23)
- Create from AI recommendation, alert, health dimension or manually; all §17 fields; assign to member/employee; statuses; outcome capture; Actions page and Home widget. No comments thread (CD-26).

### 2.13 Reports (SOW §20, minimal)
- **Monthly Management Report** only (ADR-024), on screen and as PDF stored in the private `reports` bucket with a `report_files` row, org-scoped download and audit (ADR-038.7). Included because Reports is a primary navigation item and a management report is the natural artefact of the MVP journey; it reuses dashboard components and adds no new calculation.

### 2.14 Cross-cutting
- Audit log UI for owners/admins; data export (CSV) of ledger, bank transactions, invoices, metrics; organization settings; profile; responsive layout to 320 px; empty/loading/error/denied states for every page; type-check, lint, tests, production build in CI (SOW §23).

## 3. Hard dependencies that pulled items into MVP

| Item | Pulled in by | Justification |
|---|---|---|
| Employee portfolio list page | Role model (My Employee) | An assigned employee needs somewhere to land; a bare org switcher is unusable with 10+ clients. Kept to a list with two numbers per org. |
| Platform admin app | Onboarding | No way to create the first customer, grant roles or assign employees without it. |
| Bank statement import + categorisation + transfer/recurring detection | Cash metrics, Banking Health dimension, four alert families | The SOW's headline question "why is cash falling?" is unanswerable without bank data. |
| Invoice header import | Receivables/payables aging, customer revenue concentration | Balance-sheet totals alone cannot support aging or customer questions. |
| Monthly Management Report | Reports nav item | Avoids a dead navigation item; zero new calculation. |
| PDF (limited) | SOW §6 lists PDF explicitly | Dropping PDF would breach scope; CD-11 constrains it to a safe subset. |

## 4. Post-MVP (explicitly out)

| Capability | SOW ref | Phase | Notes |
|---|---|---|---|
| Forecasting (revenue, expenses, profit, cash, AR/AP) | §14, Phase 11 | 11 | Reserved metric keys `forecast_*`, `budget_variance_*` |
| What-if scenarios, saved scenarios | §14, Phase 12 | 12 | **Built post-MVP in Phase 12 (ADR-100)**: `scenario_runs`/`scenario_values`, `/what-if`, AI tool 19. The analyst READS a saved scenario and still refuses to work a new one out; "can we afford…" is answered by MOTION's affordability check since ADR-146 (built locally, not reviewed) |
| Budget import and budget variance | §7 | 11 | CD-27 |
| Bank reconciliation (matching), liquidity ratios, live bank feeds | §15, Phase 13 | 13 | CD-20, CD-21. **Phase 13 (ADR-101) built Banking Intelligence on imported statements**: the banking pass (rule categorisation, transfer pairing, recurring detection) now runs inside every calculation; `/money/banking` overview, transactions and transaction pages; statement-level reconciliation per CD-20; liquidity indicators without invented ratios; AI tools 20–23. Still out: line-by-line matching to ledger entries, and any live feed — none exists and the UI says so |
| Commercial Intelligence / CRM, pipeline, products, campaigns, channels, CAC, conversion | §16, Phase 14 | 14 | `counterparties` is the seam. **Phase 14 (ADR-102) built Commercial Intelligence**: products and invoice lines, channels, campaigns and monthly spend, a five-stage pipeline; attribution only through won opportunities; CAC and conversion with named denominators; `/customers` overview + Products · Sales · Marketing tabs; AI tools 24–26. Still out: CRM replacement, multi-touch attribution, ad-platform spend import, a traffic source |
| Marketing Analysis module; Marketing Efficiency health dimension | §3, §9 | 14 | CD-01, CD-19 |
| Product/service contribution, invoice lines, full customer contribution with cost allocation | §7 | 14 | CD-08 |
| Accountant/CFO Command Centre (portfolio dashboard, cross-client alerts/actions/reports, advisory opportunities) | §18, Phase 15 | 15 | MVP has the list page only |
| External adviser organizations | §29 | 15 | CD-02 |
| Funding Readiness assessment, report and health dimension | §19, Phase 16 | 16 | **Built locally (ADR-145), off by default, not reviewed.** Assessment + page: Phase 16 (`PHASE_16_IMPLEMENTATION.md`), calculated only while `features.funding_readiness` is on (ADR-121). Printable report: Phase 17 (§20, REQ-RP-05), built locally behind the same flag. Health dimension: **deferred, ADR-119** — not part of Phase 16. **Blocked by dependency:** Phase 16 implementation (incl. factor F5, REQ-FR-07) waits for the Receivables/Payables Engine Recovery and its Health Score regression audit (ADR-120) |
| Daily Executive Brief, Weekly Intelligence Report, Accountant/CFO Report, Funding Readiness Report, Custom AI Report | §20, Phase 17 | 17 | **Phase 17 (ADR-141), built locally, not yet reviewed:** daily, weekly, adviser and custom reports, stored append-only in `reports`, scheduled hourly per local day; day/week figures from a separate interim calculator (`interim.v1`). The Funding Readiness Report waits for Phase 16. See `PHASE_17_IMPLEMENTATION.md` |
| Team Management System, action comments, notifications | §3 | Post-17 | CD-26. **Built locally, in-app only (ADR-144):** action comments, requests and deliverables with history, a per-person inbox; no email |
| Investment Opportunities / pitch decks | §3 | Post-17 | CD-26 |
| Partner ecosystem, lender marketplace, large third-party integrations, advanced attribution, ESG | §22 | Post-17 | SOW itself lists these as post-MVP |
| Per-organization alert thresholds, custom roles, multi-currency, groups/consolidation, time-boxed super-admin support access, billing/subscriptions | various | Post-17 | CD-18, CD-10, CD-29, CD-13 |
| Quarter and year views (materialised aggregate snapshots with per-metric aggregation rules) | §8 | Post-17 | ADR-030.6, F-B-15 |
| Receipt OCR, email-in of documents | §6 | Post-17 | |

## 4a. Adopted defaults and round-2 corrections (ADR-040, ADR-043 to ADR-047)

Round 2 of the red-team review (`RED_TEAM_REVIEW.md §6`) added the `api_server` schema, database-side MFA and throttles, grounding v3, and the engine corrections in ADR-047 to the MVP; none removes anything from §2.

### Adopted defaults

Every open product decision is implemented on its recommended default; overrides are configuration or additive changes listed in ADR-040. No MVP phase is blocked on a product answer.

## 5. MVP acceptance criteria (SOW §23, made testable)

| # | SOW criterion | Observable test |
|---|---|---|
| 1 | A new company can be created and securely isolated | Create org A and org B; user of A requesting any A-scoped URL with B's slug gets 404; pgTAP isolation suite green |
| 2 | Users authenticate and receive role-appropriate access | Five-role Playwright matrix: each role sees exactly the nav and buttons in `UX_ARCHITECTURE.md §9` |
| 3 | Supported files can be uploaded and validated | Golden CSV/XLSX/PDF set imports through review to commit; malformed set surfaces every issue |
| 4 | Invalid and duplicate data is surfaced, not discarded | Batch with 3 exact and 2 fuzzy duplicates shows all 5 in review; `import_rows` count equals the count of non-empty source lines; replacing a corrected statement (roll back old, commit new in one transaction) leaves the accepted row count equal to the corrected file's row count (ADR-029.3) |
| 5 | Metrics are deterministic | Golden dataset expected values match to the cent across two runs; `input_fingerprint` equal |
| 6 | Dashboard figures come from calculation services | Every Home figure equals the `metric_snapshots` row pointed to by `metric_current` for the latest complete month; no arithmetic in React (lint rule) |
| 7 | Health Score is explainable | Each dimension panel lists metrics, rules, positives, negatives and data quality that reproduce the score by hand |
| 8 | Alerts contain evidence and severity | Every alert row has severity and a non-empty evidence bundle |
| 9 | AI answers supported questions using validated data | Eval set of 40 questions; every number in each answer is present in a tool output |
| 10 | AI does not invent figures or cross tenants | Adversarial eval: injected instructions in descriptions, cross-org ids, and out-of-range periods all refused; grounding failures degrade |
| 11 | Material AI conclusions are traceable | Every assistant message has an evidence bundle; each Key Finding cites ≥1 item |
| 12 | Recommendations become actions | "Create action" from an AI answer creates an `actions` row with evidence and source ids |
| 13 | Critical/high security issues resolved | Security review checklist in `SECURITY_MODEL.md` signed off |
| 14 | Type check, lint, tests, build pass | CI green on `main` |
| 15 | No direct table writes are possible for tenant users | pgTAP: `authenticated` holds no INSERT/UPDATE/DELETE privilege on any `public` table; a direct PostgREST PATCH on `ledger_entries` as owner returns 42501; every `api.*` function has a pgTAP test per role (ADR-026) |
