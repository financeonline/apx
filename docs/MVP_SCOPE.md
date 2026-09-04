# MOTION — MVP Scope

Depends on: `SOW_v2_extracted.md §21–23`, `ARCHITECTURAL_DECISIONS.md`
Consumed by: `PRODUCT_REQUIREMENTS.md` (MVP flags), `IMPLEMENTATION_PLAN.md`, `UX_ARCHITECTURE.md`

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

### 2.2 Platform administration (SOW §5, §23)
- `/platform`: organizations list/create/suspend/feature flags; platform users (grant/revoke roles); assignments; jobs monitor; AI feedback queue; global audit search. *(Without this a super admin cannot onboard the first customer.)*

### 2.3 Import engine (SOW §6, §21 Phase 3, §23)
- File types: **CSV, XLSX** (full); **PDF** per CD-11 (store, text extraction, deterministic table parse, Claude-assisted extraction with mandatory review, scanned = store only).
- Import types: general ledger, trial balance, P&L report, balance sheet, bank statement, sales invoices, purchase invoices. (Receipts = store as source document + optional manual ledger entry; no OCR.)
- Full staged pipeline: upload → scan/validate file → parse → map columns (saved mappings, suggestions) → map accounts to standard categories → preview → validate rows → duplicate detection (file + record + fuzzy) → review queue → commit (transactional) → recalculation → import history → roll back.
- All row outcomes retained and visible; nothing silently discarded.

### 2.4 Financial data model (SOW §6, §21 Phase 2)
- `accounts` with seeded standard chart; `counterparties`; `ledger_entries`; `period_balances`; `invoices` (header level); `bank_accounts`; `bank_transactions`; `fiscal_periods`; `source_documents`.
- Record lifecycle and assurance statuses on every record.

### 2.5 Calculation engine (SOW §7, §21 Phase 4, §23)
- Every metric family the SOW §7 lists (the full key registry in `FINANCIAL_ENGINE.md §3`, roughly 40 keys plus variance keys), with these MVP qualifications: customer contribution = revenue contribution (CD-08); product/service contribution excluded (needs invoice lines); budget/forecast variance excluded (no budget data, CD-27).
- Monthly periods, quarter/year aggregation, period-over-period variance (vs previous month, same month last year, trailing 3-month average).
- Materialised runs and snapshots; basis and data-quality on every value; deterministic golden-dataset tests.

### 2.6 Banking (SOW §15, subset)
- Bank accounts, statement import, signed transactions, rule-based categorisation to standard categories with user override, transfer detection, recurring payment detection, balances and cash trend, inflow/outflow, coverage status (CD-20).
- **Not** included: transaction-to-ledger matching, live feeds, liquidity ratios beyond cash runway.

### 2.7 Dashboard — Home (SOW §8, §21 Phase 5, §23)
- Health score, headline metrics (revenue, gross profit, operating profit, net profit, closing cash), trends (12 months), major expense movements, receivables/payables, top risks (alerts), top opportunities (positive variances), outstanding actions, data quality and last-import status.
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
- **Monthly Management Report** only (ADR-024), on screen and as PDF. Included because Reports is a primary navigation item and a management report is the natural artefact of the MVP journey; it reuses dashboard components and adds no new calculation.

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
| What-if scenarios, saved scenarios | §14, Phase 12 | 12 | AI questions "what happens if…" and "can we afford…" answer "not yet" in MVP |
| Budget import and budget variance | §7 | 11 | CD-27 |
| Bank reconciliation (matching), liquidity ratios, live bank feeds | §15, Phase 13 | 13 | CD-20, CD-21 |
| Commercial Intelligence / CRM, pipeline, products, campaigns, channels, CAC, conversion | §16, Phase 14 | 14 | `counterparties` is the seam |
| Marketing Analysis module; Marketing Efficiency health dimension | §3, §9 | 14 | CD-01, CD-19 |
| Product/service contribution, invoice lines, full customer contribution with cost allocation | §7 | 14 | CD-08 |
| Accountant/CFO Command Centre (portfolio dashboard, cross-client alerts/actions/reports, advisory opportunities) | §18, Phase 15 | 15 | MVP has the list page only |
| External adviser organizations | §29 | 15 | CD-02 |
| Funding Readiness assessment, report and health dimension | §19, Phase 16 | 16 | |
| Daily Executive Brief, Weekly Intelligence Report, Accountant/CFO Report, Funding Readiness Report, Custom AI Report | §20, Phase 17 | 17 | |
| Team Management System, action comments, notifications | §3 | Post-17 | CD-26 |
| Investment Opportunities / pitch decks | §3 | Post-17 | CD-26 |
| Partner ecosystem, lender marketplace, large third-party integrations, advanced attribution, ESG | §22 | Post-17 | SOW itself lists these as post-MVP |
| Per-organization alert thresholds, custom roles, multi-currency, groups/consolidation, time-boxed super-admin support access, billing/subscriptions | various | Post-17 | CD-18, CD-10, CD-29, CD-13 |
| Receipt OCR, email-in of documents | §6 | Post-17 | |

## 5. MVP acceptance criteria (SOW §23, made testable)

| # | SOW criterion | Observable test |
|---|---|---|
| 1 | A new company can be created and securely isolated | Create org A and org B; user of A requesting any A-scoped URL with B's slug gets 404; pgTAP isolation suite green |
| 2 | Users authenticate and receive role-appropriate access | Five-role Playwright matrix: each role sees exactly the nav and buttons in `UX_ARCHITECTURE.md §9` |
| 3 | Supported files can be uploaded and validated | Golden CSV/XLSX/PDF set imports through review to commit; malformed set surfaces every issue |
| 4 | Invalid and duplicate data is surfaced, not discarded | Batch with 3 exact and 2 fuzzy duplicates shows all 5 in review; `import_rows` count equals file row count |
| 5 | Metrics are deterministic | Golden dataset expected values match to the cent across two runs; `input_fingerprint` equal |
| 6 | Dashboard figures come from calculation services | Every Home figure equals its `metric_snapshots` row; no arithmetic in React (lint rule) |
| 7 | Health Score is explainable | Each dimension panel lists metrics, rules, positives, negatives and data quality that reproduce the score by hand |
| 8 | Alerts contain evidence and severity | Every alert row has severity and a non-empty evidence bundle |
| 9 | AI answers supported questions using validated data | Eval set of 40 questions; every number in each answer is present in a tool output |
| 10 | AI does not invent figures or cross tenants | Adversarial eval: injected instructions in descriptions, cross-org ids, and out-of-range periods all refused; grounding failures degrade |
| 11 | Material AI conclusions are traceable | Every assistant message has an evidence bundle; each Key Finding cites ≥1 item |
| 12 | Recommendations become actions | "Create action" from an AI answer creates an `actions` row with evidence and source ids |
| 13 | Critical/high security issues resolved | Security review checklist in `SECURITY_MODEL.md` signed off |
| 14 | Type check, lint, tests, build pass | CI green on `main` |
