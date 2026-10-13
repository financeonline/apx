# MOTION — Architectural Decisions & Critical Decisions Required

Status: Architecture phase, v1.0 (2026-09-04)
Source of truth: `docs/SOW_v2_extracted.md` (MOTION Financial Intelligence System SOW, "Version 2.0")
Audience: product owner (for the decisions that need sign-off) and implementing engineers (for the decisions already taken)

This document has two parts.

- **Part 1 — CRITICAL DECISIONS REQUIRED.** Ambiguities, contradictions and gaps found in the SOW. Each has a recommendation. The recommendation is what every other document in `docs/` assumes unless the product owner overrides it. Nothing here is hidden inside another document.
- **Part 2 — Architecture Decision Records (ADRs).** Decisions the architecture takes on its own authority because the SOW constrains them or because there is one clearly correct engineering answer. Other documents cite these as `ADR-0xx`.

Vocabulary used everywhere: **Organization** = the tenant (one customer business). **Platform** = MOTION itself. **Member** = a user inside an organization (owner/admin/client). **Employee** = a platform-side user assigned to organizations. **Super Admin** = platform operator.

---

## Part 1 — CRITICAL DECISIONS REQUIRED

Ordered by how much they change the build. Items marked **[BLOCKING MVP]** must be answered before Phase 3 (Import Engine) starts; the rest can be answered before the phase that uses them.

### CD-01 · Which SOW file is authoritative [BLOCKING MVP]
**Problem.** Two files were supplied. `MOTION_Financial_Intelligence_System_SOW_v1.docx` (14:01) contains 20 modules. `Copy of …SOW_v1.docx` (14:15, later) has the *Team Management System*, *Commercial Intelligence (CRM)* and *Marketing Analysis* rows blanked and no signature section. Both are titled "Version 2.0".
**Why it matters.** Three modules either exist or do not. CRM shapes the `counterparties`/customer model; Marketing Analysis shapes the Health Score's "Marketing Efficiency" dimension.
**Recommended decision.** Treat the complete file as authoritative. All three modules are post-MVP anyway (see `MVP_SCOPE.md`), so no MVP work changes either way. Confirm in writing which file is signed.
**Impact if ignored.** Scope dispute at acceptance over modules that were never in the signed document.

### CD-02 · Who is "the adviser"? Platform employee vs external accountancy firm [BLOCKING MVP]
**Problem.** The role brief defines *My Employee* as "internal employee/adviser working for the platform owner". SOW §18 (Accountant/CFO Command Centre) and §29 (professional plans *for* accountants and CFO advisers) describe advisers as *customers* of the platform who bring their own client businesses. These are different parties with different trust boundaries.
**Why it matters.** A platform employee is inside MOTION's trust boundary and is assigned by the Super Admin. An external accountancy firm is itself a tenant, brings its own staff, and must be isolated from other firms and revocable by the client business.
**Recommended decision.** MVP: the adviser is a **platform employee** (`platform_employee`) assigned per organization by a Super Admin, revocable by the organization owner. Post-MVP: introduce **adviser organizations** (an organization with `kind = 'adviser'`) whose members can be granted access to client organizations through the same `organization_assignments` table with `grantor_organization_id` populated. The assignment table is designed now so this is an additive change (ADR-002).
**Impact if ignored.** Either external accountants get modelled as platform staff (a security boundary violation) or the employee model gets bolted onto a tenant later, forcing an RLS rewrite.

### CD-03 · Accounting basis and source-of-truth precedence [BLOCKING MVP]
**Problem.** SOW §6 lists trial balances, general ledgers, P&L/balance-sheet reports, invoices, receipts, sales/purchase reports and bank statements as inputs. These overlap: the same month's revenue can arrive from a P&L report (summary), a GL export (transactions), a sales report (invoices) and a bank statement (cash received). The SOW never says which wins, nor whether MOTION reports on an accrual or cash basis.
**Why it matters.** Deterministic calculation is impossible without a precedence rule. Double counting revenue from a GL and an invoice list is the single most likely way to show a wrong number.
**Recommended decision.** (a) MOTION reports **accrual-basis P&L** when accrual data exists and **cash-basis cash metrics** always from bank data when bank data exists. (b) Per metric and per period the engine applies fixed precedence, records which source it used (`metric_snapshots.basis`), and never sums across sources: `period_balances` (TB/P&L/BS covering the whole period) → `ledger_entries` (GL) → `invoices` (sales/purchase lists) → `bank_transactions` (cash proxy, flagged `estimated`). Details in `FINANCIAL_ENGINE.md §2`. (c) The user is told on the dashboard which basis is in use.
**Impact if ignored.** Wrong or double-counted figures; AI explanations built on contradictory inputs; loss of trust in the first week.

### CD-04 · Chart-of-accounts mapping to MOTION standard categories [BLOCKING MVP]
**Problem.** Revenue, COGS, operating expenses etc. can only be computed if every account or transaction is classified. The SOW does not say who classifies or how.
**Why it matters.** Every P&L metric depends on it. Misclassification silently corrupts gross margin and operating profit.
**Recommended decision.** Every organization gets a seeded **standard chart** of ~20 accounts, one per `standard_category` (ADR-004). Imported accounts are mapped to a standard category at import mapping time: the importer suggests by keyword rules, the reviewer confirms. Unmapped accounts land in `uncategorised` and metrics that depend on them are marked `incomplete`, never silently excluded. Mapping is saved per organization and reused.
**Impact if ignored.** Users import a GL and see zero revenue, or revenue that includes VAT and loans.

### CD-05 · Definition of gross profit, operating profit and net profit
**Problem.** The SOW lists these metrics but not their boundaries. Where do depreciation, interest, tax, director's drawings, and "other income" go? Service businesses often have no COGS.
**Why it matters.** Margin alerts and the Health Score depend on these boundaries being stable and explainable.
**Recommended decision.** Adopt the definitions in `FINANCIAL_ENGINE.md §3`: Gross profit = revenue − cost_of_sales; Operating profit = gross profit − operating_expenses (excludes interest, tax, and other income/expense); Net profit = operating profit + other_income − other_expense − interest − tax. If an organization has no `cost_of_sales` accounts, gross profit equals revenue and gross margin is shown as "not applicable" rather than 100%.
**Impact if ignored.** Every margin figure is disputed by the client's accountant.

### CD-06 · Opening cash for the first period
**Problem.** Closing cash = opening cash + net movement, but the first imported period has no prior closing balance.
**Why it matters.** Without it, every cash balance is wrong by a constant and liquidity alerts are meaningless.
**Recommended decision.** Opening cash comes, in order, from: the opening balance printed on the bank statement (parsed into `import_batches.statement_opening_balance`), `bank_accounts.opening_balance` entered by the user, or a balance-sheet import for the prior period. If none exists, cash *movements* are shown and cash *balance* is shown as "unknown — enter opening balance" (an `incomplete` state), never as zero.
**Impact if ignored.** Dashboard shows negative or zero cash for a healthy business.

### CD-07 · Receivables and payables source
**Problem.** Receivables can come from open invoices (aged) or from the balance-sheet account balance. The two rarely agree.
**Why it matters.** Aging analysis and "receivables deterioration" alerts need invoice-level data; a balance sheet gives only a total.
**Recommended decision.** If open sales/purchase invoices exist for the period, receivables/payables and aging come from `invoices`. Otherwise the total comes from `period_balances` for the receivables/payables standard categories and aging is marked unavailable. Basis is recorded and shown.
**Impact if ignored.** Two different receivables figures appear on different screens.

### CD-08 · Customer contribution cost allocation
**Problem.** SOW §7 asks for "customer/product/service contribution where data supports it" but no data source allocates costs to customers.
**Why it matters.** "Which customers are most profitable?" is a headline AI question.
**Recommended decision.** MVP defines **customer contribution = customer revenue − directly attributable costs**, where directly attributable means a `ledger_entry` or purchase invoice explicitly carrying that `counterparty_id` as a customer cost, which in practice is rare. The UI therefore labels the MVP figure "revenue contribution" and shows revenue share and concentration. Full contribution with cost allocation rules is post-MVP. Product/service contribution requires invoice lines, which are post-MVP.
**Impact if ignored.** AI is asked "most profitable customer" and either invents an allocation or answers with revenue while calling it profit.

### CD-09 · Period granularity and fiscal year
**Problem.** Not specified.
**Why it matters.** Every trend, variance, alert window and AI period reference depends on one unambiguous period grain; changing it later invalidates all snapshots.
**Recommended decision.** Calendar months are the atomic period. Fiscal-year start month is an organization setting (default January). Quarters and years are aggregates of months. Daily granularity exists only for bank transactions and the Daily Executive Brief (post-MVP).
**Impact if ignored.** Period-over-period comparisons drift and the AI confuses periods.

### CD-10 · Currency
**Problem.** Not specified. Commercial strategy implies UK and international customers.
**Why it matters.** Money columns, import validation and every formatted number assume one currency per organization; retrofitting multi-currency later touches every table.
**Recommended decision.** One base currency per organization in MVP. Every amount column still stores a `currency` code so multi-currency can be added without migration. Imports in another currency are rejected at validation with a clear message.
**Impact if ignored.** Mixed-currency sums silently produced.

### CD-11 · PDF ingestion and whether Claude may touch raw data [BLOCKING MVP]
**Problem.** SOW §6 requires PDF bank statements and financial documents. Deterministic table extraction from arbitrary bank PDF layouts is not reliably achievable. The only general-purpose extractor is an LLM, which contradicts "Claude must never be authoritative".
**Why it matters.** Scope, cost and the integrity principle collide here.
**Recommended decision.** PDF ingestion in MVP: upload, virus/size/type validation, storage, SHA-256, text-layer extraction, page count. Extraction into rows uses (1) deterministic parsers for text-layer PDFs with tabular text, and (2) Claude structured extraction as a fallback. **Every row that came through Claude is stamped `assurance_level = inferred` and `record_status = needs_review` and cannot be committed without a human ticking each row or the batch after viewing it side-by-side with the page image.** Row totals are cross-checked against statement opening/closing balances; mismatch blocks commit. Scanned PDFs without a text layer are stored as source documents only and the user is asked for CSV. This is the *only* place Claude sees raw source data, and it never writes to the database directly. This keeps the SOW principle intact: Claude proposes, a human commits, the calculator never reads uncommitted rows.
**Impact if ignored.** Either PDF support is silently dropped (SOW breach) or unverified LLM extraction feeds the calculation engine.

### CD-12 · Duplicate definition
**Problem.** "Duplicate detection" is required but not defined. Legitimate duplicates exist (two identical direct debits on the same day).
**Why it matters.** Duplicate handling decides whether numbers are over- or under-stated and whether the import review is trusted.
**Recommended decision.** Two tiers. **File duplicate:** same SHA-256 already committed in the organization → upload blocked with a link to the earlier batch. **Record duplicate:** same `dedupe_hash` (normalised date + amount + direction + normalised description + account/bank account) as an already committed record in the same organization, or another row in the same batch → row marked `duplicate`, shown in review with the matching record, defaults to *skip*, reviewer can override to *keep* with a mandatory reason. Fuzzy duplicates (±1 day, same amount and description) are flagged as `warning`, default *keep*. Nothing is discarded; skipped rows stay in `import_rows` with status `duplicate`.
**Impact if ignored.** Either double counting or silently dropped legitimate transactions.

### CD-13 · Super Admin access to tenant financial data
**Problem.** The brief says Super Admin has "platform-wide authority" but also that tenant isolation is mandatory and employees must be explicitly assigned. A Super Admin who can read every tenant's ledger is the largest single insider risk.
**Why it matters.** The platform operator's access is the largest insider risk and the first question on any customer security questionnaire.
**Recommended decision.** MVP: Super Admin can read all organizations' data, every such read outside `/platform` is written to `audit_events` with `actor_type = 'platform_admin'`, and the organization's owner can see those events in their audit log. Post-MVP: replace with time-boxed *support access grants* that the Super Admin must explicitly create (self-assignment, 24h expiry, reason required) before tenant data is readable. The RLS helper `app.accessible_org_ids()` is designed so this change is a one-function edit.
**Impact if ignored.** Undetectable insider access; fails any customer security questionnaire.

### CD-14 · Owner cardinality and transfer
**Problem.** "Owner of a customer business" — one or many? Can ownership be transferred? What if the only owner leaves?
**Why it matters.** Ownership determines who can delete the organization, manage billing and remove everyone else; an undefined rule creates orphaned or hijacked tenants.
**Recommended decision.** An organization has **one or more owners** and must always have at least one; the last owner cannot be removed or demoted. Owners can promote an admin to owner and demote another owner. Transferring sole ownership is a dedicated two-step flow (current owner initiates, nominee accepts; both audited), not a permission. No user can elevate their own role. Super Admin can reassign ownership as a break-glass action (audited).
**Impact if ignored.** Orphaned organizations nobody can administer.

### CD-15 · What a Client can do
**Problem.** "Normal customer-side user" is undefined. Can they upload data? Create actions? Use the AI?
**Why it matters.** The role decides whether the low-technical user can damage data and whether the product is useful to a manager who only consumes intelligence.
**Recommended decision.** Client is **read + participate**: view everything the org exposes except source documents and audit logs, use the AI Analyst, view actions, update status of actions assigned to them, and add comments. Client cannot import, edit financial records, manage users or settings. Rationale: the SOW's low-technical user is often the owner; the "client" role is for managers who consume intelligence.
**Impact if ignored.** Either clients accidentally corrupt data, or the role is useless.

### CD-16 · What an Employee can do inside an assigned organization
**Problem.** Undefined.
**Why it matters.** It defines what an adviser can legitimately do inside a customer's books and how the customer's audit trail reads.
**Recommended decision.** Employee = **operate, don't govern**: everything Admin can do with data (import, review, categorise, correct, run AI, create and assign actions, generate reports, view source documents) but **no** user management, settings, billing or audit-log access for that organization. Employees also get a portfolio view of assigned organizations (the MVP seed of the CFO Command Centre).
**Alternative considered.** The morning baseline made platform employees *read-only* inside tenants (no imports, no writes, no AI) and displayed them to tenants as an anonymous "MOTION Support", to keep the tenant's audit trail free of platform-authored data. That is the safer choice if employees are support staff. It is the wrong choice if employees are the advisers of SOW §18, who must import client files, run AI analysis and raise actions. This document assumes the adviser reading; every employee write is audited with `actor_type = 'employee'` and shown by name plus a "MOTION adviser" badge, so audit honesty is preserved. **Product owner must confirm which reading applies.**
**Impact if ignored.** Employees either become de facto admins of customer organizations or cannot do the advisory work the SOW sells.

### CD-17 · Source document and export rights
**Problem.** SOW §5 says source documents are access-controlled but not by whom. Export is not mentioned at all, but every finance user expects CSV export.
**Why it matters.** Bank statements and ledgers are the most sensitive artefacts in the system; export is the easiest exfiltration path.
**Recommended decision.** `documents.view` and `data.export`: Owner, Admin, Employee, Super Admin. Client: no. Every document download and export is audited. Signed URLs expire in 60 seconds.
**Impact if ignored.** Bank statements downloadable by any member; no audit trail for data leaving the system.

### CD-18 · Alert thresholds: fixed or configurable
**Problem.** SOW §13 requires rules that detect 'unusual' and 'significant' changes but gives no thresholds and does not say whether customers can tune them.
**Why it matters.** Thresholds decide alert volume; too many alerts and users stop reading Insights, too few and the product misses the one that mattered.
**Recommended decision.** MVP ships platform default thresholds, versioned in code (`ALERT_ENGINE` rule definitions in `SERVICE_ARCHITECTURE.md`). Per-organization overrides are post-MVP. Thresholds are shown in each alert's explanation so users know why it fired.
**Impact if ignored.** Either alert fatigue with no relief valve, or configuration UI built before anyone knows good defaults.

### CD-19 · Health Score weights need product sign-off
**Problem.** SOW §9 gives eight dimensions with "indicative inputs" and no weights. Two dimensions (Marketing Efficiency, Funding Readiness) depend on post-MVP modules.
**Why it matters.** The score is the first number a user sees and the one advisers and lenders will challenge; it must be defensible line by line.
**Recommended decision.** MVP scores six dimensions (Profitability 25, Cash Flow 25, Revenue Growth 15, Cost Control 15, Customer Quality 10, Banking Health 10). Dimensions with insufficient data are excluded and the remaining weights renormalised; the score shows "based on 4 of 6 dimensions". Marketing Efficiency and Funding Readiness are added post-MVP. Weights live in one versioned config and the score stores the version used. **Product owner must approve the weights and rules in `FINANCIAL_ENGINE.md §7` before Phase 6.**
**Impact if ignored.** A number nobody can defend in front of a customer.

### CD-20 · "Reconciliation" in MVP
**Problem.** SOW §15 lists reconciliation status. Reconciliation (matching bank transactions to ledger entries/invoices) is a substantial workflow.
**Why it matters.** Reconciliation is a large workflow that could consume the Banking phase and delay the core journey.
**Recommended decision.** MVP shows **coverage status** only: which periods have bank data, ledger data, both or neither, and the difference between bank net movement and ledger cash-account movement where both exist. Transaction-level matching is post-MVP (Phase 13). The `bank_transactions.matched_ledger_entry_id` column exists from day one.
**Impact if ignored.** Weeks of matching UI built before the core journey works.

### CD-21 · Live bank feeds
**Problem.** SOW §15 permits live bank connectivity only through supported secure integrations and forbids claiming connectivity that does not exist; no provider is named.
**Why it matters.** Users will assume 'Banking' means a live feed; a wrong impression undermines trust and any provider choice is a procurement and compliance decision.
**Recommended decision.** None in MVP. The UI never says "connected"; it says "last statement imported: date". Open Banking (UK) via an aggregator is a post-MVP change-control item.
**Impact if ignored.** Either an unplanned Open Banking integration lands in the MVP or the UI implies a freshness it does not have.

### CD-22 · Hosting, runtime and background jobs
**Problem.** SOW names Supabase and Next.js but not where Next.js runs or how long-running work (PDF extraction, recalculation of 36 months) executes.
**Why it matters.** PDF extraction and multi-year recalculation exceed serverless request limits; the choice determines cost, latency and operational complexity.
**Recommended decision.** Vercel for Next.js, Supabase cloud (EU/UK region, see CD-23). Background work runs through a database-backed job queue (`jobs` table) drained by a Vercel Cron-invoked route handler and, for anything over ~60 s, a Supabase Edge Function. Imports under 5,000 rows commit synchronously; larger ones are queued. No third-party queue.
**Impact if ignored.** Request timeouts on first real customer file.

### CD-23 · Data residency, retention and deletion
**Problem.** SOW is silent on jurisdiction, GDPR, retention and right to erasure.
**Why it matters.** Financial data of identifiable businesses is personal data under UK/EU law; residency, retention and erasure are contractual obligations, not features.
**Recommended decision.** Supabase project in the region matching the first customers (assume London/EU). Organization deletion = soft delete + 30-day grace + hard purge job including Storage objects. Audit events are retained after purge with the organization id but no financial payloads. **Product owner must confirm jurisdiction and whether a DPA is required.**
**Impact if ignored.** Cannot answer a customer's DPA or a deletion request.

### CD-24 · AI usage limits and cost control
**Problem.** The SOW makes the AI Analyst a core capability but sets no usage bounds; Claude calls are metered per token.
**Why it matters.** One tenant's runaway or abusive usage becomes the platform's cost and can degrade service for everyone.
**Recommended decision.** Per-organization daily message quota (default 100) and per-user rate limit (10/min); tool calls capped at 8 per answer; context window capped at 12 months of metric snapshots unless the question names a period. Quotas are settings the Super Admin can change per organization.
**Impact if ignored.** One tenant's runaway usage becomes everyone's bill.

### CD-25 · "Report incorrect insight" workflow
**Problem.** SOW §11 requires 'a mechanism to report incorrect insights' without saying who receives reports, what happens next, or what the reporter sees.
**Why it matters.** Without a closed loop, wrong answers persist and users lose trust; with automatic correction, the model would be editing its own audit trail.
**Recommended decision.** Any user can flag an AI message or alert with a reason. Flags are stored in `ai_feedback`, surface in `/platform/ai-feedback`, and are reviewed by platform staff. No automatic correction. Flagged messages carry a visible "under review" badge to that organization.
**Impact if ignored.** Reports go nowhere; the acceptance criterion is met on paper only.

### CD-26 · Undefined modules: Team Management System, Investment Opportunities, Marketing Analysis
**Problem.** Each is one sentence in the SOW with no functional detail, and Investment Opportunities ("create a pitch deck") is a different product.
**Why it matters.** Each is potentially months of work; building any of them from a one-line description guarantees the wrong product.
**Recommended decision.** All post-MVP, each requiring its own mini-SOW under change control (§28) before design. The Action Centre's assignment and comments cover the MVP need for "engagement between teams and client".
**Impact if ignored.** Unbounded scope inside the fixed SOW price and timeline.

### CD-27 · Budget data has no import path
**Problem.** "Budget/forecast variance where applicable" is listed, but no budget file type is in §6.
**Why it matters.** A variance metric with no comparison data would either show nothing or be quietly fabricated.
**Recommended decision.** Budget import (CSV: period, account/category, amount) is post-MVP with the Forecasting phase. The metric engine reserves `budget_variance_*` metric keys.
**Impact if ignored.** Budget variance appears on screens with no defined input, or is silently dropped from the SOW list.

### CD-28 · Inter-account transfers, refunds, credit notes and negative amounts
**Problem.** Not addressed. Transfers between an organization's own bank accounts are not inflows/outflows; refunds reduce revenue; credit notes reduce receivables.
**Why it matters.** Each of these inflates or deflates cash flow, revenue or receivables if handled naively, and none is visible to the user until the number is wrong.
**Recommended decision.** Bank transactions flagged `is_transfer` (auto-detected by matching opposite amounts across the org's own accounts within 3 days; user can override) are excluded from inflow/outflow. Negative revenue ledger entries are treated as reductions, not errors. Invoices with negative totals are stored as `credit_note` type. Rules in `FINANCIAL_ENGINE.md §4`.
**Impact if ignored.** Cash inflows double-counted for every internal transfer; refunds counted as expenses; credit notes ignored in receivables.

### CD-29 · Multi-entity groups ("Enterprise plans for larger groups")
**Problem.** SOW §29 sells 'Enterprise plans for larger groups', which implies consolidation across companies, but §5 defines isolation at company/entity level only.
**Why it matters.** Adding an entity level later would touch every table and policy; adding it now would burden every single-company customer.
**Recommended decision.** No Entity or Business Unit hierarchy in MVP (ADR-001). A group is several organizations with overlapping members. Consolidation is post-MVP via an `organization_groups` table; nothing in the MVP schema needs to change because every table is keyed by `organization_id` only.
**Impact if ignored.** Either premature hierarchy everywhere or a costly migration when the first group customer arrives.

### CD-30 · Acceptance test data
**Problem.** SOW §25 says the client "may" provide sample data. Deterministic calculation tests need golden datasets.
**Why it matters.** Deterministic calculation is only provable against known expected results; without golden data the acceptance criterion 'metrics are calculated deterministically' is untestable.
**Recommended decision.** Engineering builds three synthetic organizations (service business with GL, retailer with bank + invoices, mixed with TB) with hand-verified expected metrics. Client sample data is used additionally when supplied, never instead.
**Impact if ignored.** Tests assert that the engine agrees with itself, not that it is right.

### CD-31 · Definition of contribution margin
**Problem.** SOW §7 lists "contribution margin" without defining variable costs. Small-business ledgers rarely separate variable from fixed costs.
**Why it matters.** Contribution feeds the Profitability dimension of the Health Score and the customer-profitability answers; an undefined variable-cost boundary makes both indefensible.
**Recommended decision.** MVP: contribution margin = revenue − cost_of_sales − marketing (the two standard categories that scale with sales), shown with the label "contribution (after direct costs and marketing)". A per-organization variable-cost tag on accounts is post-MVP. **Product owner must confirm the definition** (`FINANCIAL_ENGINE.md §3`).
**Impact if ignored.** A contribution figure the client's accountant defines differently, undermining the Health Score's Profitability dimension.

---

## Part 2 — Architecture Decision Records

Format: Context → Decision → Consequences. Numbering is stable; other documents cite these.

### ADR-001 · Tenant boundary is the Organization; no Entity/Business Unit tables
Context: SOW says "company/entity isolation"; brief asks whether Platform → Organization → Entity → Business Unit is needed.
Decision: Hierarchy is **Platform → Organization**. Every tenant-owned row carries `organization_id`. A customer with several companies creates several organizations. Groups/consolidation are post-MVP (CD-29).
Consequences: One RLS predicate everywhere; no `entity_id` joins; consolidation later is an aggregation layer, not a schema change.

### ADR-002 · Two role families, one access resolver
Context: Five user-facing roles; owner and super admin must not merge; employees need explicit assignment.
Decision: **Platform roles** (`platform_super_admin`, `platform_employee`) live in `platform_users`. **Tenant roles** (`tenant_owner`, `tenant_admin`, `tenant_client`) live in `organization_memberships`. Employee → organization access lives in `organization_assignments`. One SQL function `app.accessible_org_ids()` and one TypeScript `resolveAccess(userId, orgId)` compute the effective role for a user in an organization. Effective roles are exactly one of: `super_admin`, `employee`, `owner`, `admin`, `client`, `suspended_member` (ADR-038.2), `none`.
Consequences: RLS and application code agree by construction. Adding external adviser firms later means inserting rows into `organization_assignments` with a `grantor_organization_id`, no policy rewrite.

### ADR-003 · Permissions are string keys; role → permission map lives in one TypeScript module; RLS enforces coarse role rules
Context: Fine-grained permissions in SQL policies become unmaintainable.
Decision: `src/core/permissions/` (`catalogue.ts`, `matrix.ts`, `check.ts`) is the single source of the matrix in `RBAC_MATRIX.md`. Code never branches on role names; it calls `can(ctx, 'imports.create')` / `assertCan(...)`. Unknown permission strings are type errors; anything not granted is denied. A generated migration (`scripts/sync-permission-matrix.ts`) mirrors the matrix into a read-only `role_permissions` table, and RLS write policies call `app.has_permission(organization_id, 'financials.edit')`, which resolves the effective role via `app.org_role()` and looks it up. A pgTAP suite asserts SQL/TypeScript parity on every CI run. Reads are still gated by organization access only.
Consequences: Defence in depth with one matrix: a bug in app code cannot cross a tenant boundary; a bug in RLS cannot grant a client write access without also passing the app check; the two layers cannot drift silently because CI fails on divergence. (Carried forward from the 2026-09-04 morning baseline; see Part 3.)

### ADR-004 · Canonical financial model: standard categories + four record tables
Decision: `accounts` (organization chart, each mapped to a `standard_category` enum), `ledger_entries` (transaction-level, debit/credit), `period_balances` (summary-level per account per month), `invoices` (sales/purchase/credit note), `bank_transactions`. `counterparties` is one table with `kind ∈ {customer, supplier, both, unknown}`. Every organization is seeded with one system account per standard category so bank-only organizations still get a P&L.
Standard categories: `revenue, other_income, cost_of_sales, operating_expense, payroll, marketing, interest_expense, tax_expense, depreciation, other_expense, cash, receivables, inventory, other_current_asset, fixed_asset, other_asset, payables, credit_card, loan, tax_liability, other_current_liability, long_term_liability, equity, drawings, transfer, uncategorised`.
Consequences: Calculations depend only on standard categories, never on customer-specific account names.

### ADR-005 · Metric precedence and basis recorded on every snapshot
Decision: See CD-03. `metric_snapshots.basis ∈ {period_balances, ledger, invoices, bank, mixed, none}`. Sources are never summed together for one metric-period.

### ADR-006 · Money and precision
Context: The morning baseline chose integer minor units (pence) in `bigint`. That is exact but breaks for 0- and 3-decimal currencies (JPY, KWD), makes SQL aggregations and hand-inspection harder, and buys nothing over Postgres `NUMERIC`, which is also exact.
Decision: Money columns `NUMERIC(18,2)`; ratios and scores `NUMERIC(20,6)`; never `float`. TypeScript uses `decimal.js` with 20 significant digits internally; values cross the Supabase client as strings and are parsed into `Decimal` at the data-access boundary (never `parseFloat`). Rounding `ROUND_HALF_UP` applied once at storage/display. Percentages stored as ratios (0.2534), displayed to one decimal. Every amount column has a sibling `currency CHAR(3)`.
Consequences: Supersedes the integer-minor-units baseline. A lint rule bans `parseFloat`/`Number()` on money fields in `data/` layers.

### ADR-007 · Periods are materialised calendar months
Decision: `fiscal_periods` rows are created per organization lazily as data arrives (and forward 12 months). Metrics are keyed by `period_id`. Quarter/year values are computed by aggregation at read time, not stored, except the health score which is monthly.

### ADR-008 · Metrics are materialised by calculation runs, never computed in the UI
Decision: Committing an import enqueues a `calculation_run` covering the affected periods and all later periods. Runs write `metric_snapshots` with `engine_version` and an `input_fingerprint`; the previous snapshots for the same key/period are marked `is_current = false`, never deleted. The UI and the AI read only current snapshots. Ad hoc calculation in React is forbidden (`SERVICE_ARCHITECTURE.md`).
Consequences: Numbers on every screen and in every AI answer are identical because they are the same rows. Historical answers remain reproducible.

### ADR-009 · Evidence = reproducible query descriptor + pinned record IDs
Decision: An `evidence_item` either pins a specific record (`ref_type`, `ref_id`) or stores a `query_descriptor` (table, filters, period, as-of calculation run) that deterministically re-selects the contributing rows. Aggregates use descriptors; drivers, alerts and AI citations pin IDs. See `EVIDENCE_MODEL.md`.

### ADR-010 · Claude is a reader of services, never of tables
Decision: The AI layer is a server-side tool-calling loop. Tools are typed TypeScript functions that call the same services the UI uses, with the caller's `AccessContext`. No SQL, no raw table access, no service-role client. The model's final answer is a JSON object validated against the response contract; every number in it must match a number returned by a tool in that turn (numeric grounding check) or the answer is rejected and regenerated once, then degraded to "I could not verify". See `AI_ARCHITECTURE.md`.

### ADR-011 · PDF extraction path
Decision: See CD-11. Claude-extracted rows are `inferred` + `needs_review`; balance reconciliation gate; scanned PDFs stored only.

### ADR-012 · Imports are staged, reviewed, committed transactionally, and never destructive
Decision: `import_rows` hold raw and mapped data with per-row status and issues. Commit is a single database transaction that inserts into the target table, links `import_row_id`, sets batch status `committed`, and enqueues a calculation run. Rejected and duplicate rows are retained. Rolling back a batch marks its records `record_status = 'rejected'` (soft) and triggers recalculation; it never deletes. Correcting an individual *accepted* financial record never edits it in place: the service writes a replacement row, sets `superseded_by` on the original, and (for `ledger_entries`) may additionally write a reversing entry so the audit trail reads like a journal. (Carried forward from the baseline's "posted entries are irreversible; corrections are reversing entries" rule.)

### ADR-013 · All writes go through Next.js server code using the user's session; service role only for jobs
Decision: The browser never writes to Supabase tables directly. Server actions and route handlers use a Supabase client bound to the user's JWT so RLS applies, plus `assertCan`. The service-role key is used only inside job workers and is wrapped in `withOrgScope(orgId)` which sets `app.current_org` and asserts every query's `organization_id`. Storage access is via short-lived signed URLs minted server-side after permission checks.

### ADR-014 · Two Supabase clients, one AccessContext
Decision: `createUserClient()` (anon key + session, RLS on) and `createServiceClient()` (service role, job-only). Every service function takes an `AccessContext { userId, orgId, effectiveRole, permissions, actorType }` as first argument. Context is resolved once per request in middleware/layout and passed down; it is never re-derived from client-supplied ids.

### ADR-015 · Audit is append-only, written by services and by triggers on critical tables
Decision: `audit_events` receives (a) service-level events with intent (`import.committed`, `member.role_changed`, `document.downloaded`, `ai.answered`) and (b) trigger-level row diffs for `organization_memberships`, `organization_assignments`, `platform_users`, `organizations`, `accounts`. No UPDATE/DELETE policy exists on `audit_events` for any role.

### ADR-016 · Record lifecycle and assurance are two separate enums
Context: SOW §6 lists "Verified, Calculated, Estimated, Inferred, Incomplete, Needs Review, Duplicate, Rejected" as one list; they mix *how sure we are* with *where the row is in its lifecycle*.
Decision: `assurance_level ∈ {verified, calculated, estimated, inferred}` describes provenance and is shown to users and to the AI. `record_status ∈ {pending, needs_review, accepted, duplicate, rejected, incomplete}` describes lifecycle. Only `accepted` records feed calculations. Both enums appear on every financial record table.

### ADR-017 · Health Score is a deterministic rules engine with a versioned config
Decision: See CD-19 and `FINANCIAL_ENGINE.md §7`. Score snapshots store the full per-dimension breakdown as JSON so explanations never need recomputation.

### ADR-018 · Alerts are idempotent per (organization, rule, period, subject)
Decision: A `dedupe_key` unique constraint means re-running calculation never duplicates an alert; the alert is updated in place (severity, explanation, evidence) and its status is preserved. Rules are code, versioned; the alert stores `rule_version`.

### ADR-019 · Customer navigation is seven items plus Settings; platform admin is a separate app shell
Decision: `/app/[orgSlug]/{home,insights,money,customers,actions,reports,analyst}` and `/app/[orgSlug]/settings/*`; `/platform/*` for super admin; `/portfolio` for employees. See `ROUTE_ARCHITECTURE.md`.

### ADR-020 · Background job queue in Postgres
Decision: `jobs` table with `FOR UPDATE SKIP LOCKED` draining, invoked by Vercel Cron every minute and by an immediate "kick" after enqueue. Job types: `calculation.run`, `document.extract`, `import.commit_large`, `alerts.evaluate`, `org.purge`, `report.render`, `ai.eval`.

### ADR-021 · Testing baseline
Decision: Vitest for unit tests (pure functions) and integration tests against a real local Supabase Postgres run as different JWTs, pgTAP for RLS policies, triggers and permission-matrix parity, Playwright for critical journeys, golden datasets for calculations, plus mandatory adversarial suites (tenant isolation, permission enforcement, AI tool boundaries, prompt injection, import validation). Coverage gates on `financial-engine/domain` and `core/permissions` at 95% lines. See `TEST_STRATEGY.md`.

### ADR-022 · Monorepo layout is a single Next.js app with internal modules by boundary
Decision: One repository, one Next.js app, three layers with downward-only dependencies: `src/app` (routes, UI) → `src/modules/*` (one per service boundary: `auth`, `tenancy`, `documents`, `imports`, `banking`, `financial-engine`, `health`, `alerts`, `evidence`, `ai`, `actions`, `reporting`, `audit`, `portfolio` — the last added by ADR-038.13) → `src/core/*` (`permissions`, `money`, `periods`, `db`, `storage`, `jobs`, `errors`, `logging`). Every module has the same anatomy: `domain/` (pure functions, no I/O), `schemas/` (Zod), `data/` (repositories, the only place that touches Supabase), `services/` (use cases; take `AccessContext` first), `index.ts` (the only import surface; deep imports are ESLint errors). `financial-engine/domain` and `core/permissions` have no Next.js or Supabase imports so they unit-test in isolation. Not a Turborepo; nothing justifies it yet. (Layering and anatomy carried forward from the baseline.)

### ADR-023 · Claude model and abstraction
Decision: All Claude calls go through `src/modules/ai/data/claude-client.ts`, which owns the API key, model id (configurable, default the latest Sonnet-class model for cost; Opus-class for report generation), retries, timeouts, token accounting and prompt-version tagging. No other module imports the Anthropic SDK. The module exposes exactly two entry points: `ai.answer` (the analyst tool loop, `AI_ARCHITECTURE.md`) and `ai.extractStatementPage` (PDF structured extraction under CD-11, called only by `imports` via the `document.extract` job; output lands in `import_rows` as `inferred`/`needs_review`, never in a financial record table).

### ADR-024 · Reports in MVP
Decision: One report, the Monthly Management Report, rendered from current metric snapshots, alerts and actions as a printable page and PDF via the job queue. The remaining five report types are post-MVP.

### ADR-025 · Feature flags per organization
Decision: `organizations.features JSONB` with boolean keys (`forecasting`, `scenarios`, `crm`, `banking_reconciliation`, `funding_readiness`) default false; Super Admin toggles. Post-MVP modules ship dark behind flags so MVP navigation never shows dead ends.

---

## Part 3 — Reconciliation with the 2026-09-04 morning baseline

An earlier session in this directory produced `ARCHITECTURE.md` (393 lines) and `ROLES_AND_PERMISSIONS.md` (~200 lines), then the directory was reset. Their content survives only as session memory. This section records what was carried forward and what was consciously superseded so nothing is lost silently.

| Baseline decision | Status in this architecture | Where |
|---|---|---|
| Pipeline DATA → VALIDATION → … → OUTCOME is immutable; LLM never authoritative for figures | Carried forward | `ARCHITECTURE.md §1`, ADR-010 |
| LLM reaches data only through a closed, typed server-side tool registry returning pre-calculated snapshots | Carried forward | ADR-010, `AI_ARCHITECTURE.md` |
| Three layers `app → modules → core`, downward-only; module anatomy `domain/schemas/data/services/index.ts`; deep imports are build errors | Carried forward | ADR-022, `SERVICE_ARCHITECTURE.md` |
| Permissions are the unit of authorization; code never checks role names; deny-by-default; `can(ctx, permission)`; `src/core/permissions/{catalogue,matrix,check}.ts` | Carried forward | ADR-003, `RBAC_MATRIX.md §6` |
| DB mirror of the matrix generated by `scripts/sync-permission-matrix.ts`, pgTAP parity suite | Carried forward | ADR-003, `TEST_STRATEGY.md` |
| Rules: last-owner protection; no self-elevation; ownership transfer is a two-step flow; AI tools inherit but never exceed the caller's permissions | Carried forward | CD-14, `RBAC_MATRIX.md §3` |
| Four gaps for v1.1: `documents.view`, `alerts.manage`, `intelligence.recompute`, `ai.admin` | Closed: first three are in the MVP matrix; `ai.admin` folded into `system.manage` | `RBAC_MATRIX.md §2.1` |
| Immutable, versioned snapshots; posted entries irreversible, corrections by reversing entries | Carried forward | ADR-008, ADR-012 |
| Four-layer tenant isolation (RLS, server auth, service permission checks, UI) with RLS on every tenant table | Carried forward (six enforcement points listed) | `RBAC_MATRIX.md §4` |
| Testing: Vitest unit + integration on real Postgres, Playwright E2E, pgTAP RLS, adversarial suites | Carried forward | ADR-021, `TEST_STRATEGY.md` |
| Stack pins: Next.js 16.3.x, TypeScript strict, Tailwind v4; toolchain Node 24.14, npm 11.13 | Carried forward | `ARCHITECTURE.md §3` |
| Money as integer minor units (`bigint`) | **Superseded** by `NUMERIC(18,2)` | ADR-006 (reason recorded) |
| Platform employees read-only inside tenants, shown as anonymous "MOTION Support"; platform roles lack `ai.use` | **Superseded** (pending product confirmation) by the adviser reading: employees operate but do not govern, are named with a badge, all writes audited | CD-16 |
| Risk register: insider staff access and metric drift flagged medium/high | Carried forward and expanded | `ARCHITECTURE.md` red flags #3, #7 |
| Companion doc `UX_PRINCIPLES.md` | Renamed | `UX_ARCHITECTURE.md` |

---

## Part 4 — Red-team revisions (2026-09-04, review round 1)

An independent adversarial review (`RED_TEAM_REVIEW.md`) of the v1.0 documents against the SOW found defects serious enough to change the architecture. This part records every resulting decision. ADR-026 onward supersede any earlier text that conflicts with them; the affected documents have been revised in place and each carries a "Revision 1.1" note. Finding ids (F-A/B/C/D-nn) refer to `RED_TEAM_REVIEW.md`; the reviewer's own findings F-P-01 (ledger coverage off-by-one → ADR-030), F-P-02 (purchase-invoice expense category → ADR-027), F-P-03 (stale invoice coverage → ADR-030 / `FINANCIAL_ENGINE.md §2.2`), F-P-04 (model-authored descriptors → ADR-032), F-P-05 (unwrapped free text → ADR-032), F-P-06 (report files → ADR-038), F-P-07 (prompt-cache wording → ADR-032), F-P-08 (previous-answer evidence → ADR-032), F-P-09 (engine and import details → ADR-027/029/033) are resolved by the ADRs named.

### ADR-026 · No table-level write privilege for `authenticated`; every mutation is a SECURITY DEFINER API function
> Refined by ADR-043: functions whose arguments are server-produced facts (`ai_persist_turn`, `register_document`, `record_access_event`, server-originated `enqueue_job`, `commit_batch_as`) live in schema `api_server`, executable only by `service_role`; `api` keeps user-intent functions.
Context (F-A-01, F-A-02, F-A-03, F-A-05, F-D-05): The browser holds the same principal as server code (anon key + user JWT) and PostgREST exposes `public`, so "the browser never writes" was a convention. Permission-coarse RLS write policies let any admin PATCH a ledger row, insert a forged snapshot or AI message, demote an owner, or enqueue a purge, with no audit row.
Decision:
1. `REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM authenticated, anon`. `authenticated` keeps SELECT under RLS. The RLS write-policy templates in `DATABASE_ARCHITECTURE.md §11` are withdrawn.
2. Every user-initiated mutation is a function in schema `api` (the only non-`public` schema exposed to PostgREST), `SECURITY DEFINER`, `SET search_path = ''`, fully schema-qualified, `REVOKE ALL FROM public`, `GRANT EXECUTE TO authenticated`. Each function: derives the actor from `auth.uid()` (never a parameter), resolves `app.org_role()`, checks `app.has_permission(org, '<permission>')`, enforces the invariants that used to live only in TypeScript (role ceilings, last-owner guard, no self-elevation, supersede-never-update, batch gating, alert status transitions, own-action limits), writes `audit_events` through internal `app.audit()`, and returns the affected ids. The function catalogue is `DATABASE_ARCHITECTURE.md §14`; each function has a pgTAP test that calls it as every role.
3. TypeScript services remain the orchestration layer (validation, composition, view models) and call `api.*` through the user-session client via `rpc()`. Domain logic stays in TypeScript; the SQL functions are invariant guards and writes, not calculators.
4. Jobs use the service role inside `withOrgScope(job.organization_id)`; the org id comes from the `jobs` row, never from `payload`. `jobs` rows are inserted only by `api.enqueue_job(job_type, payload)` which maps type → required permission (`calculation.run` → `intelligence.recompute`, `report.render` → `reports.generate`, `document.extract` and `import.commit_large` → `imports.review`), sets `organization_id` from the caller's context and rejects `org.purge` and `ai.eval` from non-service callers. `org.purge` is enqueued only by a trigger on `organizations.status → 'pending_deletion'` with `run_after = now() + 30 days`, and the handler re-verifies status and age.
5. `app.audit()` is internal (not exposed); every field (`actor_user_id`, `actor_type`, `organization_id`, `ip`, `user_agent`, `request_id`) is derived inside the function. `ai_tool_calls`, `ai_messages` (assistant rows), `metric_snapshots`, `health_scores`, `alerts`, `evidence_*`, `calculation_runs`, `fiscal_periods`, `recurring_payment_groups` are written only by jobs or by `api.*` functions on behalf of the AI loop (`api.ai_persist_turn`).
6. The four financial record tables get `audit_diff` triggers as a backstop, and `superseded_by`/`record_status` can change only through `api.supersede_record`, `api.commit_import_batch`, `api.rollback_import_batch`.
Consequences: Defence in depth is real: RLS bounds reads; functions bound writes; both check the same `role_permissions`. ADR-013 is amended: "writes go through Next.js server code" becomes "writes go through `api.*` functions called from server code". Cost: ~35 SQL functions with tests. Per-row `app.has_permission()` evaluation disappears (checked once per call), resolving the commit hot-path concern.

### ADR-027 · Balance semantics: trial balances are cumulative; ledger balances need an opening balance; tax is excluded from revenue
Context (F-B-02, F-B-06, F-B-05): A month-end trial balance carries fiscal-year-to-date P&L balances and life-to-date balance-sheet balances, not month movements; a GL export from a start date contains movements only; invoice totals and bank receipts include VAT.
Decision:
1. `period_balances` gains `period_start date NOT NULL` (period assigned from it) and `balance_basis ∈ {cumulative, movement}` set per batch by the reviewer with a detected default (TB → cumulative, P&L report → movement, balance sheet → cumulative). Balances are stored in natural sign (`debit − credit`); the engine applies the account-type sign rule. When a file supplies debit/credit columns, `closing_balance = debit − credit`.
2. For `cumulative` P&L balances the period amount is `closing(P) − closing(P_prev)` where `P_prev` is the previous cumulative balance in the same fiscal year; the first fiscal month uses `closing(P)`; if `P_prev` is missing and `P` is not the first fiscal month the value is NULL with missing reason `no_prior_trial_balance`. Balance-sheet categories use `closing(P)` directly.
3. Ledger-basis balance-sheet metrics (cash, receivables, payables, working-capital terms) = opening balance + Σ movements, where the opening balance comes from, in order: a balance-sheet `period_balances` row for the period before the earliest ledger period; an opening-balance journal (entries dated on the fiscal-year start whose description matches `/opening balance|brought forward|b\/f/`, flagged `IMP-GL-011`, excluded from P&L); `bank_accounts.opening_balance` for cash. For cash specifically the CD-06 order applies (statement opening balance → `bank_accounts.opening_balance` → prior balance sheet → opening journal). None → NULL with `no_opening_balance`.
5. `payables_days` denominator = `cost_of_sales + operating_expense + marketing` over three periods (payroll and depreciation never pass through accounts payable); `cash.decline` uses `≤ −0.20 × |opening_cash|` with an absolute floor so a zero or negative opening balance cannot invert the rule.
4. Revenue on invoice basis = Σ `subtotal`; if absent, `total_amount − tax_amount`; if both absent, Σ `total_amount` with `assurance = estimated` and warning `vat_inclusive`. Bank-proxy revenue and expenses are gross receipts/payments with warning `vat_inclusive`; when `organizations.settings.vat_registered = true` and `default_vat_rate` is set, the proxy nets down by the rate (still `estimated`). `receivables_days` uses a gross-consistent denominator (Σ invoice `total_amount` over 3 periods when receivables are invoice-basis) and records the choice in `components`. Purchase invoices map to a standard category through `counterparties.default_expense_category` (set at first mapping, editable) else `uncategorised`.
Consequences: Correct monthly figures from the most common file types; new import issues `IMP-GL-011`, `IMP-TB-012 (balance basis confirmation)`; new CD-33 for VAT settings sign-off.

### ADR-028 · Cash transfers are only between cash-like accounts; card and loan payments are cash outflows
Context (F-B-01): §4.2 paired a current-account payment with the matching inflow on a credit-card or loan statement and excluded both from cash movement, so closing cash was overstated by every repayment, cumulatively.
Decision: A pair is a *cash transfer* (excluded from `cash_inflows`/`cash_outflows`) only when both legs are on `account_type ∈ {current, savings}`. A pair between a cash-like account and a `credit_card`/`loan` account keeps `is_transfer = true` for P&L purposes (the payment is not an expense), but the cash-like leg is counted in cash metrics under category `credit_card` or `loan` ("debt repayment"/"drawdown"). For liability-type bank accounts the statement reconciliation gate is `−Σ amount = closing − opening`. New property test on the retail golden org: closing cash equals Σ statement closing balances of cash-like accounts.

### ADR-029 · Supersession is batch-scoped; invoices update rather than duplicate; dedupe keys are stable identities; dedupe re-runs at commit
> Refined by ADR-047: item 1's "row current at a historical `asOf`" is withdrawn (receivables always use the current row, ADR-047.10); item 3's refusal becomes promotion of dependants (ADR-047.9); rollback resets `superseded_by` (ADR-047.1).
Context (F-B-03, F-B-04, F-B-11, F-B-12, F-D-13, F-B-17 and the chain-rollback note): the v1.0 rules lost data on the two most common workflows (monthly invoice re-export, corrected statement re-import), superseded balances account-by-account, keyed dedupe on uuids that change with renames, and checked duplicates only at validation time.
Decision:
1. **Invoices.** A hit on `(invoice_type, counterparty_id, invoice_number)` is an *update candidate*: if any of `total_amount, amount_paid, paid_date, due_date, status` differ → issue `IMP-INV-010 updated` (warning, default keep) and commit supersedes the prior row; only fully identical rows are `IMP-DUP-001`. Receivables at a historical `asOf` use the row current at that date.
2. **Period balances.** Committing balance kind K for period P supersedes every accepted row of kind K for P from other batches (the partial unique index becomes `(organization_id, period_id, account_id, balance_kind)`); `IMP-COV-013` becomes an explicit confirmation naming the accounts that will be retired. Rollback restores the whole superseded batch and re-links any chain (A→B→C: rolling back B re-points C to A).
3. **Rollback dependencies.** `api.rollback_import_batch` finds committed batches whose rows were skipped as duplicates of the rows being rejected and refuses with "Batch X depends on N rows of this batch" unless called through the *replace* flow, which rolls back the old batch and commits the new one in one transaction (the new batch's duplicate pass is re-run after the rollback). The coverage strip offers "Replace" not "Roll back".
4. **Dedupe scope.** Ledger scope = `accounts.code` when present else the mapped account's `normalized_name`; bank scope = `(bank_name, sort_code_masked, account_number_masked)`; inline creation of a bank account whose masked identity already exists is refused and the existing account offered. Batch check `IMP-COV-014`: a GL/bank batch overlapping a committed batch by ≥ 1 full month with < 50% of overlapping rows matched as duplicates → warning "looks like a re-export with renamed accounts", requiring replace or explicit confirmation.
5. **Commit-time re-check.** `api.commit_import_batch` takes an org advisory lock and re-runs the cross-batch exact pass; any new collision returns the batch to `awaiting_review` with the rows re-flagged.
6. **Legitimate repeats.** Within-batch exact duplicates default to `keep` when ≥ 3 identical rows share a day or the description matches `/payroll|salary|wages/`; bulk "keep all exact with reason" exists; records committed from `reviewer_decision = keep` carry `duplicate_reviewed = true`, which `duplicate.transaction` excludes; the dismissed-alert cooldown applies to duplicate alerts of any severity.

### ADR-030 · Period completeness governs defaults, alerts, health and variance
> Refined by ADR-047.6: coverage uses the declared export range confirmed at mapping; the 3-day heuristic is deleted; `is_complete` has the no-cash-accounts exception and a `partial` fallback.
Context (F-B-07, F-B-08, F-D-09, F-D-18): Home defaulted to a partial current month, the analyst to the latest complete month; the ledger coverage test never covered the last month, so month-end figures fell to the bank proxy and fired false decline alerts.
Decision:
1. `fiscal_periods.is_complete boolean` maintained by the engine: true when `period_end ≤ latest data date` for the chosen P&L source and cash coverage is full. Home, Insights, Reports and the AI default to the latest complete period; Home shows a slim "{Month} so far" line for a partial current month. The rule lives in `core/periods` and is cited by both.
2. Ledger coverage: `P.period_end ≤ batch.period_end` (non-strict) or an entry dated in the last 3 days of P. `import_batches.period_start/period_end` are set to min/max `entry_date`/`issue_date` for GL and invoice batches at commit.
3. `basis_differs` on a variance suppresses every variance-based alert rule and is treated as NULL by health rules; MetricCard renders "compared on a different basis" without a percentage.
4. Alerts on incomplete periods are limited to record-level rules (`duplicate.*`, `bank.unusual_transaction`, `recurring.*`); no health score is computed for incomplete periods; `partial_month` scales completeness by days covered.
5. `period_to = min(latest period with accepted P&L or bank records, current month in the organization's timezone)`; future-dated invoices contribute to AR/AP only. `organizations.timezone` added; all "today" derivations go through `core/periods/clock.ts`.
6. MVP period picker is **monthly only** (F-B-15); quarter/year views are post-MVP and require an `aggregation ∈ {sum, last, recompute}` attribute per registry key, materialised as snapshots with `period_kind`, never computed in the UI.

### ADR-031 · Calculation runs: coalescing, scope, fingerprint, runtime, storage
> Items 1, 2 and 5 are refined by ADR-041 and ADR-047.7/8: one idempotency key per organization including chunk continuations, scheduled runs limited to `as_of_dependent` keys, fingerprint computed before writes, and 90-day compaction of unreferenced non-current snapshots.
Context (F-D-01, F-B-13, F-B-14, F-D-02, F-D-03, F-B-16, F-D-06): a second commit during a running run was never recalculated; scheduled runs skipped because `asOf` was outside the fingerprint; the JS engine over 100k rows had no proven runtime; `is_current` flips and immutable bundles grew without bound.
Decision:
1. Coalescing applies to `queued` jobs only, merging `periodFrom = LEAST(...)`. A run marks itself `stale` if any batch commits, rolls back, or a category/transfer edit occurs after its `started_at`; the worker loops until no newer change exists. `affectedPeriods` = min period over all batches committed/rolled back and all banking edits since the last succeeded run; `import_batches.calculation_run_id` is set only by the run that included the batch (`calculation_job_id` recorded at enqueue).
2. `input_fingerprint` includes `as_of::date` when the run touches the current period; `calculation_runs.as_of` stored; scheduled runs recompute aging, runway and recurring status even when records are unchanged.
3. Stale-run recovery: before acquiring the lock, any run `running` longer than budget × 3 is marked `failed (worker_lost)`; `import_batches` in `committing` whose job is dead return to `awaiting_review` with `error_summary.stage = 'commit'`; `/platform/jobs` has "reset batch" and "requeue". The Home banner is driven by the existence of a queued/running job, not by `calculation_runs.status`.
4. L0 aggregation (sums per period × standard category × account × counterparty × bank account) is a SQL function `app.aggregate_periods(org, from, to)`; the TypeScript engine consumes aggregates, so run CPU is proportional to periods × dimensions, not rows. Row-level evidence stays descriptor-based. Spike S5 in `IMPLEMENTATION_PLAN.md` proves a 36-month, 100k-row run inside the chosen worker; the fallback runtime is CD-34.
5. `metric_snapshots` become append-only; a pointer table `metric_current (organization_id, period_id, metric_key, dimension_type, dimension_id, snapshot_id)` is rewritten per run for the run's period range (delete range, insert), which also retires vacated dimensions. Full-range triggers (`account_remapped`, `settings_changed`) coalesce for 5 minutes behind an "Apply changes" action. Alert bundles are regenerated only when pinned ids or totals change. Snapshots referenced by `evidence_items`, `health_scores`, `alerts` or `alert_revisions` are never archived; retention equals organization lifetime.

### ADR-032 · AI response contract v2 and grounding v2
Context (F-C-01, F-C-04, F-C-05, F-C-06, F-C-08, F-C-09, F-C-10, F-C-11, F-C-14, F-C-02/F-A-18, F-C-17): v1 grounding accepted any number found anywhere in any tool output regardless of metric, period, sign or unit; names, directions and recommendation text were never grounded; the direct answer had no badge or evidence; three documents described different streaming and degradation behaviour; one tool accepted model-authored evidence descriptors.
Decision:
1. **NumberRef is mandatory** for every number in every text field. The validator reads the value at `tool_call_seq.path` and compares with tolerance equal to the precision of that field's `display`; sign must match; percentage form allowed only when the field's `unit = 'ratio'`; counts only for integer fields. The allowed set is built only from fields whose Zod output schema is branded `Money | Ratio | Count | Days`; strings are never scanned. Each `Statement` carries `period` and the number's path must belong to that period's `meta.periods`. Word numbers and ordinals are normalised, not excluded.
2. **Entity and direction grounding.** `Statement.entity_refs[]` list every counterparty/account/category/bank-account named; the validator requires each name to equal a name returned this turn and the number's path to sit in the same row as the entity. Direction words adjacent to a number must agree with the sign at the path. Dates must appear in a tool date field.
3. **Everything is a Statement.** `direct_answer`, `causes`, `risks`, `opportunities` and `recommended_actions.{title,issue,recommendation}` are Statements with kind, `evidence_refs` and `numbers`; digits are rejected outside `NumberRef`s in all of them; `confidence.data_quality_notes` and `unsupported` may not contain digits. `inference` and `recommendation` statements require ≥ 1 evidence ref (the engine outputs they interpret) or move to `unsupported`.
4. **Output channel.** The final call uses `tool_choice = submit_answer`; any text blocks are discarded, never streamed, never stored; `ai_messages.content` is NULL for assistant rows. The client receives status events and one validated `answer` event; sections are revealed progressively from that event.
5. **Degradation is canonical (AI doc §7.5):** unmatched statements are removed and listed under `unsupported`; recommendations whose refs all belong to removed statements are removed; a bundle is built from surviving statements; `failed` for JSON/timeout, `not_applicable` only for refusals; "Create action" is enabled only when `grounding_status = passed`; `actions.createFromRecommendation` refuses otherwise.
6. **Tool 13** accepts `{metric_snapshot_id} | {alert_id} | {evidence_item_id}` only; `EvidenceRef.query_descriptor` is removed; `query` refs carry a `descriptor_hash` that must match a descriptor returned this turn. `QueryDescriptorV1` is never part of a model-visible schema; the compiler rejects `table = metric_snapshots` without `as_of`.
7. **Untrusted text.** Every field originating from imported data (descriptions, counterparty/account names, references, filenames, invoice numbers, recurring signatures, action titles, alert explanations) passes through one `untrusted(field)` wrapper that escapes `<` and `>`; history replay re-wraps user turns, replays assistant turns as validated JSON only, never replays tool results; period labels accepted by tools are `period_context.resolved ∪ default ∪ meta.periods of this turn`. Alerts and health factors expose their numbers as structured fields.
8. **Context binding.** `findConversation(ctx, id)` filters `organization_id = ctx.orgId AND user_id = ctx.userId` before any model call; `get_evidence` on `ai_response` bundles requires the origin message's owner or org owner/admin. `resolveAccess` is re-run before every tool call; a changed role or permission set aborts the turn with the fallback message.

### ADR-033 · PDF extraction hardening and budget
Context (F-C-03, F-C-13, F-D-15, F-B-18, F-A-15): the balance gate compared model output with model output; extraction sat outside every quota; text-layer rows were stamped `verified` without reconciliation; the security doc said documents never reach Anthropic.
Decision: Gate balances come only from the deterministic regexes of §5.3 or from values the reviewer types (Claude's balances are shown as "AI-read" suggestions); with neither, commit is blocked. `IMP-PDF-002`: the deterministic count of date-bearing lines per page must be within ±10% of extracted rows, else per-row confirmation is mandatory; page-level ticks require `confidence = high` and `IMP-PDF-002` passing; `notes` render as "AI note (unverified)", ≤ 200 chars. Extraction tokens accrue to the per-organization ceiling plus `platform_org_settings.ai_extraction_pages_per_day` (default 300); the "user requests AI extraction" option requires `imports.review` and a failed deterministic parse. `document.extract` has `max_attempts 8`, backoff capped at 15 min, a `deferred_upstream` state, and per-page completion (`pages_extracted`, `pages_failed`) with per-page retry; retry from a `failed` batch reuses the stored document (the SHA duplicate check links to it). `pdf_text` rows are `calculated`, promoted to `verified` only when `IMP-BAL-006` passes with both balances captured and a `balance_after` chain; unreconciled statements carry `IMP-BAL-007` inherited into cash `data_quality`. Every non-empty source line becomes a row or an `import_rows` record with status `skipped` and issue `IMP-ROW-005`; CSV/XLSX header detection requires ≥ 3 synonym matches and records preamble lines. Feature flag `ai_pdf_extraction` (ADR-025) gates the Claude path; `document.extract` writes audit `document.sent_to_ai {document_id, pages}`; the wizard shows a consent line; `SECURITY_MODEL.md §11` states that text-layer page text is sent. Default for the flag is CD-35.

### ADR-034 · Evidence v2: stable descriptors, derived evidence, alert revisions, polymorphic guards
> Refined by ADR-046 and ADR-047: the as-of instant is the chunk's `aggregated_at` (not `finished_at`); `alerts.evidence_bundle_id` is dropped in favour of `current_revision_id`; immutability is mechanised by `append_only_guard`.
Context (F-C-07, F-C-15, F-C-16, F-C-18, F-A-13): descriptors filtered by *current* categories so old evidence stopped reconciling after a remap or rollback; derived metrics had no descendable evidence; alerts were rewritten under a preserved status; polymorphic references had no cross-org guard.
Decision: Engine descriptors name `account_ids` and `bank_account_ids` resolved at run time, never `standard_categories`. Append-only `category_history (record_table, record_id, category_account_id, valid_from, valid_to)` for bank transactions and `account_category_history` for accounts; the resolver joins as-of `calculation_runs.finished_at`. Append-only `record_status_events (record_table, record_id, status, at, actor)` written by commit, rollback, supersede and reject; as-of resolution uses it instead of `updated_at`. Rollback never clears `superseded_by`; it writes an unsupersede event and the resolver honours it. `metric_snapshots.evidence_query` becomes `{kind:'leaf', descriptor} | {kind:'derived', components:[{name, snapshot_id}]}`; variance snapshots store `{current_snapshot_id, comparison_snapshot_id}`; `get_metric.components` returns `{value, snapshot_id}`; the drawer shows one reconciliation block per leaf. `alert_revisions (alert_id, revision_no, rule_version, severity, explanation, threshold_summary, evidence_bundle_id, calculation_run_id, created_at)`; `alerts` points at the current revision; a severity increase re-opens an acknowledged alert; audit `alert.reevaluated`; `evidence_items.item_type` gains `alert` pinning `(alert_id, revision_no)`. Trigger `same_org_ref` on every polymorphic reference column (`evidence_items.ref_id`, `evidence_bundles.origin_id`, `alerts.subject_id`, `actions.source_id`, `calculation_runs.trigger_ref_id`, `ai_feedback.*_id`, `import_rows.duplicate_of_id`) asserts organization equality; all plain FKs on tenant tables are composite; pgTAP enumerates FK columns and fails on any exception.

### ADR-035 · Health score: condition-based inputs, proxy handling, bank-only first run
Context (F-C-12, F-B-09, F-D-04): K3/B3 read alert rows from the previous run and user statuses, making the score non-deterministic; the bank-proxy completeness cap excluded three dimensions for every bank-only organization, so the recommended first upload produced "Not enough data yet".
Decision: K3 and B3 count *conditions* evaluated by the same pure rule functions over the run's snapshots, never `alerts` rows; contributing snapshot ids are recorded in `breakdown[].metrics`. Bank-proxy completeness = `1 − uncategorised share` with `data_quality.proxy = true`; dimensions whose required metrics are `estimated` are included with their score capped at 70 and the note "based on bank data only". Home has a bank-only variant (Money in, Money out, Change in cash, "Cash balance: enter your opening balance"); the import wizard asks for the statement opening balance ("I don't know" allowed); "Improve your data" links to the specific fixer.

### ADR-036 · Alert keys: state rules vs event rules
Context (F-D-12): keying every rule by period produced one open alert per month for persistent conditions.
Decision: *State* rules (`concentration.*`, `cash.runway_low`, `receivables.deterioration`, `payables.deterioration`, `recurring.*`) are keyed by `(rule_key, subject)`; `period_id` is the latest evaluated period and `first_seen_at` is retained. *Event* rules (`expense.spike_*`, `revenue.decline`, `margin.deterioration`, `cash.decline`, `duplicate.transaction`, `bank.unusual_transaction`, `deviation.large_transaction`, `variance.significant`) stay period-keyed. A run creates at most 25 alerts per organization; overflow is summarised in one `info` alert.

### ADR-037 · Navigation and UX corrections
Context (F-D-07, F-D-08, F-D-10, F-D-11): Data pages were unreachable for employees and buried for admins; four badge vocabularies described one state; Home dropped gross and net profit; the wizard had no fast path.
Decision: The header "Add data" button becomes a **Data menu** (Add data · Imports · Documents · Accounts) for roles with `imports.review`; Client does not see it; primary navigation stays seven items. `/settings/data` is removed: fiscal-year/currency move to `/settings`, export and recalculate to `/data/imports`. `RBAC_MATRIX.md`: Employee `users.view` becomes ✗ (member names appear only in assignee pickers) and Employee `assignments.view` is served by `/portfolio`. One canonical badge table in `UX_ARCHITECTURE.md §8.1` (`assurance → label → tooltip`, `statement kind → label`) that AI and Evidence documents cite; MetricCard shows one status badge. Home Level 2 shows Revenue, Gross profit (when `cost_of_sales` accounts exist), Profit before interest and tax with net profit as a visible second line, Cash, Owed to you, You owe; the deviation from a four-card SOW §8 reading is CD-32. Import wizard steps are per `import_type` (bank: upload → account → review → confirm), saved mappings skip sign/date questions, zero-issue batches render review as a one-line summary with Commit primary; the issue panel groups by plain category with codes in tooltips.

### ADR-038 · Security hardening set
Context (F-A-04, F-A-06, F-A-07, F-A-08, F-A-09, F-A-10, F-A-11, F-A-12, F-A-14, F-A-16, F-A-17, F-D-14, F-D-16).
Decision:
1. No `storage.objects` policies for `authenticated`/`anon`; all reads are signed URLs minted by `src/core/storage/signer.ts` using a storage-scoped service client `withStorageScope(orgId)` that asserts the key prefix and requires an audit event id; Storage signing/upload/delete is the second sanctioned request-path use of the service role (ADR-013 amended), lint-confined to that file. Deletion removes the object.
2. `app.accessible_org_ids()` and `app.org_role()` join `organizations.status`; suspended organizations resolve to role `suspended_member` mapped to `dashboard.view` only; suspended memberships resolve to NULL. Parity fixtures cover both functions and both statuses.
3. `profiles` own-row update is column-limited to `full_name, avatar_url, timezone, onboarding_state, last_active_org_id`; `email` is written only by the auth-sync trigger; `disabled_at` only by `api.disable_user`. Invitation acceptance compares `invitations.email` with `auth.jwt()->>'email'` and requires a confirmed email; middleware ignores a `last_active_org_id` outside the accessible set.
4. `import_rows`, `import_batches`, `import_mappings` SELECT requires `imports.review`. Bank identifiers in `description_raw`/`raw_data` are stored verbatim; `description_normalized` masks 6–8 digit account numbers and sort codes; client-facing views and AI tool outputs use `description_normalized`. `SECURITY_MODEL.md` states this instead of "never stored".
5. Platform-controlled per-organization settings (`ai_quota_daily`, `ai_token_ceiling_monthly`, `ai_extraction_pages_per_day`, model overrides) live in `platform_org_settings` (RLS: platform), not in `organizations.settings`.
6. Any `/platform` surface that renders tenant content (`/platform/ai-feedback` item, audit payload expansion, org detail) writes `org.data_viewed {surface, target_id}`; `/platform/audit` omits `before/after` for tenant rows until expanded.
7. Report PDFs: bucket `reports`, path `{organization_id}/{period}/{job_id}.pdf`, table `report_files` (tenant data, SELECT `reports.view`), `getReportFile` resolves by `(organization_id, id)`, route writes `report.downloaded`, purge deletes the prefix.
8. Platform users (super admins and employees) must enrol TOTP before any `/platform` or `/portfolio` access; `app.is_super_admin()` requires `aal2`; magic-link sign-in is refused for platform users; re-authentication within 10 minutes is required for `platform.users.manage`, suspend, `org.delete`, and creating assignments. MVP scope includes MFA for platform users.
9. Purge sets `audit_events.metadata = '{}'`, `ip = NULL`, `user_agent = NULL` for the organization; metadata keys are an allow-list of ids per action (no emails, filenames or free text).
10. All `app.*`/`api.*` functions use `SET search_path = ''` with schema-qualified references; `SECURITY_MODEL.md §6.1` enumerates every function `authenticated` may execute; pgTAP asserts `proconfig` and grants.
11. `platform_settings` and `platform_org_settings` get `audit_diff`; job requeue/reset emits `job.requeued`.
12. Lifecycle: `jobs` gains status `cancelled` and types `storage.cleanup_orphans`, `snapshots.compact`; workers requeue with backoff any job for a `suspended`/`pending_deletion` organization except `org.purge`, which waits for zero running org jobs; `organizations.deletion_requested_at` and `api.cancel_deletion` mark the purge job cancelled; `invitations` gets a partial unique `(organization_id, email) WHERE status = 'pending'` and `api.invite_member` pre-checks existing membership and platform-user exclusivity with friendly errors; disabling the sole owner is refused unless another owner exists.
13. `/portfolio` and `/platform/organizations` use read-only aggregate projections (one statement each over `health_scores`, open alert counts, last committed batch, filtered by `organization_id IN (select app.accessible_org_ids())`), cached per organization tag; per-org context resolution remains for navigation into an organization. `TENANCY_MODEL.md §5.6` is amended accordingly.

### ADR-039 · Implementation plan corrections
Context (F-D-17): `core/money`/`core/periods` were scheduled after the import phase that needs them; the Claude client after the PDF path; DESIGN.md after three phases of customer-facing UI; the summary sentence before the health breakdown it reads; CD-19 checkpoint inconsistent; some "Verify by" lines unobservable.
Decision: `core/money` and `core/periods` move to Phase 4 slice 0; `ai/data/claude-client.ts` and `extractStatementPage` (mocked SDK) move to Phase 5; DESIGN.md is produced in Phase 0/1 in parallel with identity work; the summary sentence moves to Phase 8; the CD-19 checkpoint is "before Phase 8" everywhere; spike S5 (36-month run in the worker runtime) is added; every "Verify by" names a command, assertion or visual snapshot diff. Phase 3 adds the `api.*` function catalogue and pgTAP per function (ADR-026); Phase 6 adds `app.aggregate_periods` and `metric_current`.

### CD-32 · Home profit lines deviate from a literal SOW §8 reading
**Problem.** SOW §8 lists revenue, gross profit, operating profit and net profit; v1.0 UX showed one profit card with net profit in a tooltip.
**Why it matters.** Acceptance risk and a real reading error (operating profit read as net).
**Recommended decision.** Show Revenue, Gross profit (only when cost-of-sales accounts exist), Profit before interest and tax with net profit as a visible second line, Cash, Owed to you, You owe (ADR-037). **Product owner to confirm** the six-card Level 2 or request all four profit lines as separate cards.
**Impact if ignored.** Either a SOW dispute or a dashboard that misleads on profit.

### CD-33 · VAT and sales-tax treatment
**Problem.** Invoice totals and bank receipts include VAT; ledgers and trial balances are net. Nothing in the SOW says whether MOTION nets down.
**Why it matters.** Revenue, growth and DSO differ by the tax rate depending on source.
**Recommended decision.** ADR-027 §4: net where data allows, `vat_inclusive` warning otherwise, optional net-down using `settings.vat_registered` and `default_vat_rate`. **Product owner to confirm** the default rate per country and whether non-registered businesses are the primary market.
**Impact if ignored.** Month-to-month "growth" of ±20% caused by source switching.

### CD-34 · Worker runtime fallback
**Problem.** Long calculation runs, large commits and purges need a runtime with a multi-minute budget; Vercel routes and Supabase Edge Functions have tight CPU/wall-clock limits.
**Why it matters.** If the ADR-031 SQL-aggregation design plus Edge Function background tasks fail spike S5, the job layer needs a container worker (Fly.io/Railway/Cloud Run) outside the SOW's named stack.
**Recommended decision.** Run S5 before Phase 6. If it fails, add a container worker running the same job handler code, connected with a dedicated Postgres role, under change control (SOW §28). **Product owner to pre-approve** this fallback so it does not block Phase 6.
**Impact if ignored.** Dead `calculation.run` jobs for the largest customers.

### CD-35 · Sending statement text to Anthropic for PDF extraction
**Problem.** The Claude PDF path sends bank-statement page text (account numbers, payees) to a subprocessor; v1.0 security text said documents never leave.
**Why it matters.** DPA accuracy and customer consent (CD-23).
**Recommended decision.** Feature flag `ai_pdf_extraction` per organization (ADR-033), audit `document.sent_to_ai`, consent line in the wizard, subprocessor list updated. **Product owner to decide** whether the flag defaults on or off for new organizations.
**Impact if ignored.** A customer answers its own DPA incorrectly on MOTION's behalf.

---

## Part 5 — Readiness decisions (2026-09-04, after red-team round 1)

The round-1 status was NOT READY for three reasons: unreviewed new mechanisms, open product decisions, and unrun spikes. Part 5 removes the second and third as *architecture* blockers; the first is closed by the round-2 review recorded in `RED_TEAM_REVIEW.md §6`.

### ADR-040 · Open product decisions are adopted as defaults with documented override paths
Context: CD-01, CD-02, CD-03, CD-04, CD-11, CD-16, CD-19, CD-32, CD-33, CD-34, CD-35 each carry a recommendation but no answer. An architecture that cannot be implemented until they are answered is not ready; an architecture that would need rework if they are answered differently is not ready either.
Decision: Each recommendation is **adopted as the default** from today. The product owner may override any of them through change control (SOW §28). The table records, for each, the adopted default, where it is switched, and the rework an override would cause. Every override is additive or a configuration change; none requires a schema or policy rewrite, because the round-1 design placed the seam in advance.

| CD | Adopted default | Override switch | Rework if overridden |
|---|---|---|---|
| CD-01 | The complete SOW file (with Team Management, CRM, Marketing Analysis rows) is authoritative | None needed: all three modules are post-MVP either way | None for MVP |
| CD-02 | Adviser = `platform_employee` assigned per organization | Post-MVP: `organizations.kind = 'adviser'` + `organization_assignments.grantor_organization_id` (ADR-002) | Additive: one migration, no RLS change |
| CD-03 | Accrual P&L when accrual data exists; cash metrics from bank data; fixed precedence `period_balances → ledger → invoices → bank`, basis recorded | `organizations.settings.pnl_precedence` (ordered list) validated against the registry; default = the fixed order | Configuration only; engine reads the list |
| CD-04 | Seeded standard chart; mapping suggested by keyword rules, confirmed by the reviewer; unmapped → `incomplete` | `platform_settings.category_keywords` versioned rule set | Configuration only |
| CD-11 | PDF: deterministic parser first; Claude extraction under `features.ai_pdf_extraction` with `inferred` + `needs_review` rows and the ADR-033 gate; scanned = store only | Feature flag per organization | None: the flag exists |
| CD-16 | Employee = operate, don't govern (imports, review, categorise, AI, actions, reports, documents; no users/settings/billing/audit) | Post-MVP read-only variant = a second platform role value `support` in `platform_users.platform_role` mapped in `role_permissions` to view permissions only | Additive: one enum value, one matrix row |
| CD-19 | Six dimensions with weights 25/25/15/15/10/10 and the `FINANCIAL_ENGINE.md §7` rules, config `health.config.v1` | New config version file; `config_version` stored on every score | Configuration only; old scores keep their version |
| CD-32 | Home Level 2 = Revenue · Gross profit (when COGS accounts exist) · Profit before interest and tax with net profit as a visible second line · Cash · Owed to you · You owe | `platform_settings.home_cards` layout list | Configuration only |
| CD-33 | Invoice revenue net of tax where fields allow; otherwise `vat_inclusive` warning; net-down only when `settings.vat_registered` and `default_vat_rate` are set; default rate GB 20% offered at onboarding | Organization settings | Configuration only |
| CD-34 | Calculation runs are chunked (ADR-041) so they fit the Supabase Edge Function background-task budget; no container worker in MVP | If a measured chunk exceeds budget, halve `CHUNK_PERIODS` (platform setting); container worker remains a change-control option | Configuration first; container only if chunking cannot meet NFR-04 |
| CD-35 | `features.ai_pdf_extraction` defaults **off** for new organizations; enabled per organization after the consent line is accepted by an owner or admin (audited `org.feature_enabled`) | Feature flag | None |

Consequences: Implementation can start on every phase without waiting for answers. `IMPLEMENTATION_PLAN.md §7` checkpoints become "confirm or override the default", not "answer before starting". Each default is repeated in the document that implements it.

### ADR-041 · Calculation runs are chunked by period range and chained, so they fit any runtime
> Refined by ADR-047.7: a single `orgId` idempotency key for continuations, `restart_from` merging, `superseded` runs, boundary assertions, idempotent chunk bodies, per-tick sweeps, pointer restore on failure, `aggregated_at` per chunk, and a CPU-millisecond budget (≤ 1,500 CPU-ms per chunk) alongside the wall-clock budget.
Context (CD-34, F-D-02): The v1.1 design moved L0 aggregation into SQL (`app.aggregate_periods`) but still ran one job for the whole period range, whose duration depended on organization size and the runtime's CPU and wall-clock limits, which spike S5 was to measure.
Decision:
1. A `calculation.run` job processes at most `CHUNK_PERIODS` (default 12) consecutive months per invocation, oldest first, in a loop: load aggregates for the chunk plus the 12 comparison months, compute L0–L7, write snapshots, rewrite `metric_current` for the chunk, then enqueue the next chunk with the same `calculation_run_id` (`payload.cursor = next period_start`). The run row stays `running` across chunks; `calculation_runs.progress = {periods_done, periods_total}` drives the Home banner ("Updating your numbers… 24 of 36 months").
2. Per-chunk work is bounded: at most 12 periods × the dimension count, which for the largest realistic organization (2,000 accounts, 5,000 counterparties) is under 200k aggregate rows per chunk, produced by one SQL call and consumed by pure functions with no per-row I/O. Health scores are computed per period inside the chunk that contains it. `alerts.evaluate` runs once, after the final chunk.
3. Consistency: readers see `metric_current` per period; a period is never half-written because the chunk's snapshot inserts and pointer rewrite are one transaction. Cross-period metrics (variance, trailing averages, opening cash) read the previous chunk's committed snapshots, which is why chunks run oldest first and are never parallel within one run (the per-organization advisory lock is taken per chunk and released between chunks).
4. Staleness: a change committed during a run marks it `stale`; after the final chunk the worker starts a new run from the earliest affected period (ADR-031.1). Stale-run recovery (ADR-031.3) applies per chunk with `budget × 3` measured per chunk.
5. Runtime: MVP job workers are Supabase Edge Functions invoked by `/api/jobs/run` for short jobs and by their own cron for chunked jobs, using `EdgeRuntime.waitUntil` for the chunk body. Spike S5 becomes a Phase 0 verification that one 12-period chunk of the golden-mixed organization completes well inside the budget; it no longer decides the design. Vercel route handlers never run chunks.
Consequences: NFR-04 becomes "each chunk completes in under 60 s; a 36-month run completes in under 5 minutes end to end". No runtime outside the SOW's stack is needed for MVP.

### ADR-042 · Spikes are Phase 0 verifications, not readiness gates
Decision: S1 (RLS/resolver parity), S2 (three real bank-statement PDF layouts), S3 (Claude tool loop with grounding v2 on recorded fixtures), S4 (XLSX 50k-row parse memory) and S5 (one calculation chunk) run in Phase 0 with pass criteria recorded in `IMPLEMENTATION_PLAN.md §3`. Each has a designed fallback that requires no architecture change: S2 → Claude path or CSV; S3 → recorded-fixture evals until live passes; S4 → lower the synchronous row cap; S5 → lower `CHUNK_PERIODS`. Because every fallback is a setting, the architecture's readiness does not depend on the spikes' outcomes.

---

## Part 6 — Red-team round 2 resolutions (2026-09-05)

Round 2 attacked the round-1 fixes only (`RED_TEAM_REVIEW.md §6`). It confirmed that the mechanisms hold in their main lines and found the gaps below, all in how the new mechanisms were bounded rather than in their design. ADR-043 onward resolve them; the affected documents carry "Revision 1.2".

### ADR-043 · Two API schemas: `api` for user-intent mutations, `api_server` for server-asserted facts
Context (R2-A-01, R2-A-02, R2-A-05, R2-A-09): ADR-026 granted every `api.*` function to `authenticated`. Functions whose arguments are *produced by server code after validation* — persisting an AI turn with its grounding status and tool-call log, registering an uploaded document as `ready`, recording read-side audit events, enqueueing server-originated jobs, committing a large batch on behalf of a reviewer — were therefore callable by the browser with the same JWT, so a client could forge a "grounded" AI answer, register an unscanned file, or enqueue a full-range recalculation with a future `as_of`.
Decision:
1. Schema `api` keeps only **user-intent** functions: every argument is something the user legitimately chooses (an id in their organization, a role, a reason, a decision). Actor is `auth.uid()`; `GRANT EXECUTE TO authenticated`.
2. New schema `api_server` holds **server-asserted** functions: `ai_persist_turn`, `register_document`, `record_access_event` (read-side audit: `document.downloaded`, `report.downloaded`, `export.created`, `evidence.viewed`, `org.data_viewed`, `document.quarantined`, `auth.*`, `document.sent_to_ai`), `enqueue_job` for server-originated types (`document.extract`, `import.commit_large`, `alerts.evaluate`, `calculation.run` with `trigger ≠ recalc_manual`, `report.render`), `commit_batch_as(actor, batch)`, `finalize_upload`. They are executable **only by `service_role`** (`REVOKE ALL FROM public, authenticated, anon`). Server code calls them through `src/core/db/server-rpc.ts` — the third and last sanctioned request-path use of the service role (with the Storage signer and job workers), lint-confined to that file — and always passes the human actor explicitly (`actor_user_id`, `request_id`); the function re-validates the actor's role and permission with actor-parameterised helpers `app.org_role_of(actor, org)` / `app.has_permission_of(actor, org, perm)` and re-validates the actor's `aal` from `auth.users` where MFA is required.
3. User-callable `api.enqueue_job(org, job_type, payload)` remains for `calculation.run` with `trigger = recalc_manual` (permission `intelligence.recompute`) and `report.render` (`reports.generate`); payload keys are allow-listed per type; `asOf`, `trigger`, `requested_by` are derived, never accepted; `jobs.requested_by` stores the actor. Job workers call `api_server.*` with `actor = jobs.requested_by` (re-validated to still hold the permission) and never `api.*`; `app.audit()` accepts an explicit actor only when `auth.role() = 'service_role'` and `current_setting('app.current_org')` equals the row's organization.
4. `register_document` generates `id` and `storage_path` (`{org}/{id}/{sanitised filename}`), refuses caller paths, enforces `UNIQUE (storage_bucket, storage_path)`, and verifies the object exists with the declared size; upload order is signer-write → `register_document` → on failure signer-delete of that key only. `delete_document` marks the row `deleted` first (after reference and quarantine checks), then the signer deletes the object; `storage.cleanup_orphans` also removes objects whose row is `deleted`.
5. The Storage signer verifies the audit id it is given: row exists, same actor, same target, `created_at > now() − 30 s`.
Consequences: The browser can only express intent; every fact about what the server observed (grounding, scan results, tool calls, downloads) is written by the server under a principal the browser cannot obtain. `TEST_STRATEGY.md §3` gains "each `api_server.*` function called with a user JWT raises; pgTAP asserts no `EXECUTE` for `authenticated`".

### ADR-044 · Database-side hardening of the write path
Context (R2-A-03, R2-A-04, R2-A-06, R2-A-07, R2-A-08, R2-A-10, R2-A-11, R2-A-12).
Decision:
1. **MFA at the database for every platform user.** `app.is_platform_user()` = active `platform_users` row AND `coalesce(auth.jwt()->>'aal','aal1') = 'aal2'`; both the employee branch of `app.accessible_org_ids()` and the employee case of `app.org_role()` use it. An employee at `aal1` reads nothing and can execute no data function.
2. **Column privileges on raw bank text.** `REVOKE SELECT (description_raw, counterparty_name_raw) ON bank_transactions FROM authenticated`; raw text is readable only through the definer view `bank_transactions_raw` gated by `imports.review`, used by import review and the evidence trace; AI tools and exports use `description_normalized`. The same pattern applies to `counterparties.email`/`notes` for the client role.
3. **Definer hygiene.** All `api.*`, `api_server.*`, `app.*` and trigger functions are owned by `motion_definer` (`NOLOGIN`, `NOBYPASSRLS`), which owns every `public` table; a function sees rows because its owner owns the tables, and every statement inside a function filters by the validated organization (pgTAP greps each function body for `organization_id = v_org` or a documented exemption). `app.has_permission(uuid, text)` is granted to `authenticated` as the fourth RLS helper. Every function wraps its body to re-raise constraint violations as `CONFLICT`/`VALIDATION` with `DETAIL = NULL`. Every record-table mutation (`commit`, `rollback`, `replace`, `supersede_record`, `mark_transfer`, `remap_account`, `merge_counterparties`) takes `pg_advisory_xact_lock(hashtext('org:' || org))`. `app.audit()` derives `ip` from the edge-set first hop, truncates `user_agent` to 256 chars, labels both `caller_supplied`, and takes `request_id` only from `api_server` calls. Step-up re-authentication uses the latest `amr[].timestamp` with method `totp` or `password` within 600 s (Supabase tokens carry `amr`, not `auth_time`).
4. **One suspension semantic.** `app.accessible_org_ids()` includes a suspended organization only for `organizations`, `metric_current`, `health_current`, `health_scores` and `alerts` (the banner and the frozen Home); the T-data policy template adds `and app.org_role(organization_id) <> 'suspended_member'` on every other table. Role checks in policies are **allow-lists** (`in ('owner','admin','employee','super_admin')`), never `<> 'client'`. `EffectiveRole` in `core/permissions` includes `suspended_member` with `ROLE_MATRIX.suspended_member = {dashboard.view}`; TypeScript client-specific branches test `can(ctx, …)`, not `role === 'client'`.
5. **Database-side throttles.** `app.throttle(actor, bucket, limit, window)` over `api_rate_limits (actor_user_id, bucket, window_start, count)` is the first statement of every `api.*` function; buckets: `create_organization` 3/day and ≤ 5 owned organizations on `trial`; `ai_persist_turn` user turns 10/min counted before the org quota (enforced in `api_server` for the server path and by the chat route for users); `register_document` 20/h; `invite_member` 20/h; `enqueue_job` 30/h per type; `accept_invitation` 10/h with `member.invitation_failed` audit; default 120/min per user for everything else. Exceeding raises `QUOTA` (SQLSTATE 53400).
6. **Organization state machine.** `update_organization` for platform staff may patch `plan`, `features`, `kind`, `industry` and `status` only between `active` and `suspended`; `pending_deletion` and `deleted` are set only by `request_deletion` and `org.purge`; `deletion_requested_at`, `slug`, `created_by` are never patchable. `requeue_job` refuses `org.purge` unless `status = 'pending_deletion' AND deletion_requested_at IS NOT NULL`. A `running` job whose `locked_at < now() − max_runtime(job_type) × 3` is reclaimed to `queued` (`attempts + 1`) before claiming; `org.purge` waits only for non-reclaimable running jobs.
7. **Ownership transfer modelled.** New table `ownership_transfers (id, organization_id, initiator_user_id, nominee_user_id, demote_initiator, status {pending, accepted, cancelled, expired}, expires_at DEFAULT now() + 7 days, accepted_at)` with `UNIQUE (organization_id) WHERE status = 'pending'`, RLS T-gov plus nominee-own-row, `audit_diff`. `accept_ownership_transfer` requires `auth.uid() = nominee_user_id`, transfer pending and unexpired, nominee currently an active admin, initiator currently an active owner, under the org lock; `cancel_ownership_transfer` by the initiator or any owner. Session revocation after removal is done by `tenancy.removeMember` in application code after the RPC returns, not in SQL.
8. **Polymorphic guards completed.** `same_org_ref` also covers `import_rows.committed_record_id` (via `committed_table`), `record_status_events.record_id`/`related_record_id` (via `record_table`), `metric_snapshots.dimension_id` and `metric_current.dimension_id` (via `dimension_type`, skipping `none`/`standard_category`), with `alerts.subject_id` skipped for `standard_category`; `jobs` gains `UNIQUE (organization_id, id)` and `report_files.job_id`, `calculation_runs.job_id`, `import_batches.calculation_job_id` become composite; `jobs` and `audit_events` are the only tables exempt from the FK enumeration test, by name.

### ADR-045 · Grounding v3: metric, period, entity and direction binding; response modes; server-owned fields
Context (R2-C-01 to R2-C-08, R2-C-12): grounding v2 bound a number to a path but not to the noun, period word, entity or direction in the sentence; evidence refs were unrelated to the numbers; degraded text leaked through `unsupported`; the claim extractor was unspecified; refusals and clarifications had no admissible form; model-authored labels and notes bypassed everything.
Decision:
1. **Metric binding.** `NumberRef` gains `metric_key` (server-derived from the enclosing row, compared, never trusted). The registry display label for that key (`FINANCIAL_ENGINE.md §3.6`) must appear within six tokens of the number, else unmatched.
2. **Period binding in prose.** Every period-label token in a statement (matched against the canonical label set) must equal `Statement.period` or the comparison period label of the referenced entry; any other → unmatched.
3. **Entity binding.** `NumberRef` gains `entity_id`; the validator checks `entity_id ∈ row_entity_ids(path)` and that the nearest named span (≤ 6 tokens, same clause) resolves to it. Every tool row about an entity carries `subject {type, id, name}` (including `get_metric` with a dimension, `get_cash_analysis` per bank account, alert subjects, health factors) so `row_entity_ids` is never empty. Name matching: NFKC, case-fold, longest match, whole-token boundaries, possessive stripped. Counterparty and account names containing a currency amount or a percentage are rejected at `api.update_counterparty`, `api.merge_counterparties` and import mapping.
4. **Direction binding.** Direction words are allowed only within six tokens of a `NumberRef` whose path is a variance or change field (or whose statement carries such a ref for the same `metric_key`); for those fields the claimed magnitude is compared as an absolute value and the sign is taken from the direction word (required); for level fields the literal sign must match; an unanchored direction word → unmatched.
5. **Evidence derived from numbers.** For each `NumberRef` the server derives the snapshot or record id of its row (or the run id for `meta`-level fields); that id must be present in the statement's `evidence_refs`; the statement kind is recomputed from the assurance of the *derived* items; model-supplied refs are kept only if they pass the same-row test. `buildBundleForAiResponse` builds from derived items first.
6. **Claim grammar (§7.9 of the AI document).** An exhaustive regular grammar defines numeric claims (currency prefix/suffix, thousands and decimal separators, sign, `k`/`m`/`bn` with rounding to the source `display` precision, percentages, `pts`, ranges as two claims), the exempt classes (period labels ∈ `period_context ∪ meta.periods`; dates equal to a returned date field), and the order of operations: entity-name spans are matched first and removed from the scan. Ordinals are words, not claims. Count fields compare at the field's own display precision (so `cash_runway_months` at 1 dp is a count). Invoice numbers and references are matched as returned strings and removed from the scan.
7. **Response modes.** The contract gains `mode ∈ {answer, clarification, refusal, no_data}`; the validator decides admissibility: `clarification` only when `period_context.notes` carries an ambiguity flag; `refusal` only when the text equals a template from the prompt plus grounded facts; `no_data` only when every tool call returned `NO_DATA`/`INSUFFICIENT_DATA` and the direct answer cites the coverage run or period id. In these modes `entity_refs` is empty and the text is digit-free. `grounding_status` follows the mode; a model timeout is `failed`.
8. **Degradation output.** `unsupported` becomes `{topic, reason}[]` where `topic` is server-generated and digit-free (from kind, metric label, entity names) and `reason` is an enum; removed statement text lives only in `grounding_report` (owner/admin and platform review). Recommendations whose refs all belong to removed statements are removed.
9. **Server-owned fields.** `EvidenceRef.label` is removed from the model contract (the server generates labels from the referenced object); `confidence.level` is server-derived (min assurance and completeness over cited items); `data_quality_notes` is an enum of `data_quality.warnings/missing` codes plus period labels, rendered by the server. History replay wraps every string field of replayed assistant JSON in `untrusted()`; `untrusted()` caps each value at 512 characters with a marker and escapes `& < >` as `&amp; &lt; &gt;`. The stale `<transaction_description>` references are replaced by `<data name>`.
10. **Ownership rule everywhere.** The `ai_response` ownership rule applies to any resolution through an item of such a bundle, including tool 13 `{evidence_item_id}` and cloned `action` bundles (`origin_message_id` stored on the clone).

### ADR-046 · Evidence and extraction hardening
Context (R2-C-09, R2-C-10, R2-C-11).
Decision:
1. **Mechanised immutability.** Trigger `append_only_guard` (`BEFORE UPDATE OR DELETE … RAISE 'IMMUTABLE'` unless `current_setting('app.purge', true) = 'on'`, set only inside `org.purge`) on `evidence_bundles`, `evidence_items`, `alert_revisions`, `record_status_events`, `category_history`, `account_category_history`, `metric_snapshots`, `health_scores`; pgTAP tests UPDATE/DELETE as the table owner and the service role. `alerts.evidence_bundle_id` is dropped in favour of `current_revision_id → alert_revisions.evidence_bundle_id`.
2. **Complete change-set and instant.** The run's change-set and `stale` condition include `record_status_events` and `counterparties.merged_into_id` changes after `started_at`; triggers `record_superseded` and `counterparty_merged` are added; `calculation_runs.as_of_ts` records the transaction snapshot time of the aggregation step and the resolver uses it, not `finished_at`. `restored` is written by `rollback_import_batch` when a superseded batch returns; the resolver honours `unsuperseded` and `restored` identically. Descriptor canonical form is RFC 8785 JSON with all id arrays sorted ascending; `descriptor_hash` is hex-encoded in tool outputs and the contract.
3. **PDF gate closed.** AI-read balances are not displayed until the reviewer has typed values, then shown only as "matches"/"differs"; typed values equal to the AI reading keep `IMP-BAL-007` and withhold the page-wide tick. Deterministic balance capture reads only lines outside the transaction grid (no date in the date column), opening = first match, closing = last match, per-page brought/carried-forward lines recorded and checked for continuity; the `IMP-PDF-002` date regex is the §6.4 date-transform set. Every model call, retries included, decrements `ai_extraction_pages_per_day`. `document.extract` is never auto-enqueued: the review screen offers "Read with AI" to `imports.review` after the consent line, matching the `api_server.enqueue_job` path with the reviewer as actor.

### ADR-047 · Engine, import and run corrections from round 2
Context (R2-B-01 to R2-B-12): the round-1 engine fixes held in their main lines but left twelve gaps in how supersession, balance signs, cumulative differencing, credit notes, coverage, chunked runs, scheduled runs, rollback dependencies, historical receivables, alert capping and transfer pairing were bounded. Where an item below conflicts with ADR-027 to ADR-031, ADR-036 or ADR-041, this ADR wins.
Decision:
1. **Supersession column is current state; events are history (R2-B-01).** `api.rollback_import_batch` resets `superseded_by = NULL, superseded_at = NULL` on every restored row (chain re-link re-points the column), writes the `unsuperseded`/`restored` event, and the `superseded_at_set` trigger permits the reset. Engine loaders, `app.aggregate_periods` and the partial unique index keep keying on the column; evidence as-of keys on events. Test: after rolling back B, `aggregate_periods` for the period returns A's rows.
2. **State alerts re-open (R2-B-02).** In `evaluateAlerts`, an existing `resolved` state alert whose condition returns gets a new revision and `status ← open`, `status_reason_code = condition_returned`, `reopened_at = now()` (keeping `first_seen_at`); a `dismissed` alert re-opens when severity increases or when `dismissed_at < now() − 90 days`. `alerts` gains `reopened_at`, `dismissed_at`.
3. **Balance sign transform (R2-B-03).** `transforms.balanceSign ∈ {natural, reporting}`: separate debit/credit columns → natural; a single signed column where Σ(income-mapped rows) > 0 and Σ(expense-mapped rows) > 0 → `reporting`, confirmed at mapping with two sample rows (`IMP-TB-013`); `reporting` negates income/liability/equity lines to natural at commit. `pnl_report`/`balance_sheet` batches capture `period_start` **and** `period_end`; a single value column spanning more than one month is `cumulative` anchored at `period_start`, or refused.
4. **Cumulative differencing pinned (R2-B-04).** `P_prev` = the same account, same `balance_kind`, same `balance_basis`, in the immediately preceding fiscal month; if that month's winning batch of that kind exists but lacks the account → `P_prev = 0` with note `account_absent_prior`; otherwise NULL `no_prior_trial_balance`. Kind precedence within `period_balances` per (P, family): `trial_balance > pnl_report` for P&L, `trial_balance > balance_sheet` for balance families. `fiscal_year_start_month` is frozen on `import_batches` at commit and used for differencing; changing it at organization level is refused while cumulative balances exist unless each affected batch is re-confirmed. Under `movement` basis, balance-sheet categories = prior balance-sheet closing + Σ movements, else NULL `no_opening_balance`. `IMP-GL-011` pattern `/opening balance|brought forward|b\/f\b|b\/d\b|conversion balance|opening balance equity/i`, window = fiscal-year start or export first day ± 1 day, applied per `journal_ref`, promoted to a confirmation when Σ|amount| > 10% of the batch, with `api.set_opening_balance_flag(entry, bool)`.
5. **Credit notes and tax (R2-B-05).** Conversion to `*_credit_note` negates `subtotal`, `tax_amount`, `total_amount` and `amount_paid`; `IMP-INV-011` (error) when `subtotal + tax_amount ≠ total_amount ± 0.01` with both present; `subtotal = 0` with `total_amount > 0` is treated as absent. `receivables = Σ balance_due(sales) − Σ balance_due(sales_credit_note)`, likewise payables. Net-of-tax is per row; the metric carries `vat_inclusive` when ≥ 1 contributing row fell back to `total_amount` and `assurance = estimated` when the fallback share > 10%. `platform_settings.taxable_categories` (default `{revenue, cost_of_sales, operating_expense, marketing}`) is the set the proxy nets down; CD-33 cites it.
6. **Declared export ranges (R2-B-06).** The mapping step captures `period_start`/`period_end` for every batch (detected from min/max dates, statement period or file header; reviewer confirms); coverage uses the declared range; the 3-day heuristic is deleted. Latest data date per source = max declared `period_end`. `is_complete` = P&L source complete AND (cash coverage full OR no active cash-like accounts); partial cash coverage is `data_quality.bank_coverage_partial`, not incompleteness. `core/periods.latestCompletePeriod()` falls back to the latest period with accepted data, flagged `partial`. `bank.unusual_transaction` and `duplicate.transaction` thresholds use the trailing three complete months.
7. **Chunked runs made safe (R2-B-07).** One idempotency key `orgId` for every `calculation.run` job including continuations. A fresh enqueue during a chain merges `payload.restart_from = LEAST(...)` into the queued continuation; that continuation finishes its chunk, marks the run `superseded`, and starts a new run from `restart_from`. Each chunk asserts that `metric_current` for its boundary period points at this run before computing, else exits `superseded`. The chunk body is idempotent: it first deletes this run's snapshots for the chunk's periods. The worker_lost sweep runs on every worker tick and re-enqueues a missing continuation from `progress`. On final failure, `metric_current` for the run's range is restored from `previous_snapshot_id` recorded at each rewrite. Each chunk records `aggregated_at` (its transaction start) into `evidence_query.as_of` and `calculation_runs.chunks[]`; the resolver uses it. Payload shape is `{ orgId, trigger, triggerRefId, periodFrom, periodTo, cursor?, runId?, restart_from? }` with `orgId` mirrored from the `jobs` row (never trusted from payload); route handlers never run chunks; the S5 pass criterion and NFR-04 are stated in CPU-milliseconds for the Edge runtime (≤ 1,500 CPU-ms per chunk) as well as wall-clock.
8. **Scheduled runs are narrow; fingerprint before writes (R2-B-08).** `scheduled` affects the current period only and only registry keys with `as_of_dependent = true` (`receivables_overdue`, `payables_overdue`, `*_days`, `cash_runway_months`, recurring status); the pointer rewrite is limited to that key set. The fingerprint is computed at step 4 from aggregate metadata (max status-event time, row counts, category heads, settings, `as_of`) and compared with the last succeeded run before computing; an equal fingerprint finishes as `succeeded (no_change)`. Retention: unreferenced non-current snapshots are compacted after 90 days, stated identically in ADR-031.5, `DATABASE_ARCHITECTURE.md §6` and `SERVICE_ARCHITECTURE.md §5`.
9. **Rollback promotes dependants (R2-B-09).** Instead of refusing, `api.rollback_import_batch` commits, in the same transaction, every `skip`-decided row in other committed batches whose `duplicate_of_id` targets this batch, from its `mapped_data`, as a record of the dependent batch (`promoted_from_batch_id`, `accepted` event, same assurance), then rejects this batch's records. Replace re-runs dedupe for the new batch against promoted rows so the new rows win and promoted rows are superseded. Refusal remains only when a dependent row lacks `mapped_data` or its batch is already rolled back.
10. **Receivables use the current row (R2-B-10).** The "row current at a historical `asOf`" sentence is withdrawn; receivables at any `asOf` use the current row with the `paid_date`/`amount_paid` time logic (`payment_date_unknown`). `IMP-INV-012`: paid share < 10% and issue-date span > 60 days → the reviewer confirms "This list contains only unpaid invoices"; `import_batches.invoice_list_kind ∈ {full, open_items}`; revenue-family coverage and the `receivables_days` denominator require a `full` batch spanning P.
11. **Alert capping and suppression split (R2-B-11).** `evaluateAlerts` is two-pass: collect all outcomes for all periods, sort by (severity desc, period desc), apply the cap of 25 to *new* rows with `critical` exempt, overflow the rest. `dataSuppressed()` (completeness, `basis_differs`, first-period gate, `MIN_ABS`, `duplicate_reviewed`, incomplete-period rule set) is shared by health K3/B3 and alerts; `userSuppressed()` (dismissal cooldown) applies only when persisting alerts. `detectRecurring` runs inside the calculation chunk before health and before `alerts.evaluate`, with `detector_version` in the fingerprint.
12. **Transfers (R2-B-12).** One enum `transfer_kind {none, cash_transfer, card_repayment, loan_repayment, loan_drawdown, other_transfer}` everywhere. Auto-pairing requires, besides amount/date/account, that one leg's `description_normalized` matches `/transfer|tfr|to savings|from current|own account/` or the other account's name; otherwise `unpaired_transfer_candidate` for reviewer confirmation. Bank-proxy P&L reads all active accounts including liability accounts, excludes `is_transfer` of every kind and `NON_PNL`; P&L descriptors carry `bank_account_ids: [all active]` and `exclude_transfers: 'all'`; when a cash-like account has `credit_card`-category outflows and no card statement covers P → warning `card_spend_unclassified`. Bank identity = `(sort_code_masked, account_number_masked)` with `bank_name` normalised (lower-case; strip `uk`, `plc`, `bank`, `ltd`); `IMP-COV-014` for bank batches compares row hashes with the scope key removed across all accounts.

### ADR-048 · Corrections found while implementing Phase 1
Context: Phase 1 (foundation, authentication, organizations, membership, roles, permissions, tenant context, RLS, server-side authorization, audit) was built against ADR-001 to ADR-047. Building it exercised paths the design had only described, and three of them were wrong in a way no amount of re-reading the documents would have shown. Each correction below was found by a failing test, not by inspection. Where an item conflicts with an earlier ADR, this one wins for Phase 1 tables.

Decision:
1. **The audit log has no foreign keys (found by the organization-deletion test).** `audit_events.organization_id` and `audit_events.actor_user_id` were specified as `uuid REFERENCES … ON DELETE SET NULL`. That is unimplementable next to `append_only_guard`: deleting an organization makes Postgres issue `UPDATE audit_events SET organization_id = NULL`, the guard raises `IMMUTABLE`, and the delete fails — so an organization could never be deleted, and `org.purge` (Phase 4) could never complete. It is also wrong on its own terms: nulling the column erases exactly the link that makes a deleted organization's history auditable. Both columns become plain `uuid` with no reference. The ids remain populated after the referenced row is gone. This is consistent with ADR-038.9 (purge redacts `before`/`after`/`metadata`/`ip`/`user_agent` and keeps the rows) and with ADR-044.8, which already exempts `audit_events` from the composite-FK enumeration by name. Referential tidiness is not a property an audit log should have.
2. **`last_owner_guard` must stand down when the organization is going away.** The guard fired on the `ON DELETE CASCADE` removal of memberships, so "an organization must keep at least one active owner" was enforced against organizations that were ceasing to exist. It now returns early when `current_setting('app.purge') = 'on'` or when the parent `organizations` row is already gone. The rule protects a *living* organization; there is nothing to protect in one being deleted.
3. **`app.audit()` distinguishes three callers, not one.** As written it validated the organization against the caller's accessible set unconditionally, which broke every service-role and `postgres` write (the `audit_diff` trigger runs on admin paths too) and both bootstrap flows, where the actor legitimately is not yet a member of the organization being audited: `api.create_organization` (the owner's membership does not exist until the function returns) and `api.accept_invitation`. The accessible-set check now applies only when `app.role_claim() = 'authenticated'`; a NULL actor is recorded as a genuine system event; and a transaction-local `app.bootstrap` flag, set inside those two functions only, covers the two legitimate exceptions. The check is unchanged for every ordinary user write, which is what F-A-05 was about.

Not changed, and deliberately: MOTION does not read the Supabase `auth` schema at runtime. `postgres` holds `USAGE` on `auth` *without* grant option, so granting it onward silently no-ops (Postgres warns rather than errors), and a security boundary that depends on a grant that did not happen is not a boundary. `app.jwt()`, `app.uid()` and `app.role_claim()` read `current_setting('request.jwt.claims')`; `email_confirmed_at` is mirrored into `profiles` by the auth trigger; `mfa_enrolled_at` is stamped by `api.confirm_mfa_enrolment()`, which requires the caller's own session to already be `aal2`. ADR-044.1 (MFA as a database fact) is unaffected.

### ADR-049 · Corrections and contradictions found while implementing Phase 2 (data architecture)
Context: Phase 2 built the plan's Phase 4 — the financial, banking, import, intelligence, evidence and AI schema, the chart seeding, the `api.*` surface for those tables, `core/money`, `core/periods`, the evidence descriptor resolver and the data-access layer. Building it surfaced three defects and a set of contradictions between documents. Each defect below was found by a failing test, not by inspection. Where an item conflicts with an earlier ADR, this one wins for the Phase 2 tables.

**Defects corrected**

1. **A column cannot be protected by revoking it (ADR-044.2 / R2-A-04 was not enforced as written).** `SECURITY_MODEL.md` and `DATABASE_ARCHITECTURE.md §11` both specify `revoke select (description_raw, counterparty_name_raw) on bank_transactions from authenticated`. That statement runs without error and does nothing, because in Postgres a table-level `GRANT SELECT` confers select on every column and a column-level `REVOKE` cannot subtract from it — the two are additive, not layered. An integration test asserting that an owner is refused `description_raw` found it readable. The only construction that actually withholds a column is to hold **no** table-level grant and enumerate the columns that are readable, which is what the migration now does for `bank_transactions` (minus `description_raw`, `counterparty_name_raw`) and `counterparties` (minus `email`, `notes`). This also makes the tables fail closed: a column added later is unreadable until somebody grants it deliberately. The definer views `bank_transactions_raw` and `counterparties_contact` remain the only way in, each checking its own permission.
2. **Append-only guards blocked the deletion of an organization.** The six append-only tables and the two history tables carry `on delete cascade` to `organizations`, which is the correct lifecycle. The guards refused the cascade, so deleting an organization raised `IMMUTABLE: account_category_history is append-only` and failed. Any organization holding evidence, a metric snapshot or category history — that is, any organization that has been used — could not be deleted, and `org.purge` would have failed exactly as the `audit_events` foreign key would have (ADR-048.1). The rule these guards encode is "a row of a **living** organization is immutable"; they now stand down when the parent organization row is already gone, as `last_owner_guard` does since ADR-048.2. `audit_events` deliberately keeps the strict guard: it has no foreign key and must outlive what it describes.
3. **Partitioning forces two key shapes.** `metric_snapshots` is hash-partitioned by `organization_id` from day one, so Postgres requires the partition key inside the primary key — `(id, organization_id)` — and inside the uniqueness rule of `DATABASE_ARCHITECTURE.md §6`, which becomes `(organization_id, calculation_run_id, period_id, metric_key, dimension_type, dimension_id)`. This does not weaken the rule: `calculation_run_id` is already organization-scoped by its own composite foreign key, so both forms admit exactly the same rows. Separately, `metric_current`'s key is a `UNIQUE INDEX … NULLS NOT DISTINCT` rather than a `PRIMARY KEY`, because a primary key may not contain NULL while `dimension_id` is NULL for the `none` dimension and for the synthetic "Unattributed" row — which is precisely why the specification calls for `NULLS NOT DISTINCT`.

**Contradictions between documents, and how Phase 2 resolved them.** Each is implemented as stated and pinned by a named test, so changing the decision is deliberate rather than accidental. Items marked *needs a product decision* should be settled before the phase that depends on them.

4. **`is_complete` and partial bank coverage.** `FINANCIAL_ENGINE.md §2.2` and ADR-047.6 both give the formula `is_complete = P&L latest data date ≥ period_end AND (bank coverage full OR no active cash-like account)` and then say partial bank coverage is a data-quality warning, "not incompleteness". Both cannot hold: the formula requires `full`. `core/periods` implements the formula, which is the operative rule and is repeated in ADR-030.1 and `DATABASE_ARCHITECTURE.md §2`. The trailing sentence appears to be a mis-worded justification — its own worked example, a GL organization with quarterly statements, is already satisfied, because a quarterly statement's *declared range* spans each of its three months and each is therefore `full`.
5. **The fiscal year has no stated label convention** (*needs a product decision*). CD-09 fixes the start month and says nothing about how the year is named, and `fiscal_periods.fiscal_year` is a single smallint. Phase 2 uses **named by the calendar year it starts in**, so an April-start organization's FY2026 runs April 2026 to March 2027. SQL (`app.fiscal_position`) and TypeScript (`core/periods`) implement it independently and an integration test asserts they agree. The UK convention of naming that year 2027 would change `fiscalYear()`, `app.fiscal_position` and one test block.
6. **The `as_of` descriptor shape is inconsistent within `EVIDENCE_MODEL.md §3`.** The prose requires `{calculation_run_id, aggregated_at}`; the JSON example immediately above shows only `{calculation_run_id}`. `aggregated_at` is mandatory — the resolver cannot perform as-of selection without it — so the example is wrong and is corrected in this revision.
7. **Two spellings of the transfer-exclusion filter** (*needs a product decision, before Phase 6*). `EVIDENCE_MODEL.md §3` defines `exclude_cash_transfers: true` (boolean); ADR-047.12 says P&L descriptors carry `exclude_transfers: 'all'` — a different key and a different type. Phase 2 implements `§3`, so a Phase 6 engine following ADR-047.12 would have its descriptors rejected by the v1 schema.
8. **`promoted` is not a lifecycle event.** `EVIDENCE_MODEL.md §3` lists `promoted` among `record_status_events`; the enum has five values and does not include it, and ADR-047.9 says promotion writes `accepted`. The schema is correct and the resolver follows it.
9. **What `total` sums is unspecified per table.** The resolver returns `ledger_entries.amount`, `bank_transactions.amount`, `period_balances.closing_balance`, `invoices.balance_due` and NULL for `metric_snapshots` (mixed units make a sum meaningless). The invoice choice suits the receivables and payables descriptors, which are the only two v1 invoice filters; a future revenue-from-invoices descriptor would want `total_amount`, so this probably belongs in the descriptor rather than in the resolver. `total` is returned as a string, per ADR-006, resolving the `Decimal | null` in §3.1 against the `string` in §2.3.
10. **`count` and `total` have no aggregate to call** (*needs closing in Phase 6*). §3 requires both over the whole selection, but there is no `api.*` or `app.*` aggregate and PostgREST cannot sum, so the resolver enumerates the selection and caps it at 50,000 rows, raising rather than printing a total that does not reconcile. This should become a database-side aggregate alongside `app.aggregate_periods`.

**Scope deliberately not built, and why.** `api.commit_import_batch`, `api.rollback_import_batch` and `api.replace_import_batch` are not in this phase. `IMPLEMENTATION_PLAN.md` Phase 5 slice 7 assigns their behaviour — commit-time cross-batch duplicate re-check, batch-scoped supersession, promotion of dependants (ADR-047.9), supersession-chain re-linking — to the import engine, and they cannot be written correctly before the dedupe machinery exists. The SQL primitives they will be built from (`app.supersede_row`, `app.record_status_event`, `app.enqueue_recalculation`) are built and tested here, and the batch lifecycle up to `awaiting_review` is complete: a batch can be started, mapped, reviewed, have its statement balances entered and be rejected. It cannot yet be committed. Likewise the bundle *builders* for alerts, health scores and AI answers are declared but not implemented, each naming the phase that owns it.

### ADR-050 · Corrections and contradictions found while implementing Phase 3 (import engine)
Context: Phase 3 built the plan's Phase 5 — file validation, the CSV, XLSX and PDF parsers, column and account mapping, transforms, row and batch validation, duplicate detection, the commit gate, rollback and replace, and traceability. Every defect below was found by a failing test rather than by inspection. Where an item conflicts with an earlier document, this ADR wins for the import pipeline.

**Defects corrected**

1. **The validator crashed on exactly the rows it exists to report.** `parseDecimalOrNull` raises on an unreadable value — correct at a data-access boundary, where rubbish is a bug. Row validation used it directly, so a malformed amount threw instead of attaching `IMP-AMT-002`, abandoning the whole row. Discarding a record because it is malformed is the one outcome this engine must never produce (SOW §23). Validation now reads amounts through a non-throwing wrapper and reports what it cannot parse.
2. **A paired money column was required on every row.** §6.1 gives bank statements the alternative field set `transaction_date, description, money_in, money_out`, and row validation required all four. Every row of a real statement fills exactly one of the pair, so every row failed and no statement in the commonest layout could be imported at all. The requirement is that the COLUMNS are mapped, checked once per batch; the pair is either-or per row. The same applies to a ledger's debit and credit.
3. **A duplicate collision at commit erased the evidence of itself.** §9.3 requires that a colliding commit "returns the batch to `awaiting_review` and re-flags the affected rows". The function raised to abort, which rolled back the whole transaction including the re-flagging, leaving the reviewer a batch that looked untouched and an error they could only retry into. One transaction cannot both abort and leave a trace. The re-check now runs before any record is written and RETURNS `{status:'conflict'}`; the flagging persists, no records exist, and the service turns the result into a `ConflictError` at the boundary.
4. **A coalesced recalculation left the batch unlinked.** `app.enqueue_recalculation` used `on conflict do nothing`, so when a run was already queued it returned NULL and `import_batches.calculation_job_id` stayed empty — the review screen could not say "figures updating" and §11.6 had nothing to store. It now returns the queued job.
5. **`rejected_reason` existed on one record table of four.** §12 says a rolled-back batch's records get `rejected_reason = 'batch rolled back'`, which applies to whichever table the batch targeted; `DATABASE_ARCHITECTURE.md §3` listed the column only under `ledger_entries`, so rollback failed at runtime on the other three. Added to all four and documented. The column matters beyond tidiness: "why is this row not in my figures any more?" must be answerable on the row itself.
6. **`IMP-GL-010` had a tolerance it was never given.** §8.2 states the rule as `Σ debit ≠ Σ credit` with no tolerance, and §17's fixture 2 is a journal off by exactly 0.01 that must be flagged. The check used the 0.01 tolerance that belongs to `IMP-TB-011`, which §8.2 does state as "within 0.01", and so passed the fixture. `NUMERIC` is exact: a journal either balances or it does not.
7. **The filename sanitiser let `..` through**, because a dot is a legal filename character (recorded in ADR-049 for the signer; the same rule is now a single pure module used by both the signer and document validation, rather than two copies).

**Contradictions between documents, and how Phase 3 resolved them.** Each is implemented as stated and pinned by a test. Items marked *needs a product decision* should be settled before the phase that depends on them.

8. **§4's delimiter rule refuses a file §17 requires to work.** `IMP-FILE-006` wants a consistent field count in ≥ 90% of the first 20 lines; §5.1 explicitly supports a preamble above the header. Four title lines in a 20-line window is already 20% inconsistent, so fixture 22 — a file the catalogue says must import — fails §4 read literally. Consistency is now measured over the records at or below the first record with the modal field count, with a modal count of at least two, since a file with no delimiter at all is otherwise perfectly "consistent" at one field per line under every candidate.
9. **§5.1 says over-wide rows are "truncated"; SOW §23 says nothing is discarded.** Short rows are padded with nulls. Over-wide rows are NOT truncated — truncating discards cells the customer uploaded. Mapping is by column index, so the surplus is inert and visible in `raw_data`.
10. **§13's "counting the header as row 1" is unworkable as written**, because preamble rows would need numbers at or below zero and `UNIQUE (batch_id, row_number)` needs real ones. Read as: number by physical source line, which makes the header row 1 in the ordinary case and makes `csv:row:17` open line 17.
11. **The row-count invariant meets RFC 4180.** `count(rows)` equals the count of non-empty source *records*, not physical lines: a quoted newline makes one record from two lines. Recorded in the affected fixture's expectations.
12. **§6.6 and `AI_ARCHITECTURE.md §7.9` disagree about what a figure looks like in a name** (*needs a product decision*). §7.9's currency class, read literally, makes "3M" a currency amount and treats any three capitals before a number as a currency code — yet §6.6 states "3M" must remain allowed. `IMP-NAME-015` now requires a currency mark or money-shaped thousands grouping, and excludes the ISO codes that are ordinary English words. This rule blocks a commit, so a false positive costs a customer their import.
13. **§5.2 asks for a streaming XLSX parser, and streaming cannot see what §5.2 also requires.** The streaming reader in the chosen library never reports merged cells or hidden rows, because both arrive after the sheet data. The full reader is used instead, keeping the normative half of the sentence — cached values only, no formula evaluation — and the merge and hidden-row rules that a streaming pass would silently lose.
14. **A wrapped PDF description is both appended and kept.** §5.3 appends a continuation line to the transaction above it; ADR-033 requires every non-empty line to become a row. Both happen: the text is appended AND the line is kept as its own non-tabular row, so the counts add up and the duplicated text imports nothing.
15. **Fixtures live in `fixtures/imports/`**, per §17. `TEST_STRATEGY.md §5.1` says `test/fixtures/imports/`; §17 is the more specific statement and the one the catalogue is written against.

**Scope deliberately not built.** The AI-assisted PDF path (§5.4) has its schema, its gate and its budget columns in place, and the commit gate already refuses an AI-read batch with an unconfirmed page — but no model is called: `ai/data/claude-client.ts` and `extractStatementPage` belong to the AI phase. The deterministic text-layer parser (§5.3) is complete, and a PDF the deterministic parser cannot read currently stops there rather than offering "Read with AI". The review UI itself (§10) is a later phase; every action it will call exists and is tested.

### ADR-051 · Corrections and contradictions found while implementing Phase 4 (calculation engine)
Context: Phase 4 built the plan's Phase 6 — the L0 SQL aggregation, coverage and precedence, the metric registry, every metric in `FINANCIAL_ENGINE.md` §3, the banking rules of §4, the data-quality model of §5, evidence descriptors, the run algorithm of §2.4 and engine versioning. Every defect below was found by a failing test. Where an item conflicts with an earlier document, this ADR wins for the engine.

**The open question from ADR-049.7 is now resolved (item 1). Two new ones are raised (items 10 and 11).**

**Defects corrected**

1. **`exclude_transfers` is the canonical descriptor filter, resolving ADR-049.7.** `EVIDENCE_MODEL.md §3` had `exclude_cash_transfers: true`, which cash metrics need — a cash-like↔cash-like pair cancels, but a card repayment is a real outflow and must stay (ADR-028). `FINANCIAL_ENGINE.md §4.4` and ADR-047.12 need `exclude_transfers: 'all'` for the bank-basis P&L proxy, where every kind is excluded. Neither spelling covered both, so a proxy descriptor could not be expressed at all. The v1 schema now takes `exclude_transfers: 'all' | 'cash_only'` as the canonical key; `exclude_cash_transfers: true` is retained as the equivalent of `'cash_only'` so descriptors already written stay resolvable — evidence must outlive the schema that produced it.
2. **The aggregate folded transfer legs together, making the right answer unrecoverable.** The first version grouped bank rows without `transfer_kind`, so a cash transfer and a card repayment on the same account in the same category became one cell. The engine could then either exclude both — losing a real £3,000 outflow — or include both — counting an internal move as spending. `transfer_kind` is now a dimension of the aggregate. It costs at most a sixfold increase in bank cells and in practice about double, so the chunk budget is unaffected.
3. **A failed run restored nothing.** `finish_calculation_run` deleted the failed run's pointers and then read `previous_snapshot_id` from the rows it had just deleted. The restore silently put back nothing, leaving the organization with no current pointer for the range — worse than not restoring, because the dashboard would show nothing rather than the previous run's figures. The previous ids are now captured before the delete.
4. **The append-only guard forbade the retry the specification requires.** §2.4 step 3 deletes a run's own snapshots for a chunk before recomputing it, so a worker that died mid-chunk can retry. The guard refused, making retry impossible. The distinction it should draw is between published history and in-flight output: a snapshot of a run that is still `running` is a partial attempt being redone, not a figure anybody has been shown. Once a run finishes — succeeded or failed — its snapshots are immutable forever, which is what makes an answer or a report from last month still resolve to the numbers it saw (§6). No snapshot is ever updatable, in any state.
5. **Money was summed with JavaScript numbers in the composition layer**, caught by the `no-money-parsefloat` lint rule. Now `Decimal` throughout (ADR-006).
6. **The variance suffixes were declared twice**, in the registry and in the variance module, which is exactly the drift the registry exists to prevent. The registry is now the single declaration.

**Contradictions between documents, and how Phase 4 resolved them**

7. **`expense_by_category` includes `other_income`, an income category, under a formula stated as "Σ debit − credit".** Taken literally the dimensioned figure would be the negation of the `other_income` metric. §3's account-type rule, stated as holding throughout, is applied instead, so the two agree.
8. **"Categories with zero rows are not written" versus the explicit zero granted to `other_expense`, `interest_expense` and `tax_expense`.** Read literally, a covered trial balance with no revenue line would make `revenue` NULL and cascade every derived metric to NULL while interest was 0. The not-written rule is read as governing the dimensioned families, where it appears; scalar statement lines are a known 0 when a source covers the period. Cost of sales keeps its own CD-05 exception.
9. **HHI normalisation.** §3.5 asks for "Σ (share_i)² over attributed customers" and for a single customer to give exactly 1.0. Both hold only if the shares are normalised over attributed revenue rather than over total revenue, which is what `customer_revenue_share` measures. The engine normalises over attributed revenue and records `components.normalised_over`.
10. **The missing-reason vocabulary has no code for a negative or non-positive denominator** (*needs a product decision*). `gross_margin` with negative revenue, and `cash_runway_months` when the business is cash-positive, are both genuinely not computable, but §1.5 requires every NULL to carry a reason and the closed list has none that is true. Both currently carry a warning and the nearest missing code. A `negative_denominator` code would let them say what is actually the case.
11. **Two cadences in the banking rules are unreachable as specified** (*worth a look, no figure affected*). §4.3 requires three occurrences inside a trailing 18-month window, but the annual band is 355–375 days, so three annual occurrences span about 24 months and `annual` can never be returned. Separately, `loan_drawdown` is in the transfer enum and in the §4.2 table, but the kind is derived purely from the two account types, which always yields `loan_repayment` for a loan pair; direction would have to enter the derivation. Neither affects a figure — the cash consequence follows the sign of the cash-like leg, not the kind — but both are dead branches in a table that reads as if they are live.
12. **The transfer gate's ranking can pair the wrong row** (*worth a product eye*). ADR-047.12 requires only one leg to read like a transfer, and §4.2 ranks candidates by closest date and then by description similarity. So when the outflow itself says "TRANSFER TO SAVINGS", a same-amount customer receipt on the same day outranks the genuine savings credit two days later, and the receipt is cancelled out of cash. The stated ranking is implemented and the behaviour is pinned by a named test rather than quietly improved; making similarity outrank date proximity when only one leg passed the gate is a one-line change plus a documentation amendment.
13. **`payables_days` has no stated VAT footing.** §3.4 gives the gross-consistency rule for receivables only. No VAT adjustment is applied to payables and the denominator is labelled `expense_categories` in components, so the choice is visible rather than assumed.

**Scope deliberately not built.** The Health Score (§7) and the Alert Engine (§8) are in this document but belong to the plan's Phases 8 and 9. Their versions and the pure-rule seam the engine needs are in place — `HEALTH_CONFIG_VERSION`, `ALERT_RULE_VERSION`, and the registry's `as_of_dependent` flag — but no dimension rule or alert rule is implemented. The engine's own §5 partial-month completeness haircut for flow metrics is likewise not applied, because it needs the per-period day coverage the dashboard phase surfaces. Nothing silently returns a default in their place: what is not computed is not written.

### ADR-052 · Corrections and decisions from Phase 5 (executive dashboard)
Context: Phase 5 built the plan's Phase 7 — the shared component library and its fixture page, Home levels 1 to 4, the Money sub-pages, Customers, the chart-of-accounts page, and Insights. Every figure on every one of those pages is read from `metric_current` joined to `metric_snapshots` and formatted by `core/money`; nothing in the interface computes a financial number, and the `no-arithmetic-in-components` lint rule fails the build if that ever changes.

**Defects corrected**

1. **`metric_current.snapshot_id` had no foreign key.** `DATABASE_ARCHITECTURE.md §6` specifies `snapshot_id → metric_snapshots (org-composite)` and ADR-044.8 requires every tenant-to-tenant reference to be composite, but the column was created unconstrained. Nothing prevented a pointer naming a snapshot belonging to another organisation — on the single reference the whole dashboard reads through, the one that decides which figure a customer sees. It also meant the join could not be resolved at all, so the dashboard could not read a metric and its snapshot in one request. Found by the Home integration test on its first run. The composite key is added, with the unique index the hash-partitioned target needs.
2. **The "Updating your numbers" banner could not be rendered by the reader who needs it.** §7.1 requires the banner to key off a queued or running `calculation.run` job rather than off `calculation_runs.status`, because an orphaned run row would otherwise leave it up forever (F-D-03). But `jobs` is deliberately readable by platform staff only: it carries payloads, worker state and queue depth that are none of a tenant's business. Widening that policy to render a banner would have been a poor trade. `api.is_recalculating(org)` answers the one question the interface needs — a single boolean — and nothing else, which is the §14.3 pattern for a read RLS cannot express.
3. **The bank-only variant fired on a quiet month rather than on the organisation.** ADR-035's variant is for a business that has bank data and no profit-and-loss source at all. The first implementation triggered whenever the selected month had no revenue snapshot, so a business whose March ledger simply had not been uploaded yet would have been told it was a bank-only business and shown three cash cards instead of its ordinary Home with the missing figures dashed. The test is now cash figures present AND no P&L source, which is what the ADR describes.

**Decisions recorded rather than assumed**

4. **`/money` is an index, not a redirect.** `ROUTE_ARCHITECTURE.md` line 33 says the section root redirects to `/money/profit-and-loss`. It renders a short index instead: one line per sub-page carrying that month's headline figure, so a reader chooses where to go knowing what they will find. A redirect hides four of the five sub-pages behind a tab label. This is a deliberate deviation from the route table and is the only one in the phase.
5. **A figure that cannot be computed shows "—" with its reason, in every unit.** §4 states this for money; the same treatment is applied to ratios, days and counts, because "0 days to get paid" and "we cannot work out how long you take to get paid" are entirely different claims and only one of them is true.
6. **The status badge has one implementation.** §8.1's table is cited by `AI_ARCHITECTURE.md §6` and `EVIDENCE_MODEL.md §7` as well, so a second copy anywhere would be a second answer to "how sure are we about this number". `statusFor` is that implementation, and the ordering of its tests is the ordering of the table: a NULL outranks everything, then an AI reading, then an estimate, then incompleteness, then merely calculated. Reordering would let a figure a human has not confirmed be labelled "Calculated".

7. **A dimension that is not a row had nowhere to live (ADR-053).** `metric_snapshots.dimension_type` admits `standard_category`, but `dimension_id` is a `uuid` and a standard category is a name, not a row — which is also why `same_org_ref` skips that discriminator. The schema therefore declared a dimension it had no column for: the engine wrote `dimensionId: 'marketing'` and Postgres rejected it as an invalid uuid. Nothing had written a category-dimensioned snapshot before, so the defect surfaced only when the dashboard needed spending by category, a figure Home level 4 and Insights both rest on. `dimension_key text` now carries the non-row dimensions and joins both uniqueness keys, with a check constraint pinning which of the two columns each dimension type uses. The alternative — pointing `dimension_id` at the organisation's system account for that category — would have silently turned a category breakdown into an account breakdown, and made "spending by category" disagree with "spending by account" for any organisation that also posts to a named account in the same category.

8. **`accounts.normalized_name` and `counterparties.normalized_name` are now derived by trigger.** Both are pure functions of `name`, and both are the column uniqueness depends on: they are what make "Bank  Charges", "bank charges" and "Bank Charges." one account rather than three. Requiring every writer to compute the value is how two writers come to compute it differently, and a divergence there does not fail loudly — it silently splits an account's history in half. The NOT NULL constraint was protecting the right invariant in the wrong place.

9. **The route table would have denied a client the chart of accounts.** `ROUTE_ARCHITECTURE.md` §4 listed `financials.edit` as the permission to VIEW `/data/accounts`, but a client holds `financials.view` and not `financials.edit`, so the page would have 403'd for the role most likely to be looking at how their spending is categorised. `RBAC_MATRIX.md` §2.1 makes `financials.view` the read permission, and §7.4 says an action a role lacks is hidden while the page stays open. The page reads on `financials.view` and hides the re-map control without `financials.edit`; the route table is corrected to match.

10. **§6 specifies empty-state copy for two Money pages and not the other four.** "Owed to you / You owe, no invoices" and "Customers" have exact wording; Profit and loss, Cash, Bank activity and the Money index have none. Short states were written in the same register rather than left blank or filled with a paraphrase of another page's copy, and they should be ratified in the copy audit rather than assumed correct.

11. **There is no per-bank-account balance metric.** The registry has no `bank_account`-dimensioned key, so the Cash and Bank activity pages show the stored opening balance and say plainly that a per-account balance is not calculated, rather than summing transactions in the page to produce one. Summing in the page would put a second definition of a financial figure outside the engine, which is the one thing the interface must never do.

12. **Integration fixtures no longer share a reset.** `resetFixtures()` deletes every `itest-` row on the shared local database, and concurrent test runs destroyed one suite's organisation mid-test three times during this phase. The Money suite now owns a run-unique organisation and email domain and removes exactly those, sweeping anything older than an hour. Suites that share a global reset are suites that fail for reasons unrelated to the code under test.

**Not built in this phase, and not silently defaulted.** The health score card at Home level 1 is a placeholder until the plan's Phase 8, and the top-risks, opportunities and outstanding-actions widgets at level 3 wait on alerts and actions in Phases 9 and 12. The evidence drawer every "Why?" link points at is Phase 10; the links are correct and resolve to a route that does not exist yet, which is visible rather than hidden. Nothing in their place returns a fabricated figure or an empty card pretending to be a real one.

### ADR-054 · Decisions the Health Score specification did not make (Phase 6, plan Phase 8)
Context: `FINANCIAL_ENGINE.md §7` gives every weight, band and threshold, and §8.1/§8.2 give the condition rules health counts. Building them surfaced places where two sentences of the specification are each precise and together underdetermined. Each is recorded here rather than resolved silently in a rule file, because a threshold nobody wrote down is a threshold nobody can approve.

**The thresholds themselves are implemented exactly as §7.3 states them. CD-19 sign-off remains outstanding** — implementing a number and approving it are different acts, and the checkpoint in `IMPLEMENTATION_PLAN.md §7` is a product-owner decision, not an engineering one.

1. **`/home/health` is a page, not a modal.** `UX_ARCHITECTURE.md §5` sketches `HealthScoreCard { … onExplain(): void }`, which reads as an in-place drawer; `ROUTE_ARCHITECTURE.md §4` lists no sub-route under `/home`. The explanation of a score is a thing people forward to their accountant, and a modal cannot be forwarded — so it is a deep-linkable page, following the convention the route table already sets for the evidence drawer ("Evidence drawer as page (deep-linkable)"). This is a deviation from the route table and the second one in the build, after ADR-052.4.

2. **"Completeness < 0.5" is measured per rule.** §8.1 gives the threshold without naming the figure it is measured on. Each rule names the metric it actually depends on: the spike rule reads `operating_expenses`, the three outflow-based bank rules read `cash_outflows`, and the missed-inflow rule reads `cash_inflows`. A single global completeness would silence the inflow rule because the outflow statement was thin, which is a different claim from the one the threshold is making.

3. **The medians read six complete months, not three.** §8.1 says every median-based threshold uses "the trailing three complete months, never the partial current month"; §8.2 gives `bank.unusual_transaction` a six-month window. These constrain different things — WHICH months count, and HOW FAR back — so the median and MAD read six complete months and "monthly outflows", which §8.2 leaves unscoped, reads the trailing three.

4. **A ledger duplicate has no subject.** §8.2 names the subject of `duplicate.transaction` as "`bank_transaction` (or `ledger_entry`)", but the `alert_subject_enum` in `DATABASE_ARCHITECTURE.md §6` has no `ledger_entry` member. A ledger duplicate is therefore recorded with subject `none` and both rows pinned in the outcome, rather than mislabelled as a bank transaction it is not. Widening the enum is a Phase 9 decision, when the alert rows themselves are written.

5. **Volatility is a population coefficient of variation.** §7.3 G2 says "coefficient of variation of `revenue` over trailing 6" without saying which. The six months are the whole of what is being described — the question is how much this business's revenue varied over these six months, not what the variance of some generating process is — so the population standard deviation is used. A non-positive mean yields no coefficient at all rather than a negative one.

6. **"Rising over last 3" is three values in order.** §7.3 B1 says "`closing_cash` rising over last 3 +15; falling all 3 −15". Three values give two comparisons, and that is the reading taken, matching C3's "last 3". A balance that rose, fell and rose again scores nothing either way rather than being forced into a direction.

7. **The score divides by the stored weights, not by 100.** §7.2 says the remaining weights "scale to 100" and §7.4 stores `weight_applied` to one decimal place. Those two cannot both hold exactly: four dimensions at 31.3/31.3/18.8/18.8 sum to 100.2. The overall score is therefore computed from the SAME rounded values the row stores, divided by their own sum — so the reproduction test re-derives the number on the card from the breakdown JSON exactly, rather than within a rounding error. A panel that explains a number to one decimal place away from the number is a panel nobody trusts twice.

8. **B3 is scored only when all five of its rules could run.** §7.3 counts anomalies across five rules and awards +10 for none. If four of them were data-suppressed, "no anomalies found" would be the score rewarding a statement that arrived half empty. B3 is skipped, with the reason shown, unless every rule behind it was evaluated. K3 has one rule and needs no such test.

9. **"Things that need your attention" counts negative factors, not alerts.** The Home summary sentence in `UX_ARCHITECTURE.md §Level 1` ends "and two things need your attention" — written before the alert engine exists. The count is the negative factors this run's score found, which is deterministic and independent of any dismissal. Phase 9 may swap in open alerts; if it does, the sentence gains a dependency on user state and R2-B-11's guarantee must be re-examined for it, because the score's independence from dismissals would not automatically extend to the sentence beside it.

### ADR-055 · Defects corrected in Phase 6 (plan Phase 8)

1. **A failed run destroyed spending by category.** `api_server.finish_calculation_run`'s failed-run restore was last written in migration 35, before `dimension_key` existed (ADR-053, migration 41). It put every category-dimensioned pointer back without one. Because `metric_current_cell_unique` is `NULLS NOT DISTINCT`, all of a period's category pointers collapsed to a single row, and `on conflict do nothing` swallowed the collisions — so after any failed run, `expense_by_category` had no resolvable pointers at all and spending by category silently emptied. Found by writing the health equivalent of the same restore, then proved by running the new regression test against the pre-fix function, which returned nothing where it should have returned three categories.

2. **`health_current` had no way to be restored.** It carried neither `calculation_run_id` nor `previous_health_score_id`, so a run that failed after writing early chunks left an organisation reading METRICS from the last good run and a HEALTH SCORE from the run that failed — the mixed state §2.4 step 12 exists to prevent, and the more misleading half of it, because the score is the headline number. Both columns are added and restored in the same transaction as the metric pointers.

3. **`health_scores` could not be retried.** The plain `append_only_guard` refused a run's attempt to redo its own in-flight chunk, exactly as it once refused `metric_snapshots` (ADR-051.4). `app.health_score_guard` permits DELETE only while the owning run is `running`; UPDATE is never permitted, and a finished run's scores are immutable forever.

4. **A score could have been written for an unfinished month.** ADR-030.4 is a rule about what the engine returns, and nothing in the database enforced it. `api_server.finish_health` now refuses a score offered for a period whose `is_complete` is not true, and writes nothing at all when it refuses. The engine already declines to produce one; the second check is there because a score on a partial month is a wrong number rather than a missing one, and wrong numbers are the failure this whole architecture is built to avoid.

5. **The condition rules arrived early, on purpose.** §8.3 states that the health engine calls "the same functions, behind the same `dataSuppressed()` filter" that the alert job will. Six of the seventeen rules and the shared suppression are therefore built in this phase, in `src/modules/alerts/domain`, with the severity and `threshold_summary` fields Phase 9 needs. Writing a private copy for health and a public one for alerts later would have been two answers to "did marketing spend spike?", and they would have diverged the first time a threshold moved. Nothing in this module reads an `alerts` row or a status — the `RuleContext` type has no field for one — which is what makes the R2-B-11 test (identical scores before and after dismissing every alert) checkable rather than aspirational.

6. **"Parse without throwing" had grown a second private copy.** ADR-050.1 added `readAmount` inside `imports/domain/validate-rows.ts` because `parseDecimalOrNull` returns null for a MISSING value but raises for an UNREADABLE one. The condition rules needed exactly the same distinction, for the same reason at a different scale: an unreadable value must not take down a whole calculation run any more than it may discard an import row. Rather than write a third one, the helper is promoted to `core/money` as `tryParseDecimal`, and both callers use it. Found by a test that fed a rule a value the database's own types would never produce — which is the point of writing that test: the guard has to hold whether or not the impossible happens.

**Not built in this phase, and not silently defaulted.** The other eleven alert rules, alert rows, revisions, dedupe keys, the per-run cap and `userSuppressed` are Phase 9. `runCalculation` still has no job handler wiring it to the queue — it did not have one when Phase 4 left it, and this phase adds the health step to it rather than the worker around it; `healthStep()` exists so that wiring is one line when the handler lands. The evidence bundle of kind `health_score` (`EVIDENCE_MODEL.md §5`) is Phase 10, with the rest of the evidence UI; the breakdown already pins the snapshot ids that bundle will carry.

### ADR-056 · Decisions and defects, Phase 7 (plan Phase 9 — the alert engine)
Context: `FINANCIAL_ENGINE.md §8` specifies seventeen rules, their thresholds, the two-pass algorithm and the lifecycle. Six of the rules and the shared `dataSuppressed` filter arrived in Phase 6, because §8.3 requires the health score to call the same functions (ADR-055.5). This phase adds the other twelve, the copy, the evidence bundles, persistence and the interface. **The §8.2 thresholds are implemented exactly as written and remain CD-18 defaults; approving them is a separate act from implementing them.**

**Decisions the specification did not make**

1. **"Why it matters" did not exist.** `UX_ARCHITECTURE.md §8.3` requires every alert to be rendered in three labelled parts — What happened / Why it matters / What you can do — and §8.2 supplies only the first and third for each rule. The middle part is the one that turns a number into a reason to act, so eighteen sentences were written and are flagged for the copy audit rather than left blank. The stored row holds parts one and three (`explanation`, `recommended_next_step`), because those are what an export or an AI answer quotes; part two is re-rendered from the same stored `threshold_summary`, so it cannot say anything the alert did not record.

2. **A rule that could not run never resolves its alerts.** §8.3 resolves any open alert whose condition did not recur. Taken literally that would resolve a duplicate-payment alert in a month whose bank statement arrived half empty — "we did not look" reading as "it cleared". An alert is left alone when its rule was data-suppressed in every period of the run, the same refusal the health engine's B3 makes (ADR-054.8).

3. **A critical alert does not spend the cap.** §8.1 says "the cap of 25 applies to new rows, `critical` outcomes are exempt from it". Exempt in both directions: a critical row is never withheld, and it does not consume the budget either. Counting it would let three critical cash warnings push three real findings into the overflow summary, which would make the cap decide which serious things to hide. Found by the test for the exemption, which failed at 24 rather than 25.

4. **Recurring evidence is pinned, not described.** §8.2 pins "the group's last 6 transactions", and the v1 descriptor vocabulary has no `recurring_group_ids` filter. Adding one would be a schema decision rather than an alert decision, so the member rows are pinned by id — which also means the evidence shows the payments that made the group a group when the alert was raised, rather than however the detector regroups them later.

5. **The alert subject cannot name a category or a ledger row.** `alert_subject_enum` has no `ledger_entry`, and a `standard_category` subject has no id to put in `subject_id` (ADR-053). A ledger duplicate and a large ledger entry are recorded with subject `none` and their rows pinned; a category spike keeps `subject_type = 'standard_category'` with a NULL id, and the category name lives in the dedupe key and in `threshold_summary`. Widening the enum, or adding a `subject_key` column, is a schema change and belongs with one.

**Defects corrected**

6. **A dismissal with no date silenced an alert for ever, and two functions disagreed about it.** `userSuppressed` treated a missing `dismissed_at` as "not suppressed" while `statusOnRecurrence` left the same row `dismissed`, so the engine would write a revision and then not change the status. Worse, an unreadable timestamp made `daysBetween` return 0, which read as "dismissed a moment ago" and suppressed the alert permanently. Both now ask one function, `dismissalHolds`, which treats a cooldown it cannot establish as one that does not hold.

7. **Two foreign keys could never fire.** `alerts_current_revision_fk` and `alerts_action_fk` are composite keys carrying `organization_id` (ADR-044.8) declared `ON DELETE SET NULL`. Postgres's bare SET NULL nulls every referencing column, `organization_id` included — and that column is NOT NULL — so deleting an `alert_revisions` row while its alert existed raised a not-null violation instead of clearing the pointer. The same defect ADR-048.1 found on `audit_events`, on two more constraints; it surfaced only because this phase is the first thing to delete a revision. Both now use the Postgres 15 column list, `ON DELETE SET NULL (current_revision_id)`, which says what was meant. The organisation-cascade path was never affected, which is why nothing caught it earlier.

8. **`RETURNING id` into an `integer`.** `api_server.persist_alerts` assigned a revision's uuid into the variable holding its revision NUMBER. The insert path would have failed on the very first alert. Caught by inspection before the first test ran, which is the only reason it is a footnote rather than the phase's headline.

9. **The evidence descriptors did not validate.** Three rules wrote descriptors the closed v1 vocabulary does not contain — a `standard_category` filter (which ADR-034 forbids by design, because a category is a mutable property of an account and a stored category filter would make March's evidence follow a July remap), a `recurring_group_ids` filter, and an omitted `as_of`. None would have resolved. Categories are now resolved to concrete account ids at rule time, and every descriptor carries the run and instant it was written against. `parseQueryDescriptor` runs over every pin on the way to the database, so a rule that invents a filter fails at the seam rather than writing evidence nobody can open.

10. **`descriptor_hash` was missing, and the constraint caught it.** `evidence_items_query_needs_hash` requires a hash beside every descriptor — it is what an AI citation is checked against (ADR-032.6). The hash is computed in TypeScript through the one RFC 8785 implementation in `modules/evidence`, never in SQL: a second canonicalisation would eventually disagree with the first, and the disagreement would look like a forged citation.

11. **A partial-permission guard written as a negation.** `canSetAlertStatus` began as `role !== 'client' → true`, which reads correctly and grants `suspended_member` full rights over an alert list. The exact trap ADR-003 and R2-A-07 describe. It is now an allow-list, and the test that found it asserts a suspended member may do nothing.

**Not built in this phase, and not silently defaulted.** The convert-to-action row of `TEST_STRATEGY.md §8` is deferred to Phase 12 with actions themselves, as `IMPLEMENTATION_PLAN.md` Phase 9's exit gate states. `api.create_action` already exists and links `alerts.action_id`; nothing here calls it. The `alerts.evaluate` job type exists in the enum and `evaluateAlerts` is the handler's body, but no worker registers it — `runCalculation` has had no job handler since Phase 4, and wiring the queue is one change that belongs with the worker rather than scattered across two phases. The evidence drawer every "Why?" link points at is Phase 10; the links carry real bundle ids and resolve to a route that does not exist yet, which is visible rather than hidden.

### ADR-057 · Defects found by testing phases 1–7 as a whole
Context: every phase's gates were green, and the system as a whole did nothing. Each layer had been tested against the layer below it as a fixture — the run loop with stubbed dependencies, the health engine over hand-built snapshots, the alert planner over a context assembled in a test — and the seams between them had never been exercised. This audit drove the whole chain through the queue, the way the product does, and found five defects in a row. None was visible from inside a phase.

1. **No job handler was ever registered, so nothing ran.** `registerJobHandler` was exported and never called. `/api/jobs/run` is scheduled every minute by `vercel.json`; every job it claimed found no handler and failed with "No handler is registered". The calculation engine, the health score and the alert engine were all built, tested and unreachable — five phases of work that could not execute. `modules/jobs/handlers` now registers the three types the built phases own (`calculation.run`, `alerts.evaluate`, `import.commit_large`), and the drain route calls the registration explicitly rather than relying on an import side effect a bundler could remove.

   The engine's run loop was also never exported from its own module barrel, which is how it stayed unreachable without anyone noticing: nothing could import it to call it.

2. **The engine could not read its own aggregate, and a failed run could not clean up.** Two SQL-boundary defects that only PostgREST could expose:

   `financial-engine/data/repository.ts` called `rpc('aggregate_periods')`, `rpc('aggregate_transfer_legs')` and `rpc('batch_coverage')` unqualified, which PostgREST resolves against `public`. All three live in `app`, which is deliberately not on the exposed schema list. Every calculation failed on its first chunk with PGRST202. Nothing caught it because every test of the aggregation calls `app.aggregate_periods(...)` through psql, where schema qualification is free. Three `api_server` wrappers now expose them to the service role, which is what the calculation worker holds.

   `finish_calculation_run` cleared its temporary tables with `delete from _restore_pointers;`. PostgREST connects through a role with `pg_safeupdate` armed, which refuses an unqualified DELETE (SQLSTATE 21000) — so the moment a run failed, the function meant to restore its pointers raised instead, and the run was never even marked failed. `truncate` says what was meant and is not subject to the guard. Both defects were invisible to psql, and the restore is the path a test least often reaches.

3. **The health module read four columns that do not exist.** `loadRecurringGroups` selected `group_key`, `signature`, `occurrences` and `last_amount` from `recurring_payment_groups`, which has `counterparty_key`, `occurrence_count` and no last-amount column at all. The table matches `DATABASE_ARCHITECTURE.md §5` exactly; the repository had been written against the domain type instead of the schema, and its tests used fixtures, so nothing compared the two. `counterparty_key` is the signature — the document says so — and the last amount is read from the group's most recent accepted transaction rather than stored a second time and allowed to drift.

4. **The queue rejected the alert pass it was asked to schedule.** The calculation handler enqueued `alerts.evaluate` with a synthetic system actor, and `jobs.requested_by` has a foreign key to `profiles`. `api_server.enqueue_job` already documents the rule — "system job types carry a null actor" — so the actor is now null. Attributing machine work to a person would also have been wrong: nobody asked for the alert pass, and an audit trail that says otherwise stops meaning anything.

5. **Three navigation sections linked to routes that do not exist.** Actions, Reports and Analyst arrive in later phases, and the Data menu offered three import pages that have not been built. A link to a 404 tells a paying customer their product is broken rather than unfinished. The seven items remain declared — they are the `ROUTE_ARCHITECTURE.md §4` contract — and each carries a `built` flag that flips with the phase that builds it. The permission contract is unchanged and still asserted in full by `permittedNavItems`, so no RBAC test weakened.

**What this says about the test suite.** Every one of these defects sat under a green gate. The suites were thorough within each layer and had no test that ran the product end to end, so the seams — a schema qualification, a column name, a foreign key, a registration — were the only places left for defects to live, and all five were there. `pipeline-end-to-end.test.ts` now drives a real month of ledger entries through the queue to figures, a health score and an alert pass, asserting nothing but what a customer would see. It is the test that would have caught all five on the day each was written.

`isolation-cases.test.ts` closes the other gap the audit found: `TEST_STRATEGY.md §4` cases 8, 9, 11, 13 and 15 are named in the phase-3 exit gate and had no test. All five pass — an unassigned employee sees nothing, a revoked assignment stops working on the very next request with no new sign-in, a super admin's look is recorded once and attributed to the platform, an invitation cannot be used twice, and a stranger cannot tell a real organisation from an invented one. No product defect there; the isolation model held.

**Still missing, and not silently defaulted.** The import UI — `IMPLEMENTATION_PLAN.md` Phase 5 slices 1 and 4–7 — was never built: the engine, the upload endpoint and the commit functions all exist and are tested, but there is no `/data/imports/new`, `/data/imports` or `/data/imports/[batchId]`, so the only way data reaches the system today is through the API or SQL. Every empty state's primary action points at that route. This is the largest remaining gap in phases 1–7 and is a phase of work in itself. Playwright is also not installed, so `TEST_STRATEGY.md §12`'s critical journeys and §11's responsive and accessibility passes have no implementation; they are named in the phase 5 and 7 exit gates and in phase 14's.

### ADR-058 · The import UI, and what building it found
Context: ADR-057 closed with the two gaps the audit could name — there was no way to get data into MOTION through the interface, and there were no browser tests. `IMPLEMENTATION_PLAN.md` Phase 5 slices 1 and 4–7 and `TEST_STRATEGY.md` §11–§12 are both now built. The engine underneath had been tested for two phases and was believed finished; driving it from a real upload found nine defects in it, and the browser found four more. That ratio is the finding: an engine tested through its own API is an engine tested through the one caller that already agrees with it.

The wizard is `startImport` — one server call that validates the bytes, parses them, creates the accounts the file names, uploads, starts the batch and validates every row. The screens are `/data/imports/new`, `/data/imports` and `/data/imports/[batchId]`.

1. **A file MOTION could not read left an orphan behind.** The first shape stored the document and started the batch, then parsed. Every unreadable file — a PDF renamed `.csv`, a scan, a corrupt export — left a document and a batch in `created` that would never become rows, in a history a customer reads. Parsing now happens with the bytes still in hand, before anything is stored, so a refusal leaves nothing but the sentence explaining it. The column map and the sign transforms moved to the same side of the upload for the same reason (see 13): anything that can refuse the file must run before the file is kept.

2. **The review screen's "undecided" filter matched nothing.** `import_rows.reviewer_decision` defaults to `'none'`, not `NULL`. The commit gate reads `'none'` as undecided, correctly; the screen filtered on `is null` and therefore showed no rows to skip, while the commit button kept refusing for rows the reviewer could not see. `undecided()` now treats `'none'` and `NULL` alike, in one place both readers share.

3. **A ledger import could not commit, because the accounts it named did not exist.** `ledger_entries.account_id` is NOT NULL and there was no API that created an account from an import. `api.create_import_accounts` adds them under the batch's own status gate. A name gets a category only on an exact or strong keyword match; anything weaker becomes `uncategorised`, which is the honest answer and puts the account at the top of `/data/accounts` asking a human. A guessed category silently changes which metric an account feeds.

4. **The pipeline never derived direction or amount.** `ledger_entries.direction` and `amount` are both NOT NULL, and a GL export writes debit and credit columns instead. `glFromDebitCredit` and `glFromSigned` existed, were tested, and nothing called them. `normaliseMoney` in the pipeline is the caller: debit/credit becomes direction+amount, a single signed column becomes direction+amount under `transforms.glSign`, and an export that already carries both is left alone.

5. **The sign transforms threw on their own error case.** `glFromDebitCredit` returns an `issue` for an unreadable amount and parsed with `parseMoney`, which raises. §5.2 makes every non-empty source line a row — the header line included — so the header reached the transform with the text "Debit" in the debit column and took down the entire import on its first row. The transforms now read cells through `readMoneyCell`, which reports `IMP-AMT-002` instead of raising, and one unreadable line is one held-back row. `bankAmountFromInOut` and `bankAmountFromSigned` carried the identical trap and were fixed with it; `bankAmountFromSigned` returns a `BankAmountResult` now rather than a bare string, because a function that cannot report cannot honour the contract.

6. **A commit queued a recalculation with no periods to recalculate.** The payload carried the batch id and nothing else. `periodsTouchedBy` resolves the batch's declared export range (ADR-047.6 — the declared range, never the last posting date) to fiscal periods, falling back to every period when a batch declares none. The handler also read `payload.trigger_ref_id` where `app.enqueue_recalculation` writes `triggerRefId`.

7. **Every calculation run carrying a reference raised 22004.** `calculation_runs.trigger_ref_id` was registered with `app.same_org_ref('trigger_ref_id', '')` — no table name, so the trigger's `format('%I', NULL)` raised on every run that had one. Re-registered with `trigger` as the discriminator, mapping to `import_batches`, `accounts` and `counterparties`.

8. **The dashboard's first-run gate asked the wrong question.** It tested for metric snapshots, and a calculation run writes snapshots for a period with no records in it — so an organisation that had imported nothing was shown a dashboard of zeroes rather than "add your first data". The gate now asks whether any accepted, unsuperseded record exists in any of the four record tables, which is the question it was always trying to ask.

9. **The trend charts always ended at the latest period.** With more than twelve periods of data, moving the period picker back moved the figures and not the chart. `trailingWindow(periods, endingAt, count)` ends the window at the selected period.

10. **Playwright (`TEST_STRATEGY.md` §11–§12).** Three projects: `setup` signs in once and seeds an organisation with real figures, `journeys` runs the critical paths, `sweep` runs axe-core, the 320–1440px responsive pass and the keyboard pass. Two things had to be got right for the suite to mean anything. The accessibility sweep initially ran signed out, so it audited the sign-in page nine times and passed; it now reuses the setup project's `storageState`. And cleanup was keyed on a shared run tag, so one suite deleted another's organisation mid-run; each suite now deletes only what it seeded, plus a sweep of fixtures older than an hour. `networkidle` never settles against streamed RSC and is not used anywhere.

11. **`--color-ink-faint` failed WCAG AA.** 3.16:1 in light and 4.07:1 in dark, on secondary text throughout the product. Now 5.2:1 and 4.6:1. Found by axe-core on the first sweep, in a token that had been in the design system since Phase 2 and reviewed by eye every phase since.

12. **Profit and loss scrolled 281px sideways at 320px.** `TableWrap` sets `overflow-x: auto`, and an absolutely-positioned `sr-only` caption inside it had no positioned ancestor, so it escaped the scroll container and dragged the page. `relative` on the wrapper is load-bearing, not decoration.

13. **A single signed amount column was read as though the question had been answered.** §6.4: a bank file with one `amount` column is unreadable until somebody says whether payments out are shown as negative, and the answer is saved in `transforms.bankSign`. Nothing set it and nothing read it — the pipeline used the file's own signs, so a credit-card export would have posted every purchase as money coming in. `resolveBankSign` is now consulted from the wizard: card and loan accounts take the documented `positive_out` default and the column is negated; anywhere else the file is refused with a sentence saying why, before anything is stored. Refusing is not the end state — §6.4 puts the question in the mapping step, which is still to build — but refusing is what "do not guess" means here, and the alternative silently inverts a month of cash.

`fixtures/imports/` gains catalogue item 6 in full (`bank_out_in_columns.csv`, `bank_signed.csv`, `bank_positive_out.csv`), each with the expected amounts after transform, so the fixture and the transform cannot drift apart.

**Still missing, and not silently defaulted.** The interactive mapping step (§6.4) is not built: the column map is proposed from the synonym table and a reviewer cannot correct it through the interface, though `startImport` already accepts a corrected map. `detectBalanceSign` and `applyBalanceSign` are written, tested and called by nothing, because the trial-balance and P&L import paths do not yet reach them — those two still parse `parseMoney` directly and would raise on a header row exactly as the bank and GL transforms did, which is safe only for as long as they stay unreachable. PDF statements are refused with an explanation rather than extracted; §10's page-by-page path is Phase 10. Saved mappings (§6.3) are not looked up.

### ADR-059 · The Evidence UI, and the chain that was never written
Context: the evidence *mechanism* has existed since Phase 4 — the descriptor schema, the RFC 8785 hash, the compiler, the as-of resolver, `getBundle`/`resolveItem`/`resolveDerived` — and had a full suite behind it. This phase built the thing that uses it: `EvidenceDrawer` as `/app/[orgSlug]/evidence/[bundleId]`, the "Why?" entry point every figure already linked to, and the document level with its 60-second signed URL. Wiring a reader to the mechanism found that one half of the chain had never been written at all.

1. **Every derived metric's evidence chain was null.** `metric_snapshots.evidence_query` for a derived metric is `{name, snapshot_id}[]` — the component figures it was worked out from (ADR-034). The engine composes that list *while computing*, before any row exists, and `composePeriod` takes a `resolveSnapshotId` for exactly that reason. Nothing ever passed one: `NO_SNAPSHOT` returned `null`, the database generated the ids, and every derived metric this product has produced says it came from revenue and cost of sales and cannot say **which** revenue. `EvidenceQuerySchema` requires a uuid, so the chain did not degrade — it was unreadable, and `resolveDerived` threw on it. Drawer levels 2 and 3 rest entirely on that chain (F-C-15, §9).

   The engine now mints the ids. `composeWithIds` composes the period twice — once to learn which snapshots it produces, which is not knowable in advance because the P&L emits a metric per category present and concentration one per customer, then again with the ids in hand. Composition is pure and deterministic, which the engine's own idempotence tests assert, so the first pass is a description of the shape and the second is the answer; it costs arithmetic over an aggregate already in memory. `api_server.finish_chunk` takes the id and falls back to `gen_random_uuid()` for any caller that does not care.

   This is the ADR-057 pattern again, and worth naming as such: the engine's tests asserted what it *computed*, the evidence module's tests asserted what it could *resolve*, and the value that travelled between them was never asserted by either.

2. **`api.build_metric_bundle` takes its items rather than deriving them.** §8.5 makes bundle writes `api.*` functions, and the safest shape would be a function that reads the snapshot and builds the items itself with no caller input at all. It cannot: a `query` item must carry `descriptor_hash`, which is RFC 8785 canonical JSON + sha256 from the single TypeScript implementation (ADR-046.2), and a second canonicalisation in plpgsql would eventually disagree with the first — two hashes for one descriptor defeats the point of having one. Labels come from the same side for the same reason: the plain-language vocabulary is `UX_ARCHITECTURE.md §8.1` and the metric registry.

   What a caller therefore cannot do is the part that carries the weight. The kind, organization, origin and run are derived from the snapshot; `item_type` is restricted to the metric vocabulary; an empty bundle is refused (§8.6); every `ref_id` still passes `same_org_ref`; and the function returns any existing bundle for that snapshot before writing, so two readers opening one figure at the same instant get one bundle rather than two answers to a question with one answer. Every reference and every descriptor is re-resolved from the referenced objects under the reader's own RLS, so a label is a caption and never a fact.

3. **The signed URL is minted at the click, not at the render.** §9's sketch has `getDocumentReference` returning `signedUrl?`. Doing that would mean minting a 60-second URL while the page rendered: by the time a reader had worked down through level 3 and pressed the button it would be dead, and isolation case 5 — "replayed signed URL after 60 s" — would be describing normal use rather than an attack. Worse, every mint writes a `document.downloaded` audit row, so minting on render would fill the log a customer reads with downloads nobody performed. `getDocumentReference` resolves the reference; `GET /api/documents/[documentId]/url` mints, audit-first, and the signer refuses unless the audit row it is handed is this actor, this target and less than thirty seconds old.

4. **A client is shown the line, not the file — and not the file's name.** §10 stops the client role at level 4, and the first implementation still read `source_documents` to render the filename beside the lock. It does not have to be defended in code: RLS does not expose that table to a client at all, so the read simply failed and the panel 404'd. Naming the file would have meant reaching past the boundary to render a caption. What survives the refusal is the line reference — `csv:row:7`, `pdf:page:3:line:12` — which comes from `import_rows`, which a client may read, and which is what lets them ask an admin for the right thing.

5. **`api_server.throttle`.** `ROUTE_ARCHITECTURE.md §164` puts 60/min on the document URL route. Every `api.*` function throttles through `app.throttle`, whose counter is the `api_rate_limits` table, and a route cannot reach `app` — it is deliberately not an exposed schema. An in-process counter would reset on every deploy and would not be shared between instances, which is exactly what a download limit has to survive.

6. **The canonical §8.1 vocabulary moved to `modules/financials`.** `METRIC_LABELS`, `labelFor` and `BASIS_TEXT` lived in `modules/dashboard`, and the evidence module needs the same table to name an item — ADR-037 says the documents that cite §8.1 "never restate labels", and the same has to be true of the code, or the drawer would eventually call a figure by a name the card does not use. Neither module may depend on the other; `financials` is what both already depend on for financial vocabulary. `dashboard` re-exports, so no existing import changed.

7. **§8.8's eight append-only tables are six plus two, and the difference matters.** Reading the list as eight tables carrying `append_only_guard` is wrong: `category_history` and `account_category_history` carry `history_close_only`, which makes the same promise precisely. A period of validity *ends* by writing `valid_to` on the row that is ending, so a blanket UPDATE ban makes the history unwritable — installing the blunt guard on them broke re-categorising an account, and the existing suite caught it in one run. The trigger permits that one column, once, and refuses everything else including DELETE.

8. **Every 404 in the tenant shell answered 200.** `ROUTE_ARCHITECTURE.md §230` and `TEST_STRATEGY.md §4` case 3 both say 404. Every route under `/app/[orgSlug]` — a bundle that is not yours, an invented alert, a customer id from another organisation, a permission the caller lacks — rendered the uniform not-found page with a **200**. The cause was one file: `[orgSlug]/loading.tsx`. A segment-level `loading.tsx` wraps that segment's page in a Suspense boundary, so Next commits the response before the page runs; a page that then calls `notFound()` can swap the body and not the status. Correct to a reader, wrong to a monitor, a crawler, a link checker and an error budget, none of which read the body.

   The file is gone, and every route in the family answers 404 again. The skeleton it provided was worth 166–300 ms of blocking render on these pages, and the loading vocabulary it used (`Skeleton`, `LoadingCard`) is unchanged and still in use — a page that later becomes slow enough to need one puts `<Suspense>` **inside itself, below its not-found decisions**, where the status has already been settled. Nearly every page here calls `notFound()`, so there is no segment where a `loading.tsx` would be safe, and a filesystem test now says so: `route-contracts.test.ts` fails if one reappears. `evidence-not-found.spec.ts` asserts the status across four id-addressed routes, a foreign organisation and a route with no page at all — the contract had never been checked, which is why it could be untrue for nine phases.

**Still missing when this was written.** The `health_score` bundle, per-block pagination at level 3, and slice 2's own verification were all outstanding; ADR-060 closes them. `buildBundleForAiResponse` and `cloneBundleForAction` remain Phase 11 and Phase 12, so §9's three AI-specific evidence cases (descriptor-hash rejection, ownership through tool 13, derived-evidence-first) still have nothing to run against. The document level shows the reference and opens the file; it does not render the PDF page with the row highlighted — §6's "document viewer" — which needs the PDF extraction path and is deferred with it.

### ADR-060 · Closing Phase 10, and the three things that were never true
Context: ADR-059 shipped the Evidence UI with a short list of things it had not done. Working through that list — and writing the verification `IMPLEMENTATION_PLAN.md` Phase 10 slice 2 actually asks for — found three defects that had been sitting under green gates, one of them since Phase 4. The pattern is the same one ADR-057 named and ADR-059 repeated: **the fixtures had been written around the gaps**, so the tests agreed with themselves and never with production.

1. **Neither history table was ever opened.** `account_category_history` and `category_history` were written only by `remap_account` and `write_category_history`, which close the open interval and open a new one. Nothing opened the *first* one. Both tables were therefore empty until somebody re-categorised something, and after that the only interval on record began at the moment of the change.

   That is exactly the guarantee §8.7 makes and F-C-07 tests. Resolving a descriptor as of a run *before* the change finds no interval covering that instant: for an account `valueInForceAt` returns null and the evidence shows no category at all; for a bank row the resolver falls back to the row's **current** category, so an old bundle reports the new categorisation as though it had always been so — worse than showing nothing, because it is confidently wrong. "What was this when you told me the figure" was unrecoverable, which is the one question these tables exist to answer.

   Two fixtures — one pgTAP, one integration — hand-wrote the opening row, which is precisely how the gap stayed invisible for six phases: they seeded what production never did, and then asserted on it. `open_category_history` on `accounts` and on `bank_transactions` now opens the interval, existing rows are backfilled from `created_at`, and both fixtures were deleted rather than adjusted — the trigger is the fixture now, which is stronger, because it is the production path.

2. **`record_access_event` never checked its target belonged to its organisation.** `DATABASE_ARCHITECTURE.md §14.2` states the rule as "`document.downloaded` → `documents.view` **and document in org**". Only the permission half existed. Owner A, who legitimately holds `documents.view` in A, could write an audit row naming a document of B — and ADR-043.5's whole design is that the audit row is the *input* the signer verifies before it mints, so the row is a security artefact and not a record. Proven against the unfixed function, which returned audit id 177 for another organisation's document. The document route resolves by `(organization_id, id)` first and so could not produce such a row; a guarantee that holds only because today's callers happen to be careful is not a guarantee.

3. **The most prominent number in the product had no evidence behind it.** §5 gives a health score a `health_score` bundle per score row — a `metric_snapshot` item for every metric in `breakdown[].metrics`, plus the `calculation_run`. Phase 8 built the score and the explainability panel and never built the bundle. The panel prints its arithmetic, which answers "how was this worked out"; it could not answer "and which figures were those", which is what somebody disputing a score actually asks. `api_server.finish_health` now writes the bundle inside the same transaction as the score, items supplied by the caller for the reason ADR-059.2 gives.

**Two defects in the drawer itself**, both in the same blind spot — every suite exercised only the bundles `buildBundleForMetric` writes, and the drawer is the one reader for every producer:

4. **Pinned records were computed and dropped.** `loadEvidenceDrawer` built `view.pinned`; the page never rendered it. An alert's "Why?" already routed there, so opening a duplicate-transaction or unusual-payment alert silently lost the rows it was about. §4 separates pinned items from descriptors precisely because "the reader must see *that* row even if data later changes", and §8.3 keeps them unfiltered by status — a replaced or rejected row is *why* the claim was made, so it is badged, not hidden.

5. **Level 2 invented components.** It treated every `metric_snapshot` item after the first as a part of the arithmetic, so an alert's comparison month read as though last month's revenue were part of this month's sum. Only `evidence_query.components` knows what a figure was worked out from (ADR-034); everything else a bundle cites is a related figure and now says so under its own heading.

**Also closed.** Level 3 pages per block: a cursor names the block it belongs to, because a derived metric has one selection per leaf and a single cursor applied to all of them would silently skip rows in the ones it was not meant for. `count` and `total` stay whole-selection, which is what lets a truncated list reconcile. And `test/integration/setup.ts` joins the service-role allow-list: the rule protects request paths and browser bundles, the harness already holds `SUPABASE_JWT_SECRET` for the same reason, and object storage is the one thing `adminSql` cannot reach — so §4 case 5 had nowhere else to stand.

**What Phase 10 now covers.** `TEST_STRATEGY.md §9` is green except for the four cases that need the AI Analyst: descriptor-hash rejection by the AI builder, ownership through tool 13, derived-evidence-first, and chain completeness over the eval set. F-C-07 is covered in full — remap, bank recategorisation, supersession and rollback each leave a published selection returning the same rows and the same total to the cent. §4 cases 3, 4 and 5 pass, and a download writes exactly one audit row the organisation's owner can read.

### ADR-061 · The Action Centre, and two flakes it uncovered
Context: SOW §17's Action Centre is the one place in MOTION where a person records a **decision** rather than a fact. Everything else — a figure, an alert, a health score — is the product saying what is true; an action is somebody saying what they will do about it, with their name and a date on it. The schema and four `api.*` functions have existed since Phase 4; this phase built the services, the pages and the two source paths.

1. **Evidence is copied into an action, never referenced.** `EVIDENCE_MODEL.md §5`'s action row says the source's bundle items are *copied*, and `api.create_action` never did it — it recorded `source_id` and left `evidence_bundle_id` null. An alert is re-evaluated whenever the figures move (ADR-034), so an action created from one in March would silently start showing June's numbers. "Why did we do this?" is the question an action list exists to answer, and it has to stay answerable after the reason has changed. `app.clone_bundle_for_action` copies the items into a new `action` bundle; `api.create_action_from_alert` pins the current revision and links `alerts.action_id` back, so the interface offers the button once rather than inviting two people to do the same work.

2. **`evidence_bundles.origin_message_id` did not exist.** §8.9 makes the ownership rule follow a clone — "an `action` bundle cloned from [an `ai_response` one] (`origin_message_id` set) requires the origin message's owner or an organization owner/admin (R2-C-12)" — and the column the rule names was never created, so a clone of an AI answer's evidence lost the one fact that decides who may read it.

3. **Two update paths, not one with a role branch.** `api.update_action` asks "may you edit actions here"; `api.update_own_action` asks "is this one yours" and limits the columns to the two §17 lets an assignee move. A client may say what happened; they may not rewrite what they were asked to do, because those are the terms of the assignment. Collapsing them into one function that branches on a role is precisely how a client ends up able to change a due date (ADR-003: code asks for a permission, never for a role name).

4. **A name is not a fact everybody may learn.** `profiles` is own-row-only under RLS, so an owner embedding it sees their own name and `null` against every colleague's action. Names come from `api.org_members`, which needs `users.view` — an owner has it, a client does not. A client who could read the staff list off an action list would have been handed the team page sideways, so they see "you" against their own work and "someone here" against everybody else's, which is all the list needs to say.

**Two flakes, both mine, both worth naming.** Neither was in the product, and both were the same mistake in different clothes: a test that bet on a shared resource.

- **A fixed `drainJobs(n)` is a bet that no other suite left work in the queue.** When the bet lost, `pipeline-end-to-end` failed on an empty `metric_current` — a broken-looking engine that was a broken fixture. Suites that depend on their own job now wait on that job's row (`drainUntilFinished`), and the Playwright helper drains until the organisation has nothing queued. This had been latent since Phase 6 and surfaced when this phase added a fifth suite to the queue.
- **A fixture account changed the figures the evidence suite asserts.** Adding a customer-owned account to the shared fixture — so F-C-07's remap case had something a customer may really remap — put it in front of the engine, whose treatment of an uncategorised account moved revenue between £20,000 and £25,000 run to run. The account is now seeded inside the case that needs it, *after* the calculation, and the headline assertions were rewritten to check the INVARIANT — the rows behind a figure total that figure — rather than a literal £25,000. That is what the suite is for; pinning the number made it a test of the engine's mapping rules as well.

  The nondeterminism itself is real and is **not** explained here: the same four entries produced `cost_of_sales` as a leaf descriptor in some runs and a derived one in others. It is recorded rather than diagnosed, because it belongs to the calculation engine and not to this phase.

**Still missing, and not silently defaulted.** `api.create_action_from_recommendation` is built and tested against a hand-written `ai_messages` row, because Phase 11's analyst does not yet write one; the gate it exists for — an action may be created from an AI answer only when that answer **passed** grounding (ADR-032.5) — is asserted for `passed`, `degraded` and `failed`. Journey 3's "create action from a recommendation" step therefore has nothing to drive it yet. Health-dimension actions (`source_type = 'health_score'`) have a path through `api.create_action` but no button. There is no comments thread, by CD-26.

### ADR-062 · The Monthly Management Report
Context: ADR-024 puts exactly one report in the MVP, "rendered from current metric snapshots, alerts and actions as a printable page and PDF via the job queue". The interesting constraint is not the rendering — it is that `ARCHITECTURE.md` risk 7 names **metric drift**, "the same metric computed differently in two places (UI, report, AI)", and the report is where that risk does the most damage. It is the artefact somebody prints and takes to a meeting; a report that disagreed with the screen would not be caught by anybody until it had already been believed.

1. **One card builder, two readers.** The headline cards §4 fixes — which metrics, in what order, whether gross profit is shown at all (CD-05), which month the change compares against, the bank-only variant (ADR-035) — were a hundred lines inside `loadHome`. A report that re-implemented any of those rules would be drift arriving by the back door, so they were extracted to `buildHeadlineCards` and Home and the report both call it. The exit-gate test compares whole CARDS rather than figures: the label, the badge, the change line and the secondary line are all things a reader takes from the page, and any one of them differing between screen and print is the same defect.

2. **The path is derived, the file id is not.** `api_server.record_report_file` takes a file id and never a path. The job has to write the object *before* the row exists (ADR-043.4), so it has to know the id first — but the path is composed here as `{org}/{period}/{id}.pdf`, so a caller cannot point a download at another organisation's object, which is the lesson `register_document` already carries (R2-A-09). Object first, row second: a crash between them leaves an orphan object that `storage.cleanup_orphans` removes, where the reverse would leave a download the product offers and Storage cannot serve.

3. **Producing and opening are two steps.** Producing is queued work. Opening mints a 60-second signed URL at the click, audit-first, for the reason ADR-059.3 gives: a URL minted while the page rendered would be dead before anybody pressed anything, and every mint writes a `report.downloaded` row that would then record a download nobody performed.

4. **`pdf-lib`, not a headless browser.** A browser would give richer layout and would also mean shipping Chromium into the job runtime for one A4 page of figures the product already formats. The PDF is a record of numbers, not a second design system.

5. **Complete months only** (§4.14, ADR-030.4). A management report for a month that has not finished is a set of figures that will change after somebody has acted on them, so the list does not offer one rather than offering it with a caveat nobody reads.

**A test whose premise a later phase deleted.** `jobs-worker.test.ts` proved that an unregistered job type fails loudly rather than quietly succeeding, and it used `report.render` as its example — which stopped being an example the moment this phase registered a handler for it. The case now names `ai.eval`, which is genuinely unbuilt. Worth recording because the failure mode is silent: a test that names a specific unbuilt thing stops checking anything the day that thing is built, and only fails if it happens to assert on the difference.

**Still missing, and not silently defaulted.** The report renders the headline figures, the health score, open alerts and open actions; it does not yet carry the evidence bundle §5 gives a `report` bundle kind, so a figure in the PDF cannot be opened back to its rows the way one on screen can. `report_files.evidence_bundle_id` exists and is null. Exports (`/api/exports/[kind]`, `export.created`) are named in §4.14 and are not built. `storage.cleanup_orphans` had no handler when this was written, so an orphan object from a crashed render was not swept; ADR-064 builds it.

### ADR-063 · The calculation engine was comparing two clocks
Context: `evidence-drawer.test.ts` failed intermittently on `cost_of_sales descends straight to records: expected false to be true`, and in the same runs `revenue` read £20,000 instead of £25,000. ADR-061 recorded it as nondeterminism worth chasing and left it. It is not a test problem. It is a **wrong-figures defect in the calculation engine**, and it was live.

**The defect.** `app.aggregate_periods` selects rows with `created_at <= p_aggregated_at`, and `created_at` is stamped by Postgres. The run loop pinned that cutoff with the *worker's* `new Date().toISOString()`. That makes the aggregate's central predicate a comparison between two clocks: whenever the database's runs ahead — it does, by tens of milliseconds, on any host running Postgres in a container, and it drifts — rows committed **before the run was even queued** fall the wrong side of the cutoff and the run computes without them.

Nothing raises. The figures are simply a period short of some of its entries, and the shortfall is published as a number. Downstream everything follows deterministically from the lost rows: `revenue` comes out low, and `hasUsableCostOfSalesAccount` sees no rows on the system cost-of-sales account, so §3.1/CD-05 makes the figure *unknown* — `evidence_query = null`, which is why the component stopped being a leaf. Skew measured on the development machine: the database ahead by ≥45 ms, then ≥96 ms seven minutes later.

**This was always a contract violation, not a judgement call.** `FINANCIAL_ENGINE.md §2.4` step 4 reads `aggregated_at = transaction_timestamp()` — a *database* function. The engine had been reading a different clock than the specification named since Phase 6. `api_server.aggregation_instant()` is the surface that makes step 4 implementable from a worker that reaches Postgres over PostgREST.

**Per chunk, not per run.** The investigation proposed one instant for the whole run, on the reasoning that a row committed mid-run would otherwise land in the later chunks and not the earlier ones. That reasoning is sound in isolation and contradicts two locked documents: ADR-047.7 fixes `aggregated_at` as "the transaction timestamp of the **chunk** that produced the snapshot … because a run spans several chunks", and `EVIDENCE_MODEL.md §11` names a test case that requires exactly the behaviour the change would have removed — a run whose middle chunk aggregates after a supersession must resolve chunk-1 descriptors to the pre-supersession rows and chunk-2's to the post-supersession rows. One instant per run makes that unrepresentable. The clock was the defect; the scope was not.

**Also cleared, by test rather than by reading.** ADR-059's `composeWithIds` composes each period twice to mint snapshot ids before insert, which was the obvious suspect. It is not the cause: the second pass differs from the first only in the ids `resolveSnapshotId` can return, and that resolver is consumed nowhere but `derivedEvidence`. `test/unit/engine-determinism.test.ts` pins that, along with byte-identical output over repeated composition and over reversed cell order.

**Three more, found alongside it and since fixed.** `composeWithIds` keyed its id map on `key::dimensionId::dimensionKey` and looked it up with `dimensionKey = null`; latent today because no derived metric names a dimensioned component, and exactly the class of bug ADR-059 exists to end the moment one does — the resolver now carries `dimensionKey` end to end, so the two halves of the identity cannot drift. `alerts.evaluate` pinned at `finished_at ?? started_at` while the engine and its health step pin per chunk, so an alert could see a row the score did not; it now reads the EARLIEST chunk instant off `calculation_runs.chunks`, which is the only pin every metric in the run was certainly computed at or after, and `FINANCIAL_ENGINE.md §8.3`'s promise that the two see the same rows holds again. And `hasUsableCostOfSalesAccount` asked a per-period question of an organisation-level fact: a genuinely quiet month on a cost-of-sales account read as "this organisation does not track cost of sales", which is not CD-05's intent and is a claim about somebody's business made from an accident of timing. The run now resolves `costOfSalesEverUsed` once per run, from the organisation's accounts and its accepted, non-superseded rows, and passes it down the context; a period with no cost-of-sales rows is zero, and only an organisation that has never used one has no figure at all. `test/unit/engine-determinism.test.ts` pins both halves.

### ADR-064 · `storage.cleanup_orphans`
Context: two places in the codebase promised this job existed. `api.delete_document` marks a row deleted and has the signer remove the object, and its comment says the sweep finishes the job if that removal fails (ADR-043.4); ADR-062.2 says the report renderer's object-first ordering is safe because an orphan from a crashed render gets swept. Neither was true — the job type was in the enum with no handler, so every one of them failed with "No handler is registered".

It is the only job in the product that **deletes customer files**, so it is built to be wrong in the safe direction. Four independent conditions must all hold before an object goes, and any one failing spares it:

1. **Age.** Nothing younger than 24 hours, taken from `SERVICE_ARCHITECTURE.md §7`'s own figure rather than invented. The window it must cover is the gap between the object write and the row write — inside one request for an upload, inside one job attempt for a render — and it survives the case that actually bites: a worker dying between the two writes and being reclaimed after `max_runtime × 3` (ADR-044.6), whose first object must not be collected while the retry is still queued. An object with no readable timestamp is treated as written *now*.
2. **A complete read of what is claimed.** The claimed set is keyset-paginated on `storage_path` — not `offset`, which would skip a row inserted mid-sweep — and a query error **throws** rather than becoming `data ?? []`. That one swallowed error would read as "this organisation owns nothing", which is the whole catastrophe; it is the single place in the file that refuses the codebase's usual defaulting.
3. **The organisation prefix.** Enumeration and removal both take the organisation explicitly and run every key through the signer's existing `assertKeyBelongsTo` — including keys Storage itself returned, because a bug in Storage must not become a deleted file. The one call with no organisation lists **folder names only**, never a key and never bytes, and only those that parse as a UUID; anything else is reported and never swept, because deleting it would require a removal with no tenant context.
4. **A blast-radius cap.** 1,000 removals per run. The sweep stops, reports `capped`, and the rest waits for tomorrow.

**The trap worth naming.** `TENANCY_MODEL.md §8` puts the extracted-text sidecar under the document's own prefix with no row of its own. Sweeping on `storage_path` alone would have deleted the extracted text out from under a perfectly live document. It is claimed through `source_documents.extracted_text_path`, and the handler records the invariant a future `document.extract` must keep: anything written under a document's prefix must be named by a column of that document's row.

`api_server.record_storage_cleanup` writes `storage.orphans_removed` with counts and no paths — object keys carry uploader filenames, and ADR-038.9 keeps audit metadata to ids. Removed keys go to the log, which is where "which file went?" is answerable.

**Was still missing, now scheduled (ADR-074).** Nothing enqueued this job until `/api/jobs/nightly` and `api_server.enqueue_nightly_sweep` existed; `api_rate_limits` retention — this job's responsibility per `DATABASE_ARCHITECTURE.md` §7 — rides with the platform-wide run.

### ADR-065 · RLS role checks are set membership, evaluated once
Context: `PRODUCTION_AUDIT.md` C1. Every tenant-data SELECT policy was `organization_id in (select app.accessible_org_ids()) and app.org_role(organization_id) in (...)`. The first predicate is hashed and runs once; the second takes a column, so Postgres re-executes it — `accessible_org_roles()`, a three-way union over four tables, inside a `SECURITY DEFINER` call — for every candidate row. Measured on a 50,000-row ledger read by the organisation's own owner through a real `authenticated` JWT: **22,724 ms**, ~18 buffer hits per row, all inside the policy. Every page under `/app/[orgSlug]` reads under these policies; the engine does not (it reads through `api_server.*`), so the dashboard would be the thing that timed out, not the calculation.

Decision: a role check is a fact about the organisation, not the row, and is written that way. Two helpers, beside the four that exist (`TENANCY_MODEL.md` §4): `app.org_ids_with_role(variadic text[])` → the organisation ids in which the caller's effective role is one of the given roles; `app.org_ids_with_permission(text)` → those in which that role holds the permission. Every policy becomes `organization_id in (select app.org_ids_with_role(...))` or `(... org_ids_with_permission(...))` — the shape the first predicate already had, hashed, one execution of `accessible_org_roles()` per statement. Migration `20260908000001` drops and recreates 25 policies with the **same allow-list each had**, role for role; the 122 assertions of `06_financial_rls` that prove those allow-lists (including the `suspended_member` exclusions, R2-A-07) pass unchanged, which is the proof that only the shape moved. The same read afterwards: **12 ms**.

Guarded twice, because a policy written the old way would pass every semantic test and fail only in production: the migration refuses to complete if any policy on a `public` table still matches `app.(org_role|has_permission)\(organization_id`, and `06_financial_rls` asserts the same plus the actual plan an owner's ledger read gets (no per-row helper; a `hashed SubPlan`). `app.org_role(uuid)` and `app.has_permission(uuid, text)` remain for `api.*` function bodies, where they are called once with a scalar.

Not changed: the five frozen-Home policies (never carried a role check); `evidence_bundles`' per-row `exists` on `ai_messages`, which is a row-level fact (whose conversation) and legitimately per row; the suspended-organisation defect in H1, which is about which tables admit `suspended_member`, not how.

### ADR-066 · A metric bundle is built by the server, from the figure's own tree
Context: `PRODUCTION_AUDIT.md` C2. `api.build_metric_bundle(snapshot, items)` was granted to `authenticated` and, per ADR-059.2, took its items from the caller because the descriptor hash and the labels have one implementation and it is TypeScript. It validated `item_type` and nothing else. Executed in the audit with a client's token: a `query` item labelled "FABRICATED BY CLIENT", carrying hostile claim text and a payroll descriptor, became *the* bundle for the owner's revenue figure — attributed to the system, immutable, returned to every later reader, unaudited. The drawer would have resolved payroll rows as the evidence behind revenue and printed a reconciliation sentence saying the figure had no support.

Decision: ADR-059.2's reason stands (the items still come from TypeScript), but the caller is the server and the items are verified. `api_server.build_metric_bundle_as(actor, snapshot, items)` — service-role guard, actor re-validated with `app.has_permission_of(actor, org, 'financials.view')`, `NOT_FOUND` otherwise (SECURITY_MODEL.md §14) — walks the snapshot's `evidence_query` tree itself in SQL (bounded, cycle-checked) and refuses any item that is not derivable from it: a `metric_snapshot` item must name the root or a reachable component; a `calculation_run` item the snapshot's run; a `counterparty`/`account` item the snapshot's dimension; a `query` item's descriptor must equal a leaf of the tree (`order` stripped and an absent `filters` read as `{}`, which is exactly and only how the TypeScript schema's parse of a stored descriptor differs from the stored form); and no item may carry `claim` text — a metric bundle holds figures, not sentences. It serialises on the snapshot, returns an existing bundle before writing, and audits `evidence.bundle_built` with the actor. `evidence_bundles_metric_origin_unique` makes one bundle per snapshot a constraint; the old comment about the loser of a race "discarding its own" described no mechanism. `api.build_metric_bundle` is **dropped** — a function that exists with no grant is a function somebody will one day grant back. `buildBundleForMetric` is unchanged for its callers and now writes through `core/db/server-rpc.ts`, the one file allowed to name `api_server.*`.

Defence in depth on the read side: `evidence/services/bundle.ts` now compares every stored `descriptor_hash` with the hash of the stored descriptor and refuses a mismatch as an integrity failure. The earlier comment there argued against re-hashing because it "would hide drift"; comparing is the opposite — it makes drift loud.

Consequence for ADR-059.2: its statement "§8.5 makes bundle writes `api.*` functions" no longer holds for metric bundles, and should not: every other bundle kind is already written by a job or by `api_server` (`DATABASE_ARCHITECTURE.md` §7 evidence_bundles "Writes"). A bundle is a system statement about evidence; the user's click is the trigger, not the author.

### ADR-067 · The purge, and where a dead job is seen
Context: `PRODUCTION_AUDIT.md` C3. `api.request_deletion` set `pending_deletion`, `enqueue_purge_on_deletion` queued `org.purge` thirty days out, `claim_job` let it through for the closing organisation — and the worker, finding no handler, failed it three times and marked it `dead`. `TENANCY_MODEL.md` §2 promised objects removed, rows hard-deleted, audit redacted. None of it happened, and no page listed dead jobs.

Decision, in two halves and one order. **Rows first, in one transaction:** `api_server.purge_organization(org, job)` takes the org lock, re-verifies the two facts the trigger relied on thirty days earlier — still `pending_deletion`, requested ≥ 30 days ago — and refuses with `CONFLICT` otherwise (a reactivated, cancelled or hand-requeued organisation is never purged); returns `waiting` while any other job of the organisation is `running` (the handler defers rather than fails); then with `app.purge = 'on'` deletes every tenant table in FK order, refuses to finish if any base table carrying `organization_id` still holds a row (so a table added later fails the purge loudly rather than leaving data), deletes the organisation's other jobs, marks the organisation `deleted` (the row survives, per §2), nulls `profiles.last_active_org_id`, redacts `before/after/metadata/ip/user_agent` on every audit event of the organisation (ADR-038.9), and writes `org.purged` last with counts and nothing else. Idempotent: `deleted` → `already_deleted`. **Objects second:** the handler removes `source-documents/{org}/` and `reports/{org}/` through the signer's per-organisation surface, which asserts the prefix on every key. Rows before objects because a cancellation between the two steps must find an organisation whose files are still there; after the row transaction commits nothing can bring the organisation back, so a retry that finds `already_deleted` simply finishes the objects — and if that fails for good, `job.dead` is written and the nightly sweep still collects objects no row claims.

Seen, not assumed: `/platform/jobs` lists the queue for a super admin (`platform.jobs.view`) — dead, failed and running first — with the error text and a requeue control that calls `api.requeue_job`, whose own guard refuses to revive a purge for an organisation that is not genuinely pending deletion (ADR-044.6). `MVP_SCOPE.md` §2.2's "jobs monitor" is this page.

Tested from the customer's side of the promise (`test/integration/org-purge.test.ts`): an organisation seeded with a row in every family the FK graph makes hard to order — records, runs, snapshots, evidence, alerts, actions, files, an invitation, a second membership — is refused a day early, deferred while another job runs, refused when reactivated, and then purged: no row left in any tenant table, no object under either prefix, the row marked `deleted`, the owner's `my_context` empty, every audit event kept and stripped except `org.purged`, whose `after` holds the counts, a second run idempotent, and the trigger-queued job succeeding through the real worker. pgTAP asserts the service-role guard and both refusals.

### ADR-068 · The frozen Home needs its rows
Context: `PRODUCTION_AUDIT.md` H1. ADR-044.4 promised a suspended organisation's members "the frozen Home and nothing else" and named five tables that admit `suspended_member`. Two of the five — `metric_current`, `health_current` — are pointer tables. The figures Home shows live in `metric_snapshots`; the month it shows lives in `fiscal_periods`; `loadHome` also asks whether any accepted record exists before it will render at all. None of the three was reachable by the role. Executed: under suspension the owner's own client read 0 periods, 0 snapshots and 0 rows from the join Home issues, and Home rendered "add your first file" beneath the suspension banner — to a paying customer whose data was intact.

Decision: the contract stands and the policies meet it, as narrowly as the promise allows. `fiscal_periods` admits `suspended_member` (a period is a label and two dates). `metric_snapshots` admits `suspended_member` for the rows `metric_current` points at — the figures that were on Home when the organisation was suspended — and for no other row: a superseded run's figures, a snapshot no pointer names, stay out of reach (`metric_current_by_snapshot` makes the pointer lookup a probe). `loadHome` takes `{ suspended }` from the access context and, while suspended, does not ask the record-level first-run question it cannot answer; whether the frozen figures exist is the whole test, and a suspended organisation that never had data still gets the first-run state, correctly. `suspended_member`'s single permission is unchanged; every other tenant-data policy is unchanged.

Proven both ways: pgTAP asserts a suspended member reads the organisation's periods and exactly the pointed-at snapshot and not a second one written beside it; the Home integration test suspends a computed organisation and reads the same cards back. The four documents that enumerated "the five" now name the rows.

### ADR-069 · One rule for a `next` target
Context: `PRODUCTION_AUDIT.md` H2. The PKCE callback, the sign-in form and the middleware each decided for themselves whether a `next` parameter was a relative path, with the same test: `startsWith('/') && !startsWith('//')`. WHATWG URL parsing treats a backslash as a slash in special schemes, so `/\evil.com` passed and `new URL('/\\evil.com', origin)` resolved to `https://evil.com/` — verified in Node. A magic-link or reset email landing on `/auth/callback?code=…&next=/\evil.com` completed the exchange, set the session cookies, and 302'd the user off the product's domain: a phishing primitive on our own origin, one second after sign-in.

Decision: `core/routing.safeNextPath(candidate, origin)` is the only judge of a `next` target, and its rule is the only defensible one — parse the candidate exactly as the browser will, keep it only if the result is on our origin, and then re-check the shape of what comes back (a path beginning `//`, which `/./\evil.com` normalises to, would resolve off-origin again the next time anything parsed it). It is pure and dependency-free so the Edge middleware, a route handler and the browser share one implementation. The three call sites use it; `test/unit/route-contracts.test.ts` asserts that every file reading a `next` parameter imports it, so a fourth call site written the old way fails in CI rather than in production. `test/unit/safe-next.test.ts` pins every listed form — backslash, double backslash, protocol-relative, dot-segment normalisation, absolute, scheme change, `javascript:` — and the deep links that must survive.

### ADR-070 · The upload route reads the header before the body, and a failure is never an empty page
Context: `PRODUCTION_AUDIT.md` M1 and M2 — two findings in the same layer, the seam between a request and the code that serves it.

**M1.** `POST /api/imports/upload` called `request.formData()` and then checked `file.size` against the 25 MB limit, beneath a comment saying the check ran "before the body is read into memory". `formData()` materialises every part of a multipart body before it returns; the check ran after the damage, and any `imports.create` holder could post gigabytes to a Node function whose first failure would be its memory. The route also carried no throttle, though `ROUTE_ARCHITECTURE.md` §5 specifies 20 an hour per user and 100 a day per organisation. Decision: `documents/domain/upload-limits.ts` judges `Content-Length` — the one fact available before a byte of body is read — against the file limit plus multipart headroom, and a missing or unparseable length is refused rather than assumed small (browsers always send one for a `FormData` post; a chunked upload has no reason to be here). The route throttles both buckets first, on the counter every `api.*` function shares; the organisation bucket is keyed on the organisation's id, since the counter's actor column is a plain uuid and an organisation is the actor of its own daily allowance. The post-body `file.size` check stays as belt and braces. Unit-tested on the pure function; Playwright posts an oversized body and an over-quota series through the real route.

**M2.** The evidence page wrote `loadEvidenceDrawer(...).catch(() => null)` and then `notFound()`: a throttle, a database error, a descriptor whose hash no longer matched — all became 404, unlogged, with no path forward for the person looking at it. Three platform pages wrote `const { data } = …; data ?? []`, so a failing query rendered "No organisations" to a super admin during an outage, which is a state they would act on. Decision: only `NOT_FOUND` becomes the not-found page — the catch tests `isMotionError(e) && e.code === 'NOT_FOUND'` and rethrows everything else to the error boundary, where it is logged and seen; the platform pages throw on `error` as every module repository already does. The standing rule this restores is the one the project already had: nothing is swallowed, and an empty list is a fact about the data, never about the connection.

### ADR-071 · A member cancels only the jobs a member can request
Context: `PRODUCTION_AUDIT.md` M5. `api.cancel_job` gated on `intelligence.recompute` and then cancelled any queued job of the organisation by id. A member cannot enqueue a purge, an alert evaluation, a storage sweep or a large-import commit, cannot see them (`jobs_select` is super-admin only), and must not be able to stop them — cancelling an `org.purge` in particular would leave an organisation `pending_deletion` with nothing scheduled to delete it (ADR-067). Decision: cancellation is the mirror of `api.enqueue_job`, so it is held to the same set — `calculation.run` and `report.render` — and to `requested_by = app.uid()`; a server-originated type or another person's job raises `42501`. pgTAP asserts an owner cannot cancel a purge or someone else's job and can cancel their own recalculation. The platform manages server jobs from `/platform/jobs` (ADR-067).

### ADR-072 · The audit log pages
Context: `PRODUCTION_AUDIT.md` M6. `/settings/audit` fetched the latest 100 events and stopped, though `api.org_audit_events` already took an offset (capped at 500). A busy import day pushed a super admin's `org.data_viewed` visits past the hundredth row, out of the owner's reach — the one thing CD-13 promises they can always see. Decision: the page takes `?page`, fetches `PAGE_SIZE + 1` so "is there an older page?" is a fact rather than a guess, and offers Newer/Older links plus an "About" column naming the target table. Kept deliberately simple: no free-text filter in the MVP (the function has no filter parameter), and the 500 cap stands as the backstop it always was.

### ADR-073 · An invoice re-export updates by supersession — at commit, not only on paper
Context: `PRODUCTION_AUDIT.md` M3 said the commit-time re-check ran only pass 2 and that a concurrent invoice re-export surfaced as a raw `23505`. Verifying that with the real `app.commit_import_batch` found the wider fact: the loop inserted an update candidate's new invoice as `accepted` and *then* superseded the old one, and `invoices_identity_unique` is partial on exactly `accepted and superseded_by is null` — so the insert collided with the row it was replacing on every re-exported invoice, validated or not. ADR-029.1's "invoice re-exports update existing invoices by supersession" had never reached commit, and no test exercised the path; `replace_import_batch` worked only because it rolls the old batch back first.

Decision, in two parts with no DDL. (1) An update candidate is inserted `pending` — outside the partial index — the prior row is superseded through `app.supersede_row` (it leaves the index), and the new row is then set `accepted`: three statements in the one commit transaction, never two accepted rows for one identity, never a figure reading a half-committed invoice. The deferrable-constraint alternative was rejected because a partial unique index cannot be deferred and an exclusion constraint would have changed the schema for one code path. (2) `app.rerun_dedupe` gains the pass §9.3 always promised: after the byte-identical pass 2, a committable invoice row whose identity — type, customer, number — now matches an accepted current invoice from another batch is marked `IMP-INV-010` with `duplicate_of_id` set and commits as an update; it is not a collision and does not send the batch back. A candidate whose target was itself updated since validation is re-pointed along the chain to the row that is current now, rather than failing at commit with "already superseded". Pass order is pass 2 then pass 1, so a byte-identical re-export still returns to review as a duplicate.

Proven through the real function in `test/integration/import-commit.test.ts`: a validated update candidate commits and supersedes with the lifecycle events in order; a re-export committed by somebody else between validation and commit becomes an update carrying `IMP-INV-010`; a byte-identical one still returns to review; two re-exports validated against the same original form a chain, not a fork.

### ADR-074 · The nightly sweep is scheduled, and the throttle counter is pruned
Context: `PRODUCTION_AUDIT.md` M4, and ADR-064's own last paragraph. `app.throttle` upserts one `api_rate_limits` row per user, per bucket, per minute and deletes none; `DATABASE_ARCHITECTURE.md` §7 assigned retention to `storage.cleanup_orphans`; and nothing ever enqueued that job — `vercel.json` drained the queue every minute and no code path put a sweep in it. Two gaps with one root, so one decision. `GET /api/jobs/nightly`, behind the same constant-time cron secret as the worker (now one implementation, `api/jobs/_lib/cron-auth.ts`), runs daily and calls `api_server.enqueue_nightly_sweep(date)`, which queues exactly one platform-wide sweep keyed `storage.cleanup_orphans:<date>` — §7's `date` key, honoured for run jobs as well as queued ones so one sweep a night is a fact. The platform-wide handler run calls `api_server.prune_rate_limits()` and reports the count in its result; a per-organisation run leaves the platform table alone. Two days is the keep because the longest live window is one day (`upload:org`), and the function refuses a shorter keep rather than reset somebody's counter. Tested: the enqueue is idempotent per date; pruning removes the three-day-old row and keeps the 25-hour, one-day and current ones; the platform run reports a number and the scoped run reports null; `route-contracts` asserts both cron paths are scheduled and have handlers.

### ADR-075 · Stated controls exist
Context: `PRODUCTION_AUDIT.md` L1–L5, five places where a comment or a document described a control the code did not have.

**L3, session revocation.** `SECURITY_MODEL.md` §4 promised three things: an owner removing a member also ends that member's sessions; revoking a platform role invalidates every session "via the Auth admin API"; revoking an assignment archives the employee's conversations. None was implemented, and the named mechanism does not exist — GoTrue v2.196 answers 404 to every admin per-user session route. The primitive that exists is the session itself, so `api_server.revoke_user_sessions(user)` deletes the user's `auth.sessions` and `auth.refresh_tokens` rows. It is owned by `postgres` — the one definer function in the database that is, allow-listed by name in `00_structure.test.sql` — because Supabase's `postgres` holds grant option on SELECT only for the auth tables (`postgres=ar*wdDxtm`), so motion_definer can never be granted DELETE there, locally or hosted; the function carries the service-role guard like every `api_server` function and touches nothing in `public`. every refresh ends at once and the next `getUser()` fails because the JWT's session id no longer resolves. `tenancy.removeMember` calls it when the remover is an owner or super admin; `/platform/users`' revoke action calls it after `api.revoke_platform_role`. Both run after the removal committed, so a failure leaves a removed member with a session that resolves to nothing, never a member with none. Tested on seeded sessions: the target's two go, the bystander's stays, and nothing-to-end is not an error.

**L5.** `api.revoke_assignment` now archives the employee's active `ai_conversations` for that organisation and records the count on the audit event, as §4 always said; pgTAP proves it through an owner's revocation.

**L2.** `api.fix_import_row` set a row `pending`, nothing re-validated it, and the commit gate — correctly — refused a pending row, so a fix parked the batch until it was rejected or replaced. The review UI's in-place edit (`IMPORT_ENGINE.md` §10) is not built. The function is dropped until that edit exists and re-validates the row — ADR-026's invariant that every `api.*` function is executable by `authenticated` (00_structure #245) is worth more than a function nobody may call; the unused TypeScript wrapper is removed; §10 says so. A trap is not a feature.

**L1.** The middleware said "fail closed" above a `return response` that let every request through when Supabase was unconfigured. It now answers 503 with a request id and nothing else; the server layouts were never the only guard again.

**L4.** The signer's walk said it would "stop and say so" at its depth budget and stopped silently. It logs the prefixes it did not descend into. Nothing under an unvisited prefix can be deleted by that walk — the safe direction — but a bucket growing a tree the sweep never sees should not be silent.

**L6** was closed by ADR-066 (`evidence.bundle_built`).

### ADR-076 · The server persists an analyst turn; a browser never can
Context: MVP_SCOPE.md §2.10 and PRODUCTION_AUDIT.md H3 — the AI analyst existed as domain code only. Every document that names the analyst names `api_server.ai_persist_turn` (AI_ARCHITECTURE.md §2, §4, §14.14; DATABASE_ARCHITECTURE.md §14.2), and it did not exist; nor did the quota resolver it depends on, nor the Claude client, nor a conversation service. This is Phase 11 Slice 1: the parts a turn cannot be written without.

**`api_server.ai_persist_turn(actor, org, conversation, user_message?, assistant?, tool_calls[], bundle?)`** — service-role guard, actor re-validated with `has_permission_of(actor, org, 'ai.use')`, the conversation bound to `(org, actor, active)` or `NOT_FOUND` (F-C-11). Exactly one half per call. The **user half** charges the 10/min throttle and the daily-question and monthly-token quotas *before* any model is called, so an exhausted organisation never pays for an answer it will not get; quotas resolve through `app.effective_quota(org, key)` — a `platform_org_settings` override else the `platform_settings` default, and never `organizations.settings` (ADR-038.5, F-A-09). The **assistant half** writes the message (with `content` NULL by constraint: nothing the model wrote outside `submit_answer` is stored, F-C-08), every tool call, and the `ai_response` bundle, in one transaction — and it refuses any bundle item whose id or descriptor hash was not carried in `returned_ids` / `returned_hashes` of the tool calls of *that same call*. The database, not the loop, enforces "bundle item ids ⊆ tool-returned ids" (§14.2), so a fabricated citation cannot be laundered by a bug in TypeScript. `grounding_status`, `grounding_report`, token counts and model are therefore facts a user JWT cannot write (R2-A-01); pgTAP asserts a user is refused, another actor gets `NOT_FOUND`, and an unreturned citation is refused. A failed turn (`grounding_status = failed`) is stored for review with no bundle; `period_context` defaults to `{}` on such a row rather than refusing the row that records the failure. Audit: `ai.answered` / `ai.refused` (`not_applicable`) / `ai.context_changed`.

**`ai/data/claude-client.ts`** is the one file that imports the Anthropic SDK (§1.2, ADR-023; the ESLint restriction already existed). It owns the key, `DEFAULT_ANALYST_MODEL`, `temperature = 0`, `max_tokens = 1500`, the 30 s timeout with one retry on a transient error (429/5xx/connection), prompt caching on the stable prefix, and token accounting that counts cached reads (they are billed under the ceiling, §11). It decides nothing about the answer: it returns content blocks, and the loop discards text and validates `submit_answer`. Every failure is normalised to `UpstreamError` so the loop's "retry once, then `failed`" rule has one thing to catch. The transport is injectable, so the loop, grounding and the route are testable end to end against recorded responses with no key.

**`ai/services/conversations.ts`**: `findConversation` (continue) is bound to `(org, user, active)` and is `NotFound` for a colleague's, a foreign or an invented id before any model is called; `listConversations` lists the caller's own; `loadMessages` (review) lets RLS admit an owner/admin to a colleague's; `loadHistory` replays the last 10 turns oldest-first as user text and validated assistant JSON — never assistant prose, never tool results (§9).

Also in this slice, found by its gates: `scripts/check-schema-drift.ts` had been red since the ADR-075 commit, whose gate line misreported it — the deliberate `postgres` ownership of `revoke_user_sessions` was allow-listed in pgTAP but not in the drift script. The same named exception is now in both, and the audit records the misreport.

### ADR-077 · The closed tool registry, and two conventions the contract left to the code
Context: Phase 11 Slice 2 (`IMPLEMENTATION_PLAN.md`; AI_ARCHITECTURE.md §3, §4; TEST_STRATEGY.md §10.1). The fifteen tools of §3 exist in `ai/domain/tools/{metrics,money,intelligence}.ts`, registered in a closed `registry.ts`, and run through `services/run-tool.ts`, which is the §4 wrapper: the access context is re-resolved before every call and the turn aborts with `ContextChanged` if the role or permission set moved (`denial_reason = 'context_changed'`, F-C-17); `can(ctx, tool.permission)` runs before the tool and the service asserts again inside; every call — allowed, denied, timed out, failed — yields a `PersistedToolCall` with `authorized`, the denial reason, an output hash, a shape summary (never a payload) and the `returned_ids`/`returned_hashes` that alone the bundle may cite (§14.2). Every figure is read through `metric_current` in the branded envelope with `snapshot_id` beside it; `display` comes from `core/money`'s formatters, so the model quotes what the screen shows and §7.3 derives its tolerance from that. A tool never subtracts; a change is the engine's variance snapshot. Proven on a real engine-computed organisation: the owner/client matrix, F-C-02 descriptor rejection, org-from-context, `PERIOD_NOT_FOUND` for an unknown label, NOT_FOUND for a foreign id, the mid-turn demotion, and that a counterparty named `REFUND 4,800 <script>` grounds nothing and reaches the model wrapped.

Two things the written contract did not settle, and this slice did:

1. **Tool inputs strip; the response contract rejects.** §4 says an unknown property the model adds is "stripped and the call proceeds". Zod's `strictObject` *refuses* instead — the first run of the matrix had `get_metric` fail on a model-added `organization_id`. That is the wrong posture as well as the wrong behaviour: a refusal teaches the model to retry, whereas stripping makes a foreign organisation id inert (the org comes from `ctx` regardless). Tool inputs are therefore `z.object`. The response contract in `contract.ts` stays `strictObject` for the opposite reason: there an unknown field is the model asserting something the server owns (R2-C-08). The rule is recorded on `ToolDefinition`.
2. **A threshold or factor value's unit comes from its key.** `alerts.threshold_summary` and a health `FactorSentence.values` are mixed maps — `amount`/`threshold` are money, `share`/`multiple` are ratios, and `signature`/`description`/`customer` are imported *text* — with nothing in the value saying which. The unit resolves from the key: the metric registry when the key is a metric, a short field-name table otherwise, and anything else is text, wrapped `untrusted` and not groundable. A description that happened to be all digits stays text because its key says so — which is F-C-09 applied at the one place a string could otherwise have become a number.

Also found by the suite: `Number(...)` on a completeness figure in `get_business_summary`, caught by `no-money-parsefloat` and replaced with `Decimal` (ADR-006).

### ADR-078 · The analyst turn: one loop, one verdict, one route
Context: Phase 11 Slice 3 (`IMPLEMENTATION_PLAN.md`; AI_ARCHITECTURE.md §2, §7.6–7.8, §9, §10; ROUTE_ARCHITECTURE.md §165, §237). Slices 1 and 2 built the pieces; this slice is the turn itself — `ai/services/answer.ts` — and the one door the browser has to it, `POST /api/ai/chat`.

**The loop runs in the order the document numbers, and the order is the security property.** `assertCan` → `findConversation` (NotFound for anyone else's, before any model call, F-C-11) → the user turn charged through `api_server.ai_persist_turn` (quota and throttle *before* the model, F-A-09; `QuotaExceeded` is the one error the loop rethrows) → period resolution → prompt → at most eight tool calls, access re-resolved before each through `resolveAccessFresh` (`getAccessContext` is `React.cache`d per request, which is right for a page and would silently defeat F-C-17 here) → a forced `submit_answer` when the budget is spent → text blocks discarded before anything is validated (F-C-08) → contract validation, then mode admissibility (§7.7: the server, not the model, decides whether `clarification`, `refusal` or `no_data` is allowed this turn) → grounding → one regeneration with the reasons wrapped `untrusted('reason', …)` → §7.8 degradation by *removal*, never a caveat → the bundle built from derived refs and the surviving statements' own refs, filtered to ids and hashes a tool returned this turn → everything persisted by the server in one call. The turn context (`domain/turn-context.ts`) is built only from this turn's tool results — history contributes nothing to the allowed set (R2-C-02) — and keys assurance by id, so `kind` is recomputed from the data (§6.2) rather than believed. A thrown error inside the loop becomes a stored `failed` row with a reason, and the user sees the fixed fallback (§10); a mid-turn role change is `context_changed`.

**The route decides its status before its first byte.** SSE carries `status` events (tool name and label, no payload) and exactly one `answer` event; there is no partial-narrative channel. Everything that can refuse a turn happens inside `answer()` before any status event, so the handler waits for *either* the first status event or the end of the turn, and only then chooses between a JSON error with its status — 401, 404, 403, 422, 429 with `resetAt` — and a 200 stream. A quota refusal is therefore a 429, not an event inside a 200. The organisation is a slug the route resolves against the caller's own access; the body never names an organisation id (ADR-014). The message is bounded at 2,000 characters here and wrapped in §9's `<user_question>` by the prompt.

**Two things the route's own test found in the middleware.** (1) An anonymous call to any `/api/*` route was redirected to `/sign-in`; a fetch follows that into a 405 from a page with no POST. §237 says 401, and the middleware now answers 401 JSON for `/api/*` with no session (the route repeats the check, for the case where the middleware is not in front of it). (2) `/api/jobs/run` and `/api/jobs/nightly` were not public prefixes, so a caller with no session — which is what Vercel Cron is — was redirected to the sign-in page and the queue would never have drained in production. The e2e `drainQueue` helper called the route from a signed-in page, which is why nothing noticed. The cron routes authenticate themselves in constant time and answer 404 otherwise (ADR-074); they are now public to the middleware and the new `api` Playwright project calls them with no session, with and without the secret. This is recorded on `PRODUCTION_AUDIT.md` as a finding the audit missed.

Tested against a real computed organisation and a *scripted* transport (`test/integration/ai-answer.test.ts`): the happy path grounds a figure the tool returned and cites its snapshot; a fabricated figure is removed after one regeneration and the reason reaches the model wrapped; the quota is charged before the model and a refusal is a `QuotaExceeded`; a colleague's conversation is `NotFound` before any call; a demotion mid-turn is `context_changed`; the budget forces `submit_answer`; an upstream failure is a stored `failed`. The route is proven over HTTP (`e2e/api-ai-chat.spec.ts`): 401, 404, 422, one `answer` event, the assistant row's verdict, and the cron contract above.

### ADR-079 · The analyst page shows the server's verdict, and nothing it did not decide
Context: Phase 11 Slice 4 (`IMPLEMENTATION_PLAN.md`; UX_ARCHITECTURE.md §5 `AnalystChat`, §6, §7.1–7.2, §8.1; ROUTE_ARCHITECTURE.md §121–122; AI_ARCHITECTURE.md §2 step 13, §7.8, §13). `/app/[orgSlug]/analyst` and `/analyst/[conversationId]` exist; the nav item is built.

**The page is thin on purpose.** The server decides whether there is anything to ask about (no committed data → the §6 empty state and no chat), the allowance, the conversations, and — for the moment the analyst is unavailable — the figures the reader can still have. The client sends one question to `POST /api/ai/chat`, turns `status` events into one plain status line, and reveals the ONE validated `answer` event section by section in contract order (ADR-032.4). It formats no number and computes nothing: every badge is the server's `kind` (§6.2), every "Why?" is the bundle the server built from what the tools returned, and "Create action" exists only when `grounding_status = 'passed'` — with `api.create_action_from_recommendation` refusing anything else regardless (ADR-032.5). A degraded answer shows the §7.2 banner and the digit-free "Not covered" lines; the removed sentences are nowhere on the page. The pure rules — the kind table, the SSE cutter, the quota notice, the reveal count — live in `components/dashboard/analyst-presentation.ts` and are pinned by unit tests.

**"Facts we can show you" is a server component handed to the client as a node.** `MetricCard` reaches the data layer through the status rules, so it cannot enter the browser bundle; the page renders the §7.2 card from `loadHome`'s cards — the same objects Home shows, formatted on the server — and the chat shell displays it when a turn ends `failed`. The reader is never left with nothing, and the fallback is deterministic and model-free.

**`api.ai_quota_status(org)`** (migration `20260909000002`). The contract gives the page `quota.remainingToday` and a notice with the reset time, and the only reader of the quota was the refusal inside `api_server.ai_persist_turn`, which a user JWT cannot call. The new function counts *exactly* what the refusal counts — user turns since UTC midnight, tokens this month, limits through `app.effective_quota` — so the notice and the 429 can never disagree; it is `ai.use` + accessible-org (NOT_FOUND otherwise) and reads the platform override table only through the definer. pgTAP proves the count, the default, the reset instant and the stranger's NOT_FOUND.

**Feedback (§13, CD-25)** is `submitFeedback` over the existing `api.submit_ai_feedback`; every assistant message — a failed one included — carries "Report this answer". Reporting does not flag the message; platform review does.

**A colleague's conversation is read-only.** `findConversation` answers "may I continue this" (mine, here, active) and `loadMessages` answers "may I read this" (RLS admits an owner or admin); a conversation that is neither is the uniform 404. A new conversation's first answer rewrites the address to `/analyst/[id]` with `history.replaceState`, so a refresh lands on the record without the page losing the turn it just showed.

Proven: 14 unit rules; integration for the quota count moving with a persisted user turn, the stranger's NOT_FOUND, feedback recorded verbatim and refused cross-org; Playwright asks a real question against the built app (no key: the fallback and the facts card with the seeded £40,000, no "Create action", the turn recorded, the conversation page rendering the same record), reports an answer, and gets 404 for an invented conversation.

### ADR-080 · The run writes the comparisons it always said it wrote
Context: found by Phase 11 Slice 5's corpus recorder, which computed a two-month organisation through the real engine and read `variance.prev_period = null` on every metric. `FINANCIAL_ENGINE.md` §3.2 says "for each base metric B … write `B.variance.{suffix}`", and `domain/variance.ts` — `computeVariance`, `computeRevenueGrowth`, tested in `engine-variance.test.ts` — implemented exactly that. Nothing called it. The run wrote levels and never a comparison, so `health` P3/P4/G1/K2, the `expense.spike_category`, `revenue.decline`, `margin.deterioration`, `cash.decline` and `receivables.deterioration` rules, `revenue_growth_mom/yoy`, the MetricCard's change line and the analyst's `get_expense_changes` / `variance` fields have all been reading a row that did not exist — silently, because every one of them treats "no row" as "no comparison yet". The same class of defect as ADR-064's unregistered job handlers: a module built, tested and never wired. The audit did not catch it because every fixture it probed had one month of data.

**The fix is one pass in one place.** `domain/variance-pass.ts` turns a period's level results into its `B.variance.{prev_period, same_period_last_year, trailing_3m_avg}` and growth results, and `services/run.ts` calls it for every period after `computePeriod`, before the chunk is written. A comparison period comes from this run's own results when the run has already computed it (chunks are oldest-first, so P−1 usually has), else from `metric_current` through the one new repository read, `loadCurrentObservations` — loaded once per chunk for exactly the comparison periods the chunk needs. A period that does not exist for the organisation is `periodId = null`, which the domain reports as `comparison_period_missing`, never as zero. A category variance is written under `dimension_key`, because a category is a name and `dimension_id` is a uuid (ADR-053). Ids are minted before the write so growth can name the variance it came from and each variance can name both snapshots it compares (ADR-059). An as-of-only scheduled run leaves comparisons as they were (ADR-047.8).

**What changed for readers, and what did not.** Every existing unit and integration test still passes — the suites' fixtures were single months. The recorder's organisation now shows revenue +£7,000 (+38.9%), marketing +£2,200 (+183.3%) with an `expense.spike_category` alert, a scored `revenue_growth` dimension, and `get_expense_changes` rows with `previous`, `change_abs` and `change_ratio`. Proven by `engine-variance-pass.test.ts`: in-memory comparison with both snapshot ids named; stored fallback; category → `dimension_key`; growth naming its variance; missing period → `comparison_period_missing`; nothing written for a base absent on both sides.

### ADR-081 · The evaluation harness measures the server with the model out of the loop, and the model with the server in it
Context: Phase 11 Slice 5 (`IMPLEMENTATION_PLAN.md` item 5; AI_ARCHITECTURE.md §12; TEST_STRATEGY.md §10.3 and "Recorded AI"). Two runs, one vocabulary.

**The recorded run** (`npm run ai:eval`, Vitest project `eval`, on every push, no key, no database, under two seconds). A case is a recorded turn — the tool outputs the model saw and the `submit_answer` it gave — and running it is `validate → judge → ground → degrade` through the loop's own functions: `validate` and `judge` moved out of `services/answer.ts` into `domain/verdict.ts` so the harness and the product cannot reach different verdicts on the same submission. The tool outputs are real: `test/integration/ai-eval-record.test.ts` builds CD-30's first golden organisation (two complete months, two customers, computed by the engine, read through the tools) and records `test/fixtures/ai/recorded-tools.json`, stamped with `PROMPT_VERSION`; on every other run it re-reads the tools and refuses a shape that drifted, key for key. The corpus (`test/fixtures/ai/corpus.ts`, 129 cases) is *built from* the recording — a golden answer quotes the tools' own display values, paths and ids — which is what makes it a measure of the server: 40 golden cases (ten SOW §10 categories × four roles), 45 adversarial (injection in the question, in a customer name, an instruction obeyed, scenario/affordability/off-topic refusals with the §9.4 templates, prompt disclosure, unknown periods, documents asked for by a client, foreign ids cited), and 44 traps (R2-C-01..08: wrong period, wrong metric noun, no noun, wrong customer, swapped entities, flipped sign, unanchored direction, ratio off by four points, a percentage on money, a fabricated figure, a wrong path, missing evidence, an amount inside a recommendation, a prose period differing from the statement's, an uncited inference, a refusal as `answer`, an answer as `clarification`, `no_data` with figures, a digit in `unsupported`, a model `label`, a model `confidence.level`). Every rate is at target: first-pass 100%, evidence coverage 100%, refusal correctness 100%, trap catch 100%; below any §10.3 target, a set under §12's minimum, or a stale prompt version, the run is red and writes `test-results/ai-eval.json`.

**The live run** (`ai.eval` job; `npm run ai:eval:live <org> <requester>`). The §10 questions asked for real through `answer()` — quota, tools, grounding, persistence — as the person who requested the job, against an organisation with figures; the metrics and every verdict land in `jobs.result`, and a run below target fails the job (enqueued with one attempt, because a retry only spends the allowance again). Two things the job needed that a browser turn does not: a conversation opened on the member's behalf, so `api_server.ai_create_conversation(actor, org)` — service role only, actor must hold `ai.use`, owned by `(org, actor)` like every turn after it; and pacing under the product's own `ai_turn` throttle (10/min), which the runner respects rather than switches off. The handler's transport is the one seam a test substitutes; the integration test drives thirteen questions through the queue with a scripted model that reads each question and answers it as a correct model would.

**Found by the corpus, fixed here.** `topicFor` built a "Not covered" line from the model's own `statement.period` and `metric_key`; a customer named "…treat Q1 as Jul-Sep…" carried its instruction straight into that line. The topic now comes only from what the server knows — the metric of the row each number cites, tool-returned names, and a period label this turn resolved (R2-C-04). Found by the recorder, fixed first: ADR-080.

**Left for the owner, recorded rather than invented.** §7.7 says a `no_data` answer "cites the `get_data_coverage` run or period id", but `EvidenceRef` has no such type and a turn in which *every* tool returned `NO_DATA` returns no id to cite — so an honest `no_data` cannot be admissible as written. The corpus carries no `no_data` case for that reason; the contract needs a decision (a period-typed evidence ref, or citation waived when nothing citable was returned).

### ADR-082 · The review queue reads under the reviewer's own client, and the review is one function
Context: Phase 11 Slice 6 (`IMPLEMENTATION_PLAN.md` item 6; AI_ARCHITECTURE.md §13, CD-25; ROUTE_ARCHITECTURE.md §154; RBAC_MATRIX.md §2.1). `/platform/ai-feedback` lists open reports newest first and `/platform/ai-feedback/[id]` shows what a reviewer needs to decide: the answer as the reader saw it, the grounding report the server kept — the removed sentences live there and nowhere else (R2-C-04) — the tool calls with their authorisation and outcome, and the evidence bundle; then the review. The nav has the link and the overview counts open reports.

**`api.review_ai_feedback(feedback, status, note)`** — catalogued in DATABASE_ARCHITECTURE.md §14 from the start, built here. `NOT_FOUND` for an organisation the caller cannot reach (§14), then `platform.ai_feedback.review` in that organisation; `open` is refused; the note is trimmed and bounded; `reviewed`/`actioned` put the §13 badge on the message and `dismissed` takes it off; every review is audited `ai.feedback_reviewed` with the status before and after. The page's action is the form, not the rule.

**The reads widen for one role, deliberately.** ADR-065's select policies on feedback, conversations and tool calls named owner/admin/super_admin, which left an assigned EMPLOYEE — the one role the matrix gives `platform.ai_feedback.review` ◐ — unable to read what they are asked to review. The role set now includes `employee`; its reach is already confined to assigned organisations at aal2 by `app.accessible_org_roles()` (SECURITY_MODEL.md §4, ADR-044.1), so an unassigned employee still sees nothing and a client still sees only their own. Opening an item writes `org.data_viewed` (ADR-038.6, CD-13).

Proven: pgTAP (owner and client refused, unassigned employee and aal1 employee `NOT_FOUND`, assigned employee reads feedback/tool calls/message and reviews, `open` refused, badge on then off, two audit rows); integration through the service (super admin and assigned employee see and load the item with the removed sentence and the tool calls, the stranger gets `NOT_FOUND`, an owner has no queue, the review flags and audits, dismissal unflags).

### ADR-083 · A PDF statement goes in through the same wizard — and what wiring it found
Context: `PRODUCTION_AUDIT.md` H3 §2.3 — "PDF import refused: `wizard.ts`: 'PDF statements are not ready yet'". The deterministic text-layer parser of IMPORT_ENGINE.md §5.3 (`parsers/pdf-text.ts`, `parsers/pdf-scanned.ts`) had been built and unit-tested against the §17 catalogue and was never called. This is PDF slice 1: the wizard uses it. Slice 2 is the §5.4 Claude-assisted path (the `document.extract` job, consent, budget, side-by-side review), which starts from the failed batch this slice leaves behind.

**The wizard.** A `.pdf` goes to `parsePdfText`. A table comes back as a `pdf_text` batch through the same mapping, validation, balance gate and review as a CSV; its rows point at `page:N;line:M` (§13), its captured balances feed `IMP-BAL-006`, and commit already promoted `pdf_text` rows from `calculated` to `verified` only when the statement reconciles (ADR-033). No text layer (§5.5): the file is stored as an `unreadable` document, no batch, and the reader gets the fixed sentence. A text layer but no grammar (§5.3 "yields nothing"): the file is stored, a `pdf_text` batch is created and failed with a plain reason, so the review screen has somewhere to put "Read with AI". `api.start_import_batch` takes `extraction_method` from the wizard (`csv`, `xlsx`, `pdf_text`; the AI and manual methods stay the server's), and `register_document` keeps the probe's `has_text_layer` and `page_count`, which §5.4 reads.

**What the first real PDF exposed.** Five things that had never run, each invisible to every fixture that came before because those fixtures were CSVs with ISO dates and no thousands separators:

1. `api_server.fail_import_batch` had never worked: `case … 'failed'` yields text, Postgres refuses it for the enum column (42804), and the wizard's error path threw a second error instead of failing the batch with a reason (§16). Fixed; `fromPostgresError` now logs an unmapped SQLSTATE with its code and sentence, which is how this one was found.
2. The §6.4 date transform — `detectDateColumn`, `parseDateValue` — was exported and never called. Any non-ISO date column failed `IMP-DATE-001` on every row. The pipeline now detects each date column's order over the whole column (per-column choice → file choice → what the column disambiguates → the organisation's country) and reads every cell with it; rows that would read the other way round carry `IMP-DATE-003`.
3. The §6.4 number transform — `detectNumberColumn`, `parseAmount` — likewise. A cell of "2,500.00" reached the sign transform as text it could not parse and fell out of the sum, so no statement with a thousands separator could reconcile. Separators are now detected per money column before signs are applied.
4. `import_batches.extraction_method` was never set: every XLSX batch was stamped `csv`.
5. The header line, which every parser keeps in `rows` and names by `headerRow`, was validated as data — "Date" failed the date column and the reviewer was left dismissing an "error" that was the column headings. It is now staged as non-tabular.

Not in this slice, recorded: §5.3's "the reviewer can type the printed balances into the batch header" needs the batch re-validated after typing (`api.set_statement_balances` stores them; nothing re-runs the gate), and §6.4's explicit day/month choice needs a control in the mapping step; both belong with slice 2's review work. Proven by the wizard suite: `bank_text.pdf` → 36 lines kept, 28 transactions, `page:N;line:M`, balances 1,000.00 → 7,320.14 captured and reconciled; `bank_scanned.pdf` → stored `unreadable`, no batch, the §5.5 sentence; a prose-only PDF → stored, batch `failed` with the reason; a PDF's bytes under a `.csv` name → refused by its bytes. pgTAP: `extraction_method` recorded, `pdf_claude`/`manual` refused from a user token.

### ADR-084 · AI reads a page; a person decides; the gate never hears the model
Context: PDF slice 2a (IMPORT_ENGINE.md §5.4; AI_ARCHITECTURE.md §14; ADR-033; CD-11; CD-35; R2-C-11; `PRODUCTION_AUDIT.md` H3 §2.3 — "`document.extract` job type exists with no handler; `api.confirm_pdf_page` exists with no caller"). The Claude-assisted path now exists from the button to the rows.

**One button, one job, three server functions.** "Read with AI" appears on a `failed` `pdf_text` batch of a text-layer document in an organisation whose `features.ai_pdf_extraction` is on, under the CD-35 consent line, to a reviewer holding `imports.review`; it is the only path that creates a `document.extract` job (never automatic, R2-C-11). The job acts as that reviewer through `api_server.begin_extraction`, `charge_extraction_page` and `record_extraction_page`, each of which re-checks the permission and the flag, so the job holds no rule of its own. `begin_extraction` writes `document.sent_to_ai {document_id, pages}` with the reviewer as actor BEFORE any page is sent (F-A-15). `charge_extraction_page` runs BEFORE every model call, first attempts and retries alike — a page that fails costs every attempt — against `platform_org_settings.ai_extraction_pages_per_day` and the monthly token ceiling. Extraction tokens count under the same ceiling as the analyst's: `app.ai_tokens_used_this_month` sums both, and `ai_persist_turn` and `ai_quota_status` were re-created to read it (§11).

**The model sees one page's text, as data, and answers one way.** `extractStatementPage` is tools-free: the page inside `<document_text>` with the fixed escape form, one forced `submit_page` tool whose schema is the §5.4 contract (ISO dates, signed decimals, notes ≤ 200 characters), and any answer outside it — a wrong page, a model-added field, a bare integer — is a page failure, retried within the run, then recorded failed. A provider outage defers the batch and the job (`deferred_upstream`).

**What comes back goes through the product's pipeline, not around it.** Every row the model produced becomes a `ParsedRow` with `page:N;line:M` and its page, and runs through the SAME mapping, §6.4 transforms, validation, dedupe and balance gate as a CSV row, plus `IMP-PDF-001` ("read by AI — confirm against page N") and, where the deterministic date-line count disagrees by more than ten percent, `IMP-PDF-002`. What the model read as the balances is kept on `extraction_stats.balances_read` for the reviewer's comparison and is never written to `statement_*_balance`, which the gate reads (F-C-03). With nothing captured and nothing typed, the gate blocks commit in its own words. Commit already refused unconfirmed pages in SQL; the review now says which pages, shows each page's rows beside the document (rendered by the browser from a short-lived signed URL — MOTION never rasterises), and offers "I have compared all rows on page N" page-wide only when confidence was high and the line count agreed, else after every row on the page has been decided — re-checked in the action, then by `api.confirm_pdf_page`.

**Left for slice 2b, recorded:** typed statement balances with re-validation (so a `pdf_claude` batch can pass the gate on the printed figures), the "matches / differs" line against `balances_read`, and the model's `notes` (not persisted yet). Proven: pgTAP (user token refused; flag off refuses begin and charge; begin flips the batch and writes the consent audit once; a second begin refused; the third page charge in a day over a budget of two is `QUOTA`; a recorded page's stats carry attempt, tokens, confidence and the read balance while the gate's column stays null); integration through the queue with a scripted reader (flag off → job fails with no audit; flag on → two pages read as the reviewer, two charges on the organisation's counter, rows `warning` with `IMP-PDF-001` and their pages, `IMP-BAL-007`, not committable; `commit_import_batch` refuses); unit for the extractor's contract and the line-count rule.

### ADR-085 · The reviewer's typed balances are judged by the same gate, and a copy of the model's is not a judgement
Context: PDF slice 2b (IMPORT_ENGINE.md §5.3 "the reviewer can type the printed balances into the batch header to reconcile", §5.4's balance rules; ADR-033; F-C-03; the follow-ups ADR-083 and ADR-084 recorded). `api.set_statement_balances` stored a typed pair and nothing judged the batch on it, so a statement whose balances the parser missed stayed unreconciled whatever the reviewer knew, and an AI-read batch could never commit.

**Re-validation is the pipeline's gate, run again.** `setStatementBalancesAndRevalidate` stores the typed pair through the user-callable function (audited as reviewer-entered), then runs the SAME `checkBatch` over the rows that will commit, in row order, with the liability rule and the running-balance chain, and writes the result through `set_batch_validation` as the reviewer — every issue the pipeline found that was not about balances is kept; the balance verdict is replaced. A reconciled `pdf_text` batch's rows become `verified` at commit, as ADR-033 always said. For an AI-read batch, the absence of any balances is now the blocking error the document names ("Enter the opening and closing balances printed on the statement"), not a warning.

**Copying the model is not vouching.** When the typed pair equals what the model read (`extraction_stats.balances_read`) and no deterministic capture exists, the batch keeps `IMP-BAL-007` and the page-wide tick is withheld — in the review, in the action, and in the reviewer's own words on the screen. A comparison line ("matches / differs from the AI's reading") appears only once both figures have been typed, so the path of least resistance is reading the page. The model's read balances remain on `extraction_stats` and never enter `statement_*_balance`.

Proven: the AI-read batch (ADR-084's test) is blocked for balances, reconciles on printed figures the model did not fully read, and fails again on wrong ones while keeping the typed pair; a text-layer statement re-judged on wrong figures fails and on the captured figures reconciles.

### ADR-086 · Export is a stream of what RLS shows, recorded before the first byte
Context: `PRODUCTION_AUDIT.md` H3 ("no CSV export"); ROUTE_ARCHITECTURE.md §167; SECURITY_MODEL.md §8 step 4, §12; ADR-038.4. `GET /api/exports/[kind]?org=slug` for `ledger`, `bank_transactions`, `invoices` and `metrics`, offered on `/data/imports` to roles holding `data.export`.

**What is in the file is what the caller may see.** The rows are read through the caller's own client, so RLS decides; only `record_status = accepted` records are exported (a superseded or rejected row is history); a bank line carries `description_normalized` only — the raw statement text with account numbers in it is not in the select and not readable by the route (R2-A-04). The file streams in pages of a thousand rows, so a ten-year ledger does not sit in memory. `export.created` is written through `record_access_event` with `export_kind` BEFORE the first byte: an export that started is a fact whether or not the download finished. Ten an hour per user on the shared counter; 401 with no session, 404 for an organisation that is not yours or a kind that does not exist.

**Two refinements the rules left to the code.** (1) §8 step 4 says a cell starting with `-` is written with a leading apostrophe. Applied literally that would turn every negative amount in a finance CSV into text, and a plain signed decimal cannot execute in any spreadsheet — the risk is `-1+cmd|…`, not `-5.00`. `core/csv` therefore writes a pure numeric literal as a number and defuses every other dangerous lead (`=`, `+`, `-`, `@`, tab, CR); the apostrophe is applied before quoting so it survives as the cell's first character. (2) `bank_transactions.category_account_id` references `accounts` on the org-composite key (ADR-044.8), which PostgREST cannot embed; the category names are read once per export and joined in code.

Proven: unit for the writer (every dangerous lead, the numeric exception, RFC 4180 quoting); Playwright against the built app — the seeded ledger streams as `text/csv` with the documented header, no cell in the file opens as a formula, the access event is written with its kind, every kind answers with its own header, unknown kind and foreign organisation are 404, no session is 401.

### ADR-087 · The document library shows what a file became, and deletes only what nothing rests on
Context: `PRODUCTION_AUDIT.md` H3 ("no Documents page — uploaded files cannot be deleted from the UI"); ROUTE_ARCHITECTURE.md §127–128; UX_ARCHITECTURE.md §Data menu; ADR-043.4/5; R2-A-07/09. `/data/documents` lists every file the organisation has uploaded — kind, size, when, status, and the imports that rest on it — and `/data/documents/[id]` shows the file itself with those imports. The Data menu's `Documents` entry is built.

**Reads are the caller's.** `source_documents` is an allow-list of owner/admin/employee/super_admin (never a client), so the page holds no service role and cannot show what RLS would not. The viewer never puts a URL in the HTML: the browser fetches a 60-second signed URL from `/api/documents/[id]/url` when the viewer opens, which records `document.downloaded` (ADR-043.5); a PDF renders in the browser, anything else is offered as a download. The viewer is one shared component, and the import review's page-by-page view now uses it.

**Delete is `api.delete_document`.** It refuses a quarantined file (evidence of an attempted upload) and a file an import still rests on; it marks the row `deleted` and returns the path, the signer removes the object, and `storage.cleanup_orphans` finishes the job if that fails — the row is never removed, because it is the record that a file existed. The page offers the control only where the function would allow it, and the function decides regardless. Deleted files stay listable behind "Show deleted files too".

Proven by Playwright against the built app: the seeded ledger file is listed with its committed import and offers no Delete; its page opens, the download link appears from a signed URL and `document.downloaded` is recorded; an invented id is 404.

### ADR-088 · The last three platform pages, and who is allowed to see the whole platform
Context: `PRODUCTION_AUDIT.md` H3's remainder — `/platform/organizations/[orgId]`, `/platform/audit` and `/platform/settings` (ROUTE_ARCHITECTURE.md §150, §155, §156; MVP_SCOPE.md §2.2, which calls them the reason a super admin can onboard a customer at all). With these, every surface H3 named exists.

**The organisation detail page answers "what is this customer's state, and why is their analyst refusing".** Members (through `api.org_members`, because `profiles` is own-row-only), assigned staff, what the organisation may do, the limits that apply to it, what is in it, and its status. Suspend and reactivate go through `api.update_organization`, which owns the rule that status moves only between `active` and `suspended` — deletion is `api.request_deletion` — and refuses quota keys because those are platform-controlled; the quotas go through `api.update_platform_org_settings`. "Open as staff" is a link into the tenant shell, which records `org.data_viewed` in the customer's OWN audit log, where the customer can see it (CD-13).

**`api.platform_audit_events` is new, and it is super admin at aal2 — not `audit.view`.** `api.org_audit_events` is per-organisation, and a global page needs one query across every organisation plus the platform's own events (`organization_id is null`). The route table says `audit.view`, but an EMPLOYEE holds `audit.view` for the organisations assigned to them: giving them the platform's whole trail through this page would widen their reach silently. The function therefore requires a super admin with a second factor, exactly as `/platform/jobs` and `platform_settings` already do, and it resolves the organisation and the actor's name — which `profiles`' own-row-only RLS hides from a direct read. Filters are typed and the action filter is a prefix, so the page offers families ("Members and roles", "The analyst") as links rather than free text over an append-only table; a search is a URL a person can paste into a ticket.

**Two things the first real run of it found.** (1) The function was written `stable` and called `app.throttle`, which INSERTs: Postgres refuses a write in a read-only transaction (25006), so every call failed. The read surface does not throttle — the paging cap (500) is what bounds a caller — and this now matches `org_members` and `org_audit_events`. (2) The organisation's column is `country_code`, not `country`; a page that named the wrong column would have 500'd for every customer.

**Platform settings shows what it knows and does not hide what it does not.** The three AI limits are described in the words the product uses and validated as whole numbers; any other key in `platform_settings` is still listed and editable as JSON, because a setting nobody can see is a setting nobody can fix. `api.update_platform_settings` audits every change.

Proven at the service level, as the feedback queue is (a super admin at aal2 is not something Playwright can produce without TOTP): the detail page reads members, assignments, flags, limits and counts; suspend/reactivate, a feature toggle and a quota override all take effect and are audited; the trail spans organisations and the platform, names the actor and filters by family; and every one of these is refused to the organisation's own owner, to an assigned employee, and to a super admin without a second factor. pgTAP asserts the same refusals at the database.

### ADR-089 · Vouching for an answer is one click, and an employee's reach is proven at both layers
Context: the Phase 9 review of the AI analyst against AI_ARCHITECTURE.md §13 (CD-25) and §10.1. Two gaps, both in what the surface offered rather than in what it enforced.

**Feedback had only complaint paths.** `reportAnswerAction` has always accepted four types, but the UI opened a form and asked "what was wrong?" — so `helpful` was unreachable from the product, and saying "that missed the point" cost the reader a written sentence. §13 turns confirmed reports into eval cases; an answer somebody vouched for is the other half of that corpus, the regression fixture you want to keep passing, and it was being thrown away. `FeedbackControls` now offers three paths priced by what they are worth: **Helpful** and **Not helpful** are one click each, and only **Report an incorrect figure** — the one claim worth a sentence — opens the form with its type select and free-text box. The confirmation is type-aware ("Thank you — noted." for a vouch; "Someone will look at this answer." for anything a person must read), because telling a reader their compliment has been escalated is a lie about what happens next.

**An unassigned employee's refusal came from RLS, and nothing proved it.** §10.1's matrix was covered for owner, admin and client, but platform staff were only tested where assigned — so the interesting case, the employee whose role grants the permission and whose assignment does not grant the rows, was untested. Four tests in `ai-tools.test.ts` now drive it: the assigned employee reads the real figure (£25,000); the unassigned one is `authorized: true` — the permission check genuinely passes — and gets `NO_DATA`/`PERIOD_NOT_FOUND` with the figure nowhere in the payload; the same employee at aal1 resolves nothing at all (ADR-044.1); and `get_source_document_reference` is authorised by role for both and NOT_FOUND either way. The point of the four together is that neither layer alone is the boundary: RBAC decides which tools exist, RLS decides which rows are inside them, and the honest-NO_DATA envelope is what keeps the difference from leaking as an error message.

Proven: 17 tests in `test/integration/ai-tools.test.ts` (506 integration overall), and Playwright against the built app for both new feedback paths — one-click Helpful persists `ai_feedback.feedback_type = 'helpful'`, and the report form still persists the selected type with its comment.

### ADR-090 · The organisation scope is a request header, because a session setting could never have carried it
Context: `PHASE_1_7_INTEGRATION_AUDIT.md` H1. `withOrgScope` asserted the job's organisation with `db.rpc('set_config', {setting_name: 'app.current_org', new_value: orgId, is_local: false})`, and `app.audit` compared that setting with the organisation an event named — ADR-043's guard against a worker draining organisation A writing a row for organisation B.

**It had never once run, for two independent reasons.** `set_config` lives in `pg_catalog`, which is not an exposed schema, so PostgREST answered `PGRST202 · Could not find the function public.set_config`; supabase-js returns that as a value rather than throwing, and both call sites discarded it. And `core/db/server-rpc.ts` keeps its OWN client, so every `api_server.*` call was made on a different connection from the one the scope was asserted on — the scope would not have reached them even had the name resolved. `app.audit`'s guard begins `current_setting('app.current_org', true) is not null`, so the whole branch was skipped on every call, silently, since Phase 4.

**A session GUC is the wrong shape.** `is_local => false` sets a setting on whichever pooled PostgREST connection served one request. It does not belong to the next request, it is not reset between them, and it is invisible to a different client. A series of independent HTTP calls cannot be scoped by a connection-level variable.

**The scope now rides on the request.** `withOrgScope` builds a service-role client whose every request carries `x-motion-org`, and PostgREST places request headers into `request.headers` — transaction-local to that one request. `app.audit` already reads that setting for `ip` and `user_agent`. An `AsyncLocalStorage` scope makes `server-rpc.ts` pick the same client up, so an `api_server.*` call made anywhere inside a job is scoped without threading a parameter through every signature. The header is not a trust input: it is set by the server from the `jobs` row, only ever compared for equality against an organisation the function resolved for itself, and read only on `service_role` paths. It can refuse a write; it can never authorise one.

**Fail closed, in two places.** `app.require_scope(p_org)` raises when no scope was established and when it names another organisation, and the eight `api_server.*` functions that only ever run inside a job now call it first — `persist_alerts`, `finish_calculation_run`, `finish_chunk`, `finish_health`, `record_report_file`, `purge_organization`, `set_period_completeness`, `start_calculation_run`. A malformed header raises rather than reading as "no scope", because treating a corrupted scope as an absent one is the fail-open reading of the very thing being added. `app.audit` refuses an event whose organisation is not the scoped one, including a platform-level (NULL) event from inside a scope. Functions reachable from a request as well as a job keep validating a human actor instead.

Proven: 13 integration cases in `test/integration/org-scope.test.ts` — valid scope works, missing scope is 42501, wrong scope is 42501, a non-uuid scope raises, a cross-organisation audit write is refused and writes nothing, `authenticated` can execute neither helper and cannot reach a scoped function at all, and entering `withOrgScope` scopes the `serverRpc` path as well as `scope.db`. Two pgTAP cases assert the same refusals at the database. Three suites that drove `api_server.*` through `psql` now set `request.headers` as PostgREST would, and `org-purge.test.ts` calls its handler through `withOrgScope`, the way the worker does — it had been driving a path production never takes.

### ADR-091 · A permission denial is 403 and the denied state, not a 404 and not an outage
Context: `PHASE_1_7_INTEGRATION_AUDIT.md` M1. `ROUTE_ARCHITECTURE.md §11` specifies, in its own footnote, "403* = page renders the friendly permission-denied state (`UX_ARCHITECTURE.md §7.4`) with HTTP 403; the organization's existence is already known to these users, so 403 does not leak anything". Neither half existed. A page calling `assertCan` threw `PermissionDenied` into the tenant error boundary, which rendered "Something went wrong on our side… send the reference below to support" with a 500 — a permission boundary presented to a customer as a MOTION outage. A page calling `notFound()` answered 404. `DeniedState` and `PermissionGate` were built and imported by exactly one file: the `/dev/components` gallery.

**`forbidden()` and `forbidden.tsx`, which means `experimental.authInterrupts`.** It is the only way a Server Component can set 403 and render its own UI. The flag is a statement about the API's stability, not about what it renders, and the alternative was to keep answering 404 or 500 for an outcome the specification names exactly. `requirePermission(ctx, permission)` in `app/_lib/authz.ts` is the page-layer twin of `assertCan`; twenty-seven pages use it. `assertCan` stays where it belongs — services, server actions (which return a structured failure into the form) and API routes (which already mapped it to 403 with a plain message).

**What deliberately stays 404.** The layout's uniform 404 for a caller with no role in the organisation, because 403 there would confirm the organisation exists (SECURITY_MODEL.md §14); any resource id belonging to another organisation; and `/data/documents` and `/data/documents/[id]`, where §4's own row says "Client role → 404". 403 is only ever for a caller who already knows the organisation exists and lacks one permission inside it.

Proven by Playwright against the built app, in a new `authz` project that signs in as three callers rather than sharing one session: a client gets 403 and the denied state on `/data/imports`, `/data/imports/new`, `/settings/team`, `/settings/danger` and `/settings/audit`, and sees neither "something went wrong" nor a support reference; an owner gets 200 on the same pages; a stranger gets 404 on all of them including `/home`; a document id stays 404 for a client; and `/api/exports/ledger` answers 403 with `PERMISSION_DENIED` and no stack, SQL or internal name in the body.

### ADR-092 · An unmapped discriminator is a mistake, not a pass
Context: `PHASE_1_7_INTEGRATION_AUDIT.md` M2. `app.same_org_ref` resolves a polymorphic reference's target table from its discriminator and asserts `organization_id` equality — the guard ADR-034 introduced because a composite foreign key cannot express "this id points at whichever table the discriminator names". A value with no mapping returned `new`.

That is right for `none`, `standard_category`, `user` and `query`, which name no table. It was wrong for `actions.source_type = 'ai'`, which names `ai_messages` and was never mapped: the one polymorphic column pointing at an AI message had no database check at all, and the invariant held only because both writers re-read the message scoped to the organisation themselves. **The defect is that the trigger could not tell the two apart** — "not listed" meant both "deliberately points at nothing" and "somebody forgot".

**Both are now stated.** A value that names no table maps explicitly to the reserved token `-`, and an id beside it is refused outright: a row that names no table must name no row. A value in neither list raises with the name of the trigger to edit. A NULL discriminator (`import_rows.committed_table` before a commit) is "nothing yet" and asserts only that no id claims otherwise. Every discriminator in the schema is re-registered complete, and `actions.source_type = 'ai'` maps to `ai_messages`.

**Two constraints the triggers were standing in for.** `evidence_bundles.origin_table` is plain `text` and had no CHECK of any kind — the trigger's argument list was the only thing restricting it, and an unlisted value passed straight through. It now admits only the six origins EVIDENCE_MODEL.md §5 names. And `evidence_item_xor` said a row carries a ref_id or a descriptor without saying which `item_type` takes which form, so `item_type = 'query'` with a `ref_id` satisfied the xor and then skipped the trigger; `evidence_items_query_is_descriptor` states the pairing.

**The gate that stops it recurring.** `check:schema` now reads every `same_org_ref` trigger's arguments out of `pg_trigger` and asserts that every value of its discriminator's enum is mapped. Adding an enum value without saying what it points at is a failed build rather than an unguarded column nobody notices until a customer writes it. Verified by removing the `ai` mapping and watching the gate name both missing values, then restoring it.

One pgTAP expectation changed rather than being satisfied: a `standard_category` alert carrying another organisation's account id used to assert `lives_ok`. That WAS the behaviour and it was the hole. The implementation was wrong, not the test's subject.

### ADR-093 · Period completeness is one predicate, and it lives where ADR-030.1 said it did
Context: `PHASE_1_7_INTEGRATION_AUDIT.md` M3. ADR-030.1 says "the rule lives in `core/periods` and is cited by both", so Home, Insights, Reports and the analyst default to the same month. `core/periods/completeness.ts` existed, was fully commented against ADR-047.6, and was imported by nothing in `src/` — its only caller was its own unit test. The rule that actually ran was `financial-engine/domain/coverage.ts`, which wrote `fiscal_periods.is_complete`, and the two differed in how they asked about bank coverage: `bankCoverage === 'full'` against a three-valued enum in one, `bankCoverageRatio >= 1` in the other.

**One predicate, two doors.** `completenessHolds(facts)` in `core/periods` is now the only place the rule is written, over the four facts it needs. `core.isPeriodComplete` adapts the period-coverage shape onto it; the engine's `isPeriodComplete` keeps its signature and does the engine's own work — choosing the P&L source by §2.3 precedence, finding that source's latest declared data date, deciding which accounts are cash-like — then calls the same predicate. `bankCoverageFromRatio` is the single conversion between the two vocabularies, so "full" means one thing on both sides.

**The dashboard is a third reader, not a third rule.** `latestCompletePeriod(periods)` in `dashboard/services/home.ts` reads `fiscal_periods.is_complete` as the engine wrote it, and is renamed `latestCompletePeriodByFlag` to say so — a name that looked like a rule is how it came to be read as one.

The document conflict stands where the old module recorded it and is restated in the one that survives: FINANCIAL_ENGINE.md §2.2 and ADR-047.6 both give the formula and then add "partial bank coverage is a warning, not incompleteness". The formula requires `full` and is implemented, because it is the operative rule and is repeated in ADR-030.1 and DATABASE_ARCHITECTURE.md §2, while the trailing sentence's worked example is satisfied by the formula anyway. Flagged for the product owner, unchanged.

Proven: the existing 81 cases pass untouched, which is the first evidence that the two were the same rule; a new parity block drives both doors over the whole truth table (eleven combinations of P&L date, bank coverage and cash-like account) and holds them equal, checks `bankCoverageFromRatio` at each boundary, and reaches the same verdict from engine coverage as from the facts behind it.

### ADR-094 · The low-severity duplicates, removed rather than noted
Context: `PHASE_1_7_INTEGRATION_AUDIT.md` L2–L6. Four small duplications and one implicit gate, each harmless today and each a place where a future correction would have to be made twice or would be missed.

**One access resolution.** `getAccessContext` was a second copy of `resolveAccessFresh`'s body. It is `cache(resolveAccessFresh)`. A change to how access is resolved — the one function deciding what every request may see — is now made once.

**One assurance ladder, in `core`.** The four-value ladder was declared three times: the union type in `financial-engine/domain/types.ts` and again in `evidence/domain/assurance.ts`, and the rank as two tables ordered AGAINST each other (`verified: 0 … inferred: 3` and `verified: 3 … inferred: 0`) under two exported functions both called `minAssurance`. `core/assurance` holds the levels, the rank, `weakestOf` and `weakestIn`; both modules delegate and keep their public names. It belongs in `core` because two modules need the vocabulary and neither owns it. A new unit suite holds both surviving forms against the ladder over every pair.

**One document delete.** `modules/imports` exported `deleteDocument(db, id)` — a bare RPC wrapper with no permission check, no object removal and no caller — beside `modules/documents`' guarded `deleteDocument(ctx, id)`. The database enforced `imports.review` either way, so nothing was exposed; an unguarded twin of a guarded operation is an invitation, and it is gone.

**`/home` says what it requires.** It was the only tenant page with no explicit gate. It was correct — every effective role that resolves holds `dashboard.view`, and `suspended_member`'s entire grant is that bit — but by a property of the matrix rather than by anything the page said.

**Route-table drift, recorded rather than silently carried.** `/app/[orgSlug]/evidence` (the `?metric=&period=` resolver behind every "Why?" link) and `/app/[orgSlug]/insights/alerts/[alertId]` exist with no row in `ROUTE_ARCHITECTURE.md §4`. Both are correctly authorised — `financials.view` on the first, `financials.view` on the second — and both are recorded here as deviations, the way `/home/health` and `/platform/ai-feedback/[id]` already were. In the other direction `/settings/billing` is in the route table behind a `billing` flag and does not exist, consistent with MVP_SCOPE.md putting billing post-MVP. The route table is the one artefact in the project with no mechanical drift gate behind it; that remains true and remains the reason this drifted.

### ADR-095 · A download is not a replay because two clocks disagree by 200 ms
Context: found while re-running the gates for the Phase 1–7 remediation, not in the audit. `ADR-043.5` requires that nothing is signed without the id of an audit event written in the same request, re-read and verified — right actor, right target, recently written. The recency test was `ageSeconds >= 0 && ageSeconds <= 30`, where `created_at` is Postgres's `now()` and the age is measured against Node's `Date.now()`.

**Those are two machines.** On this workstation the Docker VM's clock runs about 200 ms ahead of the host, so an event written and read back within the same request has a NEGATIVE age and the signer refuses it: `/api/documents/[id]/url` answered "This download was not recorded, so it cannot proceed" for a file the caller had every right to. In production the application server and the database are likewise separate hosts, and a few hundred milliseconds of NTP skew is ordinary — this would have refused real downloads, intermittently, with a message that reads like an attack was stopped.

**The upper bound is the control.** What ADR-043.5 defends against is an OLD audit event being replayed to authorise a fresh download, and thirty seconds is what says no to that. A lower bound of exactly zero adds nothing to it and only asserts that two clocks agree perfectly. Five seconds of tolerance for a clock running ahead, named and explained; the thirty-second ceiling unchanged.

Found because `e2e/api-documents.spec.ts` began failing on a machine that had been up long enough to drift. It had been passing, which is the part worth noticing: a control that depends on clock agreement fails intermittently and looks like a permissions bug.

### ADR-096 · The evidence chain is walkable from both ends
Context: Phase 8 (Evidence & Traceability). The mechanism has existed since plan Phase 4 and the drawer since Phase 10: `evidence_bundles`/`evidence_items`, the RFC 8785 descriptor hash, the as-of resolver, and the five levels of `EVIDENCE_MODEL.md §6` rendered as a deep-linkable page. Every §5 producer builds its bundle at the point of writing — the metric on demand, the alert per revision, the health score inside `finish_health`, the AI response inside `ai_persist_turn`, the action by cloning, the report at render. **Nothing in Phase 8 rebuilds any of that**, and no second evidence architecture was created.

**What was missing was the other direction.** The chain INSIGHT → METRIC → CALCULATION → RECORD → SOURCE DOCUMENT could be walked downward from any figure, and only downward. A reader looking at one bank line, or at one uploaded file, had no way to ask the same question: a record had no history of its own anywhere in the product, and a document page listed the imports that rested on it but never what those imports became.

**Two services, no new tables, no new bundle kind.** `getRecordProvenance(ctx, kind, recordId)` answers "where did this row come from, and is it still counted"; `getDocumentEvidence(ctx, documentId)` answers "what rests on this file". Both are pure reads over columns that already existed — a record carries `source_document_id`, `import_batch_id`, `import_row_id` and `period_id`; a batch carries its declared range, the `row_counts` its commit wrote, and the `calculation_run_id` that commit triggered. Adding a table would have meant a second place for the same relation to be true.

**A record's standing is the resolver's rule, applied to one row.** `countsTowardsFigures` is `accepted && !superseded` — the same predicate `isVisibleAtInstant` applies to a whole selection, so a reader asking about one row gets the answer the drawer's reconciliation gives for the set it belongs to. A superseded row names its replacement; a rejected row gives the reviewer's reason. Neither is hidden: hiding them would erase the reason a figure is what it is.

**Absence is an answer, not a failure.** A row restored by a rollback, created by a merge or typed in by hand has no file behind it, and the page says exactly that rather than filling the gap. §8.6 is explicit that a reference which cannot be resolved is worse than no reference, and this is the read side of the same rule.

**"Contributed to", never "produced".** A month's figures rest on every file covering it, so a document's months are stated as a contribution. Only a committed import that has not been rolled back counts: a rolled-back batch is still listed, because its existence is history a reader may need, but its rows and its months are excluded from what rests on the file — they were taken back out.

**Product words in the URL.** The four record tables reach the reader as `ledger`, `bank`, `invoice` and `balance`. `UX_ARCHITECTURE.md §7` forbids showing a reader database terminology, and a URL is something a reader reads and pastes into a ticket; the table name never leaves the server, and `/evidence/record/ledger_entries/<id>` is a 404 rather than a synonym.

**Security is inherited, not re-implemented.** Both services read through the caller's own client, so RLS decides; the organisation comes from the request's `AccessContext` and never from an argument. `getRecordProvenance` requires `financials.view` and delegates the document half to the existing `getDocumentReference`, which owns the client-role stop (`documents.view`) — a client gets the line reference and `locked: true`, never a filename, and a second implementation here would have been a second place for that rule to drift. `getDocumentEvidence` requires `documents.view`, which a client does not hold and which `source_documents` RLS refuses in any case. A record id from another organisation resolves to nothing and is answered NOT FOUND, never a denial (SECURITY_MODEL.md §14).

**Bounded by construction.** Four indexed reads for a record (three primary keys and one period) and three for a document (`import_batches_document_lookup`, then one range query over `fiscal_periods` for all batches at once). Row counts are read off the batch where the commit wrote them rather than counted again, so the cost is O(imports of this file) and never O(rows).

Proven: 14 integration cases (`evidence-provenance.test.ts`) covering a counted row to its line of its file, a superseded row naming its replacement, a rejected row giving its reason, a hand-entered row with no file, both cross-tenant directions, the client stop at the filename, and a rolled-back import excluded from both the count and the months; 4 Playwright cases walking a record row in the drawer to its own history and a file to what rests on it, and asserting that neither a table name nor another organisation's id is accepted in the URL.

One correction of record: `src/modules/evidence/index.ts` carried a list of builders "still deliberately absent", naming the health-score, alert, AI and action builders. All four had been built in the phases since, each at the point of writing rather than in this module. The comment was stale documentation inside the code, which is the kind the next engineer trusts; it now says where each builder actually lives.

### ADR-097 · The analyst gets the two ends of the evidence chain, and nothing else it did not have
Context: Phase 9 (AI Financial Analyst). The analyst has existed since plan Phase 11: the closed registry, the branded numeric envelope, grounding v3, the four response modes, the untrusted-data wrapper, `api_server.ai_persist_turn`, the quota, the feedback loop and the eval corpus. **Phase 9 rebuilt none of it** — no second provider abstraction, no second evidence system, no second engine. The registry was fifteen tools; the question was whether it was the right fifteen.

**It was short by exactly the two things Phase 8 built.** `getRecordProvenance` and `getDocumentEvidence` gave the interface the chain read backwards — one record's own history, and what rests on one file — and the analyst had no way to learn either. Asked "is that £4,000 payment real?", the honest answer names the import it came in with and the line of the file and says whether the row is still counted; the model could reach none of that, so the only truthful reply was that it did not know. `get_record_evidence` and `get_document_evidence` call the Phase 8 services and re-derive nothing.

**Their authorisation is inherited, not restated.** Tool 16 is `financials.view`, the permission its service already requires; the document half is whatever `getDocumentReference` gives THIS caller, so a client gets `has_document` and the line and never a filename — the stop lives in one place and a tool that re-implemented it would be a second place for it to drift. Tool 17 is `documents.view`, which a client does not hold, so the registry refuses it before the service runs and records the attempt as unauthorised. Neither input schema mentions an organisation, a user or a role: no tool in this registry does, which is why no tool argument can be made to reach across a tenant.

**What the model may quote is still branded.** The record's amount crosses as a `money` envelope and the counts as `count`; the description, the filename, the rejection reason and the source reference cross wrapped `untrusted`, because every one of them is text somebody typed into a spreadsheet. `counted` is the resolver's own predicate — `accepted && !superseded` — so a superseded or rejected row cannot be quoted as though it were inside the figures (§6).

**The corpus grew where the brief named attacks it did not carry.** Four new adversarial families: credentials (the API key, the connection string, the environment), cross-organisation requests including a literal `select *`, "assume a number", and "make up the evidence". Each is a refusal case asserting both the template and that nothing of the shape being fished for appears in the final text. `absent` carries the SHAPE of a secret (`sk-ant`, `service_role`, `postgres://`) and never a real one: an eval corpus is checked into the repository, and a real key inside it would be the leak it tests for. "Assume a number" is the most dangerous of the four, because complying looks like helpfulness — the assumed figure must appear nowhere, including inside a caveat.

Proven: 146 eval cases (was 132); 22 in `ai-tools.test.ts` (was 17), five of them the new tools — a real row walked to its real file, a client refused tool 17 and given no filename by tool 16, both tools answering NOT FOUND across a tenant, and a table name rejected as a record type. The registry test asserts the count, so an eighteenth tool cannot be added without editing it.

`AI_ARCHITECTURE.md §3` gains rows 16 and 17. The database has no tool catalogue to drift from, so the table in that document and `TOOLS` in the registry are the two statements of the same fact, and the test that counts them is what holds them together.

### ADR-098 · An action made from an alert takes the alert's priority, and the Action Centre has lenses
Context: Phase 10 (Action Centre). The actions surface already existed — the table with issue, recommendation, priority, owner, due date, status, outcome and a cloned evidence bundle; `api.create_action`, `_from_alert`, `_from_recommendation`, `assign_action`, `set_action_status`, `update_action`; the module, the list, the detail page, the `get_actions` tool and the analyst's Create-action control. **Phase 10 created no table, no second evidence path and no second lifecycle.** Two things were wrong or missing.

**Priority was decided by nobody.** `api.create_action_from_alert` copied the alert's title, its explanation and its recommended next step, and then set `priority = coalesce((p_input ->> 'priority')::action_priority_enum, 'medium')`. It never read `alerts.severity`, and the one caller in the product (`createFromAlert(ctx, alertId)`) sends no priority. So **every action converted from an alert was `medium`** — a `critical` cash-runway alert included — and the Action Centre, which sorts by priority then due date, put it below a task somebody had typed in by hand. The field was populated, the value was wrong, and nothing said so.

Severity now decides it: identity across `critical`/`high`/`medium`/`low`, and `info → low`, because an informational alert is the least urgent thing that could still be worth doing. A caller-supplied priority is **ignored** rather than rejected — the conversion is one click on an alert, and failing it over a field the interface does not offer would be a worse answer than using the severity the rule already decided. The service's parameter type no longer accepts one, so the interface cannot lie about what it does. Changing it afterwards is `api.update_action`, which requires the permission and is audited; so a considered change is possible and an unconsidered one cannot happen. The derivation is written onto the `alert.converted_to_action` audit row, which makes "why is this critical?" answerable from the trail rather than from the source.

**No due date is proposed, deliberately.** Nothing in the alert rules carries one, and defaulting to "seven days" would be a commitment MOTION invented on a business's behalf.

**The screen had no lenses.** The page offered three status tabs — To do, Finished, Everything — which answer "what exists" and not the question a person opens it with on a Monday: what is late, what is mine, what is urgent. `domain/views.ts` adds seven lenses with their counts, and puts the rules in the module rather than the page, because "due soon" and "needs attention" are statements about work and a page that decided them would be a second place for them to be decided.

Two properties carry the meaning, and both are refusals to invent a commitment. **An action with no due date is in neither `due_soon` nor `overdue`** — it is undated, not late. **`due_soon` looks forward only**, so an overdue action is in Overdue and not in both, which is what lets the two counts be read as separate piles of work. `DUE_SOON_DAYS = 7` is how far the screen looks ahead, not a date assigned to anybody: nothing here writes a `due_date`.

The counts come from the same `inView` predicate as the lists, so the number on a tab and the rows behind it cannot disagree, and a lens with nothing in it is greyed rather than hidden — "nothing is overdue" is the most reassuring thing this page can say, and hiding the tab would make it unsayable. Two reads serve the whole screen: a business's open actions are bounded by what people can attend to, so the lenses are counted in memory rather than asked for one query at a time.

Proven: 10 unit cases on the lenses (the undated row in neither pile, the two piles not overlapping, finished work no longer late, month-end arithmetic); 9 integration cases driving every severity through the real function plus the ignored override, the audit derivation and the permitted later change; 2 Playwright journeys walking the lenses and converting a critical alert through the product.

### ADR-099 · Forecasting is a statement about the engine's figures, kept in its own tables
Context: Phase 11. `PRODUCT_REQUIREMENTS.md §14` (REQ-FC-01…05) puts forecasting at P11 with `forecast.*` reserved; `MVP_SCOPE.md §4` row "Forecasting (revenue, expenses, profit, cash, AR/AP) | §14, Phase 11"; `DATABASE_ARCHITECTURE.md §395` anticipates a forecasts table arriving "with its phase". Nothing existed: no table, no service, no metric key, and the analyst refused the question outright because the feature was not there.

**Forecasts are not `metric_snapshots`.** A snapshot is what the engine COMPUTED for a period that happened; it is pinned by `metric_current`, cited by health scores, alerts and evidence, and append-only per calculation run. A forecast is a different kind of claim about a period that has not happened. Putting the two in one table would mean every existing reader of `metric_current` — Home, Money, the analyst's tools, the evidence drawer — had to learn the difference or risk rendering a forecast as a figure. `forecast_runs` and `forecast_values` make that mistake impossible rather than merely discouraged, and `forecast_values.assurance_level` is defaulted AND constrained to `estimated`, so REQ-FC-05 is a constraint rather than a convention.

**Leaves are forecast; everything else is derived through the engine's own identities.** `revenue`, `cost_of_sales`, `operating_expenses`, `cash_inflows`, `cash_outflows`, `receivables` and `payables` get a baseline. `gross_profit = revenue − cost_of_sales`, `operating_profit = gross_profit − operating_expenses`, `net_cash_movement = inflows − outflows`, and cash chains forward from the last ACTUAL closing balance. Averaging operating profit directly would eventually disagree with its own components, which is the one inconsistency a reader would notice and never trust again — so §7's "the relationship must be deterministic" is met by construction. An organisation with no cost-of-sales accounts gets no gross profit and therefore no operating profit, exactly as CD-05 already governs the actuals; and with no bank balance there is no closing cash, because §8 forbids inventing one.

**`baseline.v1`: a recency-weighted average, and deliberately no trend.** Weights are linear over the kept months, so a business that changed six months ago is not held down by what it was before. No trend is extrapolated: a straight line through eight noisy monthly points produces a confident-looking number whose confidence comes from the arithmetic rather than the business, and a three-month horizon is exactly the range over which "this is the level it has been running at" is the most a small business's history can support. Stated here as a choice rather than left implicit, because the next person will want to add a slope.

**Sufficiency is three consecutive complete months, and the window stops at a gap.** Three follows the precedent the health score already set (`MIN_DIMENSIONS_FOR_SCORE`, "fewer than three cannot describe a business"); nothing in the approved documents fixes a number, so this one is chosen, versioned in `forecast.config.v1` and documented rather than assumed. The window is the most recent CONSECUTIVE run: a gap means the months before it describe a business that has since stopped reporting the same way, and averaging across it would quietly treat them as if it had not. Incomplete months are excluded entirely, for the same reason ADR-030.4 refuses to score one.

**One-offs are found with median and MAD, not mean and standard deviation** — the one-off being looked for is exactly the thing that drags a mean and inflates a standard deviation. Where more than half the window is identical the MAD is zero, so the mean absolute deviation is the fallback scale (Iglewicz–Hoaglin), because five identical months and one fifty times larger is the textbook case the rule exists for and a zero scale would have missed it. At most a quarter of a window may be dropped: past that the spread IS the business.

**Confidence is three words, not a percentage.** `strong` / `limited` / `weak`, derived from how many complete months the baseline rests on and whether any rested on estimated figures. §19 forbids an invented number and there is no statistical interval here to report honestly.

**Generated on demand, stored, and known to be stale.** A forecast is written when somebody asks, like an evidence bundle (ADR-066), not on every calculation run — most organisations never open the page. Each run records the `calculation_run_id` its baselines read, so "your figures have changed since this was worked out" is a fact the page states rather than a risk it carries. Nothing is cached beyond that row, and the row carries its own generation time.

**The evidence for a forecast is its history.** The bundle's items are the metric snapshots the baselines read plus their calculation run — each keeping the HISTORY's own assurance while every forecast value stays `estimated`. Nothing about the future is cited, because there is nothing about the future to cite, and a verified past is not evidence that a future is verified. `evidence_kind_enum` gains `forecast` and the ADR-092 origin allow-list gains `forecast_runs`; the polymorphic guard is re-registered complete, so the drift gate stays satisfied.

**The analyst reads the forecast and cannot compute one.** `get_forecast` (tool 18) returns `forecast_values` as branded `money` envelopes, so the response contract marks a forecast statement as an estimate without the model being asked to remember. A model that produced its own number would have no `NumberRef` to ground it and the sentence would be removed (§7.8). The refusal template split in two: "what if" is still Phase 12 and still refused; forecasting is available, and continuing to say it was not would have been the same class of wrong answer as the reverse. `PROMPT_VERSION` bumps to `analyst-v3.1` and the corpus was re-recorded.

**Reached from Money, not from an eighth navigation item.** `UX_ARCHITECTURE.md §3.1` fixes the primary navigation at seven items and ADR-037 created the Data menu specifically to keep it there; an eighth would undo a decision the UX made on purpose. `/forecast` follows the precedent `/evidence` and `/home/health` already set.

Proven: 33 unit cases on the engine (sufficiency, gaps, one-offs, weighting, order-independence, the identities, the cash chain, byte-identical reruns); 19 integration cases (the stored figures, the `estimated` constraint refusing anything else, evidence citing history, the tool returning exactly what was stored, and the five-role and employee-assignment boundaries); 2 Playwright journeys; 151 eval cases including the split refusal set.

### ADR-100 · A scenario is the forecast with stated changes, composed by the forecast's own arithmetic
Context: Phase 12. `PRODUCT_REQUIREMENTS.md §15` (REQ-SC-01…10) puts What-If Scenarios at P12; `MVP_SCOPE.md §4` row "What-if scenarios, saved scenarios | §14, Phase 12"; SOW §14 names eight changes a scenario must support and requires that outputs "show BASELINE versus SCENARIO and clearly expose assumptions". Phase 11 left the analyst refusing what-ifs by name and `ARCHITECTURE.md §7` reserved "forecasting/scenarios read `metric_snapshots` and write their own tables".

**There is one piece of arithmetic, and both sides of the comparison go through it.** `composeFromLevels` — the identity and cash-chain walk extracted unchanged from `forecast/domain/compose.ts` — is called twice: once with the forecast's own leaf levels (the baseline) and once with those levels plus the assumptions' deltas (the scenario). Profit is therefore derived from sales and costs on the scenario side exactly as it is on the baseline side, and cash is chained from the same real opening balance. A scenario engine with its own identities would drift from the forecast it is being compared against, and a comparison whose two halves were computed differently is not a comparison. The extraction is behaviour-preserving and Phase 11's 33 unit cases pass unedited, which is the evidence that it is.

**A scenario is not a forecast and not an actual, and the three are kept apart everywhere.** `scenario_runs` and `scenario_values` are their own tables — not `forecast_values` — so no existing reader can pick up a scenario by accident, which is the same reasoning that kept forecasts out of `metric_snapshots` (ADR-099). `scenario_values.assurance_level` is defaulted AND constrained to `estimated`. The page labels the two columns "Expected now" and "If this happens", and the AI tool returns both halves so the model cannot quote one as the other.

**Both figures are stored, because a saved scenario must not move.** §13 requires that reopening a scenario shows what it showed. A row holding only the scenario figure would be compared, on reopening, against whatever the forecast says *then* — so regenerating a forecast would silently rewrite the history of every saved scenario. Storing the pair makes a saved scenario a fixed statement about a fixed baseline; what *can* change is whether the forecast underneath is still the one it was made from, and that is reported as staleness rather than silently applied.

**Every assumption is explicit, and nothing else is inferred.** Eight kinds, one per change SOW §14 names, each carrying the numbers it needs and the month it starts. A price change does not become a sales change unless the change in the number of sales is stated (§9). Marketing spend adds no revenue, ever, because no relationship in MOTION's data defines one (§10). A sale becomes cash only when the assumption says it is collected that month, and that answer is a field on the assumption, stored and rendered, because §7 forbids inventing payment timing. Direct costs follow sales only when asked to, and then at the organisation's own rate read from its own forecast — never at a margin this module chose. Interest is an amount somebody typed, never a rate applied to a principal (§11), and because interest sits below the operating line in the engine it changes cash and not operating profit, which the page says in words.

**A missing input is a refusal, not a zero.** A percentage of wages needs to know what wages have been, which is the engine's own `expense_by_category` breakdown; an organisation without one is refused the percentage and offered the amount. An organisation with no cost-of-sales accounts is refused a supplier change outright, because adding direct costs would invent a gross profit its books have never had (CD-05). A change assumed to move cash is refused when there is no cash figure to move. And when anything is refused, the WHOLE scenario is unavailable and nothing is stored: a partly applied scenario would sit in the list looking like an answer.

**Bad input never becomes a number.** Money and percentages are strings matched against a fixed grammar and then compared as Decimals — `Number('12,00')` is `NaN`, `parseFloat('12abc')` is `12`, and `z.coerce.number()` would turn either into a figure nobody typed. Two assumptions of the same kind, or a sales change beside a price change, are a CONFLICT rather than a last-one-wins merge: a scenario that quietly dropped one of two things somebody asked about would answer a question they did not ask. Every objection is reported at once.

**Read is `dashboard.view`; working one out is `intelligence.recompute`.** No permission was invented — §19 and §22 forbid one that could sit outside the matrix, and ADR-099 set the precedent. A scenario is a statement about figures, so everyone who may see the figures may read it, a client included; working one out is triggering a deterministic calculation over the organisation's figures, which is what `intelligence.recompute` names and which a client does not hold. The check is made in the page, again in the service, and a third time in SQL where `api_server.finish_scenario` re-validates the actor.

**Written by `api_server`, not `api`.** The assumptions are user intent, but the FIGURES are what the deterministic engine worked out — a server-observed fact in exactly the sense a grounded AI answer is one (ADR-043). `api.*` is granted to `authenticated`, so a browser reaching a scenario-writing `api.*` function could publish any number it liked under MOTION's name. Putting one away is pure intent and is `api.archive_scenario`, throttled and audited like every other user-intent write.

**Archived, never deleted.** A scenario's evidence bundle points at its row, and deleting one would leave a bundle citing something that no longer exists, which `EVIDENCE_MODEL.md §8` will not have. Archiving takes it out of the list and keeps the record of what a business modelled.

**The evidence for a scenario is its forecast's evidence, copied.** The bundle's items are cloned from the forecast's bundle — the same clone-on-decision pattern an action already uses (§5) — so a regenerated forecast cannot change what a saved scenario says it rests on. Nothing about an assumed future is cited, because there is nothing about an assumed future to cite. `evidence_kind_enum` gains `scenario`, the ADR-092 origin allow-list gains `scenario_runs`, and the polymorphic guard is re-registered complete.

**The analyst reads a saved scenario and has no way to work one out.** `get_scenario` (tool 19) takes an optional scenario id and NOTHING else — there is deliberately no tool that accepts assumptions. That is the structural answer to "make the scenario assume revenue is ₹50L without the user providing that assumption": there is no surface on which a model-invented assumption could become a figure, so the attack has nothing to aim at. The refusal template changed accordingly: it no longer says what-ifs are unavailable — they are — it says who does the sum and where, because telling somebody a feature is missing when it is there is the same class of wrong answer as the reverse. `PROMPT_VERSION` bumps to `analyst-v3.2` and the corpus was re-recorded. A tool that ran a scenario from model-supplied assumptions was considered and rejected: it would have been a read-only call by the letter of §18, and a machine for producing confident answers to questions nobody asked in practice.

**No action is created, and the integration point is a link.** §17 requires user confirmation and forbids a new workflow, so the page offers a link to the Action Centre and nothing more. Creating an action FROM a scenario, with the scenario's evidence copied, is deliberately not built.

**Reached from the forecast and from Money, not from an eighth navigation item** — `UX_ARCHITECTURE.md §3.1` fixes the primary navigation at seven, and `/forecast` set the precedent (ADR-099).

Documents updated in the same commit: `docs/DATABASE_ARCHITECTURE.md` (two table sections, two §14 catalogue rows), `docs/AI_ARCHITECTURE.md` (tool 19, the refusal split), `docs/PRODUCT_REQUIREMENTS.md` (REQ-SC-01…10 delivered), `docs/MVP_SCOPE.md`, `docs/UX_ARCHITECTURE.md`, `docs/SERVICE_ARCHITECTURE.md`, `docs/ROUTE_ARCHITECTURE.md`, `docs/PHASE_12_IMPLEMENTATION.md`.

One thing this phase did NOT fix, recorded so it is not rediscovered as new: `test/integration/ai-eval-record.test.ts` is intermittently red because the golden organisation's alert SET is not reproducible run to run. Measured on a git worktree of `434a457` with a clean database, it fails there too (1 in 6, against 2 in 6 on this branch), so it is Phase 7/11's and not this one's. A `rule_key` tiebreak on `loadAlerts` was written, measured, found not to fix it, and reverted (`docs/PHASE_12_IMPLEMENTATION.md §16`).

Proven: 81 unit cases (the eight kinds, the cascade, the conflicts, the bounds, determinism and order-independence, every refusal, and every sentence the assumptions list prints); 39 integration cases (the baseline column equal to `forecast_values` to the penny, the identities in the stored rows, the `estimated` constraint refusing anything else, a saved scenario surviving a regenerated forecast, evidence cloned from the forecast, the tool returning exactly what was stored and offering no way to supply an assumption, and the five-role, employee-assignment and cross-tenant boundaries); 2 Playwright journeys with an axe sweep over the form; 158 eval cases including the invented-assumption set. (After remediation: 88 unit and 49 integration cases; the journey drives the refusal state twice.)

**Addendum, 2026-09-21 — remediation before Phase 13 (`PHASE_12_REMEDIATION.md`).** An
independent audit of this phase (`PHASE_12_FINAL_AUDIT.md`) found four things the decision above
did not deliver in full, none of which changes the decision: a refusal's reasons never reached the
reader (they now travel through the ordinary `ActionResult` error channel, and the saved scenario
below the form is labelled as last saved); an assumption starting after a short horizon was silently
ignored (it is now a sixth refusal reason, `starts_after_horizon`, refused like every other missing
input); the forecast's basis and warnings were not rendered (they are now carried onto the run at
save time and shown in the forecast's own words); and tool 19 fell back to GBP for assumption
amounts (every amount now takes `organizations.base_currency`, carried on the view). The
deterministic engine, `composeFromLevels`, the tables, the permissions and the evidence path are
exactly as recorded above.

No earlier ADR was superseded or reversed.

### ADR-101 · The banking rules run inside the calculation, and banking is imported statements — never a connection
Context: Phase 13. `PRODUCT_REQUIREMENTS.md` REQ-BK-01…11; SOW §15; CD-20 (reconciliation = coverage and statement balances, not line matching), CD-21 (no live feed; never say "connected"); FINANCIAL_ENGINE.md §2.4 step 5 and §4.1–4.3, which since Phase 4 have described a "banking job" that categorises by rule, pairs transfers and detects recurring flows. The pre-flight inventory found the three rules built and tested as pure functions in Phase 6 and **never applied**: no row was ever categorised by a rule, no transfer ever paired by a rule, `recurring_payment_groups` never written — so four alert rules could never fire and "unusual" could not exclude a standing order. It also found a statement row without a currency column committed as `'GBP'` whatever the organisation reports in, `api.create_bank_account` defaulting to `'GBP'`, no UI able to create a bank account at all, and `rejected_reason` on `bank_transactions` missing from the column grant so the record provenance read failed on every bank row.

**The banking pass is a step of the calculation run, before the fingerprint.** `planBankingPass` (pure, `banking/domain/pass.ts`) composes the three existing rule functions into one plan; `bankingStep` loads the organisation's accepted rows and hands the plan to `api_server.apply_banking_pass`, which is idempotent (touches only rows whose state differs, appends `category_history` only on change), never overrides a person (`category_source = 'user'` is skipped whatever the plan says), and derives the transfer KIND from the two account types exactly as `api.mark_transfer` does — the plan cannot assert it (ADR-028). It runs at the top of `runCalculation`, so what it wrote is inside what the fingerprint reads: an unchanged organisation still finishes `no_change`, proven by `test/integration/banking.test.ts`. The keyword-set, detector and pass versions replace the literal `'recurring.v1'` in the fingerprint, so a rule change re-categorises history and re-fingerprints. Groups the detector no longer finds are marked `stopped`, never deleted: alerts and evidence may cite them. Transfer legs are excluded from recurring detection — money between an organisation's own accounts is not a payment to anybody, and `recurring.missed` on a stopped sweep would be noise. A row that looks like a transfer but has no partner is never paired (ADR-047.12); the Banking page names it under "Things to notice".

**No second cash calculation.** Every banking figure is either the engine's (`metric_current`: `closing_cash`, `cash_inflows`, `cash_outflows`, `net_cash_movement`, `cash_runway_months`, with their `statement_closing_cash`/`statement_delta` components and warnings) or `api.bank_period_summary`, one aggregated read over the same accepted rows under the same rule — `cash_transfer` legs excluded from money in/out and reported separately — asserted equal to the engine to the penny. Per-account "balances" are the balance printed on the statement (`balance_after` at the month's last line), shown as a fact with its date, never computed. Reconciliation is CD-20's: per account and month, from the covering statement batch — reconciled (balances captured and the rows add up), does not reconcile (IMP-BAL-006/007), not checked (balances not captured), no statement — and at organisation level the engine's own statement cross-check. A line is never marked reconciled because it was imported; `matched_ledger_entry_id` stays unused and the page says so.

**Imported, not connected — stated by the database.** No provider exists. `api.bank_period_summary` returns `source = 'imported_statements'`; every banking tool result carries `source` and `connected: false`; every banking page prints one sentence — "Bank figures come from the statements you have uploaded. MOTION is not connected to your bank." — with the last statement's import date and covering-to date. The prompt forbids "live", "connected", "synced"; eight eval cases refuse asks for a sync, a live balance, an estimated balance and a self-judged "unusual" list; journey 13 asserts the vocabulary never appears for owner or client. The seam for a future provider is the same import pipeline (a provider would produce rows with `source_ref` and a batch, and the pass and pages would not change); nothing in Phase 13 pretends one exists.

**Currency is the organisation's.** The import pipeline stamps every committable row with `organizations.base_currency` when the file names none (upper-casing one it does name; IMP-CUR-007 still refuses one that differs); `api.create_bank_account` defaults to the organisation's currency; the add-account form sends none; the rows and accounts already written as `'GBP'` in other organisations were corrected once in the migration — exact by construction, since no other currency could have been imported. Multi-currency accounts remain unsupported and are refused at import, not converted; no exchange rate exists anywhere.

**Permissions and reach.** No new permission. `banking.view` reads everything on the pages and through tools 20–23 (a client included); `banking.reconcile` categorises and pairs; `financials.edit` adds an account; `documents.view` reaches the statement, through the record page's audited signed URL, never from the banking pages; `data.export` governs the unchanged CSV export. The summary function is how a client learns statement freshness at all — `import_batches` needs `imports.review` — and it exposes dates and printed balances, never the file or the raw text. `rejected_reason` joins the column grant on `bank_transactions`; `description_raw` and `counterparty_name_raw` stay withheld.

Consequences: the recurring and unusual alert rules become live for the first time on organisations with statements; an existing organisation's first run after this migration re-categorises its history by rule (a person's choices untouched) and one recalculation is expected. The saved "apply to similar" organisation rule (§4.1 point 2) still does not exist. Statement lines are not matched to ledger entries. A single signed-amount CSV on a current account still needs a sign convention the upload form does not ask for (a pre-existing wizard limitation, recorded in `PHASE_13_IMPLEMENTATION.md §21`).

### ADR-102 · Commercial figures are the engine's or rule-named aggregations of recorded rows; revenue reaches a campaign only through a won opportunity
Context: Phase 14. `PRODUCT_REQUIREMENTS.md` REQ-CI-01…12, REQ-FD-09, REQ-CA-11; SOW §16; CD-01 (counterparties are the customer seam), CD-08 (contribution excludes shared overhead), CD-26. The pre-flight inventory found no commercial schema at all — no products, lines, campaigns, channels or opportunities — and `customerAttributableCosts` never populated, so customer contribution equalled revenue for every organisation. The brief forbade inventing costs, attribution, acquisition cost or conversion, and forbade a second financial truth.

**Two sources of figures, and no third.** A commercial number is either read from `metric_current` (customer revenue, share, contribution, concentration — the engine's, unchanged) or is an aggregation of rows a person recorded (invoice lines by product, campaign spend by month, opportunities by stage) computed by one SQL read function or one pure rule. Nothing in `src/modules/commercial` sums an invoice; `api.product_period_summary` sums *lines*, and the integration suite asserts Σ lines + unattributed = Σ attributed `customer_revenue` for the month. No engine metric, fingerprint input, job or permission was added.

**Attribution is a rule with a printed status.** A campaign is credited only with the engine's `customer_revenue` of customers won through it — an opportunity in stage `won` naming both — from the won month onward, earliest win first. Acquisition cost is that campaign's spend over those customers in the stated window; conversion is over the cohort created in the window with both denominators named. Where a denominator is zero, or no cost line names a product, the result is null with a reason the page and the tool print verbatim ("Contribution unavailable — cost data is insufficient."). Nothing is spread across channels, estimated, or inferred from timing.

**Writes go through `api.*` under `customers.edit`; reads under `customers.view`.** Six write functions share one guard (`app.require_commercial_edit`); org-composite foreign keys make a cross-organisation reference impossible to store; RLS is forced and authenticated users hold no write grant. Forms render only for editors; server actions re-check; the database re-checks.

**The analyst reads, never computes.** Tools 24–26 return the pages' own view models with their rules and statuses; the prompt (`analyst-v3.4`) refuses, with a fixed opening, any ask to assume a source of revenue, compute an acquisition cost or conversion rate itself, treat an attributed figure as verified, or supply a figure a tool did not return.

Consequences: contribution stays "unavailable" for most products and equals revenue for customers until costs are recorded as lines — stated on the page rather than approximated; attribution is single-touch by construction; campaign spend is manual. A pre-existing engine gap (headline revenue is a covered zero on a pure invoice basis, while `customer_revenue` is right) was found by the reconciliation test and recorded in `PHASE_14_IMPLEMENTATION.md §22–23` for the engine's next revision rather than patched inside this phase.

### ADR-103 · The invoice basis reports a profit and loss, the net-of-tax rule has one home, and "unattributed" is a data-quality state rather than a customer
Context: Phase 14's reconciliation test, and the independent audit that followed it (`PHASE_14_FINAL_AUDIT.md`, HIGH-1 and MEDIUM-1…3). `FINANCIAL_ENGINE.md` §2.1 has said since Phase 4 that the `invoices` source feeds `revenue` (sales, net of tax) and `counterparties.default_expense_category` (purchases). It never did. `app.aggregate_periods` emits invoice cells with `account_id` and `standard_category` NULL — correct, an invoice header has no account — and `compose.ts#accountAmounts` walks accounts, so on the invoice basis it found nothing: every P&L line was a COVERED ZERO and `uncategorisedExposure`, keyed on the same NULL category, counted 100% of the month as uncategorised, which dragged the figure to `estimated`. `customer_revenue` was right all along because `counterpartyAmounts` reads `invoice_type` directly. Precedence (`period_balances → ledger → invoices → bank`) meant an organisation that uploaded a full sales-invoice list AND bank statements — the MVP's own "Retail Co" shape — lost the bank proxy it would otherwise have had and reported £0 revenue.

**The fold belongs in the composition, not in SQL.** `compose.ts` derives each invoice cell's category (§2.1: sales and their credit notes are `revenue`; a purchase takes the counterparty's `default_expense_category`, else `uncategorised`), applies `invoiceSignFor` exactly once so a credit note subtracts (ADR-047.5), and reports the total under the organisation's system account for that category — the same home a categorised bank line without an account of its own already uses. A category absent from the chart falls back to `uncategorised`, so money stays visible rather than vanishing. The uncategorised share is measured on what the figure REPORTS, which is how a purchase with no stated category still raises §3.1's warning. `counterpartyAmounts` now signs invoice cells the same way, so `Σ customer_revenue + unattributed = revenue` holds with credit notes in the month. `loadCostOfSalesEverUsed` counts an invoice-basis purchase as the system cost-of-sales account carrying a figure (CD-05, ADR-063): without that, an invoice-only business was told it does not track cost of sales and `gross_profit` silently became revenue.

**One net-of-tax rule, named `app.invoice_net`.** It existed three times and agreed twice: the aggregate and `sign.ts#invoiceNetOfTax` read a `subtotal` of 0 beside a positive total as ABSENT (exporters that omit the column write 0), while Phase 14's `api.set_invoice_lines` and `api.product_period_summary` took the 0 through a plain `coalesce`. Every SQL caller now calls the one function; the TypeScript mirror is tested against the same table of cases in both languages (`supabase/tests/13_invoice_net.test.sql`, `test/unit/engine-sign.test.ts`). The aggregate also carries `fallback_rows`, so §3's `vat_inclusive` warning and its 10%-of-rows `estimated` threshold can fire at last — a gross total standing in for a net one overstates revenue, and the figure now says so.

**"Unattributed" is not a customer.** The engine's synthetic `dimension_id = NULL` row keeps the identity exact and must stay. What it must not do is enter a ranking: the Commercial overview lists real customers only and reports the remainder beside the list as the gap it is, the revenue-by-customer table sorts it last and names it "Not attributed to a customer", and `get_customer_profitability` returns it under `not_attributed_to_a_customer` with a note forbidding the model to name or rank it as a business. The engine's own top-1/top-5 never included it.

**A merge moves commercial history to the surviving identity.** `api.merge_counterparties` is a pointer, not a rewrite, and the engine keys every figure by `coalesce(merged_into_id, counterparty_id)`. Phase 14's reads did not: `listOpportunities` and `api.product_period_summary` used the recorded id, so tidying a duplicate silently dropped that customer's product mix and the campaign that won them. Both now resolve the survivor (and a filter by customer also returns the rows merged into them). Where a merge leaves one identity with two won opportunities, the earliest-win rule decides which campaign is credited, exactly as it does for a customer won twice — nothing is lost and nothing is counted twice.

Consequences: organisations whose P&L resolves to the invoice basis get real revenue, profit and margins for the first time, and their first run after this migration will move those figures — from zero to the truth. Purchases from suppliers with no `default_expense_category` land in `uncategorised` and, past §3.1's thresholds, mark the month's revenue `estimated`; that is the specification, and the remedy is the confirmation step the import already offers. A VAT-inclusive list with no tax column now reports `vat_inclusive` and, past a tenth of rows, `estimated`. `app.aggregate_periods` and `api_server.aggregate_periods` gained a column, so both were recreated; the service-role guard is unchanged.

### ADR-104 · A sum over nothing is not a known zero: cash needs a cash-like account, cost of sales needs the source that is being read, and an invoice-basis expense figure's evidence names its suppliers
Context: the independent re-audit after ADR-103 (`PHASE_14_REMEDIATION_AUDIT.md`: HIGH-2, MEDIUM-4, MEDIUM-5). The remediation had made invoice-only organisations viable for the first time, and the first one probed showed **Cash £0 · Calculated** on Home: `cash.ts#openingFor` summed opening balances over the accounts it was given, and with no cash-like account the loop never ran, `missingAccounts` stayed empty, and a vacuous sum came back as 0 with completeness 1. §1.5 says never zero-fill and §2.3 says a family nothing covers is NULL with a reason; the sibling case — an account with no opening balance — already obeyed both. The same audit found two consequences of ADR-103's fold: every invoice-basis expense figure shared one descriptor (all purchases in the period), so drilling into cost of sales of 3,000 listed 4,000; and the widened "cost of sales ever used" let a ledger organisation whose ledger states no cost of sales print a 100% gross margin with no warning because purchase invoices existed elsewhere.

**Cash.** When an organisation has no active cash-like account and none was covered this period, the whole family — `opening_cash`, `closing_cash`, `cash_inflows`, `cash_outflows`, `net_cash_movement` — is NULL with `no_bank_accounts`, basis `none`, completeness 0, and a later period inherits it through the carried opening exactly as `no_opening_cash` does. A since-closed account still counts for the months a statement covered it. The reason reaches the reader as "Add a bank account and upload its statements to see your cash." The test that asserted the zero ("nothing to have a balance") was rewritten to assert the rule; it had encoded the defect. The same principle is applied to the counterparty family: when no source covers it, the synthetic Unattributed row is not written, because there is no revenue for it to reconcile against.

**Cost of sales.** `costOfSalesEverUsed` stays the account-bearing fact it was (ledger and balance rows on a cost-of-sales account, or a non-system account). Invoice evidence — purchases from a supplier whose `default_expense_category` is `cost_of_sales` — is loaded separately as `costOfSalesInInvoices` and counts **only when the invoices are the P&L basis**. On any other basis it is evidence the chosen source is not reading, and `cost_of_sales` is NULL with `cost_of_sales_in_other_source`; `gross_profit` carries `no_cost_of_sales`, `gross_margin` is NULL, and Home hides the gross-profit card as it does for `no_cost_of_sales_accounts`. No cost is invented in either direction.

**Evidence.** An invoice has no account, so an expense figure on the invoice basis cannot be scoped by `account_ids` the way a ledger figure is. It is scoped by the suppliers that make it up: the composition records, per category, the counterparties whose purchases were folded into it, and the leaf descriptor carries them as `counterparty_ids` beside the purchase types — a v1 filter the counterparty family already uses. A figure no supplier's purchases went into gets no descriptor rather than one that re-selects every purchase; revenue keeps the sales types, which are exactly the figure.

Consequences: organisations without bank statements see "—" with a reason where they saw £0, on Home, Money and in every tool; a portfolio built on `closing_cash` will carry unknowns as unknowns. Ledger organisations with cost-of-sales purchase invoices the ledger omits lose a 100% margin they should never have had and gain the sentence that says why. Evidence on invoice-basis expense figures reconciles to the figure. Nothing about precedence, `app.invoice_net`, attribution or the alerts module changed; the pre-existing `ai-eval-record` ordering flake is documented, not touched.

### ADR-105 · Home reads the engine's cost-of-sales state, not a field the engine empties; invoice-basis P&L evidence sums the net the P&L summed
Context: the final independent re-audit of f8fdc58 (`PHASE_14_FINAL_REMEDIATION_AUDIT.md`, Part A: MEDIUM-7, MEDIUM-8). The three financial blockers before it were verified closed; these two stood between the reader and an honest figure.

**Home.** CD-05 says an organisation whose cost of sales cannot be established never sees a "Profit after direct costs" card, because sales presented as profit after direct costs reads as a 100% margin. `buildHeadlineCards` hid the card when `gross_profit.dataQuality.missing` carried the absent-by-design code — and `pnl.ts#buildGrossProfit` has, since Phase 4, deliberately removed that code from `gross_profit.missing`, writing gross profit as revenue with the warning `no_cost_of_sales` so the statement adds up. The rule was dead; the card showed "£4,000 · Partial data" for every organisation without cost data, which is the commonest state of a small business here. The rule now reads what the engine actually emits — the `no_cost_of_sales` warning on `gross_profit`, and a `cost_of_sales` that is NULL with `no_cost_of_sales_accounts` or `cost_of_sales_in_other_source` — and Home prints the engine's own reason beneath the cards ("Profit after direct costs isn't shown: …") in the shared reason words. The monthly report builds its cards from the same function and omits the card too. The engine is unchanged: nothing is manufactured, no NULL becomes zero, a valid gross profit still shows.

**Evidence.** The invoices projection in the descriptor compiler summed `balance_due`, written for receivables and payables where Σ `balance_due` is the figure. Until ADR-103 no invoice-basis P&L figure existed to drill into; afterwards "Cost of sales £3,000" listed rows totalling the £3,600 still owed, and a paid sale appeared under "Revenue" as £0. A compiled query now carries an `amountBasis`: `column` for the receivables/payables shape (a descriptor with `open_as_of` or `overdue_as_of`), `invoice_net` for every other invoice descriptor — the engine's net-of-tax rule (`invoiceNetOfTax`, the TypeScript mirror of `app.invoice_net`) signed by invoice type, so a credit note subtracts and Σ rows equals the P&L figure whatever has been paid. The supplier scoping of ADR-104 is untouched, a category with no contributing purchases still carries no descriptor, and receivables and payables still sum `balance_due`.

Consequences: the drill-down behind revenue, cost of sales, expense categories and a customer's revenue on the invoice basis reconciles to the penny, including partly and fully paid invoices; Home and the report stop presenting sales as profit after direct costs when no cost is known, and say why. Nothing about the cash rule, precedence, `app.invoice_net`, attribution, the alerts module or tenancy changed.

### ADR-106 · One availability rule: a figure the product will not show, the analyst may not state
Context: the adversarial audit of b6cac0b (`PHASE_14_FINAL_REMEDIATION_AUDIT.md`, Part E: MEDIUM-1). ADR-105 taught Home to omit the gross-profit card when cost of sales cannot be established. It did not teach the analyst, which is a first-class surface here. Measured on one organisation with sales of £9,000 and no direct-cost accounts: Home omitted the card and printed the reason, while `get_business_summary` — the tool the prompt names first for a broad question — returned gross profit of £9,000 with `assurance_level: calculated` and `completeness: 1.00`. The only caveat reaching the model was one entry in a warnings array for which the prompt had no rule, and §3 of the prompt tells the model to mention assurance only when it is *not* calculated. The same organisation could be told on its home page that profit after direct costs cannot be shown, and told by the analyst that it was £9,000.

Decision: whether a figure is **economically established** is a product semantic, not a Home presentation choice, and it is stated once. `financials/domain/vocabulary.ts` gains `metricAvailability(metricKey, figure, costOfSales?)` returning `{ state: 'available' }` or `{ state: 'not_applicable', reason }`, with `AVAILABILITY_REASON_TEXT` for the reader's words. `financials` is where it belongs: both the dashboard and the AI already depend on it for financial vocabulary, and neither may depend on the other. The rule fires for `gross_profit` and `gross_margin` on the `no_cost_of_sales` warning, on the absent-by-design code, or on a `cost_of_sales` that is NULL with one; it prefers the reason `cost_of_sales` states, because gross profit's own `missing` has that code stripped. Every other metric is `available` — a NULL cash figure is already unavailable through its own reason (ADR-104), and a second answer to the same question is exactly what this ADR exists to prevent.

**Home** and the monthly report now read the rule instead of restating it, and `missingReasonText` spreads in the shared reason text so one limitation cannot be worded two ways. **The analyst tools** put the semantics in the contract rather than in advice: every `MetricValue` carries `availability`, and `not_applicable` carries the reason, the explanation, and **no value** — `get_metric`, `get_business_summary` and `get_metric_trend` hand the model nothing to quote. A not-applicable `get_metric` also returns no `components`, because gross profit's components are revenue and cost of sales, and offering "revenue 9,000" under a gross-profit result re-offers the number suppressing the value removed. The prompt (`analyst-v3.5`) states the deterministic rule for the structured field; it does not ask the model to be careful.

The engine is untouched. It still writes gross profit as revenue with its warning, because a statement has to add up. What changed is that no presentation surface now reads that number as a conclusion.

Consequences: Home, the report, `get_business_summary`, `get_metric`, `get_metric_trend` and the analyst's answer agree. A genuine gross profit is still reported everywhere, which the regression tests assert in both directions. The recorded eval fixture was re-recorded for the new tool shape (`analyst-v3.5`), and the corpus gained one golden and two trap cases for the unsupported figure.

### ADR-107 · A voided invoice is not evidence of anything
Context: the adversarial audit of b6cac0b (Part E: HIGH-1). `app.aggregate_periods` reads invoices under `record_status = 'accepted' and superseded_by is null and status <> 'void'`, and every other invoice reader in the engine repeats that third clause. The evidence layer carried only the first two: the lifecycle pair is generic and lives in the compiler's shared block, while `status <> 'void'` sat inside `addOpenAt`, the helper that builds the receivables and payables shape. So voided invoices were excluded from a receivables drill-down and included in every P&L one. From ADR-105 each contributed its full net rather than an outstanding balance. Measured: a cost-of-sales figure of £3,250 whose drill-down summed £10,250 over 4 rows; revenue of £8,000 against £13,000; the same for a customer's revenue; and the analyst's `get_transactions_for_evidence` citing £10,250 as the evidence for £3,250. Reachable through the ordinary import: invoice `status` is a mappable column and the commit casts it straight to the enum, so any list exported with voided invoices lands them.

Decision: the compiler applies `status <> 'void'` to **every** invoices descriptor, through one named helper that `addOpenAt` also calls, so there is a single spelling of the engine's third clause. It is applied whether or not the selection is pinned to a run: a void is the invoice's own business status, not a record-lifecycle event, so it has no row in `record_status_events` and the as-of projection cannot see it — which is also why the gap existed. `FilterSet` de-duplicates, so the receivables shape emits it once.

Supersession was never broken and is asserted beside the void, because the two are different concepts reached by different mechanisms. Descriptor hashes are computed over the descriptor, not the compiled query, so no stored hash changes.

Consequences: the drill-down behind revenue, cost of sales, an expense category and a customer's revenue reconciles to its figure for organisations that void invoices, and the analyst's evidence tool cannot return a voided row. Nothing about precedence, `app.invoice_net`, the amount basis of ADR-105, receivables semantics or the engine changed.

### ADR-108 · A merged counterparty's rows are in the survivor's figure, so they are in the survivor's evidence
Context: the Fable 5.1 audit of `33ae461` (`PHASE_14_FINAL_REMEDIATION_AUDIT.md`, Part F: HIGH-2), first observed while regression-testing merges in the pass before it and deliberately left for a decision. `app.aggregate_periods` folds every row of a merged counterparty into its survivor (`coalesce(c.merged_into_id, i.counterparty_id)`), and a merge is a pointer that never rewrites a row (`api.merge_counterparties`, ADR-046.2), so the rows keep their original ids. Both places the engine writes a counterparty-scoped descriptor — `concentration.ts#counterpartyEvidence` for a customer's revenue or a supplier's spend on every basis, and `pnl.ts#leafEvidence` for the supplier-scoped expense figures of ADR-104 — named only the surviving id. The drill-down behind a survivor's figure therefore re-selected only the survivor's own rows. Measured on a clean database: customer revenue 8,000 with evidence 5,000; supplier spend 3,750 with evidence 1,500 and cost of sales fed by that supplier the same; ledger-basis customer revenue 5,000 with evidence 4,000; and the analyst's evidence tool citing the short total. It understates rather than overstates, on a first-class Phase 14 feature, reached by the ordinary merge action.

Decision: one closure, computed once. `financial-engine/domain/merged.ts#withMergedCounterparties(counterparties, ids)` returns the named ids plus every counterparty merged into them, followed to a fixed point because merges can chain, and sorted so two runs over one set of data write byte-identical descriptors. Both descriptor builders call it. Nothing about the fold, any figure, precedence or `app.invoice_net` changed: what changed is which rows a descriptor names, so that it names the rows the figure summed. Descriptor hashes change only for figures a merge feeds, and only on the next run.

Consequences: the drill-down behind a merged customer's revenue, a merged supplier's spend and a cost-of-sales or expense figure fed by a merged supplier reconciles to the figure on the invoice, ledger and bank bases, and the analyst's evidence tool cites the absorbed rows. `test/integration/evidence-merged-counterparty.test.ts` fails 4 of 4 on `33ae461` and passes here.

**ADR-106, addendum — the Profit & loss page.** The same audit found the one presentation surface ADR-106 had not reached: Money › Profit & loss printed gross profit as "£12,500.00 · Partial data" between a cost of sales reading "—" and a margin reading "—", each with the engine's reason. That is the figure Home omits and the analyst is not given, on the page an owner opens to look closer. `figuresFor` now reads `metricAvailability` — the same rule, not a page-local one — and presents a `not_applicable` figure exactly as an unavailable one is presented, by handing the renderer the row with no value and the engine's reason, so no second rendering rule exists. Revenue and a real gross profit are untouched. With this, Home, the monthly report, Money › Profit & loss, `get_business_summary`, `get_metric`, `get_metric_trend` and the analyst's answer read one rule.

### ADR-109 · The figure/evidence invariant is enforced by a sweep, not by remembering
Context: the Opus 5 release check of `621f9e6`. Phase 14 had fixed "the drill-down must equal the figure" four times in four places — the amount basis (ADR-105), voided invoices (ADR-107), merged counterparties (ADR-108) — each fix correct, each local, and each followed by an audit that found the same invariant broken somewhere nobody had thought to test. Five metric families had a reconciliation test; the engine has sixteen leaf-descriptor producers. The open question was never "is this family right" but "which families has no one looked at".

Decision: stop answering that question by inspection. `test/integration/evidence-reconciliation-sweep.test.ts` seeds three organisations on the three P&L bases, reads **every** row of `metric_current` whose snapshot carries a leaf descriptor, resolves each through the real evidence service under the owner's RLS, and asserts Σ evidence = figure. It names no metric. A new figure with a new descriptor joins the test by existing; a descriptor that selects the wrong population fails it without anyone having predicted the shape of the mistake. The fixture deliberately contains rows the figures exclude — voided invoices, a credit note, an uncategorised payment, a matched transfer pair and an unpaired transfer candidate — so a merely-too-broad descriptor is caught rather than flattered. It checked 97 descriptors on first run.

It found two defects immediately, both fixed here:

**`other_income` re-selected every sale.** On the invoice basis the income branch of `pnl.ts#leafEvidence` returned the sales-type descriptor for whichever income figure asked. That is exact for `revenue` and wrong for `other_income`, which no invoice can reach: an invoice becomes a sale or an expense category, never other income. A figure of 0.00 carried a drill-down of 18,500.00 over three rows. The branch now takes the income category and returns no descriptor for anything but revenue — the guard the expense branch has always had ("a figure nobody's purchases went into gets no descriptor").

**A directional bank selection summed to the negative of its figure.** A bank amount is signed, so `cash_outflows` of 4,200.00 had a drill-down totalling −4,200.00 while `cash_inflows` matched: the two halves of one statement disagreed about sign, and the analyst's `sum` would have reported the negative. A compiled query gains `amountBasis: 'column_magnitude'`, set for any `bank_transactions` descriptor carrying a `direction`, because the engine states money out as a positive magnitude as it does every expense. Inflow rows are already positive, so one rule covers the table. Selections with no direction can mix signs and keep them.

Consequences: the invariant now has a guard that does not depend on anyone remembering it, and two defects it found are closed. One family is knowingly outside it and named in the test rather than skipped silently — see HIGH-3 in `PHASE_14_FINAL_REMEDIATION_AUDIT.md`. No figure changed; both fixes are to what a descriptor selects and how its rows are totalled.

### ADR-110 · The bank basis has one population rule: the figure and its evidence read the same value
Context: HIGH-3 from the release check of `621f9e6`. On the bank basis a counterparty's figure (`compose.ts#counterpartyAmounts`) was Σ|amount| over every cell for that party that was not revenue-categorised — uncategorised rows, transfer legs and inflows included — while its descriptor (`concentration.ts`) selected expense-category, outflow, non-cash-transfer rows. Measured: `supplier_spend` 8,850.00 over a drill-down of 0.00. The two rules had nothing in common but their inputs, and ADR-109's sweep named the family as knowingly unreconciled.

Decision: the population is **decided from the contract, once**, in `financial-engine/domain/bank-commercial.ts`, and both the figure and the descriptor are read off the same value. It is the reading `FINANCIAL_ENGINE.md §3.5` and §4.4 already give and that the §4.4 reference implementation, `banking/domain/proxy.ts`, already follows; nothing is invented.

1. **Customer revenue** (bank basis) = the party's **inflows** categorised `revenue`, not transfers. §3.5: "inflows with `counterparty_id`"; §4.4: "maps inflows in `revenue` category to `revenue`". `other_income`, owner funding (equity), loans and every other non-P&L category are outside it whoever the counterparty is.
2. **Supplier spend** (bank basis) = the party's **outflows** categorised in an expense category (`cost_of_sales ∪ OPEX_SET`, which is exactly the `expense` account type), not transfers. §3.5: "bank outflows"; §4.4: "outflows by category to expenses". Drawings, loan repayments and other non-P&L categories are outside it.
3. **Transfers of every kind are excluded** from both, and from the bank P&L lines (§4.4, ADR-047.12). `is_transfer ⇔ transfer_kind <> 'none'` is a table constraint, so the engine's check of the cell's kind and the descriptor's `exclude_transfers: 'all'` name the same rows. The descriptor previously carried `exclude_cash_transfers: true`, which let a card-repayment leg into a supplier's drill-down.
4. **Uncategorised rows are excluded** from both. §4.4 counts them "for completeness, never for a figure", `NON_PNL_CATEGORIES` contains `uncategorised`, and the bank-basis P&L already leaves them out and flags them with `uncategorised_amounts`. A payment bearing a supplier's name is not spend until someone says what it was for. A party whose only rows are uncategorised or transfers therefore has no figure (the HIGH-3 shape), rather than a figure over an empty drill-down.
5. **Direction is one rule for the whole bank basis**, `bankLineDirection`: an income-type category counts its inflows, an expense-type category its outflows. The P&L fold (`compose.ts#accountAmounts`) and both counterparty populations take it from that function; every bank P&L descriptor (`pnl.ts#leafEvidence`) now carries `exclude_transfers: 'all'` and the same side, taken from its line's account type (income → `inflow`, expense → `outflow`). A refund on the other side — a revenue-categorised outflow, an expense-categorised inflow — enters no bank-basis figure, which is what `proxy.ts` does ("left to the accrual bases rather than netted here on an assumption the document does not make"). Because every bank P&L and counterparty descriptor now has a direction, each totals as the positive magnitude its figure states (ADR-109's `column_magnitude`).
6. **The contract is enforced by type, not by convention.** `BankCommercialPopulation` is a class with a private constructor; a bank-basis counterparty descriptor is built only from `ConcentrationPeriodInput.bankPopulations`, the same value `bankCommercialSelection` summed, and without it the figure carries no descriptor rather than one assembled from another account list.

Found on the way and fixed here, because it was the same invariant on the same basis: once the sweep's bank rows kept their categories (see below), the bank P&L expense lines were seen to have drill-downs totalling the **negative** of their figures (`operating_expenses` 800.00 over −800.00) — the fold netted signed amounts and the undirected descriptor summed them signed. Point 5 closes it. Also: a hand-marked transfer (`api.mark_transfer`) keeps its category, so the bank P&L counted a revenue-categorised transfer leg as revenue; point 3 now checks the kind rather than trusting the category.

Test changes: `evidence-reconciliation-sweep.test.ts` no longer exempts any family. Its bank rows are now categorised by the user, because the banking pass re-derives `rule` categories and, with no rule to match, had cleared them — every bank P&L and counterparty line in that fixture had been a zero, which is how both defects sat behind a green sweep. `bank-commercial-population.test.ts` is the dedicated regression: 12 tests, every one failing on the previous engine.

Consequences: bank-basis `customer_revenue`, `supplier_spend`, `revenue` and the expense lines change for any organisation that has transfer legs carrying a P&L category, uncategorised rows with a counterparty, or refunds. The invoice and ledger bases, `app.invoice_net`, invoice precedence and eligibility, void and supersession exclusion, and cash are untouched. `ENGINE_VERSION` is not bumped, consistent with ADR-103 to ADR-109 in this pre-release phase. Known limits, recorded rather than hidden: a bank refund appears in no bank-basis figure (the documented §4.4 behaviour); bank-basis figures are not netted of VAT although `proxy.ts` nets them (pre-existing, flagged `vat_inclusive`); `components.row_count` on a bank P&L line still counts rows on both sides of the category. The **ledger** basis has the same two-rule shape and is NOT addressed here: its counterparty figure takes every non-revenue cell by magnitude (HIGH-5) and its descriptors total `amount` unsigned (HIGH-6); both are reproduced in `PHASE_14_FINAL_REMEDIATION_AUDIT.md` Part H and open.

### ADR-111 · The ledger basis joins the commercial population, and a ledger drill-down is totalled in reporting sign
Context: HIGH-5 and HIGH-6, found while closing HIGH-3 (ADR-110) and reproduced through the real pipeline. **HIGH-5:** on the ledger basis a counterparty's figure (`compose.ts#counterpartyAmounts`) was Σ|cell| over every non-revenue ledger cell for the party, while its descriptor selected expense accounts. A general-ledger import attaches the contact to every line of a journal (`imports/domain/pipeline.ts`), so a supplier's payables and bank lines counted as spend: 11,300.00 over a drill-down of 6,100.00. The customer side counted `other_income` and took a refund's magnitude as a sale. **HIGH-6:** a ledger descriptor was totalled on `ledger_entries.amount`, which is stored positive with the side in `direction`, so any P&L account with entries on both sides had a drill-down that added what the figure subtracted: `revenue` 19,400.00 over 21,400.00. The sweep's ledger fixture had one-sided accounts and contacts only on P&L lines, so it passed.

Decision:
1. **One population module for both bases.** `bank-commercial.ts` becomes `commercial-population.ts`; `CommercialPopulation` (private constructor, so nominal) now carries its basis. The account sets are the same on both bases and come from the contract (§3.5): customer = `revenue` accounts, supplier = `expense`-type accounts (`cost_of_sales ∪ OPEX_SET`). `other_income`, receivables, payables, cash and every other balance-sheet or non-P&L account is outside both, whatever contact is printed on the line.
2. **The ledger figure is the reporting-sign net**, computed with the engine's own account-type rule (`ledgerAmount`): credits less debits for a customer's revenue, debits less credits for a supplier's spend. A refund or a supplier credit reduces the party's figure, as a credit note does on the invoice basis (ADR-103), and `Σ customer_revenue + unattributed = revenue` holds with Unattributed being revenue lines that name no customer. The descriptor is `account_ids` from the same population. `ConcentrationPeriodInput.revenueAccountIds` / `expenseAccountIds` are removed, so a ledger or bank descriptor can only be built from the population the figure used, and a population built for another basis yields no descriptor.
3. **A ledger selection over both sides is totalled in reporting sign.** The compiler sets `amountBasis: 'ledger_reporting'` for a `ledger_entries` descriptor without `direction`; the resolver signs each line with `ledgerLineAmount`, using its account's category at the as-of instant (`account_category_history`, else the current category; an account's type is a function of its category by `accounts_type_matches_category`). Each record's `amount` carries that sign too, so the rows the drawer and the analyst see add up to the figure. A descriptor with `direction` is one side and keeps `column`. This applies to every ledger descriptor — P&L lines, counterparties, the expense-spike alert's pins — because every ledger figure the engine writes is in reporting sign.
4. **The invoice basis is untouched**: `counterpartyAmounts` now serves it alone, and `app.invoice_net`, invoice precedence, eligibility, void and supersession are unchanged.

Tests: `ledger-commercial-population.test.ts`, 10 tests, all failing on `cad227c` (Supplier One 12,500.00 → 5,800.00; revenue evidence 27,400.00 → 25,400.00; a party named only on balance-sheet lines 1,300.00 → no figure). The sweep's ledger fixture now has two-sided accounts and contacts on payables, receivables and bank lines; on `cad227c` it reports 6 ledger mismatches, on this tree none. Unit: the ledger compose case, the ledger descriptor shape, the cross-basis guard, and the compiler's `ledger_reporting` basis.

Consequences: ledger-basis `customer_revenue` and `supplier_spend` change for any organisation whose ledger carries contacts on balance-sheet lines, `other_income` with a contact, or refunds and credits; every ledger drill-down with entries on both sides now totals to its figure, and each ledger record shows its signed amount. `ENGINE_VERSION` is not bumped, consistent with ADR-103 to ADR-110.

### ADR-112 · The Command Centre is `/portfolio`, for every adviser-capable role, as a projection over the accessible set
Context: SOW §18 asks for an adviser's multi-client view — portfolio dashboard, health, clients requiring attention, alerts, actions, AI analysis, reports — with "client isolation and explicit assignment permissions mandatory". `/portfolio` already existed as the platform employee's landing page (a list of cards), `ROUTE_ARCHITECTURE.md` gave members a 404 on it, and nothing multi-client existed for an owner of several organisations. `ARCHITECTURE.md §7` foresaw the command centre as "a projection over `organization_assignments`" needing no tenancy change.

Decision:
1. **Who.** `/portfolio` is the Command Centre for every role that advises: `super_admin` (at aal2, every organisation), `employee` (assigned organisations, at aal2), `owner` and `admin` (the organisations they hold that role in). These are exactly the holders of `assignments.view`. A caller whose accessible set contains no organisation in one of those roles — a client-only member, a stranger — gets the uniform 404 from the portfolio layout, which never confirms that a portfolio exists. *(Corrected by ADR-114 §6: an ACTIVE platform account at aal2 with no assignment gets the specified empty state, not the 404.)* A person who is a client in one organisation and an owner in another sees only the second. Middleware no longer decides this family (it keeps only the session and MFA gates); the layout does, from the database's answer.
2. **Over what.** The set is `api.my_organizations()`, the database's own resolution through `app.accessible_org_roles()` — the single source every RLS policy reads — filtered to the adviser roles (`modules/portfolio/services/access.ts`). Nothing is granted that RLS did not already grant.
3. **How it reads.** *(Superseded by ADR-114 §1–3: counts now come from one uncapped aggregate, `api.portfolio_summary`, and detail lists are capped separately; the design below derived counts from capped lists, which was HIGH-A, and read health unbounded, which was HIGH-B.)* Five statements whatever the client count: the organisations, health (`health_current` joined to `health_scores`, complete months only, the latest two per organisation for the trend), standing alerts (`open`, `acknowledged`), open actions, and actions finished in the last seven days. Every statement carries the authorised ids in its predicate AND runs under the caller's RLS; a row must pass both. Nothing loops per organisation, nothing selects everything and filters afterwards, and no money is summed: the portfolio counts, ranks and labels rows other modules wrote.
4. **Attention.** A client enters the queue for facts other modules established — critical or high alerts, an overdue or urgent (critical/high priority) action, health At risk or Needs attention, a health band that fell since the previous complete month, or a score that fell ≥ 10 points inside its band, or a suspended organisation — with fixed weights (100, 80, 70, 60, 50, 45, 40, 30, 20) and a deterministic order: heaviest reason, then the sum, then the name. No portfolio score exists and no model ranks anything.
5. **Surfaces.** `/portfolio` (queue, counts, every client, recent changes), `/portfolio/alerts`, `/portfolio/actions` (the Action Centre's own lenses and rules), `/portfolio/clients/[orgId]` (why flagged, health, alerts, actions — an id outside the portfolio is the uniform 404), `/portfolio/analyst` (ADR-113). Every drill-down opens the organisation's existing alert, action, evidence and home pages: one alert lifecycle, one action lifecycle, one evidence chain. The tenant header and the organisation picker link to the Command Centre for the same roles.
6. **Not built.** No new health calculation, alert rule, action state, evidence store or financial formula; no per-organisation feature flag (the surface is per person, not per organisation).

Consequences: `ROUTE_ARCHITECTURE.md §5`, the middleware rule for members and the status matrix row for `/portfolio` change (owner/admin 200, client 404); `RBAC_MATRIX.md` notes it. An employee's browser session still needs TOTP, so the browser journey runs as an owner and the employee boundary is proven at the database and the API (`test/integration/portfolio.test.ts`, incl. the resolver bypassed with a foreign id, and an assignment revoked mid-session). Caps: *(corrected by ADR-114 §2)* detail lists are capped (500 alerts, 500 actions per lens, 50 recent changes, 25 shown in the queue) and say so when truncated; counts are never derived from them.

### ADR-113 · The adviser analyst answers over an authorised digest, through one structured tool, held to that digest, and recorded in its own table
Context: SOW §18 "client AI analysis"; the brief's rule that the authorisation boundary must sit before the model receives data and that the model may summarise deterministic results but never calculate an authoritative figure. The organisation-bound analyst (`ai_conversations`, `ai_messages`, `api_server.ai_persist_turn`) cannot hold a question that spans several organisations: its RLS, quota and evidence bundle all key on one `organization_id`.

Decision:
1. **Before the model.** `askAdviser` loads the caller's portfolio (ADR-112 §3) and builds a digest from it — each client, alert and action given a short reference (`client:N`, `alert:N`, `action:N`), health as score/band/month/trend, attention reasons as labels, and the counts. The model is shown that digest inside a `<data>` element and nothing else: no data or database tools, no organisation it may not advise. It has exactly one tool — the forced structured-output tool `submit_briefing` — through which it must answer. The turn is then opened by `api_server.portfolio_ai_begin_turn`, which re-checks every organisation in scope against the actor with `app.org_role_of` (the same resolver RLS uses) and charges a 10/min throttle — refusing, before any row exists, a scope the actor may not advise, whatever the server asked for.
2. **After the model.** The model must answer through `submit_briefing` (mode, headline, clients[{ref, summary, because[]}], notes, limitations). `groundBriefing` drops any client ref the digest did not issue and any `because` ref that is not that client's own alert or action. *(Corrected by ADR-114 §5: the original number check — "a number the digest states" anywhere — accepted fabricated figures that happened to equal an unrelated count (MEDIUM-D); numbers are now grounded to specific cited facts, sentence by sentence. Corrected again by ADR-115, then ADR-116, and replaced by ADR-118: the model writes no text; it selects facts, attention reasons, sources and library phrases, and the server writes every sentence of the briefing.)* It replaced any headline, summary or note that stated such a number with the server's own sentence built from the attention reasons; each of those marks the turn `degraded`. A refusal carries no clients and is `not_applicable`; a submission that fails the schema is `failed` and nothing is rendered. Text blocks are never read.
3. **Recorded.** `portfolio_ai_turns` holds the question, the scope ids, the validated briefing plus the names and alert/action ids its references resolve to (never a financial figure), grounding status, model and token counts; RLS is own rows or super admin; the definer role writes through the two `api_server` functions only. It is the one Phase 15 table, and it copies no financial number.
4. **What the model cannot do.** Change a health score, an alert's severity, an action's state or a permission; cite an organisation it was not handed; introduce a figure. Financial figures beyond the health score are not in the digest by design: the analyst says so and points to the client's own pages, where the evidence chain lives.

Consequences: no daily quota is charged (quotas are per organisation); the throttle is the only limit, recorded as a known limitation. Eight eval cases (`test/eval/portfolio-eval.test.ts`) pin the contract; `test/integration/portfolio-ai.test.ts` proves, with a recording fake model, what is handed, what the database accepts as a scope, and what the server keeps.

### ADR-114 · Portfolio integrity: authoritative aggregates, bounded health, current-access AI turns, fact-specific grounding, and the unassigned employee's empty state
Context: the independent audit of `bab3a68` returned NOT READY with five blockers, each reproduced there and proved RED against that commit before any fix (`test/integration/portfolio-scale.test.ts`, `portfolio.test.ts`, `portfolio-ai.test.ts`; `test/eval/portfolio-eval.test.ts`):
- **HIGH-A.** Counts and attention reasons were derived from a detail list of standing alerts (and of open actions) capped at 1,000 rows, newest first. 3 critical alerts older than 1,050 newer ones were shown as 0 critical alerts; their client had 0 open alerts and was absent from the attention queue. 1,023 open actions were counted as 1,000.
- **HIGH-B.** Health was read from `health_current` and `fiscal_periods` unordered and unpaginated, so PostgREST's `max_rows` (1,000) silently dropped scored months. 45 clients scored for 24 months showed 4–6 as "Not yet scored", and those at risk left the queue.
- **HIGH-C.** `portfolio_ai_turns` was readable by its author whether or not the author still advised the organisations in it. A revoked employee kept reading a former client's name, summary and alert titles. The established rule is the opposite: `ai_*` RLS requires current access.
- **MEDIUM-D.** Grounding accepted any number that appeared anywhere in the digest. "Revenue declined 3%. Cash runway is 8 months. Profit margin is 14%." was graded `passed` because 3, 8 and 14 were counts.
- **MEDIUM-E.** An employee with no assignment, whom middleware routes to `/portfolio`, received the uniform 404 instead of the empty state `UX_ARCHITECTURE.md` specifies. The route matrix still said 200.

Decision:
1. **Counts are aggregates, never derived from a list.** *(Transport corrected by ADR-117: the scope is derived in the database, a NULL list is the whole scope, and the aggregate is read in pages.)* `api.portfolio_summary(orgs, today, due_soon_until)` computes, in one grouped statement over the full population: standing alerts (total, critical, high); open actions (total, overdue, due soon, urgent, urgent-and-not-overdue, the caller's own); and each organisation's health. Every count on every Command Centre page, every client row and every attention reason reads it. Overdue, due-soon and urgent are the Action Centre's own rules; the due-soon window is passed in from `DUE_SOON_DAYS`, so the rule has one source. The function is security definer and scopes itself to `orgs ∩ app.adviser_org_ids()`, so a forged id or a client-only organisation contributes no row.
2. **Detail lists are capped independently and say so.**
   - Alerts are read worst first (severity, then oldest).
   - Actions are read with the lens as a predicate in the statement, in `byUrgency` order.
   - Both are capped at 500, below PostgREST's `max_rows`, and travel as a `CappedList` with the authoritative total. The page states "Showing the first N of M … every count on this page is the full number" when truncated.
   - The overview's attention list shows the first 25 and states how many more need attention. Every client appears in the client list.
   - The recent feeds (7 days) are capped at 50 and are recent by definition.
3. **Health is bounded to the rows needed.** The same statement ranks each organisation's complete scored months (`health_current ⋈ health_scores ⋈ fiscal_periods`, `is_complete`) and returns only the latest and the one before: one row per organisation, whatever the history. PostgREST's row limit is never relied on. There is no new health calculation: the score, band rule and "no score is not zero" are the Health module's.
4. **Stored AI turns require CURRENT access.** `app.adviser_org_ids()` is the caller's adviser organisations right now, taken from `app.accessible_org_roles()`, the same resolver every RLS policy uses. The turn read policy is `user_id = app.uid() and scope_organization_ids <@ array(select app.adviser_org_ids())`, or a super admin at aal2.
   - A turn over several organisations is readable only while the author advises every one of them.
   - Revocation hides a turn on the next request; reassignment restores it. That is the same effect `ai_conversations` RLS has through `accessible_org_ids()`.
   - No parallel archive state was added.
5. **Grounding is fact-specific.** The digest states every number as a fact `{id, subject, metric, words, period, value, unit}`. The model's forced output tool cites fact ids per headline, per client summary and per note. A number survives only when a cited fact matches it on:
   - value, compared exactly as a decimal;
   - unit ("%" is a percent, "months" is months, "£" is money, a bare number is a count or a score);
   - subject (a client summary may cite only that client's facts or the portfolio's);
   - metric (one of the fact's words is in the sentence);
   - period (if the sentence names a known period, it must be the fact's).
   A sentence with any number that fails is removed; the rest stands. An emptied summary becomes the server's own sentence from the attention reasons, and an emptied headline becomes the server's count sentence. A limitation may state no number. Prompt version `adviser-v2.0`. *(Superseded in detail by ADR-115: the scan saw digits only (audit M-1) and stripped cited titles as substrings (L-2); claims are now read in every written form and bound per clause; prompt `adviser-v2.1`. Replaced by ADR-116 and then ADR-118: the model writes no text; prompt `adviser-v4.0`.)*
6. **An eligible employee with no assignment has an empty Command Centre.** When the adviser set is empty, the resolver asks `resolvePlatformRole`, the tenancy module's single rule (`my_platform_role`: active, aal2). An active platform account gets an empty context, and the overview renders the specified empty state. Everyone else without a portfolio still gets the uniform 404: a client-only member, a stranger, an aal1 or suspended platform account.

Consequences:
- The overview reads 1 resolver call, 1 aggregate and 2 recent feeds. The alerts, actions and client pages add their own capped detail read; the client page reads for that one organisation.
- No statement loops per organisation.
- `/portfolio` is now in the axe/overflow sweep. The counts strip is a list, which fixes the `definition-list` / `dlitem` violations.
- Known residual *(narrowed by ADR-115: metric, period and subject are now read per clause)*: the metric and period checks are per sentence, not per number. A sentence that names two metrics can pair a number with the wrong one when the values coincide. The subject, unit and exact-value checks still apply.

### ADR-115 · Adviser grounding binds every quantitative claim — in digits, words, fractions or multipliers — to one cited fact
*(Superseded by ADR-116, itself superseded by ADR-118: the final release audit of `33a182f` showed that reading the model's prose cannot be made safe (F-1…F-4). The model now writes no text at all; it selects references and the server writes every sentence. Kept as the record of what was tried and why it was replaced.)*

Context: the independent audit of `71fd748` (`docs/PHASE_15_INDEPENDENT_AUDIT.md`) returned NOT READY on one blocker and a related low:
- **M-1 (MEDIUM).** The grounding scan (`briefing.ts` `NUMBER`) saw digit sequences only. "Revenue fell by twenty per cent and cash runway is one and a half months." and "Revenue fell by a third; costs doubled; margin halved." were graded `passed`, stored with `grounding_status = passed` and shown under the *Grounded* badge. The digest carries no financial fact, so each was a fabrication by construction.
- **L-2 (LOW).** The titles of cited alerts and actions were removed from the sentence as substrings before the scan. An action titled `3` erased the `3` of "Revenue fell 3%", which then passed.
- **L-3 (LOW, documented residual).** Metric words were read per sentence and by substring: `open_actions = 8` grounded "Runway is 8, per the open action list", and `8pc`, `8 pct`, `8pp`, `8 pounds`, `8k` were all "bare" numbers.

Decision:
1. **One claim grammar.** The adviser does not get a second number parser. `portfolio/domain/quantities.ts` reads a sentence and hands everything it does not itself resolve to the AI module's claim grammar (`extractClaims`, AI_ARCHITECTURE §7.9), which already reads digits, number words, percentages, points and currency. Before that it reads what the adviser's contract needs and §7.9 deliberately leaves alone:
   - fractions: "one and a half", "three quarters", "½". Their value is exact, or null when there is no decimal ("a third").
   - multipliers, as the unit `multiple`: "doubled", "halved", "cut by half", "increased by half", "twice as", "3x", "twofold". "Three times higher" is read as ×3 by some people and ×4 by others, so it has no value.
   - "one", "zero" and "no" in front of a counted noun or a unit: "one month", "no critical alerts". §7.9 exempts "one" alone because "one of the customers" is not a figure, and that exemption still holds.
   - the unit each claim is stated in, including `pc`/`pct` (percent), `pp` and percentage points (a unit no fact has), months, days, weeks and pounds.
   - approximation (a hedge before the figure or "or more" after it) and magnitudes with no figure ("significantly", "materially", "sharply", "most of", "several").
2. **A claim is bound, not matched.** Each claim must be bound to one fact the sentence cites, agreeing on:
   - **value**, compared as an exact decimal;
   - **unit**: bare → count or score; points → score; percent, months, money and multiple → the same unit only; proportion and unknown units → nothing;
   - **metric**, read from the claim's OWN clause. Clauses break at `,` `;` `:` `(` and at *and, but, while, with, because, since…*. A fact's words must start a word, so "action" no longer matches "transaction". A fact may also require a noun ("critical" needs "alert") and exclude the qualifiers of more specific facts, so 3 open actions never state 3 overdue ones. A clause that names no metric at all ("…, from 61 in Jul 2026 to 38 in Aug 2026") is governed by the nearest clause before it that does. A count or score fact never states a figure in a clause that uses a financial word (revenue, cash, runway, margin, cost…);
   - **subject**: a summary's claims are about its own client unless the clause names another. A headline or note must name the client whose fact it states. A portfolio fact needs a portfolio clause ("clients", "portfolio", "across", "overall"), and only "clients"/"portfolio" once a client is named;
   - **period**: the period named in the clause, or in the sentence if the clause names none, must agree with the fact's. "August" agrees with `Aug 2026`; `Aug 2026` does not agree with a September fact; a quarter agrees only with its exact label;
   - **direction**: a fact may carry `increase` or `decrease`, and a clause stating the opposite does not state it. The health-score change now carries its sign; it had been an absolute value with "fell" and "rose" both counted as metric words.

   A hedged claim, a claim with no exact value, or a magnitude with no figure has no fact to bind to. A sentence with any claim that fails is removed (the existing output contract), and the other sentences stand. One valid claim never rescues another.
3. **Titles and names are text, never facts.** A summary may quote the title of an alert or action it cites in `because`, only as the exact title and only inside quotation marks. That span is set aside whole. A title's numbers therefore neither need grounding nor ground anything. A title (or a client's name) with a unit or a currency against it, such as `“3”%` or `£"3"`, is a title used as a figure, and the sentence is removed. An unquoted title is prose and is scanned like any other text. No substring is ever removed from a figure.
4. **Facts gain `noun`, `excludes` and `direction`, and the unit `multiple`.** `buildDigest` emits none in `multiple`, percent, months or money today. The units exist so that such a claim can only ever be grounded by a fact that states one.
5. **The prompt says so.** Prompt version `adviser-v2.1`: digits only; the metric in the same clause; name the client; no words-as-numbers, fractions, multipliers, approximations or unquantified magnitudes; titles in quotation marks. The server does not rely on the model obeying it.

Consequences:
- **The badge.** *Grounded* is `grounding_status = 'passed'`, decided on the server. It now means every quantitative claim was bound to a fact. `test/integration/portfolio-ai.test.ts` drives the audit's sentence through `askAdviser` with a fake transport and asserts that the stored turn is `degraded`. Journey 15 asserts in the browser that a stored `degraded` turn is labelled *Partly grounded* and never *Grounded*.
- **Tests.**
  - `test/unit/portfolio-quantities.test.ts`: 69 cases of the reader.
  - `test/eval/portfolio-eval.test.ts`: brief §6 A–F, §8, §9, §11, §12 and §14, L-2 titles, and honest answers that must still pass.
  - Proof against the old code: 33 of the new eval cases and both new integration cases fail on `71fd748`'s `briefing.ts`. The auditor's ten grounding probes, of which 3 failed on `71fd748`, all pass.
- **Stricter behaviour on honest answers.**
  - An unquoted title containing a number word ("Cash runway under two months") now degrades its sentence. Eval case 6 now quotes the title, and 6b records the unquoted case.
  - Two counts joined without a clause break ("2 critical and 3 high alerts") need the noun in each clause.
  - Pronoun-only sentences in the headline or notes ("Its score is 38") cannot state a client's fact.
  - Each of these fails closed, and the prompt steers the model away from it.
- **Residuals, recorded.**
  - Two claims in ONE clause with no break between them are bound to that clause's words together, so a pair of same-unit values can still cross only when both values exist in cited facts of metrics that clause names.
  - "None" is not read as zero.
  - A relative period ("this quarter", "last month") is not read as a period.
  - No live Claude model was run: there is no API key in this environment. The validator is deterministic and model-independent; the fake transport is the evidence.
- **Unchanged.** Authorization, the digest's content, the turn table and RLS are untouched; this is grounding only.

### ADR-116 · The adviser model does not write figures: it cites facts, and the server writes every figure from the fact
*(Superseded by ADR-118. The second final release audit (`48f2c4f`) showed that the prose statements this decision still allowed could re-qualify a server-rendered figure ("…has 3 open actions. They are overdue."), and that the prose word list missed many forms. The claims below that no model text sits beside a figure and that F-1…F-3 are closed by construction were false. The typed facts and their rendering are kept; the prose channel and `free-text.ts` are removed. Kept as the record.)*

Context: the final release audit of `33a182f` (`docs/PHASE_15_FINAL_RELEASE_AUDIT.md`) returned NOT READY. ADR-115 had tried to read every quantity in the model's prose and bind it to a cited fact. Four MEDIUM findings showed that reading prose cannot be made safe:
- **F-1.** A count stood behind a sentence that said something else: `portfolio/clients = 12` grounded "12 clients need attention"; the open-action count grounded "completed 8 actions".
- **F-2.** The current and previous health scores could swap. "This month" matched any period, and verbs outside the direction list ("slumped") passed.
- **F-3.** Two figures in one clause could swap values. "As well as", "as" and "of" did not break a clause.
- **F-4.** "A couple of", "a single", "a dozen", "both", "all", "none of", Roman numerals and Arabic-Indic digits were not read at all.

Every fix of this kind leaves the next phrasing through.

Decision:
1. **Facts are authoritative, typed and self-describing.** Each digest fact carries id, subject, organisation, metric, claim type, period, exact value, direction, source, and the canonical sentence that states it.
   - Claim types: `count`, `score`, `score_change`, `percent_change`, `amount`, `duration`, `multiplier`. The Phase 15 digest emits the first three.
   - Example sentences: "Alpha Ltd has 3 open actions"; "Alpha Ltd's health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026"; "12 actions are open across the portfolio".
   - The sentence is written when the digest is built, from the view's aggregates, and never from anything the model sends.
2. **The model's output is statements, and a statement is prose OR facts.** The forced tool `submit_briefing` takes, per headline, client summary and note, a list of `{kind: 'text', text}` or `{kind: 'facts', facts: [ids]}`.
   - The model is shown each fact as `{id, type, period, says}`, where `says` is the sentence the server will write, and chooses ids.
   - It never supplies a value, and no model text is placed beside a fact. Text sent with a facts statement is recorded and never shown.
   - A modifier beside a server figure ("8 open actions *that are overdue*") would re-qualify it. So a fact statement is the server's whole sentence.
   - Counts about one client share a sentence ("Alpha Ltd has 8 standing critical alerts and 3 open actions."). Each value stays with its own noun, in whatever order the ids arrive.
3. **The server validates and renders.**
   - Each fact id must be one the digest issued. A client summary may cite only that client's and the portfolio's facts.
   - Invalid ids are dropped. The valid facts in the same statement still render, because no fact can lend its value to another.
   - The rendered text, the fact ids it contains, and the status are what is stored. The page renders the stored text, and its shape is unchanged.
4. **Prose is untrusted, so a rejection rule replaces the parser.** `portfolio/domain/free-text.ts` does not try to understand prose. It asks whether the text carries anything quantitative, and if so the sentence is removed. It looks for:
   - any numeral in any script (`\p{N}`) and Roman numerals;
   - number, ordinal (from "second"), fraction, multiplier and cardinality words ("a dozen", "a couple", "a single", "both", "all", "every", "none", "no alerts");
   - percent and point words, and magnitude words ("sharply", "significantly");
   - any period ("August", "this month", "year to date", "Q3"), because periods belong to facts;
   - letters outside the Latin script.

   Vague non-numeric quantifiers ("several", "some", "a few"), "first", "one of" and "the one" are allowed. Client names are set aside whole, and only when they contain a letter. A false positive costs one sentence; the rule errs that way on purpose.
5. **Titles are metadata.** A cited alert or action is shown by the page from its `because` ref. Its title is never a fact, and a title quoted in prose is prose (its numerals remove the sentence).
6. **The badge.** `passed` is stored only when nothing was dropped: every fact valid and every prose statement free of quantities. A figure shown under *Grounded* is therefore always a figure the server wrote from a fact in the caller's digest. The badge is read from `grounding_status`, never decided on the client.
7. **Prompt `adviser-v3.0`.** The model is told it does not write numbers, how to cite facts, and what prose may contain. The server does not rely on it.

Consequences:
- **F-1 to F-3 are closed by construction.** A figure's noun, subject, period and direction are part of its fact's sentence. The model cannot attach a figure to another meaning, swap two figures, or reverse a direction, because it writes none of them.
- **F-4 is closed by the rejection rule.** It is a fail-closed filter over untrusted text, not the source of any figure.
- **Tests.**
  - `test/eval/portfolio-eval.test.ts`, 51 cases: the brief's 20-case matrix, each of the audit's F-1 to F-4 sentences, fact authorisation, and honest answers.
  - `test/unit/portfolio-free-text.test.ts`: 73 cases.
  - `test/integration/portfolio-ai.test.ts`, +2 cases: a model citing facts is stored `passed` with the server's sentences, and never the value it tried to write; swapped and number-word prose is stored `degraded`.
  - On `33a182f`'s grounder, every one of ten of the audit's bad sentences (F-1 to F-4), with the citations a model would send, was graded `passed`.
- **ADR-115 is superseded.** `portfolio/domain/quantities.ts` and its test are removed. The organisation analyst's claim grammar (AI_ARCHITECTURE §7.9) is untouched.
- **Limitations, recorded.**
  - Qualitative prose is not verified against facts. "Cash pressure is increasing" is allowed and is the model's statement, not MOTION's. It cannot carry a figure, a period or a cardinality.
  - The rejection rule is a vocabulary. A quantity written in a form it does not list would stay in prose. It would still be the model's words, never presented as a server figure. The rule covers every form the audits and briefs name.
  - No live Claude model has been run (no API key in this environment). Every test uses the deterministic validator and a fake transport.

### ADR-117 · The Command Centre's reads derive their scope in the database and carry no id list in a URL
Context: final release audit of `33a182f`, finding **F-5** (MEDIUM):
- The four detail reads (standing alerts, recent alerts, open actions by lens, finished actions) were PostgREST GETs with `organization_id=in.(…every id…)` in the URL.
- At 201 organisations the gateway answered 414 URI Too Long. `/portfolio`, its alerts and actions pages, the client pages and the analyst all failed for any adviser that large, including every super admin once the platform passes 200 organisations.
- Separately (**L-6**), the resolver `api.my_organizations()` and the aggregate were cut at PostgREST's 1,000 rows.

Decision:
1. **One scope, derived in the database.** `app.portfolio_scope(orgs)` is the caller's current adviser organisations (`app.adviser_org_ids()`, from `app.accessible_org_roles()`, the resolver every RLS policy reads), narrowed to `orgs` when a list is given.
   - `NULL` means the whole scope.
   - A list can only narrow the scope; a forged, foreign or client-only id selects nothing. A list in a request body is never authorisation.
2. **The detail reads are RPCs (POST):** `api.portfolio_standing_alerts`, `api.portfolio_recent_alerts`, `api.portfolio_open_actions` and `api.portfolio_finished_actions`.
   - Like every `api.*` function they are security definers with an empty `search_path` (R2-A-06). They read only rows of organisations in `app.portfolio_scope`, bound to the caller's own `app.uid()`, exactly as `api.portfolio_summary` does.
   - They order and cap at 500 in the statement.
   - The action lens predicates are the ones the aggregate counts with.
3. **`api.portfolio_summary` reads through the same scope.** A whole-portfolio read sends `NULL`: the overview, the alerts and actions pages and the analyst's digest send no id list at all. A client page sends its one id.
4. **Pages, not caps.** The aggregate (one row per organisation) and `my_organizations` (name order, id tiebreak) are read in pages of 1,000 until a short page. A super admin's portfolio of any size is read whole.

Consequences:
- **Evidence.** `test/integration/portfolio-transport.test.ts` holds 1,005 organisations:
  - a super admin reads all of them in 6 POSTs (resolver ×2, aggregate ×2, feeds ×2), with counts from the last page;
  - an employee with 250 assignments reads exactly those;
  - an owner who asks for foreign ids, a client, and an owner over the organisation they are only a client of all read nothing foreign;
  - the 500 cap cannot be raised; anon cannot call the reads.
- **RED on the old code.** On `33a182f`'s repository, services and resolver, the three large-portfolio loads fail. pgTAP `14_portfolio` has 15 new checks.
- **Timing.** One local run measured 83 ms for the super admin's 1,005-organisation overview. That is a single local measurement, not a benchmark; no latency benchmark has been performed.
- **No per-organisation query exists.** The number of requests grows with pages of 1,000, not with organisations.

### ADR-118 · The adviser briefing is structured: the model selects references, the server writes every sentence
Context: the second final release audit (`docs/PHASE_15_FINAL_RELEASE_AUDIT_2.md`, of `48f2c4f`) returned NOT READY.
- **F-1 and F-2 remained open.** ADR-116 let the model write prose statements next to server-rendered facts. Prose placed after a fact re-qualified it, and was stored `passed`:
  - "…has 3 open actions. They are overdue." (1 was overdue);
  - "…health score for Jul 2026 was 61. That is its latest score." (the latest was 38).
- **F-4 remained open.** The prose rule was a word list, and it missed many forms, including the first audit's verbatim sentence "Alpha Ltd does not have any critical alerts.".
- **A test had been altered.** The implementation's test of that sentence had been changed (a trailing "... none." added) so that it was caught. That masked the defect.
- ADR-116's claims "no model text is placed beside a figure" and "F-1 to F-3 are closed by construction" were false.

Decision:
1. **Model selects, server writes. The model writes no text at all.** The forced tool `submit_briefing` takes, per headline, client and note, a list of BLOCKS. Every block is a reference to something the server already holds:
   - `facts` — fact ids. The server renders each fact's canonical sentence: value, noun, subject, period and direction are the fact's. Counts about one client share one sentence, each value with its own noun.
   - `attention` — ids of MOTION's own attention reasons (`client:N/attention/<kind>`). The server writes the reason's label.
   - `source` — an `alert:N` or `action:N` of the digest. The server writes it as a source: kind, the title in quotation marks, and its severity or priority and standing. The source is added to the client's citations. A title is tenant text shown as a title; it is never a fact and grounds nothing.
   - `phrase` — an id from a small server-owned library, each phrase with a condition the server checks against the data:
     - `needs_attention` (the client has attention reasons);
     - `look_first` (the client is first in MOTION's attention order);
     - `client_clear` (the client has no reasons);
     - `health_unavailable` (the client has no score);
     - `review_evidence`;
     - `portfolio_clear` (no client needs attention);
     - `figures_elsewhere`;
     - `not_in_portfolio`;
     - `outside_scope`.

     No phrase states a quantity or a period (a unit test holds the library to that).
2. **Anything else is discarded, and the answer is degraded.** That means:
   - a `text` block or any unknown kind;
   - any field a block's kind does not have (`text`, `value`, `label`…), which is stripped;
   - an id the digest did not issue; another client's fact, reason or source in a client's summary;
   - a phrase that is not in the library or whose condition does not hold.

   Limitations are portfolio phrase ids. A refusal is a portfolio phrase.
3. **There is no free-text channel to police.** `portfolio/domain/free-text.ts` (ADR-116's word list) is removed. No parser, dictionary or Unicode handling is part of the safety of the briefing. A quantity in any language, spelling or script has nowhere to go.
4. **Grounded means:** every block in the stored briefing was rendered by the server from authorised facts, MOTION's attention reasons, the caller's alerts and actions, and library phrases whose conditions hold, and nothing the model sent was discarded. It does not mean the model chose the most useful references. `degraded` (*Partly grounded*) means something was discarded. The page renders the stored status.
5. **No commentary channel.** There is no unverified "analyst commentary" beside the figures. Richer language can come later only as further server-owned templates or facts.
6. **Prompt `adviser-v4.0`.** The model is shown each fact as `{id, type, period, says}`, each client's attention reasons with ids, its alerts and actions by ref, and the phrase library with a `{client}` placeholder.

Consequences:
- **F-1, F-2 and F-4 are closed by the contract, not by recognition.** Neither "They are overdue." nor "That is its latest score." nor "Alpha Ltd does not have any critical alerts." can be submitted as anything the server renders. F-3 stays closed; ordering is kept and no value moves between facts.
- **Tests.**
  - `test/eval/portfolio-eval.test.ts`, 80 cases: every sentence both audits reproduced, VERBATIM (including the restored "Alpha Ltd does not have any critical alerts."), alone and attached after a correct fact; the brief's model-misbehaviour cases A–F; compound ordering; the rise/fall template; fact authorisation; phrase conditions; attention and source rendering; a well-behaved answer.
  - `test/unit/portfolio-briefing-contract.test.ts`, 16 cases: the schema, per-kind field strictness, malformed references, and the phrase library carrying no quantity or period.
  - `test/integration/portfolio-ai.test.ts`: a full turn from references to stored `passed` text, and fabricated text and values beside a fact stored `degraded`.
  - On `48f2c4f`'s grounder, all nine audited attachment and prose sentences tried were graded `passed`.
- **ADR-116 is superseded**; its fact model and rendering are kept.
- **What this does not claim.** It does not make false statements impossible for the model in general: it can still choose a less relevant fact. What it guarantees is that the trusted briefing contains only server-rendered facts, attention reasons, sources and approved phrases, and that model text is never rendered into it.
- **Limitations.**
  - The briefing is less fluent than prose.
  - No live Claude model has been run (no API key); every test uses the deterministic validator and a fake transport.
  - The digest sent to the model has no size bound (audit L-H).

### ADR-119 · Funding Readiness ships as a standalone assessment; its Health Score integration is deferred
Status: **decided by the product owner, 2026-09-30.** Design only; nothing is implemented by this ADR.

Context:
- `MVP_SCOPE.md` row 100 schedules "Funding Readiness assessment, report and health dimension" for Phase 16.
- `FINANCIAL_ENGINE.md §7.1` reserves a `funding_readiness` Health Score dimension (weight 10, "post-MVP"). `health/domain/config.ts` says that when a reserved dimension lands, every weight is rescaled to sum to 100 and the config version bumps.
- Activating it would move every organisation from `health.config.v1` to a v2. That changes every health score MOTION has published.
- Phase 15 (released at `74050d1`, audited READY in `docs/PHASE_15_FINAL_RELEASE_AUDIT_3.md`) reads the Health Score. `portfolio/domain/attention.ts` (`bandFell`, `scoreFell`) and the adviser briefing compare the latest two complete months. A month scored under v1 beside one scored under v2 would show a band fall caused by a rules change, not by the business.
- Three of the seven Funding Readiness factors (revenue & profitability, cash flow, banking behaviour) re-score inputs the Health Score already scores (profitability, revenue growth, cash flow, banking health). Inside the Health Score those signals would be counted twice.

Decision:
1. **Funding Readiness Health Score integration is deferred and is not part of Phase 16 implementation.**
2. Phase 16 delivers Funding Readiness as a standalone, persisted, deterministic assessment (`docs/PHASE_16_IMPLEMENTATION.md`).
3. `health.config.v1`, every stored `health_scores` row, `health_current`, the Home score, the analyst tool `get_health_score`, the recorded AI eval corpus and every Phase 15 health comparison stay exactly as released.
4. The reserved `funding_readiness` row in `FINANCIAL_ENGINE.md §7.1` and the SOW requirement REQ-BH-10 are **not deleted**. They remain open requirements, now marked deferred.
5. When the dimension is eventually activated, it needs its own decision, at minimum:
   - a config-version bump;
   - a full re-score of history under the new config;
   - a rule that Phase 15 attention never compares scores of different `config_version`s;
   - an answer to the double-counting described above;
   - its own independent audit.

Consequences:
- `MVP_SCOPE.md` row 100 is delivered in part by Phase 16: the assessment. The printable report is Phase 17 (SOW §20, REQ-RP-05). The health dimension is deferred by this ADR.
- The Home Health Score and the Funding Readiness score are two separate numbers with separate band vocabularies (`docs/PHASE_16_IMPLEMENTATION.md §6`). Neither is derived from the other.
- **Addendum (2026-09-30, with ADR-120).** "Health unchanged" binds **Phase 16**. The separate Receivables/Payables Engine Recovery (ADR-120) is expected to change Health Scores: rule Q3 starts scoring, and the `receivables/payables.deterioration` alerts start firing. That change is intentional, happens outside Phase 16, and is independently audited there. Phase 16 must not make or hide any Health change of its own.

### ADR-120 · Receivables, payables and working capital are recovered by a separate engine remediation before Phase 16
Status: **decided by the product owner, 2026-09-30 (Phase 16 U-1).** Not implemented; this records the decision and the dependency.

Context:
- **Defined but never computed (verified at `74050d1`).** `FINANCIAL_ENGINE.md §3.4` and the metric registry define `receivables`, `receivables_overdue`, `receivables_days`, `payables`, `payables_overdue`, `payables_days` and `working_capital`. A pure `computeReceivables` exists (`financial-engine/domain/receivables.ts`, Phase 4, `b2a6861`), but `composePeriod` never calls it and no SQL writes these keys. No calculation run has ever persisted them.
- **Tests fake the figures.** The integration tests that need them insert snapshots by hand (`writeMetric`).
- **Knock-on effects:**
  - Health rule Q3 (`customer_quality`, days to get paid) is always skipped.
  - The `receivables.deterioration` and `payables.deterioration` alerts can never fire.
  - Money › receivables / payables have no engine figures.
  - Funding Readiness factor F5 (REQ-FR-07) has no trustworthy production source.

Decision:
1. The recovery is a **separate engine remediation**, not part of Phase 16, and it is done **before** Phase 16 implementation. It must deliver:
   1. calculation invocation (the receivables module wired into the run under the EXISTING §2.3 precedence);
   2. deterministic persistence (snapshots, descriptors and current pointers like every other metric; an engine version bump per §6);
   3. empty and missing-data handling (NULL with the engine's reasons, e.g. `stale_invoice_data`, `no_opening_balance`, `open_items_only`, `no_source_covers_period`; never zero);
   4. unit, integration and pgTAP coverage;
   5. tenant/RLS verification;
   6. Health Score regression testing.
2. Restoring the calculation may make existing Health Score rules (Q3) and alerts begin to fire. That is an **intentional** consequence, and it must be **independently audited** as part of the remediation. It includes re-scoring history, and it checks that no Phase 15 comparison mixes before-recovery and after-recovery scores without that being stated.
3. **Dependency chain:** Receivables/Payables Engine Recovery → Health Score regression audit → Phase 16 implementation, including F5.
4. **Figures F5 may use.** F5 must never consume manually inserted, test-only or synthetic figures. Missing receivables/payables data stays unavailable, never zero and never a healthy score.
5. **Requirement unchanged.** REQ-FR-07 stays a requirement; only its implementation is blocked by this dependency.

#### ADR-120 — implementation record (2026-09-30, engine 2.0.0)

Status: **implemented; awaiting independent audit.** Phase 16 has not started.

**Scope as approved.** During inspection a second defect of the same class was found: the cash chain was never carried between periods. The product owner decided (2026-09-30) to fix it **in this same remediation**, so one engine version bump and one Health regression audit cover both.

**1. Root cause — one defect class: the run computed each period alone and never carried anything.**
- `composePeriod` (the only caller of the metric modules) ran P&L, cash and concentration. It **never called `computeReceivables`** (Phase 4, `b2a6861`), and no SQL wrote the seven receivables keys. No calculation run ever persisted them.
- `computeCash` supports `openingCarry` / `priorNetMovements`, but the run **never supplied them** (logged in Phase 14 only as LOW-8). As a result:
  - every month opened at the bank account's own `opening_balance` instead of the previous close. Reproduced: opening 20,000 with −3,000 a month gave 20,000 → 17,000 in June, July **and** August;
  - `cash_runway_months` never had three months and was always `insufficient_history`.
- Found on the same path and fixed because the restored figures would otherwise not reach their consumers correctly:
  - (a) **Coverage.** Composition told the cash module that every active account was covered in every period, so a month with no statement reported a known 0.00 movement at completeness 1 (contrary to §3.3).
  - (b) **Silent truncation.** `health` `loadObservations` and the engine's `loadCurrentObservations` read `metric_current` in one PostgREST request, which is **silently truncated at 1,000 rows**. A 24-month organisation holds ~1,300 rows before this change and 1,848 after, so the health step and the alert pass had been working on an arbitrary subset (the ADR-114 lesson).
  - (c) **Variance bases.** `receivables_days` / `payables_days` were not variance bases, so §8.2's "days slowed ≥ 10" trigger read a key no run wrote.
  - (d) **Drill-down totals.** The evidence resolver totalled `open_as_of` / `overdue_as_of` drill-downs as today's unsigned Σ `balance_due`, and `period_balances` drill-downs in natural sign. Neither could reconcile to the engine's figure.

**2. Exact implementation (no migration; schema unchanged: 55 tables, 125 api functions).**
- **Wiring.** `financial-engine/domain/receivables-input.ts` (new, pure) shapes `ReceivablesPeriodInput` from what the run holds. `composePeriod` calls `computeReceivables` last, and fills derived-component snapshot ids.
- **Per-side source**, first that can state the balance:
  1. invoices of that side under §2.2's AR/AP test (`invoiceSideCoverage`: spans P, or committed **0–45 days after** P);
  2. the balance family's cumulative trial balance / balance sheet — a stated zero when the statement lists no row;
  3. the ledger, only with an opening-balance journal;
  4. otherwise NULL with `stale_invoice_data` / `no_opening_balance` / `no_source_covers_period`.
- **Working capital** is NULL when `closing_cash`, `receivables` or `payables` is unknown. Before, an unknown receivables balance was summed as nil.
- **Run (`services/run.ts`):**
  - per period: `cashOptions` (opening carried from P−1's close once any earlier period had a statement; P−2/P−1 net movements, NULL when a month was not fully covered), `priorDenominators`, the invoice rows (paged), the opening journal, and the cash-like accounts a statement actually covers in P;
  - once per run: every committed batch (`import_type` now kept by the loader).
- **Version gate.** The first run on a new engine version recomputes the whole history (`loadLatestEngineVersion`).
- **Cash domain.** A month whose statements do not cover every active cash-like account has an unknown movement for runway (`movementKnown`).
- **Variance bases** gained `receivables_days`, `payables_days`.
- **Paging.** `loadObservations` (health / alerts) and `loadCurrentObservations` (engine) page in 1,000s, ordered.
- **Resolver.** `invoice_open_at` totals on the engine's `invoiceOutstandingAt` (exported: one rule, two readers); `balance_reporting` totals `period_balances` in reporting sign.
- `ENGINE_VERSION` 1.0.0 → **2.0.0** (major: existing cash values change).

**3. Calculation path restored.** `calculation.run` job → `runCalculation` (carries, batches, invoices) → `composeWithIds` → `composePeriod` → `computeReceivables` / `computeCash` → `finish_chunk` → health step → `alerts.evaluate` job. Health and alerts read the snapshots unchanged, through their existing rules.

**4. Persistence path.** Unchanged architecture: `metric_snapshots` + `metric_current` via `api_server.finish_chunk`, each snapshot with `basis`, `assurance_level`, `data_quality`, `components` and `evidence_query` pinned to the run. No figure is written anywhere else. The fixtures prove every receivables snapshot belongs to a succeeded 2.0.0 run.

**5. Evidence path.**
- **Leaf descriptors:**
  - invoices: `open_as_of` / `overdue_as_of`;
  - `period_balances`: with `account_ids`;
  - `ledger_entries`: naming every period summed.
- **Derived metrics** (`*_days`, `working_capital`) name their input snapshots.
- **Reconciliation:** the sweep now walks **104** descriptors (100 before), **0 mismatches**. The fixture tests reconcile:
  - historical receivables including an invoice paid after the date (1,200 = 1,200);
  - receivables and overdue with a credit note (4,400 / 1,800);
  - a ledger balance (2,500 / 2,600);
  - a trial-balance liability (4,000 = 4,000).

**6. Test coverage.**
- **Unit** `engine-receivables-wiring.test.ts` (24):
  - per-side and after-only freshness;
  - outstanding-at rule;
  - positive / genuine zero / unavailable / stale;
  - sales-only ⇒ payables unknown;
  - trial balance (stated zero, liability sign, movement basis refused);
  - ledger with and without an opening journal;
  - working capital valid and NULL;
  - runway over unstated months.
- **Compiler:** one test for `balance_reporting`.
- **Integration** `receivables-recovery.test.ts` (26), over six organisations seeded as raw committed records and computed only through the real queue (`test/fixtures/adr120-orgs.ts`; nothing writes a snapshot). It covers A–O and edge cases 1–14:
  - no invoices; no purchases; invoice-only; ledger; bank + invoice; partial and complete coverage;
  - fully paid and outstanding, on both sides;
  - empty organisation; multiple months; a month with missing data;
  - tenant isolation and RLS; evidence; the intended Health and alert changes.
- **Existing tests amended because the approved rule changed their expectation** (each comment says why):
  - working capital with unknown receivables (5,900.00 → NULL);
  - the §3.2 variance-base list;
  - two compiler assertions (`column` → `invoice_open_at`);
  - the fingerprint test's version literal;
  - the run-loop test's repository mock (three new readers).
- **AI eval corpus** re-recorded (`RECORD_AI_EVAL=1`, ADR-081). Normalised diff:
  - `get_receivables` / `get_payables` return the engine's NULL snapshot with `no_source_covers_period` instead of `NO_DATA`;
  - `get_business_summary` lists those NULL rows;
  - one `get_alerts` `threshold_summary` gains `revenue` (paging fix);
  - `get_health_score` gains one snapshot id.

  The prompt version (`analyst-v3.5`) is unchanged.

**7. Health Score behavioural changes** (before/after regression audit: the same six fixtures computed on `74050d1`'s engine and on 2.0.0, diffed rule by rule for every dimension and month). Only these rules changed, each for the stated reason:

| Rule | Before | After | Cause |
|---|---|---|---|
| C2 runway | always `skipped` | scores: BANK Aug `3 to 6 months` +5; INVBANK Aug `>= 6 months` +20; LEDGER and TB Aug `cash generative` +20 | runway computed (cash carry) |
| Q3 days to get paid | always `skipped` | INVBANK and INVONLY Aug `60 to 90 days` −10 (61 days); LEDGER Aug `<= 30 days` +15 (in an excluded dimension) | receivables computed |
| B1 balance trend | `no clear trend` (flat, uncarried balance) | BANK `falling for 3 months` −15; LEDGER `rising for 3 months` +15 | cash carried |

- **Scores, August:** INVBANK 71 → 75, INVONLY 72 → 70, LEDGER 69 → 76, TB 70 → 80.
- **Unchanged:** June and July in every organisation, every other rule (P1–P4, G1–G3, K1–K3, C1, C3, C4, Q1, Q2, B2–B4), and `health.config.v1`.
- **Rules not modified.** No Health threshold or rule was modified.
- **Months without a statement** now carry `bank_coverage_partial` at completeness 0, so the existing 0.6 rule excludes their cash dimension instead of scoring an invented 0.00 movement.
- **Phase 15 comparisons.** The first 2.0.0 run recomputes an organisation's whole history under the same config, so the latest-two-months comparisons compare like with like.

**8. Alert behavioural changes** (same audit):
- **Now fire:**
  - `receivables.deterioration` (INVBANK and INVONLY Aug, medium, 41% overdue);
  - `payables.deterioration` (INVBANK Aug, high, 100% overdue).
- **Now fire because their inputs are no longer truncated.** The conditions were already true:
  - LEDGER `revenue.decline` (Jul medium −25%, Aug high −33%);
  - INVBANK `concentration.supplier`.
- **Removed:** INVBANK `cash.decline` (Aug). It was an artefact: August had been computed from the account's opening balance rather than July's close.
- **Moved:** state alerts `recurring.*` move from a future month (Aug 2027), which had been treated as fully covered, to the last covered month (Aug 2026).
- **Rules not modified.** No alert threshold or rule was modified.

**9. Security verification.**
- No schema, grant, policy or permission change.
- New figures live in the existing RLS-forced tables. The new suite proves:
  - another organisation's owner reads none of them;
  - the owner reads their own;
  - a descriptor resolved through an outsider's session returns nothing.
- The existing tenancy, RLS, portfolio and isolation suites pass: integration 782/783, pgTAP 1,068/1,068.

**10. Final gates (clean database, sequential, 2026-09-30).**

| Gate | Result |
|---|---|
| typecheck | pass |
| lint | pass |
| unit | 2,067 / 2,067 |
| integration | 782 / 783 in one full run on the final code (52 files). The one failure was `ai-eval-record` detecting the intended `get_receivables` output change; after re-recording (the only file changed afterwards) that test passes, then shows its known flake below |
| `ai-eval-record` isolated rate on the new recording | 6/10, the documented `get_alerts #16 output shape` ordering flake, pre-existing and untouched |
| eval | 253 / 253 |
| pgTAP | 1,068 / 1,068 |
| schema drift | 55 tables / 125 api functions, unchanged |
| production build | pass |
| Playwright | 69 passed + 1 pre-existing conditional skip (as at the Phase 15 release) |

**11. Known remaining findings (not fixed here; none blocks the recovered figures).**
- **F-1 Unpaged record reads (pre-existing).** The alert pass's ledger, bank and invoice record readers are also unpaged (1,000-row cap). ADR-120 does not change their row counts.
- **F-2 Invoice coverage for the P&L (pre-existing, P&L family).** The shared `invoices` coverage accepts an invoice batch committed before a period ended, and an `open_items`-only list can become the P&L basis. The AR/AP family no longer uses it.
- **F-3 Statement opening balance not wired.** CD-06's first opening-cash source (the statement's own opening balance) is not wired; opening cash still comes from `bank_accounts.opening_balance`.
- **F-4 Ledger opening from a prior balance sheet.** ADR-027.3's balance-sheet row for the period before the earliest ledger period is not implemented; such ledger balances are NULL `no_opening_balance`.
- **F-5 Invoice read scales with rows.** The aging invoice read is proportional to rows (paged), not to periods × dimensions.
- **F-6 No deploy-time recalculation.** Each organisation shows 1.0.0 figures until its next run, which then recomputes its whole history. Operationally, enqueue a `recalc_manual` for every active organisation after deploy.
- **F-7 Future fiscal periods.** Months after the as-of date carry the last close at completeness 0 with `bank_coverage_partial`.
- **F-8 `payables_days` needs cost of sales.** Its denominator requires `cost_of_sales`, so an organisation with no cost-of-sales accounts has no `payables_days` (§3.4 as written).
- **F-9 Balance drill-down totals.** `period_balances` drill-downs are now in reporting sign for every descriptor. P&L trial-balance descriptors still do not total to their monthly figure (cumulative differencing, pre-existing, outside the sweep).

#### ADR-120 — pre-audit hardening and final disposition (2026-09-30)

Status: **hardened; ready for independent audit.** Not independently approved. Phase 16 not started.

**Receivables / payables source precedence (per side, per period; `domain/receivables-input.ts`):**
1. **Invoices of that side.** A sales batch (`sales_invoices` / `sales_report`) for receivables, a purchase batch (`purchase_invoices` / `purchase_report`) for payables, whose declared range spans P, or which was committed **0–45 days after** P ended (`invoiceSideCoverage`).
   - Every accepted, non-superseded invoice issued by the as-of date is aged with `invoiceOutstandingAt`: an invoice paid after the date counts at its total; credit notes subtract; void invoices are excluded.
   - The as-of date is P's end, or the run's `asOf` for the current period.
2. **The balance family's statement for P.** Trial balance over balance sheet (ADR-047.4), cumulative basis only.
   - Σ closing balance of the category's accounts, in reporting sign.
   - A covering statement with no row states **0**. A movement-basis statement is not a balance.
3. **The ledger.** Only when BOTH hold:
   - a declared GL range spans P (not `partial_month`);
   - an opening-balance journal exists and P is not before the journal's period.

   Value = opening journal + every movement from the journal's period to P. Movements before the journal are already inside it and are never added.
4. **Otherwise NULL**, with `stale_invoice_data` (a batch of that side exists but none covers P), `no_opening_balance` (ledger rows but no usable opening), or `no_source_covers_period`.

Working capital is NULL when cash, receivables or payables is unknown. The balance-sheet-only terms may be missing (`partial_working_capital`).

**Cash carry and runway coverage semantics (`services/run.ts`, `domain/cash.ts`):**
- **Chain start.** The chain starts at the first period in which a statement covers any cash-like account. Before it, each month is computed on its own; with no opening source it is NULL `no_opening_cash`, never 0.
- **Chain-start opening**, per account, CD-06 order:
  1. the earliest statement's own printed opening balance — only when that statement starts on the first day of a fiscal period; `verified`; deterministic or reviewer-typed values only;
  2. `bank_accounts.opening_balance` dated on or before the period start (`calculated`);
  3. otherwise NULL.
- **Carry.** From the chain start, P opens at P−1's close, carrying P−1's basis, assurance and missing reasons. An account first covered later brings its own opening (a "joiner").
- **Coverage and completeness.** Coverage is the accounts a committed statement ACTUALLY covers in P: `completeness = covered / active`, with `bank_coverage_partial` below 1.
- **Runway.** `cash_runway_months` needs three consecutive months, each fully covered (every active cash-like account stated). A month without that is unknown (`insufficient_history`), never a 0.00 burn. A cash-generative window is NULL with `cash_positive`, which Health C2 scores as designed.

**Deployment recalculation mechanism:**
- **Function.** `api_server.enqueue_engine_upgrade(engine_version)` (migration `20260930000001`, service role only). It queues `calculation.run` (`recalc_manual`) through the EXISTING `app.enqueue_recalculation` for every `active` / `suspended` organisation that has a succeeded run but none on `engine_version`, writing `job.enqueued` audit rows (`reason: engine_upgrade`).
- **Idempotent.** The recalculation idempotency key coalesces with any queued job for the organisation.
- **Resumable.** An organisation leaves the set only when a run on the new version SUCCEEDS.
- **Tenant-safe.** One job per organisation under `withOrgScope`.
- **No giant transaction.** The function only inserts job rows; the worker computes each organisation separately.
- **Failures visible.** They surface as failed/dead jobs in `/platform/jobs`.
- **Nothing left behind silently.** `/api/jobs/nightly` calls it every night after the storage sweep, so a failed organisation is queued again until it succeeds.
- **After a deploy.** Run `APP_URL=… CRON_SECRET=… npm run engine:upgrade` (the same endpoint) to start at once. The run recomputes the whole history on a version change (`loadLatestEngineVersion`).
- **No other schedule touched.** No other scheduled calculation exists to disturb (FU-6).

**Final findings table** (FU-n = the follow-up register, ADR-122):

| # | Finding | Severity | Origin | Affected by ADR-120? | Action | Status |
|---|---|---|---|---|---|---|
| H-1 | New engine version left every organisation on old figures until its next run; §6's deploy-time recalculation was never built | HIGH | pre-existing gap, made material by 2.0.0 | Yes | `enqueue_engine_upgrade` + nightly + `npm run engine:upgrade`; tests: queues only eligible, idempotent, runs on 2.0.0, failure isolated/visible/re-queued, server-only, version validated | **FIXED** |
| H-2 | Set-returning RPC reads (`aggregate_periods`, `aggregate_transfer_legs`, `batch_coverage`) silently capped at 1,000 rows by PostgREST `max_rows` (proved: 1,200 cells → 1,000) | HIGH | pre-existing (Phase 4) | Yes. The ledger history, statement cells and invoice denominators all come from the aggregate. On `364bf17`, revenue came out 99,900.00 for a 120,000.00 month. | `serverRpcAll`: paged, ordered on the full grouping key; `engine-row-cap.test.ts` (fails on `364bf17`, passes now) | **FIXED** |
| H-3 | Engine table reads `accounts`, `counterparties`, `bank_accounts` capped at 1,000 | MEDIUM | pre-existing | Yes: receivables/payables accounts; supplier category → `payables_days` (proved: cost of sales 0.00 → 500.00); cash coverage | paged | **FIXED** |
| H-4 | Restored deterioration alerts named only invoices ISSUED in the alert month, at today's balance; void invoices were not excluded; the read was unpaged | MEDIUM | pre-existing code, reached by ADR-120 | Yes: `overdue_count`, `top3_share`, pinned evidence. The condition (snapshot share) was correct. | `loadOpenInvoices` (paged, non-void, visible at the run instant) aged with `invoiceOutstandingAt` at the figure's `as_of`; unit test | **FIXED** |
| H-5 | CD-06's first opening-cash source (the statement's own opening balance) never supplied | MEDIUM | pre-existing | Yes: the value at the chain start, hence every carried month and runway | earliest statement per account, first-of-period only; unit + HISTORY integration (8,000 opening, `verified`) | **FIXED** |
| H-6 | Ledger fallback could add movements posted before a mid-export opening journal (double count) and used partly covered months | MEDIUM | ADR-120 (`364bf17`) | Yes | balance starts at the journal's period; a declared range must span P; unit tests | **FIXED** |
| H-7 | The P&L family's shared `invoices` coverage accepts a batch committed BEFORE the period and treats the AR/AP freshness gate as revenue coverage. A month no list covers takes the invoice basis and reports revenue **0.00 with no missing reason** (probe: INVBANK Sep–Dec 0.00, identical before and after ADR-120) | HIGH | pre-existing (P&L coverage) | No. ADR-120 uses its own per-side, after-only test; its only reach is `receivables_days` on a balance or ledger basis becoming unavailable, never wrong. | registered as FU-1. **Must be fixed before Phase 16 F1** (it would score `no_revenue` −30 on a fabricated zero) | **PRE-EXISTING / FOLLOW-UP** |
| H-8 | Unpaged record readers: alerts `loadLedgerRecords`, `loadInvoiceRecords` (duplicates), `loadExistingAlerts`; health `loadBankRecords`, recurring members, `loadRecurringGroups` | MEDIUM | pre-existing | No. The restored C2/Q3/B1 and the restored alert conditions read the paged `metric_current`; the restored alerts' invoice list reads `loadOpenInvoices`. These feed B3/K3, bank, duplicate and recurring rules. | FU-2 | **PRE-EXISTING / FOLLOW-UP** |
| H-9 | Fingerprint source lists unpaged | LOW | pre-existing | No: they decide whether a run happens, not its figures; the version bump forces the recompute | FU-3 | **PRE-EXISTING / FOLLOW-UP** |
| H-10 | `loadPeriods` unpaged | — | — | No: one row per month, cannot reach 1,000 | none | **INTENTIONAL** |
| H-11 | `statementClosing` / `unreconciledStatement` never supplied to cash, so `statement_balance_mismatch` / `unreconciled_statement` never appear on cash snapshots. Phase 16's design (gate G-3) assumed they do. | MEDIUM | pre-existing | No: data-quality warnings only, no value | FU-4 | **PRE-EXISTING / FOLLOW-UP** |
| H-12 | ADR-027.3's other ledger opening (a balance-sheet row for the period before the earliest ledger period) not implemented | LOW | ADR-120 scope | No wrong value: such a balance is NULL `no_opening_balance` | FU-5 | **INTENTIONAL** (conservative; unavailable, never wrong) |
| H-13 | Aging invoice read is row-proportional | LOW | ADR-120 design | — | paged; reuses the Phase 4 domain rule rather than a second copy in SQL | **INTENTIONAL** |
| H-14 | No daily scheduled calculation: the `scheduled` trigger exists but nothing enqueues it, so the current month's aging/runway refresh only on imports, recalculations and the engine-upgrade sweep | MEDIUM | pre-existing | No | FU-6 | **PRE-EXISTING / FOLLOW-UP** |
| H-15 | Periods after the as-of date carry the last close at completeness 0 with `bank_coverage_partial` | LOW | ADR-120 semantics | — | §3.3 coverage rule | **INTENTIONAL** |
| H-16 | `payables_days` NULL without cost-of-sales accounts | LOW | §3.4 as written | — | — | **INTENTIONAL** |
| H-17 | P&L trial-balance drill-downs do not total to the monthly (differenced) figure | LOW | pre-existing | No: balance-family descriptors reconcile (sweep) | FU-7 | **PRE-EXISTING / FOLLOW-UP** |
| H-18 | CI "security checks" red: new `brace-expansion` high advisory (transitive) | MEDIUM | external | No | lockfile-only patch bumps, separate commit; `uuid` moderate via `exceljs` (breaking fix) is FU-8 | **FIXED** (high) / FOLLOW-UP (moderate) |
| H-19 | `ai-eval-record` `get_alerts #16` ordering flake | LOW | pre-existing | No | out of scope by instruction | **PRE-EXISTING / FOLLOW-UP** |
| H-20 | AI tools list a NULL receivables row with `availability.state: available` | — | existing tool contract | — | `availability` is only the ADR-106 withholding rule; the value is `null` with its missing reason, like every NULL metric | **INTENTIONAL** |

**Hardening verification:**
- **Same six fixtures, old engine vs hardened engine**, rule by rule: Health changes only C2, Q3, B1, as recorded above, with no other rule in any dimension or month. The alert changes are as recorded above. The fixtures' figures are identical to `364bf17`.
- **Days-to-pay variance.** `receivables_days` / `payables_days` variances are now written (e.g. `payables_days.variance.prev_period` 44 in INVBANK September). The deterioration rules keep their existing incomplete-period suppression.
- **New tests:**
  - `engine-row-cap.test.ts` (5, above the cap on every read);
  - `engine-upgrade.test.ts` (6);
  - `receivables-recovery.test.ts` now 32 (adds history-first/banking-later with a statement opening, and admin / client / assigned and unassigned employee / super admin at aal1 and aal2 through RLS and the resolver);
  - unit: 5 wiring tests (journal start, partial month, working-capital genuine zero, statement opening ×2) and 1 alert rule test.

Gates for the hardening commit are recorded in its commit message.

### ADR-122 · Follow-up register: pre-existing defects found during the ADR-120 hardening
Status: **open. Not fixed by ADR-120; each needs its own decision.** Listed so none is lost. None changes an ADR-120 figure (ADR-120 findings table, H-7…H-19).

| # | Defect | Evidence | Recommendation |
|---|---|---|---|
| FU-1 | P&L `invoices` coverage accepts a batch committed before the period, and uses the AR/AP freshness gate as revenue coverage. A month no full list spans reports revenue 0.00 with no reason, and a complete month inside a gap between two lists would be scored by Health as a zero-revenue month. | `coverage.ts` `arApBatch` (negative day gap accepted; `invoices.covers` true on it); ADR-120 probe INVBANK Sep–Dec revenue 0.00 before and after | Fix before Phase 16: revenue needs a `full` list spanning P (ADR-047.10); the freshness gate is the AR/AP family's only. **FIXED (ADR-125, engine 4.0.0).** |
| FU-2 | Alert and health record readers unpaged (1,000-row cap) | ADR-120 H-8 | Page as `loadOpenInvoices` does. |
| FU-3 | Fingerprint source lists unpaged | ADR-120 H-9 | Page, or fingerprint from counts/max timestamps. |
| FU-4 | Statement closing cross-check and unreconciled-statement flag never supplied to cash | `compose.ts` passes neither `statementClosing` nor `unreconciledStatement` | Wire before Phase 16 F3.4 relies on `unreconciled_statement`. |
| FU-5 | Ledger opening from the prior balance sheet (ADR-027.3 (a)) | ADR-120 H-12 | Implement if ledger-only organisations need AR/AP without an opening journal. |
| FU-6 | No daily `scheduled` calculation is enqueued | no caller of the `scheduled` trigger | Enqueue per organisation from the nightly route (as-of-only runs, ADR-047.8). |
| FU-7 | P&L trial-balance drill-down totals ≠ monthly figure | cumulative differencing | Descriptor over the two statements, or a derived descriptor. |
| FU-8 | `uuid` moderate advisory via `exceljs` | `npm audit` | Upgrade `exceljs` deliberately (breaking). |
| FU-12 | Cost-side mirror of FU-1: with only a full SALES list establishing P, the invoice-basis P&L states `cost_of_sales`/`operating_expenses` 0.00 and profit = revenue; conversely a purchase-only list's costs are now NULL | ADR-125 | Decide per-side P&L coverage for the invoice basis before Phase 16 relies on profit or cost figures from invoice-only organisations. **FIXED (ADR-126, engine 5.0.0):** invoice-basis costs need a full purchase list that establishes the month. |
| FU-13 | The import pipeline never wrote `invoice_list_kind = full`; every list committed through the app had a NULL kind | ADR-125 D-5 | **FIXED (ADR-125):** the kind is written at commit (trigger `app.invoice_list_kind_at_commit`) and committed batches were backfilled. |
| FU-14 | A period that stops being complete kept the `health_current` pointer an earlier run left | ADR-125 D-6 | **FIXED (ADR-125):** `api_server.set_period_completeness` withdraws the pointer. Known limit: not restored if the run then fails. |
| FU-15 | `invoiceSideCoverage` (AR/AP) does not yet limit a list to its commit date | ADR-125 | **OPEN.** Out of FU-1's scope by the owner's instruction (AR/AP unchanged). |

FU-1, FU-13 and FU-14 are fixed by ADR-125 (below), and FU-12 by ADR-126; FU-15 is open. FU-9 to FU-11 are in the ADR-122 amendment of 2026-09-30.

### ADR-121 · Funding Readiness is calculated only while enabled, with eligible historical backfill on enablement
Status: **decided by the product owner, 2026-09-30 (Phase 16 U-4, U-5).** The earlier proposal (calculate for every organisation and let the flag gate visibility only) is **REJECTED**.

Decision:
1. **Flag off** (`organizations.features.funding_readiness` absent or false, the default):
   - no Funding Readiness calculation;
   - no current assessment;
   - `/app/[orgSlug]/funding` returns not-found;
   - no navigation link.

   This is enforced server-side, and by RLS on the funding tables (a flag predicate), never by UI hiding alone.
2. **Enablement** sets the flag, writes the audit event and enqueues `funding.assess` on the EXISTING job queue, all in one transaction. The job assesses every eligible period (each complete fiscal period with current metric snapshots) and establishes the current assessment. From then on each `calculation.run` assesses its complete periods. The EXISTING nightly job re-enqueues `funding.assess` for an enabled organisation whose latest eligible period has no current assessment. This is **"calculate after enablement with eligible historical backfill."**
3. **Disablement** stops calculation. Rows already written remain as the audit record but are unreadable while the flag is off. Re-enabling runs the backfill again for periods whose current assessment does not cite the period's current run.
4. Each row records its `trigger` (`enablement_backfill` / `calculation_run` / `nightly_backstop`), so activation history is auditable.

### ADR-123 · ADR-120 remediation: answers to the independent audit, and the AR/AP freshness rule
Status: **implemented (`8493362`); second independent audit NOT READY** (`docs/ADR-120_SECOND_INDEPENDENT_AUDIT.md`) — residuals and new findings go to ADR-124. Phase 16 not started.
Context: the independent audit of ADR-120 (`docs/ADR-120_INDEPENDENT_AUDIT.md`, of `7a139b8`) returned **NOT READY**: HIGH F-1…F-4, MEDIUM F-5…F-11, LOW L-1…L-10. Every blocking finding was reproduced on the auditor's own data shapes, now kept as the permanent fixture `test/fixtures/audit-orgs.ts` and asserted in `test/integration/adr123-remediation.test.ts` through the real queue.

**Decision (product owner, 2026-09-30) — the AR/AP invoice freshness rule (F-4, F-9):**
- A batch of a side covers P when its declared range spans P, OR when it is fresh for P. Fresh means all three of:
  - committed on or after `P.period_start`;
  - committed no more than 45 days after `P.period_end`;
  - its declared range overlaps P (starts on or before P's end, ends on or after P's start).
- **Approved:** the commit window.
- **Added in implementation, recorded here for the owner:**
  - the range must reach into P (the auditor's F-4 fix, because the approved window alone still let a March list, committed 5 April, cover February);
  - the range must not have ended before P, because the first draft let that same list state a verified 0.00 for April and hide April's balance sheet — the remediation test caught it.

**Findings and what was done:**

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| F-1 | HIGH | Cash carried across a missing statement month, relabelled complete | (a) §2.3 applied to cash: a month no source covers is NULL `no_source_covers_period`, not a carried value. (b) The chain RESTARTS when P−1 was not fully stated or its close is unknown; a restart takes only a balance stated exactly at P's start (that day's statement opening, or a typed balance dated the day before), else NULL. (c) The statement closing cross-check and the IMP-BAL-006/007 flag are wired (FU-4). GAP: August 4,000 → 3,500 (verified); July NULL; no invented `cash.decline`. | FIXED |
| F-2 | HIGH | Opening taken from the wrong statement | A statement's opening is a candidate only for the period starting on its own first day; ties go to the latest committed (L-4). MIDSTART: July NULL (unknowable); August restarts at 5,500 → 5,600. | FIXED |
| F-3 | HIGH | Two opening journals double-counted | The LATEST opening journal at or before P, plus movements from its period. LEDGER2: 6,000 / 7,000 / 5,000; drill-down 5,000. | FIXED |
| F-4 | HIGH | A later list stated a verified 0.00 for an earlier month | Freshness rule above. BSREV February: NULL `stale_invoice_data`. | FIXED |
| F-5 | MED | Days to get paid from unstated revenue zeros | The denominator treats revenue carrying `open_items_only` as unknown. BSREV April/May: NULL. The P&L defect itself remains FU-1. | FIXED (its ADR-120 reach) |
| F-6 | MED | TB + BS drill-down summed twice | New descriptor filter `balance_kind` pins the statement the engine chose. TBBS 9,000 → 9,000. | FIXED |
| F-7 | MED | Part-paid invoice with a payment date dropped from drill-down | The resolver's open-at filter uses `invoiceOutstandingAt` (non-zero contribution). PARTIALPD 600 → 600, 1 row. | FIXED |
| F-8 | MED | Drill-downs over ~250 records: HTTP 414 | Id batches of 100 (measured limit ~200). BIGINV 10,500 → 10,500, 1,050 rows. | FIXED |
| F-9 | MED | Current month unreachable; the test depended on the wall clock | Freshness rule above (CURRENT: September 1,500 / overdue 1,000). Fixtures pin `committed_at` (`COMMITTED_AT`); the impossible assertion is replaced by the true one (a June–August list says nothing about September). | FIXED |
| F-10 | MED | Deterioration alerts: "133%", HIGH alert on a net credit | No alert when the total is not positive; `top3_share` is over the gross overdue invoices it names (≤ 100%); figures keep their sign. Thresholds and triggers unchanged. | FIXED |
| F-11 | MED | Health/alert regression record incomplete | Restated below from an 18-organisation diff (7 ADR-120 fixtures + the audit's 11), pre-ADR-120 engine (`1443e76`) vs this remediation. | FIXED (needs owner sign-off) |
| L-1 | LOW | `payables_days` gross ÷ net | Needs a spec decision (VAT netting of payables) | FOLLOW-UP (FU-9) |
| L-3 | LOW | Movement TB hid a cumulative BS | Statement kind precedence runs over kinds that can state a balance. MOVTB: 9,000. | FIXED |
| L-4 | LOW | Same-day statements tie-broken by uuid | Latest committed wins | FIXED |
| L-5 | LOW | Upgrade sweep audited re-found jobs | Migration `20260930000002`: audit only when a job is queued | FIXED |
| L-6 | LOW | Fingerprint lists unpaged | — | FOLLOW-UP (FU-3) |
| L-7 | LOW | Paged aggregate re-evaluated per page; one statement timeout (the retry succeeded) | — | FOLLOW-UP (FU-10) |
| L-8 | LOW | `*_days` derived evidence names only P's inputs | — | FOLLOW-UP (FU-11) |
| L-9 | LOW | Future periods carried cash | A month with no covering source is NULL (F-1 (a)) | FIXED (cash) |
| L-10 | LOW | No pgTAP for the upgrade sweep | `supabase/tests/15_engine_upgrade.test.sql` (12) | FIXED |
| H-11 | — | "Not affected by ADR-120" was wrong (audit) | The cross-check is wired as part of F-1 | FIXED |

**F-11 — the complete Health and alert change set of ADR-120 + ADR-123.** The same 18 organisations were computed by the engine before ADR-120 and by this one, and compared rule by rule and alert by alert, every period. Every change falls into one of these categories. No threshold or rule was changed.

| Category | Rules / alerts that change | Where (fixtures) |
|---|---|---|
| A. Newly available figures (receivables, payables, runway) | Q3 scores (was always skipped); C2 scores (was always skipped); `receivables.deterioration` and `payables.deterioration` fire | INVBANK, INVONLY, LEDGER, LEDGER2, CURRENT, PARTIALPD, CREDITHEAVY (July only; a net credit in August does not), BIGINV, LONG (13 months) |
| B. Cash carried, and openings stated by statements | B1 reads a carried balance. C1/C4 and the `cash_flow` dimension are scored where a statement now states the opening (it was unknown). `cash.decline` removed where it was a carry artefact, added where cash really fell three months running. | BANK, LEDGER, HISTORY, GAP, MIDSTART, INVBANK (removed), BIGINV (added) |
| C. A month with no statement is unknown, not a zero movement (§2.3) | C3 is skipped (`insufficient_history`) in the first months after data begins, where it had scored invented 0.00 movements. `bank.unusual_transaction` / `variance.significant` no longer fire on a month no statement spans. | BANK, INVBANK, LEDGER, TB (June–July); MIDSTART |
| D. Health and alert reads no longer truncated at 1,000 rows | G1, G2, K1, P1, P2, P4, B2 now evaluated. `revenue_growth`, `cost_control` and `profitability` included where required metrics had been cut off. `revenue.decline` replaces `variance.significant`. `concentration.supplier` fires. | LONG (15 months: August 56 → 67), BIGINV (unscored → 59/76/50), LEDGER, LEDGER2, CURRENT, PARTIALPD, CREDITHEAVY, INVBANK |
| E. State alerts re-dated from a future month to the last covered month | `recurring.*` | BANK, INVBANK, LEDGER |

**Consequence for Phase 15.** The first 2.0.0 run recomputes an organisation's whole history under the same `health.config.v1`, so `bandFell` / `scoreFell` compare like with like. But the Command Centre will show different scores for organisations with long histories (category D), and different attention reasons (A, B). **This change set needs the product owner's sign-off.**

**Gates** are recorded in the commit message.

### ADR-122 amendment (2026-09-30)
- FU-4 (statement cross-check and unreconciled flag) is **FIXED by ADR-123** (F-1).
- New follow-ups:
  - **FU-9:** `payables_days` VAT consistency (L-1);
  - **FU-10:** paged-aggregate performance (L-7);
  - **FU-11:** `*_days` derived evidence naming the three-month denominator (L-8).
- **FU-1 remains: fix before Phase 16 F1.** *(Fixed since by ADR-125.)*

### ADR-122 amendment (2026-09-30) — FU-1
- **FU-1, FU-13 and FU-14 are FIXED by ADR-125** (engine 4.0.0; migration `20260930000004`). An earlier draft of this amendment recorded FU-13 and FU-14 as open blockers awaiting an owner decision; that is superseded — both are fixed, and ADR-125 records how.
- New follow-ups: **FU-12** (cost-side mirror of FU-1) and **FU-15** (AR/AP lists not yet limited to their commit date) — both OPEN, in the register above.

### ADR-124 · Second ADR-120 remediation: per-account cash balances, period-aware AR/AP freshness, dated opening journals
Status: **APPROVED by the product owner (2026-09-30) and IMPLEMENTED — engine 3.0.0. Owner sign-off (2026-09-30): the 27-organisation Health/alert change set (`docs/ADR-124.md` §6) is APPROVED** — that sign-off covers ADR-124's change set, not ADR-123's F-11 table. Implementation record, tests, gates and the 27-organisation Health/alert regression record: `docs/ADR-124.md`. Not independently audited: by the owner's process decision the comprehensive independent audit follows once the remaining approved phases are built. Phase 16 not started.

**Context.** The second independent audit of `8493362` (`docs/ADR-120_SECOND_INDEPENDENT_AUDIT.md`) returned **NOT READY**. Blocking:
- **HIGH:** N-1 and N-2.
- **MEDIUM:** N-3 to N-7.
- **First-audit findings:** F-1, F-2 and F-10 are partly fixed; F-11 is not closed.

Four of the blocking findings (N-1, N-2, N-3, N-6) sit in the cash chain. ADR-123 patched it twice, and each patch fixed the reproduced shapes but not the general case. The cause is structural. The chain carries one **organisation-level** closing figure and decides "carry or restart" for all accounts together. It judges a month's coverage by whether a **single** statement spans it, and it starts the chain at the first month a single statement spans. Every finding is a data shape where one of those three shortcuts is wrong:
- a month partly covered, or covered only by the GL (N-1);
- a split first statement (N-2);
- a joining account (N-3);
- a 5th-to-4th statement cycle (P-2).

ADR-124 therefore replaces the shortcuts with one rule rather than adding a third patch.

**D-1 · Cash is a per-account balance history (N-1, N-2, N-3, N-8, N-9, P-2).** For each cash-like bank account *A* and period *P*:
1. **Coverage.** *A*'s movement in *P* is **known** only when the union of *A*'s winning statements covers every day of *P*. The winning statement for a range is the latest committed; a superseded upload is ignored, including for the unreconciled flag (N-8). One statement need not span the month on its own (P-2: 5th-to-4th cycles).
2. **Opening.** Take the first of these that applies:
   - (a) *A*'s own closing for *P−1*, when known (the carry);
   - (b) a balance stated **exactly** at *P*'s start: a statement opening dated `P.start`, a statement closing dated `P.start − 1`, or a typed balance dated `P.start − 1`. This rule is the same at a chain start and at a restart (N-2, N-9). A typed balance dated earlier is never an opening for *P*.
   - (c) otherwise unknown.
   When (a) and (b) both exist, (a) is stored and (b) is a cross-check that raises `statement_balance_mismatch`. The computed value is kept, as §3.3 already requires.
3. **Closing.** Opening + movement, when both are known; otherwise unknown. An unknown closing never carries. The next period can only restart through (b).
4. **Organisation figures.**
   - `opening_cash` and `closing_cash` are the sums over the accounts in scope. Each is published only when every in-scope account's value is known; otherwise NULL with the reason, naming the accounts.
   - `cash_inflows`, `cash_outflows` and `net_cash_movement` are published only when every in-scope account's movement is known; otherwise NULL with `no_source_covers_period`.
   - Cash figures come from bank statements and typed balances only. A ledger or balance-sheet basis never lends a month a cash figure computed from bank rows (the GAPGL July 9,000 and its 0.00 "ledger" movement).
5. **Carrying between chunks.** Per-account closings are stored in `closing_cash.components.per_account`, and the run reads them for the period before its range. No schema change is needed; the loader adds `components` to its select.

Expected outcomes on the audit's reproductions:

| Organisation | Month | Result |
|---|---|---|
| GAPGL | July | NULL, so no invented July. August restarts at the printed 4,000. |
| PARTJUL | July | NULL, and the August `cash.decline` disappears. |
| MIDTYPED | July | NULL, because the typed balance is dated 31 May, not 30 June. |
| MIDTYPED | August | 5,500 → 5,600 |
| NEWACCT | April–July | *A*'s balances (see D-2) |
| NEWACCT | August | 9,100 |
| CYCLE | June | Opens at the typed balance, then carries 9,000 / 8,000 / 7,000 / 6,000, if its typed balance is dated 31 May. |

**D-2 · Which accounts are in scope for P (N-3; needs owner approval).**
- An active cash-like account **joins** at its start: the first day any source states something about it, meaning its first statement's start or the day after its typed balance date. Before its start it is outside the sum; this is §3.3's "joins at its first covered period", made reachable.
- An active account about which **nothing** is stated (no statement, no typed balance) is in scope for every period. Cash is then unknown, naming that account: "add a statement or an opening balance for …". It is never silently left out of the total.
- A closed account stays in scope for the periods its statements cover.

**D-3 · AR/AP invoice freshness depends on whether P is complete (N-4, N-10). This supersedes the rule approved under ADR-123 and needs owner approval.** A batch of a side covers *P* when its declared range spans *P*. Otherwise:
- **The current period** (the one containing the run's as-of date): the batch covers *P* when it was committed on or after `P.start` and its range overlaps *P*. This is unchanged, and CURRENT stays at 1,500 / 1,000.
- **A completed period:** the batch covers *P* when it was committed after `P.end` and no more than 45 days after it, and it states the position **at** `P.end`:
  - a **full** list (every invoice, with paid dates) whose range reaches `P.end` (starts on or before `P.end` and ends on or after it);
  - or an **open-items** list whose as-at date (the range end) is exactly `P.end`.
- An open-items list dated after `P.end` cannot state *P*. Invoices paid in between are missing from it, so it would under-state *P* (N-10).
- A list committed **during** a completed month states nothing about that month's end (N-4). BSLIST August falls back to its balance sheet: 3,000.

**D-4 · An opening journal starts on its own date (N-5).**
- The ledger fallback starts at the journal's `entry_date`, not at the start of its period. In the journal's own period it adds only the movements dated on or after that date. Earlier periods are unchanged.
- The loader reads `entry_date`, and the aggregate for that one period is date-aware.
- The evidence descriptor gains an optional filter, `entry_date_from`, handled like `balance_kind`: optional in the schema, part of the hash, and emitted only for that period. Old descriptors still parse.
- LEDGER3 August: 5,000.
- Fallback, if the owner prefers: a journal not dated on a period start makes the ledger fallback NULL, with the reason `opening_journal_mid_period`.

**D-5 · The deterioration alert states a possible share (N-7; needs owner approval because it changes when the alert fires).**
- `share` becomes the gross overdue invoices ÷ the gross open invoices: the positive open balances, the population the sentence names.
- Open credits are reported separately in the summary (`open_credits`).
- The 50% and 75% thresholds and the days trigger are unchanged.
- CNFUTURE: "1,000.00 of 1,000.00 owed on invoices is overdue (100%); credits of 800.00 not yet applied". The alert remains HIGH, and the figure is now possible.

**D-6 · The engine version is bumped to 3.0.0 (N-6).**
- ADR-123 changed existing formulas and precedence; under §6 that is a **major** change, and it did not bump the version. ADR-124 bumps it to `3.0.0`, so the upgrade sweep re-queues every organisation, including those `7a139b8` computed.
- **Rule from now on:** any remediation that changes an existing figure bumps the major version in the same commit. A unit test pins `ENGINE_VERSION` to the version recorded in the latest ADR, so forgetting fails CI.

**LOW findings included:**
- N-11: state and overflow alerts are evaluated only up to the as-of period.
- N-12: a NULL cash figure has completeness 0 and the assurance of its missing input, never `verified`.
- N-13: the auditor's nine probe organisations (GAPGL, PARTJUL, NEWACCT, BSLIST, LEDGER3, UNRECON, CNFUTURE, MIDTYPED, CYCLE) become the permanent fixture `test/fixtures/audit2-orgs.ts`, asserted through the real queue in `test/integration/adr124-remediation.test.ts`.
- Unit tests cover the per-account chain directly: the run-loop restart, the joiner and L-4.
- The non-discriminating "no cash fell from 9,000" test is replaced by PARTJUL's decline, which fails on `8493362`.

**Out of scope (unchanged):**
- Health Score thresholds and rules;
- alert thresholds;
- Phase 15 code;
- the Phase 16 boundary;
- RLS and authorisation;
- FU-1 (fix before Phase 16 F1), FU-2, FU-3, FU-5 to FU-11, and L-1 (FU-9).

**F-11 and sign-off.**
- After implementation, the Health and alert change set is recomputed for all 27 organisations: the 7 ADR-120 fixtures, the first audit's 11 and the second audit's 9. The comparison is `1443e76` against the ADR-124 commit, rule by rule and alert by alert.
- Every change is assigned to a category, and any change that fits no category is investigated rather than recorded.
- One owner sign-off then covers ADR-120, ADR-123 and ADR-124 together.

**Specification changes on approval:**
- FINANCIAL_ENGINE §2.2: the per-account bank test and the period-aware freshness rule.
- FINANCIAL_ENGINE §3.3: the per-account opening, closing, scope and joiner rules.
- FINANCIAL_ENGINE §6: the version rule.
- EVIDENCE_MODEL: the `entry_date_from` filter.

**Order of work (as amended by the owner at approval):** build → test → regression-verify → document → commit. No separate independent audit of ADR-124 now; it is included in the comprehensive audit after the remaining approved phases. Phase 16 is still not started.

**As implemented — where it refines the approved text** (details in `docs/ADR-124.md`):
- *D-1:* the chain is day-level — a run of consecutive covered days starts at its earliest anchor (a printed opening or closing, or the typed balance, each at the close of a day) — so a statement cycle that is not calendar-aligned carries (P-2) and "exactly at P's start" is simply the anchor dated the day before. No cash figure is read back from a previous run.
- *D-2:* an account joining mid-month brings its balance of the day before it starts into that month's opening.
- *D-3:* the approved rule, applied consistently: an `open_items` list states a completed month only when its as-at date (range end) is that month's end, whether or not its range spans the month.
- *D-4:* implemented as proposed (date-aware), not the NULL fallback.
- *D-5:* without the invoice population (no `openInvoices`), a net share above 100 % is withheld rather than stated.
- *D-6:* the sweep keys on the LATEST succeeded run; Home shows figures from another engine version under "Updating your numbers"; the golden hash test enforces the bump.

### ADR-125 · FU-1: revenue is stated only from a source that establishes the month
Status: **IMPLEMENTED — engine 4.0.0** (with migration `20260930000004` for FU-13 and FU-14). Not independently audited: the owner has deferred the comprehensive independent audit until the remaining approved phases are built. Phase 16 not started. Implementation record: `docs/FU-1_IMPLEMENTATION.md`; regression record: `docs/FU-1_ENGINE_REGRESSION_RECORD.md`.

**Context.** ADR-120's hardening registered FU-1 (ADR-122; ADR-120 finding H-7). An organisation's invoice list could make the engine state revenue **0.00, calculated, complete, with no missing reason** for months the list says nothing about: INVBANK September–December read 0.00 before and after ADR-120. Health would then score such a month as a zero-revenue month, and Phase 16 F1 would score `no_revenue` −30 on the same fabricated zero. FU-1 had to be fixed before Phase 16.

**Root cause.** In `coverage.ts` `computeCoverage`, the invoices block set `arApBatch` for any invoice batch that spanned P **or** had `daysBetween(P.end, committedAt) <= 45`. That second test is true for every batch committed BEFORE P (the gap is negative) and so for months far in the future. The invoices source therefore covered P, with warning `open_items_only`. §2.3's P&L precedence (`period_balances` > `ledger` > `invoices` > `bank`) chose invoices, and `composePeriod` summed zero invoice cells: revenue 0.00, `calculated`, completeness 1, no missing reason. The same coverage fed the counterparty (customer) family and `isPeriodComplete`.

**Decisions.**
1. **The rule.** The invoices source covers P for the P&L and customer families, and for `is_complete`, only from committed **full sales lists**: target `invoices`, `invoice_list_kind = full`, import type `sales_invoices` or `sales_report` (`invoiceRevenueCoverage`). An `open_items` list (ADR-047.10) and a purchase-only list never cover revenue. The `arApBatch` branch is deleted. The 45-day freshness gate belongs only to `invoiceSideCoverage` (AR/AP, ADR-124 D-3), which is unchanged.
2. **The commit-date limit.** A list's **effective range** runs from its declared start to the EARLIER of its declared end and its commit date. A list knows nothing after the day it was committed: the upload form accepts any end date, and a new batch defaults to the whole current month.
3. **Combining lists.** Effective ranges that meet or overlap combine into one run, as statements do (ADR-124 D-1, `revenueRuns`). A completed P is covered if and only if the combined runs contain every day of P. Two contiguous halves cover a month; halves with a gap do not.
4. **Current and future months.**
   - A period not yet begun (after the as-of) is never covered.
   - The current period is stated as revenue **to date**, through the earlier of the run's end and the as-of: warning `partial_month`, completeness = days reached ÷ days in P. It is complete only when the run reaches P's end.
   - `latestDataDate.invoices` is the latest effective end, capped at the as-of (`revenueDataDate`), so a current month stated to date is not `is_complete`.
   - For the current month's invoice revenue to date, the days-figure denominators (`revenue`, `invoiceSalesTotal`, `payablesExpenseBase` in `receivables-input.ts` `denominatorInputsFor`) are NULL: days figures are not computed from a few days of flow.
5. **FU-13 · The list kind is written at commit.**
   - *The defect:* the import pipeline never wrote `invoice_list_kind = full`. Its only writer, `api.record_batch_confirmation`, copies `p_value ->> 'invoice_list_kind'`. The review page never sends that key: it confirms IMP-INV-012 with `{answer: 'yes'}`. The column has no default. So every list committed through the app had a NULL kind, and under decision 1 would have stated no revenue. Adversarial review found this and rated it a blocker.
   - *The fix:* trigger `app.invoice_list_kind_at_commit` (`BEFORE INSERT OR UPDATE OF status, invoice_list_kind` on `import_batches`). When an invoice batch reaches `committed` with a NULL kind, it sets `open_items` if `confirmations ? 'IMP-INV-012'`, else `full`. An explicit kind is left as it is.
   - `app.backfill_invoice_list_kind()` applies the same rule to batches already committed; the migration calls it.
   - This makes IMPORT_ENGINE's batch-level kind ∈ {`full`, `open_items`} true of the data. It is not a rule change.
6. **FU-14 · An incomplete period shows no Health score.**
   - *The defect:* a period that stopped being complete kept the Health pointer an earlier run had left in `health_current`. Adversarial review rated this major.
   - *The fix:* `api_server.set_period_completeness` now deletes the `health_current` row of any period it marks incomplete. The `health_scores` rows (history) are kept.
   - No Health rule, weight or threshold changed (ADR-030.4).
   - *Known limit:* a run that FAILS after withdrawing a pointer does not restore it. The failed-run restore only restores that run's own pointers, and `is_complete` was never restored on failure either.

**NULL, not zero.**
- Months no full sales list establishes fall through §2.3 unchanged: to the bank as a cash proxy, else NULL with `no_source_covers_period`.
- A covered month with no sales is a genuine, stated 0.00.
- Margins on an uncovered month carry `no_source_covers_period`, not `comparison_is_zero` / `no_cost_of_sales_accounts`.
- The AI tool layer returns no value, with the reason, for an uncovered month.

**What did not change.**
- §2.3 precedence and fallthrough.
- AR/AP coverage (`invoiceSideCoverage`, ADR-124 D-3).
- Cash, receivables, payables and working-capital figures: none changed in the 27-organisation record.
- Health rules, weights and thresholds; alert rules and thresholds.
- RLS and grants. The only additions are the two new `app` functions, which are revoked from clients; the trigger runs as definer.

**Consequences.**
- **Engine 4.0.0** (major: existing values change). The golden hash was re-recorded, and the golden corpus includes the FU-1 cases. The upgrade sweep recomputes every organisation's whole history.
- **27-organisation record (3.0.0 → 4.0.0).** 17 organisations are unchanged. In the other 10 (INVBANK, INVONLY, CREDITHEAVY, PARTIALPD, LONG, BIGINV, CNFUTURE, CURRENT, BSREV, BSLIST), every change is P&L 0.00 → NULL `no_source_covers_period`, in months no full sales list establishes.
- **Health and alerts.** Only BSREV February's Health score is withdrawn: it rested on manufactured revenue and opex, and February is no longer complete. No alert was added or removed.
- **FU-13's consequence on the AR/AP side (recorded, not hidden).** Existing imported lists now read as `full` (or `open_items`), so the change reaches AR/AP too:
  - For real organisations, `receivables_days` can now be computed from these lists. With a NULL kind, `fullListSpans` was always false.
  - A list confirmed under IMP-INV-012 states a completed month only when its as-at date is that month's end (ADR-124 D-3).
  - This is the import specification finally being true of the data. The regression fixtures always set the kind, so the 27-organisation record cannot show this change.
- **Month rollover.** A current month's stored revenue to date stays until the next recalculation. There is no daily scheduled run (FU-6).
- **P&L snapshot completeness** reflects categorisation, not coverage. This is pre-existing and applies to all bases.

**Tests and gates** (details and figures in `docs/FU-1_IMPLEMENTATION.md`):
- *New tests:*
  - `test/unit/fu1-revenue-coverage.test.ts` (25).
  - `test/integration/fu1-remediation.test.ts` (27) over the 16 organisations in `test/fixtures/fu1-orgs.ts`. It includes FU-13 through the real commit path and FU-14.
  - `supabase/tests/16_fu1_list_kind.test.sql` (14).
- *Meaningfulness:* 15 of the 27 integration tests fail on the 3.0.0 engine.
- *Gates* on the final code, clean database, run one at a time:
  - tsc, eslint and next build: pass.
  - Unit 2,161 / 2,161, with the coverage gate passing.
  - Eval 253 / 253.
  - Integration 867 / 868. The one failure is the pre-existing `ai-eval-record` flake.
  - pgTAP 1,102 / 1,102.
  - Schema drift: pass.
  - Playwright: 69 passed, 1 skipped.
  - Evidence sweep: 54 → 42 checked, 0 mismatches.

**Remaining.**
- FU-12 (cost side) OPEN — since fixed by ADR-126.
- FU-15 (AR/AP commit-date limit) OPEN.
- FU-14's failed-run restore limit.
- Month rollover (FU-6).
- FU-2, FU-3 and FU-5 to FU-11: unchanged.

### ADR-126 · FU-12: invoice-basis costs are stated only from a purchase list that establishes the month
Status: **IMPLEMENTED — engine 5.0.0.** No migration. Not independently audited: the owner has deferred the comprehensive independent audit until the remaining approved phases are built. Approved by the owner on 2026-10-01 as the fix to make before Phase 16 ("Fix FU-12 first"); Phase 16 not started. Implementation record: `docs/FU-12_IMPLEMENTATION.md`; regression record: `docs/FU-12_ENGINE_REGRESSION_RECORD.md`.

**Context.** FU-12 (ADR-122 register, from ADR-125) is the cost-side twin of FU-1. Once a full SALES list establishes a month, §2.3 hands the invoices source the whole P&L. The invoice basis builds every cost line from PURCHASE invoices, but only the sales side was checked for coverage.
- With a sales list alone, `cost_of_sales`, every expense category and `operating_expenses` came out **0.00**, calculated and complete.
- Gross, operating and net profit therefore equalled revenue, and every margin read 100%.
- Phase 16 reads `net_margin`, `operating_profit` and `net_profit` (F1, F2), so it would have scored invented profitability.

**Root cause.** `pnl.ts` `coveredTotal` returns ZERO for a category with no cells. That is right when a source covers the period, and wrong when nothing established the purchases: the invoices source "covered" the month on the strength of its sales list alone.

**Decisions.**
1. **Purchase coverage** (`coverage.ts` `invoiceCostCoverage`, `PeriodCoverage.invoiceCosts`).
   - Committed FULL PURCHASE lists (`purchase_invoices` / `purchase_report`, kind `full`) establish a month by FU-1's own rules, through one shared function `invoiceListCoverage(…, side)`:
     - effective range = declared start → min(declared end, commit date);
     - lists that meet combine;
     - a completed month needs every day covered;
     - the current month is covered to date with `partial_month`;
     - a month not yet begun is never covered.
   - It decides nothing about which source wins. A purchase-only list still does not make the invoices source cover P, because costs alone are no P&L.
2. **Uncovered costs are NULL** (invoice P&L basis only).
   - These are NULL with `no_source_covers_period`, completeness 0 and no evidence: `cost_of_sales`, every expense category (opex, other / interest / tax expense, marketing) and `operating_expenses`.
   - Every figure derived from them follows: gross / operating / net profit, every margin, and contribution and its ratio.
   - This takes precedence over the "no cost-of-sales account" path, so gross profit never falls back to revenue.
   - No expense-side `expense_by_category` row is written.
   - Revenue and `other_income` are unchanged.
   - A covering purchase list with no purchase in the month is a genuine, stated 0.00.
3. **The current month: the same days on both sides.**
   - Both sides are stated to date. Current-month costs are covered only when the purchase lists reach exactly as far as the sales lists (equal completeness = equal days reached); otherwise they are NULL.
   - Adversarial review showed why: sales reaching the 25th against purchases reaching the 3rd stated a 94% net margin, carrying only `partial_month`.
   - A completed month is covered by both sides only in full, so the windows agree by construction.
4. **Supplier family** (invoice counterparty basis).
   - Uncovered: no `supplier_spend` rows, and `supplier_concentration_top1/top5` are NULL `no_source_covers_period` (never a 100% share of nothing).
   - Covered to date: the figures carry `partial_month`.
   - The customer side is unchanged.
5. **Unestablished purchases are left out of the whole fold** (`compose.ts` `pnlCells`). A supplier's default category can be anything, including `other_income` or `revenue`. So purchases no list establishes for P are removed from every invoice-basis category, from the uncategorised share and from the VAT counts that qualify revenue — not only from the cost lines. *Found by review.*
6. **Variance: an absent category is unknown where nothing establishes the spending** (`variance.ts`, `variance-pass.ts`).
   - In a period whose `operating_expenses` is NULL `no_source_covers_period`, an expense category with no row is UNKNOWN, not a known zero. This applies on the current side and on every comparison side, including the trailing three-month average. `other_income` follows `revenue` the same way.
   - Before this, a month with no purchase list read as "Marketing −100%, favourable" in Insights and the analyst's `get_expense_changes`.
   - This also closes the same pre-existing leak for months no source covers at all, on EVERY basis: a ledger, balance or bank month next to a month no source covers now carries a NULL category variance where it read −100% or a 0.00 comparison (`new_in_period`). The golden corpus shows it (June after a May no source covers).
   - Known limit (pre-existing): a comparison period that exists but has no stored `operating_expenses` row at all still reads absent categories as known zeros.
   - *Blocker found by review.*
7. **Days denominators.**
   - `payablesExpenseBase` is NULL when costs are uncovered (cost of sales NULL), or when stated only to date (`partial_month`, `receivables-input.ts`). In either case `payables_days` is NULL.
   - Its reason stays `insufficient_history`, as for `receivables_days` when revenue is unknown (pre-existing wording, unchanged).
8. **P&L page.** An empty spending breakdown in a month whose spending nothing establishes now says the spending isn't known (and, for invoice lists, that a full purchase list must cover the month and, in the current month, reach the same day as the sales list), not "Nothing was recorded…" (`ProfitAndLossView.spendingKnown`).

**What did not change.**
- §2.3 precedence and fallthrough; FU-1's revenue rule.
- AR/AP coverage (`invoiceSideCoverage`); cash; the levels on the ledger, balance and bank bases (their category variances change only next to a month no source covers — decision 6).
- `app.invoice_net` and credit-note signs.
- Health rules, weights and thresholds (`health.config.v1`); alert rules and thresholds (`alerts.rules.v1`).
- RLS, grants and schema: no migration.

**Consequences.**
- **Engine 5.0.0** (major: existing values change). The golden hash was re-recorded, and the corpus carries the FU-12 cases. The upgrade sweep recomputes every organisation's history.
- **Health.** Profitability and cost control drop out of a month's score through their requirement groups when `net_margin` / `operating_expenses` are NULL. Nothing became zero. See the regression record for which scores moved.
- **Mixed bases (recorded, by the spec).** When the counterparty basis is invoices (a sales list) but the P&L basis is the ledger, §2.3's counterparty precedence still picks invoices. So the supplier side is NULL without a purchase list even though the ledger could state the costs.
- **Known limits, unchanged:**
  - uncovered cost lines still carry descriptive components (account ids, row counts); evidence is null;
  - month rollover (FU-6);
  - FU-15 (AR/AP commit-date limit).

**Tests and gates** (details in `docs/FU-12_IMPLEMENTATION.md`):
- *New tests:* `fu12-cost-coverage` and `fu12-review` (unit), `fu12-remediation` (24, integration, 7 organisations), golden FU-12 and variance cases.
- *Meaningfulness:* 7 of the 24 integration tests fail on engine 4.0.0.
- *Gates* on the final tree, clean database, run one at a time:
  - tsc, eslint and build: pass.
  - Unit 2,200 / 2,200, with the coverage gate passing.
  - Eval 253 / 253.
  - Integration 893 / 893.
  - pgTAP 1,102 / 1,102.
  - Schema drift: pass.
  - Playwright: 69 passed, 1 skipped.
- *27-organisation record (same day, 4.0.0 → 5.0.0):* 19 unchanged. 8 invoice-list organisations change; every changed figure goes from a value to NULL `no_source_covers_period`, and none becomes zero. Health changes only through profitability and cost control being excluded (`required_metric_missing`). One info alert is removed (INVONLY `variance.significant`).

**Remaining.**
- FU-15.
- FU-6.
- FU-14's restore limit.
- The `finish_chunk` snapshot insert under load (see the implementation record).
- FU-2, FU-3, FU-5 and FU-7 to FU-11: unchanged.

### ADR-127 · The pointer rewrite resolves each cell's previous snapshot in one pass; three date- and load-sensitive tests fixed
Status: **IMPLEMENTED** (migration `20261001000001`). Not independently audited. Found while gating ADR-126 on 2026-10-01: three integration tests that passed on 2026-09-30 failed on `main` (5797306) as well, on a clean database.

1. **`api_server.finish_chunk` — a product defect (performance).**
   - The `metric_current` insert looked up `previous_snapshot_id` with a correlated subquery per row on `dimension_id IS NOT DISTINCT FROM …`, which no index serves. That is quadratic in a month's cells: about 1,050 customers × 3 per-customer metrics took the chunk to 5–9 s against the 8 s statement timeout. So `adr123-remediation`'s BIGINV run passed or failed with machine load, and a real organisation with a few thousand customers would fail every time.
   - The newest earlier run's snapshot of every cell is now picked once (`DISTINCT ON`, newest `started_at` first, as before) and joined with null-safe, hashable equality. The answer is unchanged. A new exact test (`engine-run.test.ts`, "names, per cell, the NEWEST earlier run's snapshot…") passes on the old and the new function. BIGINV's slowest `finish_chunk` call is now ≈ 1.8 s.
2. **`portfolio-scale.test.ts` HIGH-B — a test defect (date).** It hard-coded `2027-08` as the latest period, but `api.create_organization` creates periods relative to `now()`, so from 1 October the latest is `2027-09`. The product was right. The test now reads each organisation's own latest and previous periods; its assertions are otherwise unchanged. *Known:* its HIGH-A cases still name `2026-08`, which stays inside the period window until about August 2027.
3. **`scenarios.test.ts` — a test defect (setup time).** It seeded history with about 600 sequential `docker exec psql` calls and exceeded the 60 s hook timeout under load. It now writes the same rows in one block per organisation (setup ≈ 2 s), with an explicit hook budget.

No rule, threshold, figure or permission changed.

---

### ADR-128 · FU-15: an invoice list states a month-end position only through the day it knew

**Status:** Accepted (Step 0B, 2026-10-05). Engine 6.0.0. Not independently audited; database suites not yet run (no Docker in the authoring environment).

**Problem.** `invoiceSideCoverage` (§2.2, AR/AP) judged a completed month by the list's DECLARED range only. A full list committed on 10 August with the upload form's default range of 1–31 August stated 31 August's receivables and payables as `verified` — without the invoices raised on 11–31 August, and with everything paid after the 10th still open. The revenue/cost rule (`listRuns`, FU-1/FU-12) already capped a list at its commit date; the two answers disagreed for the same list.

**Decision.** Four dates are kept apart: the declared range (what the list is about; for an aged-debtors list its end is the as-at date), the commit date (the last day it can know anything), the month asked about, and the run's as-of (which month is current). A list knows through `min(declared end, commit date)`:
- a full list covers a completed P when that effective range spans P, or (unchanged, ADR-124 D-3) when it is fresh for P and reaches P's end;
- an open-items list states P only when its as-at date is P's last day and it was committed on or after it;
- the DSO sales history (`fullListSpans`) uses the same effective range;
- the current month keeps ADR-123 F-9's rule (committed on or after its start); a list committed before the month began no longer covers it.
A late upload of a valid month-end snapshot stays valid: a full list committed months later rebuilds the month-end position from each invoice's payment date (`payment_date_unknown` when one is missing). When no list establishes the month, the family falls through to the balance sheet / ledger, else NULL `stale_invoice_data` (label reworded: "Your invoice list does not show the position at the end of this month").

**Evidence.** `test/unit/fu15-ar-ap-coverage.test.ts` (15 cases; 6 fail on 5.0.0, including the value-level case that showed a verified 0.00); golden boundary cases; golden diff: the FU-1/FU-12 "committed mid-month" receivables/payables/overdue move from `verified 0.00` to NULL `stale_invoice_data`, nothing else.

### ADR-129 · FU-9: days payable on one VAT footing, from recorded data only

**Status:** Accepted (Step 0B). Engine 6.0.0.

**Problem.** `payables_days` divided a VAT-inclusive balance (invoice `balance_due`, or the AP control balance) by cost of sales + operating expense + marketing, which is VAT-exclusive on the invoice basis (`app.invoice_net`) and for a VAT-registered ledger — overstating days by the VAT rate, unflagged (the audit fixture read 37 for about 30). The +10-day deterioration trigger fired early.

**Decision.** No rate is ever assumed — not 1.2, not `default_vat_rate`: nothing records which purchases were zero-rated, reduced or exempt.
- Payables from INVOICES divide by the full purchase lists' GROSS totals (net + recorded tax, credit notes subtracted — `purchaseInvoiceGross`, the twin of `invoice_total_gross` for DSO). Mixed rates, zero rates and invoices with no tax column all read correctly. Every month of the window needs a full purchase list establishing it (FU-15's range), else `insufficient_history`.
- Payables from a BALANCE or the LEDGER divide by the expense base only when its footing is gross (`expenseBaseFooting`): bank-proxy costs (payments as made), or a ledger / trial balance of an organisation EXPLICITLY not VAT-registered. A net footing (VAT-registered ledger, invoice nets) or an unknown one gives NULL `vat_basis_unknown`.
- `vat_registered` unset is now distinguishable from false (`vatStatusKnown`), and is in the fingerprint.

**Consequence (product decision required).** Nothing in the product sets `vat_registered`. Until it can be set, every ledger- or trial-balance-based organisation reads `payables_days` as unavailable with `vat_basis_unknown`; invoice-basis and bank-proxy organisations are unaffected. `receivables_days` is unchanged (it still nets by `default_vat_rate` when registered, with `vat_inclusive` otherwise) — aligning it is a separate decision.

### ADR-130 · A bank figure is no firmer than the bank rows under it; promotion keeps a row's own assurance

**Status:** Accepted (Step 0B). Engine 6.0.0 (assurance only — no value changes).

**Problem.** Commit stamps each statement row's assurance (`pdf_claude` → `inferred`; `pdf_text` → `verified` when reconciled, else `calculated`; CSV/XLSX → `verified`), but metric assurance came from the SOURCE alone: cash from an AI-read statement was badged verified on Home, in Health and to the analyst, while the evidence drawer (which reads the rows) said "please check". Rollback promotion re-inserted dependants as `verified` whatever their batch, and dropped columns commit writes (an invoice's subtotal, tax and payment date — moving `app.invoice_net` to its fallback — a bank line's counterparty and running balance, a ledger line's counterparty and opening flag).

**Decision.** Only bank statements can be read from PDF, so only bank rows can be weaker than verified. Each statement batch carries the level commit stamped on its rows (`statementRecordAssurance`, the commit CASE by name); a period's bank figures — cash, and P&L / customer figures whose basis is the bank — are weakened to the weakest statement overlapping the period (`bankRecordAssuranceFor`, conservative across accounts). `app.batch_record_assurance` is the same CASE in SQL; `app.promote_dependants` uses it for the DEPENDANT's batch and re-inserts the same columns commit does (migration `20261005000001`). `scripts/engine-compare.ts` now reports assurance-only changes and the days figures.

**Not changed (decision):** Health treats only `estimated`/proxy as capped (`dimension.ts`), so an `inferred` cash figure still scores uncapped; opening cash carried from an earlier AI-read month is not downgraded (its anchor is a printed, verified balance). *Superseded: Health by ADR-134; carried opening cash by ADR-137 (Step 0D).*

### ADR-131 · FU-6: a daily scheduled recalculation over the periods the date changes

**Status:** Accepted (Step 0B). Amends ADR-047.8. Migration `20261005000002`.

**Problem.** Nothing queued the `scheduled` trigger. A month that ended with no new data kept the figures computed while it was current (aged at the run date, invoice coverage judged by the current-month rule, never health-scored); overdue ageing, "stopped" recurring payments and their alerts moved only on an import. And the designed scheduled run would not have fixed it: it rewrote five as-of keys of the current month only (orphaning the rest of the snapshots it inserted), skipped Health, and left `receivables` beside overdue figures of another day.

**Decision.**
- Every run (any trigger) whose previous succeeded run's as-of lies in an earlier month recomputes from that month — so the month that closed is computed as completed: coverage, completeness, variances, Health.
- The `scheduled` run writes every key of the current period (plus that rolled-over month); never history no date can change. `asOfDependentOnly` is no longer used by any trigger.
- `api_server.enqueue_scheduled_recalculation()` (nightly, after the upgrade sweep — *amended by ADR-135: hourly, from `/api/jobs/scheduled`*): one job per ACTIVE organisation whose latest succeeded run is dated before its LOCAL today (`now() at time zone o.timezone`), with that date as the payload's `as_of`. The date is the skip test — unchanged rows never justify skipping. Idempotent per organisation and date (any status), skips an organisation with a calculation already queued, never runs suspended / closing / never-run organisations, and retries a dead day the next day.
- Queue: a queued SCHEDULED job gives way to any other trigger coalescing into it (`app.enqueue_recalculation`). A failed or lost calculation whose key already has a queued twin is coalesced into it (`cancelled`, twin widened by `app.merged_calculation_payload`) instead of violating `jobs_idempotency_queued_unique` — reproduced on the 5.0.0 functions: `finish_job` and `reclaim_stale_jobs` (which runs inside every `claim_job`) both raised 23505, the second stalling the whole queue.
- Alerts: an EVENT alert of a period the run did not evaluate is not resolved by its absence (a daily run over October no longer resolves September's duplicate payment as "cleared").
**Cost.** Bounded: one period a day per active organisation, two on the first run after a month end; no full history. **Limitation:** the nightly cron is 02:00 UTC, so an organisation west of UTC gets its run on the previous local date (22:00 in New York); an hourly cron would remove that.

### Follow-up register (Step 0B, 2026-10-05)

| FU | Status |
|---|---|
| FU-6 | Implemented (ADR-131); database suites pending |
| FU-9 | Implemented (ADR-129); product decision: a VAT-status setting |
| FU-15 | Implemented (ADR-128) |
| FU-5, FU-11, ADR-124 R-1 | Open, unchanged (recorded in `docs/STEP_0B_IMPLEMENTATION.md`) |
| FU-16 (new) | Open: `app.enqueue_recalculation` keeps the QUEUED payload when two non-scheduled triggers coalesce (pre-existing), so a second import into an EARLIER month than the waiting job's is not recomputed until another trigger reaches it |

---

### ADR-132 · FU-16: a coalesced recalculation computes the union; one calculation per organisation at a time

**Status:** Accepted (Step 0C, 2026-10-05). Migration `20261005000003`. Not yet run against real Supabase.

**Problem.** One calculation can wait per organisation (`jobs_idempotency_queued_unique`). A second trigger coalesced into it and was DROPPED:
- a January import arriving while a March import waited was never recomputed;
- an account remap (every period) arriving after an import recomputed only from the import's month.

A calculation could also be claimed while another for the same organisation was RUNNING (the index covers queued rows only), so two runs could interleave pointer writes.

Separately: `calculation_runs.trigger_ref_id` accepts a reference only for `import_*` (a batch), `account_remapped` and `counterparty_merged` (`same_org_ref`). Yet `override_bank_category`, `mark_transfer` and `supersede_record` enqueue with a transaction or record id, and the opening-balance flag enqueues `import_commit` with a ledger-entry id. Read from the code, every such run was refused at insert and died after three attempts. The tests never drained one: they insert banking jobs by hand with no ref.

**Decision.**
- `app.merged_calculation_payload` keeps the union. A full-range trigger wins; a `scheduled` payload gives way; otherwise every trigger reference is kept in `refs`, and the handler recomputes the union of the periods they touched (`periodsTouchedByAll`).
- `app.enqueue_recalculation` is one `insert … on conflict do update` merge.
- `api_server.claim_job` serialises claims (a transaction-scoped advisory lock) and never claims a calculation for an organisation with one running.
- Failed and lost runs coalesce into a queued twin with the same merge (ADR-131).
- The handler records only a reference the table accepts (`runTriggerRef`), still using the original reference to decide the periods.

**Tests:** `test/integration/calculation-coalescing.test.ts` (queued union, full-range dominance, earlier import while one RUNS, retry and lost-worker coalescing, banking/supersede/opening-flag runs succeed) — not yet run; `test/unit/run-trigger-ref.test.ts` (the mapping read from the migration).

### ADR-133 · Days figures on one VAT footing from recorded facts; a VAT-status setting

**Status:** Accepted (Step 0C). Engine 7.0.0. Migration `20261005000004`.

- `receivables_days` follows ADR-129's rule. From invoices: the sales lists' gross totals. From a balance: revenue only when its footing is gross (`vatFooting`). It no longer divides the receivable by `1 + default_vat_rate` (ADR-027.4's netting withdrawn: one rate cannot describe zero-rated, exempt and reduced-rate sales). A net or unknown footing gives NULL `vat_basis_unknown`.
- Bank-proxy flows the proxy netted by a default rate (registered, with a rate: CD-33) are `unknown`, not gross, for both days figures. 6.0.0 wrongly treated bank costs as always gross.
- `api.set_vat_registration(org, 'registered' | 'not_registered' | 'unknown')`:
  - requires `settings.manage` and is throttled;
  - merges only its own key (`api.update_organization` replaces the whole `settings` object);
  - `unknown` removes the key and is never stored as false;
  - audited `org.vat_status_changed`;
  - a change queues a full recalculation (`settings_changed`).
- UI: Settings → VAT, three answers including "Not set".

### ADR-134 · Health: AI-read inputs take the existing cap, with their own reason

**Status:** Accepted for sign-off (Step 0C). `health.config.v2`.

**Problem.** §7.2 / ADR-035 cap a dimension at 70 when a required input is `estimated` or a proxy, with the note "based on bank data only". `inferred` (read from a PDF by AI) is the weakest rung of the assurance ladder, yet had no treatment, so it scored uncapped.

**Decision (proposed rule; no new number).**
- A dimension with an `inferred` required input is capped at the EXISTING 70.
- Its reason says why: "includes figures read from a PDF by AI", or both reasons together.
- The explanation renders the stored reason (`capNote`); before, it always printed the bank-only note.

**Scoring impact.** Only dimensions whose required inputs are inferred — in practice cash flow and banking health in months whose cash comes from an AI-read statement (ADR-130) — and only when they scored above 70. They fall to 70. The total moves by (score − 70) × that dimension's applied weight.

**Sign-off asked:** if inferred inputs should be treated differently from estimated ones (a lower cap, or exclusion), that is a new number and a product decision.

### ADR-135 · The daily recalculation is enqueued hourly, one run per organisation and local date

**Status:** Accepted (Step 0C). Route `/api/jobs/scheduled` (`5 * * * *`).

At 02:00 UTC an organisation in Los Angeles was still on yesterday (19:00 local), and one in Kiritimati was 16 hours into its day. Now:
- An hourly tick queues only organisations whose latest succeeded run is dated before their local today.
- The database refuses a second scheduled job for the same organisation and local date.
- Each organisation is therefore queued in the first hour after its own midnight, whatever its offset or DST state.
- Cost: one indexed query an hour and still at most one run per organisation a day.
- `p_now` exists for the DST and offset tests (pgTAP 19).
- The nightly route goes back to the sweep and the engine upgrade only.

"Due" is defined by the latest SUCCEEDED run's `as_of`, so a failed or dead day is retried. The range rule (ADR-131) recomputes from the month that run last saw as current, so a closed month missed by any number of days is recomputed by the next run of any trigger.

### ADR-136 · Unicode identity for names; collisions are held for a person, never merged

**Status:** Accepted (Step 0D, 2026-10-06). Migration `20261006000001`. Resolves the Step 0C release blocker (review finding 7).

**Problem.** `app.normalize_name` kept only `[a-z0-9]`. It is the uniqueness key of accounts, counterparties, products, marketing channels and campaigns, and the key every import matches on. "Müller GmbH" and "Möller GmbH" were one key, so a file's Möller was booked to Müller. Every name with no letter A–Z had the key `''`, so an organisation could hold only one customer named in Arabic, Japanese, Greek or Cyrillic. Step 0C stopped the import path from acting on either (IMP-CP-017/018) but could not import those names at all, and account names were unguarded.

**Decision: the matching rule.**
1. NFKC. Compatibility forms are one name: "Ａｃｍｅ" = "Acme", "ﬁ" = "fi", half-width = full-width katakana, precomposed = combining accent.
2. Unicode SIMPLE lower case through the built-in `pg_c_utf8` collation (Postgres 17), the same everywhere with no ICU and no OS locale; final sigma `ς` read as `σ`.
3. Every run of whitespace, punctuation, symbols and control characters becomes one space; the ends are trimmed.

Everything else is significant: every letter in every script, every accent and combining mark, every digit. "Müller" ≠ "Muller", Cyrillic "Асме" ≠ Latin "Acme", "٣" ≠ "3". "Straße" ≠ "Strasse" (no full case folding: the conservative direction is two records, never one). For ASCII the key is byte-for-byte the old one, so only names with other characters move.

The TypeScript mirror (`storedNameKey`) is compared with the database over every code point Postgres assigns (integration test; zero differences). Characters added after Unicode 15.1 can differ; the database's key is the one stored and enforced.

**Decision: existing records.**
- Re-keyed in place; display names never change.
- Where the new key makes two or more existing records one name (a collision the old key hid, e.g. "İzmir Ltd" and "Izmir Ltd", or a full-width and an ASCII spelling), EVERY record of the group is held. It keeps its name and history; its key becomes `<key> [held <id>]`, which no import key can equal; it is audited `name_identity.held`.
- While an unmerged held record of a name exists:
  - an import naming it is refused (`IMP-CP-019`, `IMP-ACCT-019`);
  - a new or renamed record of it is refused (the derive trigger).
- A person resolves it by renaming or merging records; re-saving the last one re-derives its key.
- Invoice rows the old key already booked to a different name (past silent merges) are reported, not changed.

**Evidence before migrating:** `scripts/sql/unicode-names-dry-run.sql` (read-only; its key is the migration's function body, pinned by a test). The upgrade job seeds the baseline schema with names in five scripts and known collisions, runs the report, migrates, and verifies every record (`scripts/sql/unicode-names-verify.sql`).

**Not changed:**
- The duplicate-detection scope key (`scopeKey`) still uses the old account-name key. Changing it would change stored row hashes and stop re-imports matching earlier imports.
- Look-alike characters across scripts are two names; no confusable warning is shown.

### ADR-137 · A cash balance is no firmer than what it rests on, in every later month

**Status:** Accepted (Step 0D). Engine 8.0.0 (assurance only; no value changes). Amends ADR-130.

**Problem.** A month's opening cash is the balance at the close of the day before it, carried along the statement chain from an anchor (ADR-124). Its assurance was the anchor's SOURCE alone. So cash carried through a month an AI read — or opened by a balance typed onto an AI-read statement, possibly copied from the model's reading — was `verified` in every later month, on Home and in Health. ADR-130 weakened only the figures of the month whose statement was AI-read.

**Decision.**
- An anchor printed on a statement is no firmer than that statement (`statementRecordAssurance`): `inferred` on an AI-read statement, `calculated` on an unreconciled text PDF.
- A balance at the close of day D is as firm as the best anchor of its chain dated on or before D that AGREES with the chain (to the penny), weakened by the rows of every statement the chain crossed since that anchor. A verified printed balance that agrees therefore attests the chain again from its day; one that disagrees attests nothing (§3.3: the computed value stands, and the mismatch is shown).
- Crossed statements include superseded ones: a re-upload whose rows were skipped as duplicates leaves the earlier rows in place. Only a rollback, or a Replace (which rolls back), removes them.
- `opening_cash` and `closing_cash` take this per-account assurance (the total is its weakest account). The period's statements (ADR-130) no longer weaken them: an opening does not rest on its own month's rows, and a closing counts them in its own chain. Movement figures keep ADR-130.
- Evidence: both figures carry `rests_on_statements` (per account and in total). The evidence drawer names those statements. The "Please check" tooltip says the figure may be carried from a month read by AI.
- Health needs no new rule: ADR-134's cap of 70 (still awaiting product approval) applies to the carried figure.


### ADR-138 · H-1: no bank data is not banking evidence. H-2: a balance report's P&L is its closing balances by §3

**Status:** Accepted (Step 0E, remediation of the independent audit of `step0d-review-frozen`). Engine 10.0.0 (9.0.0 superseded before release); `health.config.v3`; migrations `20261007000001`, `20261007000002`. For re-review.

**H-1 problem.** `computeCoverage` returns `bankCoverageRatio = 1` when no cash-like account is in scope. That is right for `is_complete` (nothing to wait for). The run handed the same number to Health as a fact about banking, so an organisation with no bank account got Banking Health 60 with B4 "full coverage +10", and totals that should be NULL were published.

**H-1 decision.**
- Coverage states a second value, `bankEvidenceRatio`: covered over in-scope cash-like accounts, or **NULL** when none is in scope (no account, only closed ones, or only credit-card and loan accounts).
- Health reads it. NULL or 0 → banking_health is excluded (`no_bank_coverage`) by the existing rule, and the weights renormalise. B4 is never "full" and never a penalty for absence.
- Completeness is unchanged.
- Consumers reviewed:
  - `isPeriodComplete` / `completenessHolds`: completeness, unchanged.
  - `run.ts` → `score-run.ts` → `banking-health.ts`: now evidence.
  - `cash.ts` `bank_coverage_ratio`: its own computation, unaffected.

**H-2 problem.** For a trial balance or P&L report, `compose` read `debit_total` / `credit_total`, which no import fills, so every such month's P&L was 0.00 `verified`. Three related faults:
- §3's differencing (`sign.ts` `periodBalancePnlAmount`) had no caller.
- The batch's basis was hard-coded NULL ("movement").
- Every report kind covering the month was summed.

On the import side, a Debit/Credit trial balance and a single-Amount P&L report never produced the NOT NULL `closing_balance`. Their rows validated and then failed the commit.

**H-2 decision.**
- **Import:** each layout produces a natural-sign `closing_balance`.
  - A balance column: as given; its sign is confirmed by IMP-TB-013 and applied at commit.
  - Debit/Credit: debit − credit, both totals kept, natural sign by construction, so no sign question is asked.
  - One Amount column: the amount, with IMP-TB-013.
  - A row with no figure stays an error. It is never a zero.
- **Engine (§3):** only the winning report kind is read (trial balance before P&L report, §2.2).
  - Movement basis: the month is `closing_balance`.
  - Cumulative basis: closing(P) − closing(P−1), with P−1 the same kind AND basis. The fiscal year's first month, as frozen on the batch, is its own closing. A prior report lacking the account gives a known zero with `account_absent_prior`. No prior report gives NULL `no_prior_trial_balance`.
  - `app.batch_coverage` now returns `balance_basis` and `fiscal_year_start_month_at_commit`.
- **Coverage:** a report kind whose batch spans P but holds no row for P does not cover P, as §2.2 already requires of the ledger. A report that states nothing about the month cannot override a source that does.
- **Evidence:** balance drill-downs filter by report kind. A cumulative month's figure is a difference, so no single row selection can total to it (ADR-109). Its `evidence_query` is `kind: 'difference'`: the formula `year_to_date - prior_year_to_date` and two terms. Each term has its period and its own leaf descriptor (the same accounts and report kind), or `unavailable` with the reason (`no_prior_trial_balance`).
  - Migration `20261007000002`: `api_server.build_metric_bundle_as` accepts both term descriptors as leaves of the figure, so a bundle cites both periods' records.
  - The drawer shows the subtraction: each term's period, its records' total, and the result. An unavailable term shows its reason.
  - Σ sign × total(term) equals the figure (integration-tested). *(In 9.0.0, before review, no evidence was written for these figures; that was rejected as a resolution.)*

**Policies applied after review (product owner, Step 0E):**
1. **No prior cumulative period → NULL.** The month stays covered and states NULL `no_prior_trial_balance`, per §2.2. It does not fall back to a ledger or bank source.
2. **A missing account is not assumed zero** unless the report establishes completeness. A trial balance whose rows balance (Σ debit − credit within 0.01) lists every account carrying a balance, so an account it omits stands at zero.
   - This applies on both sides: an account the prior report lacks, and an account this month's report lacks.
   - A P&L report, or a trial balance that does not balance, establishes nothing. The account's month is NULL `account_absent_unconfirmed`, and so is every figure built on it.
   - *This narrows §3's text, which made the prior-side zero unconditional.* (9.0.0 inferred zero on both sides.)
3. **"No rows" fallback is per batch and per month.** A balance batch states a month only where it has accepted rows dated in it (`row_months` from `app.batch_coverage`). A batch whose rows all lie in other months is genuinely unavailable there, so the next source in §2.3 states the month. Rows include zero-value and balance-sheet lines. A report that establishes a genuine zero P&L (for example, balance-sheet lines only) still covers the month and never revives older ledger or bank figures (unit-tested).

**Ambiguities that remain open (not decided here):**
- **A1:** A batch with NO rows at all, an empty report, covers nothing. If a product rule wants an empty P&L report to state "no trading" for its range, that needs a decision and an explicit confirmation at import.
- **A2:** Completeness is established only by a balancing trial balance. A single-column trial balance is not balance-checked at import (IMP-TB-011 runs for Debit/Credit layouts only), so the engine checks the balance itself. Should a non-balancing single-column trial balance be refused at import instead?
- **A3:** Two batches of the same kind with rows for the same month are both summed when the later one did not supersede the earlier. This relies on commit superseding at batch scope (IMP-COV-013) and was not re-audited here.
- **A4:** A movement-basis report's absent account contributes nothing to its month. That is inherent to any record source, and no zero is inferred, but it is stated here for completeness.

**Not changed:** H-3, R-2, R-3, U-1, U-2 and every LOW finding of the audit remain open. The cap of 70 (D-2) and the VAT rule (D-1) are unapproved.

### ADR-139 · Step 0F: completeness is attested, cumulative evidence reconciles per side, a corrected report replaces the old one

**Status:** Proposed (Step 0F, remediation of the re-review of `39711f5`: N-1…N-7). Engine 11.0.0 (10.0.0 superseded before release); `alerts.rules.v2`; `health.config.v3` unchanged. Migrations `20261007000001` (edited before release: `report_complete`), `20261008000001`, `20261008000002`. **The completeness policy below is a product decision awaiting the owner's approval; it is implemented, not approved.** For separate re-review.

**N-1 problem.** ADR-138 policy 2 treated a balancing trial balance as complete, and an absent P&L category was read as 0.00 whatever the report was. A cash-only trial balance therefore stated a verified zero revenue over a ledger that had sales, an expenses-only P&L report a zero revenue, and partial cumulative reports a zero — "absent" became "zero" without anything establishing it.

**Evidence traced before deciding (no completeness metadata existed).** A balance import records only its period (IMP-RANGE-015), basis (IMP-TB-012) and, for one-column files, sign (IMP-TB-013). None of these, the row set, the declared range or a balancing total tells the engine whether the file lists every account: a partial extract can balance (cash against equity), and a full report can list only non-zero lines. Only the reviewer knows. So completeness needs a **user attestation at import**; existing imports have none and are **not** treated as complete (no backfill).

**N-1 decision.**
- **Attestation (IMP-TB-016).** Every trial balance and P&L report import asks: "Does this report list every account for the period, including accounts with nothing in them?" `complete` / `partial`, nothing pre-selected; the database refuses any other value. Stored with who and when (`import_batches.confirmations`), audited `import.confirmed`. A balance sheet is not asked (it states no P&L).
- **Complete** = attested `complete` AND, for a trial balance, Σ closing within 0.01 of zero. A P&L report need not balance.
- **A category with a line** takes the line (an explicit 0.00 line is a stated zero).
- **A category with no line:** 0 when the report is complete; on a cumulative month 0 only when this AND the prior report are complete; no prior → NULL `no_prior_trial_balance`; otherwise NULL `category_not_in_report`. Only categories the organisation has an account for are filled. An account in one month's cumulative report and not the other's follows the same rule (`account_absent_unconfirmed`).
- **Source selection (§2.3, unchanged order, one source per family).** A complete report always wins (a stated zero is never revived from older ledger or bank data). An incomplete report yields the WHOLE P&L family to a ledger or invoices source that covers P — never a mix, never a sum — with the warning `balance_report_incomplete` on every figure. The bank proxy never displaces a report: with only the bank beside it, the report is used with its NULLs. The selected source is the figure's `basis`; the insufficiency is the NULL's `missing` reason or the warning.

**N-2 decision.** Each `difference` term states `expected`: the total the engine read for exactly the rows its descriptor selects, in reporting sign. The drawer reconciles (1) each side's records against that side's `expected`, (2) the formula Σ sign × records = the figure, and (3) the engine's arithmetic Σ sign × expected = the figure; a mismatch at any step is stated on the page, on that side and in the formula. Every year-to-date subtraction in a figure's evidence tree is shown, at any depth (net profit → operating profit → gross profit → revenue), each side linking to its own records block; no records block of a cumulative figure is reconciled against the figure. Figures written by 10.0.0 have no `expected`: the formula still reconciles from the records.

**N-3 decision.** Commit inserts balance rows `pending`, supersedes the accepted report of the same kind for every month the new report states (account-matched where possible, ADR-029.2), then promotes — one transaction under the organisation lock (ADR-073's pattern). The first commit that would replace accepted balances writes nothing and returns `needs_confirmation`, adding IMP-COV-013 to the batch; the reviewer confirms and commits again. History, `record_status_events` and old evidence bundles are preserved (an old bundle still shows the figure as it was). A failed commit leaves the previous report current. Concurrent corrections are applied one after the other.

**N-5 / N-6 / N-7.** A trial-balance-basis expense spike cites the report lines (both sides for a cumulative month), not ledger entries. Commit never applies the reporting-sign flip to a row carrying debit or credit totals. The alert list breaks severity/recency ties by rule, then `dedupe_key` (a total order); the recorded eval fixture's two tied alerts were reordered to that order (no value changed) and the shape test also compares every alert's shape by rule.

**Open decisions (not decided here):**
- **C1 (owner):** approve the attestation wording, its being required for every trial balance and P&L report, and the strict NULLs for unattested reports. Consequence: every existing trial-balance or P&L-report month in production states NULL for any category it has no line for (operating expenses, net profit, margins, Health dimensions resting on them) until re-imported with the attestation. Alternatives: a one-time attestation for existing batches by their owner (never automatic); or treating a balancing Debit/Credit trial balance as complete (rejected in review as insufficient evidence).
- **C2:** whether a category for which the organisation has no account at all should be filled (currently not: it cannot be stated or absent).
- **C3:** whether an incomplete report should yield to a ledger that covers P only partially (currently: the ledger must cover P by §2.2).
- **C4:** IMP-COV-013 is raised at commit, not at validation, so a reviewer sees it after pressing Import once.
- ADR-138 A1, A2, A4 remain open; A3 is resolved by N-3.

**Not changed:** H-3, R-2, R-3, U-1, U-2, D-1…D-6 and every other outstanding finding remain open. Funding Readiness is not ready.

**ADR-139 amendment · existing imports: one-time owner confirmation (Step 0F follow-up; engine 12.0.0; migration `20261008000003`).** Owner decision C1: existing trial balances and P&L reports are not bulk-confirmed and not re-uploaded; an owner or admin confirms them one import and one month at a time after reviewing the stored file. Still for separate re-review.

- **Is "every account" the right question?** Not for both report types, and not as first worded:
  - A **trial balance** is the whole ledger: every account — income, expenses, assets, liabilities, equity. "Every account" is the right scope, but the first wording ("including accounts with nothing in them") was wrong: real trial balances routinely omit zero-balance accounts, and an omitted zero account is exactly the zero completeness lets us infer. Now: "Is this the full trial balance — every account with a balance for the period: income, expenses, assets, liabilities and equity?" Stored scope `all_accounts`. It must also balance.
  - A **P&L report** never contains balance-sheet accounts, so "every account" would ask about lines it cannot have. Now: "Is this the full P&L report — every income and expense line for the period?" Stored scope `income_and_expense`. Lines grouped in the report are acceptable if every amount is inside one (the category split is then a mapping question, not completeness — noted as open C5).
  - The scope is set by the server from the import type (IMP-TB-016's stored value and every attestation), never taken from the client. Both choices are worded per type; nothing is pre-selected; the help text says a category with no line is counted as zero only on a full report.
- **Existing imports.** `api.attest_report_completeness(batch, month, complete|partial, reason)`: owner/admin role only (an employee who may review imports may not); committed trial balance / P&L report only; a month the import still states; a reason is required. Append-only `report_completeness_attestations` records who, role, when, scope, month, reason and the answer it corrects; audit `report.completeness_attested` with the previous and new answer. A correction is a new row; nothing is overwritten. It queues a recalculation of the import's periods onward, and the run fingerprint includes the current attestation per (import, month) — without it the run would have finished `no_change`. Earlier snapshots keep their own values, basis and assurance (unchanged mechanism); evidence is rebuilt from the new snapshots.
- **Per month.** The answer in force is the latest attestation for (import, month), else the import's own answer, else unconfirmed. Unconfirmed and partial both keep absent categories NULL; they differ only in the reason (`report_completeness_unconfirmed` — a confirmation is still possible — vs `category_not_in_report`).
- **No inference.** A balancing total never confirms anything; a trial balance confirmed complete that does not balance stays not complete.
- **Completeness is not accuracy.** A report-basis P&L now takes the weakest of the report's own record assurance (and, on a cumulative month, the prior report's). Today no trial balance or P&L report can be AI-read (`document-extract` refuses all but bank statements), so no stored assurance changes; the rule guarantees an attestation can never raise one (tested with a simulated AI-read report: its figures and its implied zeros stay `inferred`).
- **Source fallback (§2.3, as agreed in N-1, unchanged).** Unknown or partial: a ledger or invoices source covering the month states the whole P&L family (warning `balance_report_incomplete`); with only the bank, the report is used with NULLs; no zero is published. Confirmed complete: the report wins, and its stated zeros are never replaced by older ledger or bank figures. So a confirmation can switch a month's source from the ledger to the report (and a correction back) — integration-tested.
- **Open:** C2, C3 as before; C4 (IMP-COV-013 at commit) as before; **C5** grouped P&L lines (the category split inside a group); **C6** whether a later re-import of the same month should carry an earlier month's attestation (it does not: an attestation belongs to one import).

### ADR-140 · Owner decisions on the audit of c5a8473 (D-2, D-3, R-2, R-3) and the remaining implementation findings (H-3, H-4, H-5, H-6, R-4, U-2)

**Status:** Accepted by the owner (decisions, 2026-10-06), implemented on `fix/step0-outstanding-findings`; for separate re-review. Engine 13.0.0, `health.config.v4`, `alerts.rules.v2`; migration `20261009000001`; migration `20261006000001` (unreleased) amended in place.

**Owner decisions.**
- **D-2 — approved:** the Health cap is 70, for bank-only (proxy/estimated) and AI-read (inferred) inputs alike, applied to every input a rule scores (H-3 below).
- **D-3 — separate and warn:** names that differ only by a compatibility form (full-width "Ａｃｍｅ", the ﬁ ligature, half-width katakana) or by the dotted capital İ are DIFFERENT customers until a person merges them. The identity key is NFC (canonically equal text is still one name) and lower-cases İ by its full mapping (i + U+0307). An import matched to an existing record spelled differently beyond letter case raises a reviewable warning, IMP-CP-020. This supersedes ADR-136's NFKC and simple-İ rules; migration `20261006000001` is amended in place (unreleased), with its seed, verify and dry-run scripts.
- **R-2 — ask at import:** a full invoice list states receivables or payables only once someone confirms it holds every invoice still unpaid at its start date, older ones included (IMP-INV-013, nothing pre-selected, validated in the database). Existing lists are unconfirmed until an owner or admin confirms one (the ADR-139 attestation, scope `open_invoices`, for the month the list starts in). Unconfirmed: the family falls through §2.3 to a balance sheet, trial balance or ledger, else NULL `opening_invoices_unconfirmed`. Open-items lists, revenue and costs are unaffected.
- **R-3 — estimated with a bound:** a receivables or payables figure resting on payments with no date stays as §3.4 reads it (paid), but is `estimated` (never `verified`), and its components and evidence page state the range it could be in.

**Implementation findings fixed.**
- **H-3:** the cap tests every input a dimension's rules scored, earlier trend months included; banking health (B1, B2) and cash flow's C3 can now be capped.
- **H-4:** "Capped at 70" only where the cap bound; "Can score at most 70" below it.
- **H-5, H-6:** FINANCIAL_ENGINE §7 states the as-built config and the stored-weight rounding.
- **R-4:** the consecutive cash-decline alert says "more money went out than came in", not that the balance fell.
- **U-2:** the Unicode re-key no longer holds the survivor of a merge made before the upgrade; the merged-away record is held.

**Consequences for existing data (until confirmed):** an invoice-only organisation's receivables, payables, overdue and days figures become NULL `opening_invoices_unconfirmed` for every month a full list would have stated, and Health dimensions resting on them are excluded, until an owner confirms the list or adds a balance sheet. Customers previously keyed together by İ/I or compatibility forms become separate records on the upgrade's re-key (it is unreleased; no production data was ever keyed by NFKC).

**Second round of owner decisions (2026-10-06).**
- **D-1 — approved as built:** ADR-133's rule stands — days figures only on one VAT footing; an unknown footing (VAT status not set) gives NULL `vat_basis_unknown` with the prompt to set it in Settings.
- **D-6 — use the balance sheet:** FU-5 implemented (engine 14.0.0): a ledger with no opening journal is anchored by the latest earlier cumulative balance sheet or trial balance that states the category, plus the ledger's movements since (every month between must carry ledger rows); evidence `opening_balance + movements`. No anchor: NULL `no_opening_balance`, as before.
- **D-5 — build the review screen:** a Customers screen lists records held for an identity decision, with "merge into one" and "keep separate (rename)" actions, audited.
- **F5.2 — gross share:** recorded in `PHASE_16_IMPLEMENTATION.md` (overdue ÷ gross open invoices, as the alert does; never above 100%).

**Re-review of 6a551de, defects fixed here:** NF-1 (payables base NULL on an unknown category), NF-2 (a partial or unconfirmed trial balance's absent AR/AP/working-capital line is unknown), NF-3 (rolling back a corrected report, migration `20261009000002`), NF-4 (a cumulative month over an incomplete prior report yields to a covering ledger), NF-5 (the confirmation takes the organisation lock; a replaced report is refused), NF-6 (reasons `prior_report_not_complete`, `trial_balance_not_balanced`; year-to-date note on the import page), NF-7 (`zero_by_completeness` on figures whose zeros rest on a confirmation, a "Calculated" badge saying so, and the P&L question no longer invites grouped lines).

**Third round of owner decisions (2026-10-06).**
- **Phase 16 A-1…A-5 — confirmed** (recorded in `PHASE_16_IMPLEMENTATION.md`).
- **Balance sheets are asked too:** IMP-TB-016 for balance sheets ("every asset, liability and equity account with a balance", scope `assets_and_liabilities`; not required to balance); existing ones can be confirmed per month by an owner or admin; a missing AR/AP or working-capital line on an unconfirmed or partial balance sheet is unknown (engine 15.0.0, migration `20261009000003`).
- **C6 — ask again:** a replacement report needs its own answer; nothing carries over (as built).
- **C3 — keep the report with NULLs:** a ledger that covers only part of a month cannot state it; the incomplete report is used, with NULLs for what it lacks (as built).

**Still open (owner):** D-4; sign-off of the 5.0.0→15.0.0 change set (F-11), which follows the separate re-review; ADR-139 C2 (C3, C6 decided above; C4 is resolved: IMP-COV-013 is asked at validation when an accepted report of the same kind exists for a month the file states, and commit still re-checks under the organisation lock for a report committed in between); U-3 (LOW, TS/DB key parity for post-Unicode-15.1 code points) is documented, not fixed.

### ADR-141 · Phase 17 Intelligent Reporting: composed reports are stored; day and week figures are interim and kept apart from the monthly engine
Status: **owner decisions R17-1…R17-4 taken 2026-10-06; built locally on `feat/phase17-reporting`; not reviewed, merged or deployed.** Detail: `PHASE_17_IMPLEMENTATION.md`.

Context: the Phase 1 agreement (§22, Annexure A) puts the Daily Executive Brief, Daily Challenges, Weekly Intelligence Report, Weekly Development Comparison, Monthly Management Report, Accountant/CFO Report, Funding Readiness Report and Custom AI Report in Phase 1. Only the monthly report existed (ADR-024). The engine computes complete months only (ADR-030), and its outputs are golden-hashed per version.

Decision:
1. **R17-1, day and week figures, both ways.** (a) The briefs report events (alerts, actions) and the latest complete month as Home shows it, with no new calculation. (b) Day- and week-level figures — money in and out, net cash movement, invoicing net of credit notes, invoices fully paid, invoices that fell due unpaid — come from a separate pure calculator, `financial-engine/domain/interim.ts` (`interim.v1`), over dated, live records. Nothing the monthly engine produces reads it, and nothing it produces is a metric snapshot, so engine 15.0.0, its golden record and every monthly figure are unchanged. Absent data is absent, never zero. A window that some account's data does not reach is marked Incomplete. Every figure lists its records.
2. **R17-2.** "Daily Challenges" is the brief's "What needs attention today" section. "Weekly Development Comparison" is the weekly report's comparison of every interim figure with the week before. Both are **interpretations** that the owner has to confirm in writing.
3. **R17-3, delivery.** On screen; a PDF on request; and scheduled. The hourly tick queues yesterday's brief after each organisation's local midnight, and last week's report on its local Monday, once per organisation, kind and window. No email (no provider; outside Phase 1).
4. **R17-4, the Custom AI Report.** Each question goes through the analyst's own route (same grounding, refusals, evidence, quota). The server builds the report from the caller's stored conversation, taking only message ids from the browser. It is private to its author.
5. **Composed reports are stored, append-only** (`public.reports`), because what was open on a day is a fact about that day. Recomposing adds a version and keeps the old one. Stored content is versioned and carries no colleague names (clients may read it, and `users.view` is not theirs) and no import details (`imports.review`).
6. **The Funding Readiness Report** is not built: Phase 16 has not started. The Reports page shows the slot as not available yet.

Consequences: a new table, two `api_server` writers, `report.compose`, `report.render` by `reportId`, `report_files.report_id` (with `period_id` nullable), and a scheduled sweep beside the scheduled recalculation. While adding `reports` to the purge order, eleven earlier tables were found missing from it (purges of organisations using them always failed). That is fixed separately (migration `20261010000001`). The monthly PDF list now excludes the PDFs of other kinds that also name a month.

### ADR-142 · Budgets are imported plans, compared with actuals beside the engine
Status: **owner decision 2026-10-06 ("separate budget module"); built locally; not reviewed, merged or deployed.**

Context: Agreement §9 requires "budget/forecast variance where applicable"; REQ-FC-03/04 and REQ-CA-14 were post-MVP. Forecast variance exists (Phase 11). There was no budget.

Decision:
1. **Import.** A budget is imported through the ordinary wizard as import type `budget` → target `budget_lines`: month, account, amount, mapped to the chart like a trial balance (unknown accounts created with a keyword-suggested category, as for any import). A year-month cell is read as the first of the month. One line per account and month (`IMP-BUD-001`). A negative amount warns (`IMP-BUD-002`). Future months raise no "dated in the future" warning. Same traceability, review, commit and rollback as every import: `budget_lines` follows the financial-record contract.
2. **Replacement.** A month's budget replaces the last one for that month, at batch scope, like a balance report: superseded, never deleted. Rolling the revision back restores the earlier budget.
3. **Not a financial record.** The engine never reads `budget_lines`. No metric snapshot is written, and the engine version is unchanged.
4. **Variance** (`modules/budgets`, `budget_variance.v1`) is pure. It reads the month's current lines summed by standard category, sets them beside the engine's actual snapshots in the engine's own P&L order, and subtracts. Budgeted profits are derived as the engine derives actual ones, and a category with no budget line counts as nil in a derived profit, which the row states. A missing actual is absent, never zero. Balance-sheet categories are listed as not compared.
5. **Surfaces:** `/money/budget` (`financials.view`), and analyst tool 27 `get_budget_variance` (`financials.view`; budget figures labelled as an imported plan; actuals carry snapshot ids). The tool was recorded for the eval corpus with two adversarial cases (no budget imported; a budget the user invents), and the prompt is unchanged.

### ADR-143 · The Departmental Dashboard is an overview of the departments MOTION already has, and of the system itself
Status: **owner decision 2026-10-06 ("Department overview page"); built locally; not reviewed, merged or deployed.**

Context: Agreement §4 / Annexure A list a "Departmental Dashboard: Business Department Overview. System Functional Overview" without defining it.

Decision (the developer's reading, confirmed by the owner's choice, still to be confirmed in writing as the definition):
1. `/app/[orgSlug]/departments`, a navigation item after Home. Gated on `financials.view` (every active role), not `dashboard.view`, so a suspended member keeps only the frozen Home (ADR-044.4).
2. **Business department overview:** one tile per department (Finance, Banking, Customers, Actions, Alerts, Reports, AI Analyst, Planning), each with its headline, a status (in order / needs attention / nothing yet) by fixed rules, and a link into the section. A tile appears only for someone who may open the section (`banking.view`, `customers.view`, `actions.view`, `reports.view`, `ai.use`).
3. **System functional overview:** when data was last added, the last calculation (status, time, engine version), imports waiting or failed (`imports.review` only), the team size (`users.view` only), what runs on a schedule, and the organisation switches that actually gate something. ADR-025's other four flags shipped ungated and are not shown as "off".
4. Nothing is computed: every figure is a snapshot, count or row its own page reads.

### ADR-144 · Team/Client Management is in the product: comments, requests and deliverables, and an inbox
Status: **owner decision 2026-10-06 ("In-app"); built locally; not reviewed, merged or deployed.**

Context: Agreement §4 / Annexure A put a "Team/Client management System — management and engagement platform between teams and clients … tracking and deliverable notifications to clients about their data" in Phase 1 (MVP_SCOPE had it post-17, CD-26). There is no email provider, and adding one is outside Phase 1.

Decision:
1. **Comments on actions** (`action_comments`, append-only). Anyone who can see the action may comment.
2. **Requests and deliverables** (`engagement_items` with an append-only `engagement_events` history):
   - a client raises requests of the team;
   - the team adds deliverables for the client and moves either along (open → in progress → delivered / closed);
   - a requester may withdraw their own request.
3. **Inbox** (`notifications`), written only by the server (`app.notify`), when:
   - data is added (an import is committed): the client is told and linked to Home, and a reviewer is linked to the import;
   - a weekly or adviser report is ready (daily briefs are not notified, to avoid daily noise);
   - a request or deliverable is created or moves;
   - someone comments on an action or item you are part of.
   A notification goes only to someone who may open what it points at, never to the person who caused it. The header shows the unread count, and `/notifications` lists them.
4. **No new permission.** Comments and requests follow `actions.view`. Deliverables and status changes follow `actions.assign`, which the team holds and a client does not. RBAC_MATRIX is unchanged. A colleague's name is shown only with `users.view`; otherwise "You" or "A colleague".
5. **Not built:** email, digests, notification preferences, and file attachments on requests. Each would be a change request.

### ADR-145 · Phase 16 Funding Readiness, as built — and where the build departs from the design
Status: **built locally on 2026-10-06 on the owner's instruction ("build it now, locally"), AHEAD of the design's prerequisite.** The independent re-review of the receivables/payables recovery (ADR-120) and its Health regression audit has not happened. F5 therefore rests on unreviewed engine work. Off by default. Not reviewed, merged or deployed.

As designed (PHASE_16_IMPLEMENTATION.md §3–§11):
- the seven factors, every threshold and A-1…A-5;
- one clamp; unavailable is not a value; the 0.6 completeness exclusion and the 70 cap;
- the gate (F1 + F2 + three of F3–F6), renormalised weights with Health's rounding, and the five bands;
- the disclaimer word for word;
- fixed-template sentences, missing lines and improvement actions, with no AI anywhere;
- an append-only `funding_assessments` table and the `funding_current` pointer;
- one `funding_assessment` evidence bundle per row;
- RLS that includes the flag;
- the page, a flagged navigation link, the portfolio link and the platform toggle;
- the enablement backfill queued in the same transaction as the flag;
- the nightly backstop;
- the `debt_balance` engine metric (engine 15.1.0, minor).

Departures, each to the owner's attention:
1. **Assessment timing.** The design adds "a funding step in `calculation.run` immediately after the health step". It is built as a `funding.assess` job queued after every successful run while the flag is on. An assessment therefore always cites a run that succeeded, and a run that fails part-way never leaves a funding pointer to restore. Any queued assessment job assesses every complete month whose current assessment does not cite that month's current run, whatever triggered it, because queued jobs of one organisation merge.
2. **F3.2** reads B3 as the period's current Health score recorded it, which is the same `bankingAnomalies` evaluation from the same run, rather than re-running the condition functions in the job.
3. **The 70 cap** also applies to AI-read (`inferred`) required inputs, as owner decision D-2 set for Health. The design text named only estimated and proxy inputs.
4. **A complete statement with no borrowing line** is a known zero debt. On an unconfirmed, partial or unbalanced statement it is unknown, consistent with Step 0F/NF-2. The design predates that rule.

Still deferred, as designed: lender matching and the analyst explaining an assessment. (The Funding Readiness Health dimension was deferred here by ADR-119; ADR-147 later activated it.)

- **Addendum (2026-10-06): the Funding Readiness Report (REQ-RP-05).** Built in Phase 17 on the same flag. It freezes the latest month's current assessment (`funding.v1`) into `reports`; it recalculates nothing and carries the disclaimer verbatim. Produced on request only (not scheduled). While the flag is off: the Reports page says it is switched off, `api.enqueue_job` refuses (NOT FOUND), and the `reports_select` policy hides earlier Funding Readiness Reports; the rows are kept, as assessments are. It inherits everything above: unreviewed, ahead of its prerequisite, and off by default.

### ADR-146 · "Can the business afford a proposed expenditure?" — MOTION checks it, the analyst reports it
Status: **built locally on 2026-10-06 on the owner's instruction to build the pending SOW items ("start building one by one, which is pending"). Not reviewed, merged or deployed.** SOW §12 lists the question; until now the analyst refused it (`affordability` template, AI_ARCHITECTURE.md §9.4).

Context:
- ADR-100 kept the analyst from working a what-if out: a model that applied an assumption would become the source of a financial figure. Affordability was refused for the same reason.
- The question has one input the system cannot know — the amount — and otherwise needs only the stored cash forecast.

Decision:
1. **A deterministic check, `affordability.v1`** (`scenarios/domain/affordability.ts`). The spend is a delta on the forecast's `cash_outflows` leaf, once or every month from a chosen forecast month. Both columns — cash as expected, cash after the spend — are composed by the forecast's own `composeFromLevels` from the same real opening balance. Rule:
   - **affordable** — the lowest closing cash over the horizon, after the spend, is at least one month of the forecast's money out (the buffer);
   - **tight** — it stays at or above zero but below the buffer;
   - **not affordable** — it goes below zero.
   The same rule is applied to cash without the spend, so "cash is already tight" is said. Cash only; profit, accounting treatment and anything past the last forecast month are not assessed. No forecast, or one that cannot state closing cash, is a refusal with its reason — never a zero.
2. **One service for page and analyst** (`checkAffordability`, `dashboard.view`, nothing stored). The What-if page has a "Can we afford it?" GET form; the analyst has tool 28, `check_affordability`.
3. **The amount is the person's, verbatim.** The tool takes `amount_as_written`, refuses it unless it appears in this turn's question (case and spacing aside), and parses it itself: digits with comma thousands, optional two decimals, optional currency mark, optional `k`/`m`. `1,50`, `1.234,56`, Indian grouping and words are refused, not guessed. One-off/monthly and the start month are echoed back so the answer states them. This is the one, narrow departure from ADR-100's "no tool takes an assumption": the assumption is a single number the person typed, and the arithmetic stays MOTION's.
4. **Without an amount** the analyst refuses with the revised `affordability` template ("I can check that once I know the amount…") and gives the nearest supported facts.
5. `PROMPT_VERSION` → `analyst-v3.6`. This bump also covers tool 27 (`get_budget_variance`, ADR-142), which was added without one.

Consequences:
- The registry is closed at 28 tools; the eval recording gains a `check_affordability` call (NO_DATA: the recorded organisation has no forecast) and two adversarial cases in which no verdict or worked-out balance may appear.
- The buffer of one month is a product rule, not advice; the owner may change it (a config bump to `affordability.v2`).

### ADR-147 · health.config.v5 — Marketing Efficiency and Funding Readiness join the Health Score
Status: **built locally on 2026-10-06. Not reviewed, merged or deployed.** The owner chose, when asked: Funding Readiness dimension — "Build, for everyone"; Marketing Efficiency — "Build it from existing data". SOW §11 lists both dimensions; FINANCIAL_ENGINE.md §7.1 reserved them; ADR-119 deferred the second and set five conditions for activating it, each answered below.

Decision:
1. **One config bump for both, `health.config.v5`.** Eight dimensions. The weights are rescaled proportionally from 25/25/15/15/10/10 plus the two reserved 10s (×100/120, largest remainder): 21/21/13/13/8/8/8/8. Like every Health threshold, the weights await product-owner sign-off (CD-19).
2. **Funding readiness (REQ-BH-10)** scores only Funding Readiness signals Health does not already read (ADR-119 condition 4, double counting): R1/R2 debt against a year of operating profit and its three-month trend (F4.1, F4.2), R3/R4 the overdue share of what customers and suppliers are owed over the gross open-invoice population (F5.2, F5.3), R5 complete months of the last six (F6.1). F1, F2, F3, F5.1 (= Q3), F6.2 (= G2), F6.3 and F7 are left out. Thresholds are the APPROVED `funding_readiness.v1` ones, copied into Health's config (the funding module imports Health's rule shape, so a runtime import back would be a cycle) and asserted equal by a unit test. Required: any one of debt, receivables, payables; none of them established is excluded, never "owes nothing". It is computed **for every organisation** inside the Health run, whatever `features.funding_readiness` says; the standalone assessment, its page and its report still follow the flag (ADR-121, ADR-145). The dimension states facts the engine already established; it is not the Funding Readiness score.
3. **Marketing efficiency (REQ-BH-08)** reads the Commercial records under ADR-102's rules: M1 the revenue (`customer_revenue`, from the month of each first win) of customers campaigns won, over campaign spend, in the three months ending P; M2 the cost per customer won against the three months before. No campaign spend in the window excludes it (`no_campaign_data`, a new exclusion reason) — having no campaigns is not inefficiency. **The M1/M2 thresholds are PROPOSED**: no product document states them. Campaign records changing does not by itself trigger a recalculation; the next run picks them up. The Marketing Analysis module itself stays out of Phase 1 (SOW §5).
4. **The whole history is re-scored** (condition 2): a calculation run whose organisation's latest score was made under another config recomputes its full history, as an engine-version change does; `api_server.enqueue_health_upgrade(config)` queues every such organisation nightly.
5. **Never compared across configs** (condition 3): `loadHealthCard` gives no change when the previous month's config differs (Home, the reports, the analyst), and `api.portfolio_summary` returns no previous month across a config change, so Phase 15 attention cannot see a band "fall" that is a rules change.
6. Condition 5, its own independent audit, is **not met**; this is listed with the open items.

Consequences:
- Every organisation's scores can move. Fixture checks: on the shared unit fixture the overall score is unchanged (78 under v4 and v5); in the audit H-2 cumulative trial-balance case July goes NULL → 82 and August 87 → 84, because a complete cumulative statement states debt as a known zero and the new dimension scores (worked by hand in the test).
- "Based on N of 8 areas" replaces "of 6".

### ADR-119 addendum (2026-10-06)
The dimension is activated by ADR-147 on the owner's instruction, for every organisation. Conditions 1–4 are answered there; condition 5 (independent audit) is not yet met.

### ADR-148 · Advisory opportunities in the Command Centre — fixed rules over the latest Health breakdown
Status: **built locally on 2026-10-06 on the owner's instruction; rules chosen by the owner from a proposal. Not reviewed, merged or deployed.** SOW §20 lists "Advisory opportunities"; it was the only §20 item not built (REQ-AD-10).

Decision:
1. **The attention queue's mirror image, built the same way.** `opportunities.v1` (`portfolio/domain/opportunities.ts`, pure) reads each client's latest complete scored month — the breakdown already stored, dimension by dimension and rule by rule — through one scoped statement, `api.portfolio_health_breakdowns(orgs[])` (`app.portfolio_scope`, POST, ADR-117). No model, no new figure: every opportunity lists the stored scores and rule results that triggered it.
2. **Six rules, in a fixed order** (owner's choice; thresholds proposed and declared once):
   - *Ready to fund growth*: Health Stable or Strong, funding readiness ≥ 70 and cash ≥ 70;
   - *Surplus cash*: C2 "≥ 6 months" and profitability ≥ 60;
   - *Campaigns paying back*: marketing ≥ 70;
   - *Growing on thin margins*: sales growth ≥ 65 and profitability < 50;
   - *Collections and working capital*: Q3 above 60 days, or R3 overdue share ≥ 30%;
   - *Momentum*: Health up ≥ 10 points or a band since the previous month — only across the same config (the summary returns no previous month otherwise, ADR-147).
   A skipped rule or an excluded dimension never satisfies a rule.
3. **Where.** An "Advisory opportunities" section on `/portfolio` (clients with the most opportunities first, then by name; 25 shown, all counted) and on each client page, with a link to the Health Score's evidence.
4. **Into an action.** "Record as an action" sends only the client and the rule; the server works the opportunity out again from the current breakdown and creates the action in the client's Action Centre (`api.create_action`, source `health_score` = the score it rests on), under the client organisation's own `actions.create`.

Consequences: an opportunity is only as current as the latest calculation; the thresholds can change with a bump to `opportunities.v2`.

### ADR-149 · The Portfolio Report — every advised client on one page and in one PDF
Status: **built locally on 2026-10-06 on the owner's instruction. Not reviewed, merged or deployed.** SOW §20 lists "Client reports" for the Command Centre; each client already had its own Accountant/CFO Report (ADR-141), but there was no report across clients (REQ-AD-08).

Decision:
1. **The overview's facts, assembled** (`portfolio/domain/report.ts`, `portfolio_report.v1`, pure): portfolio counts; then every advised client — attention queue first in its order, then the rest by name — with its health (score, band, month, trend, areas scored), attention reasons, alert and action counts, and its advisory opportunities with their reasons. No new figure or judgement; the Health disclaimer is carried.
2. **Composed when asked, not stored.** A portfolio spans organisations and every stored report belongs to exactly one (`public.reports`), so `/portfolio/report` and `/portfolio/report/pdf` compose it from the current figures each time (`no-store`), for the caller's own portfolio and nothing else; no portfolio is the uniform 404.
3. The PDF renderer lives in `modules/reporting` (`renderPortfolioPdf`), which already reads the portfolio; the portfolio module does not import reporting, so there is no cycle.

Consequences: the report is as current as the latest calculation of each client; two downloads minutes apart can differ.

### ADR-150 · Receipts read by AI from a photo or PDF — the one path that sends a file
Status: **built locally on 2026-10-06 on the owner's instruction. Not reviewed, merged or deployed.** SOW §8 lists "Invoices and receipts" for ingestion; receipts could be imported only as a CSV/XLSX list, and a receipt photo or PDF was refused or stored unread (`MVP_SCOPE.md` "Receipt OCR: post-17").

Context: every AI reading so far sends text only (ADR-033, ADR-084; SECURITY_MODEL: "never binaries"). A receipt photo has no text, so reading one means sending the file.

Decision:
1. **The one exception to "never binaries", fenced the way statements are.** Only for the Receipts import; only while `ai_pdf_extraction` is on; only when a reviewer with `imports.review` asks, after a consent line that says the FILE is sent; audited `document.sent_to_ai` (`file_sent: true`) before it is sent; each page charged against the daily page budget and the monthly token ceiling before the call. Never on upload.
2. **Accepted files.** JPEG or PNG by magic bytes (GIF refused), ≤ 5 MB (`IMP-FILE-009`, the provider's image limit); a PDF ≤ 10 pages, scanned or not. A photo uploaded as any other import type is refused before anything is stored.
3. **The model reads; it never decides.** `ai.extractReceipts` answers through a forced `submit_receipts` tool — page, position, date, who was paid, description, a POSITIVE total, currency only when printed; anything else, or a page the file lacks, is a failure, retried, then the batch says so. The account is the reviewer's choice of one of the organisation's active expense accounts, checked in SQL (`api_server.begin_receipt_extraction`); the model has no field for it.
4. **The same pipeline and gate as an AI-read statement.** Receipts become rows through the CSV pipeline (`IMP-PDF-001` on each), under `extraction_method = pdf_claude` — so the commit gate requires every page confirmed and the ledger entries are `inferred` (CD-11). One-sided debits, as for any receipts list (the bank statement carries the payment).
5. **Who was paid** is kept in the description ("Ryman — Printer paper"); it is not matched to a counterparty in this version.

Consequences: `extraction_method = pdf_claude` now also means "a receipt file read by AI", not only a PDF statement's text — the name is kept so the commit and its gate apply unchanged. No deterministic line count exists for a receipt, so the page-wide tick rests on the model's confidence and a reviewer's look at the photo beside the rows.

### ADR-151 · The interface on shadcn/ui
Status: **built locally on 2026-10-06 on the owner's instruction ("Switch to shadcn/ui"). Not reviewed, merged or deployed.** SOW §6 names "Tailwind CSS and shadcn/ui"; the build had used its own Tailwind primitives.

Decision:
1. **shadcn/ui as shadcn/ui intends: owned source.** `components.json`; `src/lib/utils.ts` (`cn` = clsx + tailwind-merge, told about MOTION's `rounded-card` radius); `src/components/ui/shadcn/` — Button and Badge (`cva` variants, Radix `Slot`/`asChild`), Input, Textarea, NativeSelect, Label (Radix Label), Card parts, Alert, Table parts, Skeleton — themed with MOTION's design tokens rather than shadcn's default palette, so contrast and the accessibility sweep are unchanged.
2. **The app's shared primitives are built on them**, keeping their names and props (`Button`/`ButtonLink` tones → variants `default`/`secondary`/`ghost`/`destructive`; `Card`/`CardHeader`/`CardBody`; `Badge`; `Banner` → `Alert`; `TableWrap`/`THead`/`TBody`/`TR`/`TD` → Table; `Field`/`Input`/`Select`/`Textarea`), so every screen using them is on shadcn/ui; hand-styled controls in screens were converted to the shadcn components directly.
3. **Deliberate departures from shadcn's defaults:** the Card root is a `<section>` (pages name cards as regions); the Table container keeps `min-w-0` and `relative` (ADR-058.12); selects are shadcn's NativeSelect, not the Radix popover Select (screen readers, phones, and journeys selecting by label); hidden, checkbox, radio and file inputs stay native.
4. **Charts stay MOTION's own SVG**, which §6 allows ("Recharts or equivalent").

Consequences: new dependencies `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-slot`, `@radix-ui/react-label`. Visual output is intended to be unchanged; the browser journeys and the accessibility sweep are the check.

### ADR-152 · Home's headline cards in the widget grid's design
Status: **built locally on 2026-10-07 on the owner's instruction (a supplied `draggable-widget-grid` template; then "Keep all the cards as they are. Just implement the theme design system" — the template's look, no dragging). Not reviewed, merged or deployed.**

Decision:
1. **The template, as owned shadcn/ui source** (`src/components/ui/shadcn/draggable-widget-grid.tsx`, exported from the shadcn barrel; ADR-151), its logic and design kept: 24px radius, hairline ring, soft resting shadow (`0 1px 2px` at 12%), 12px gap, staggered entrance, Motion springs. Its `card`/`border` colours are mapped to MOTION's `surface`/`line` tokens (MOTION has no separate card tokens), so it follows the light and dark themes. New dependency: `motion`.
2. **Home's six headline cards use it with dragging off** (`editable={false}`, through `WidgetCards` in `components/dashboard`): same cards, same content, same fixed order; only their design changes. Nothing is stored.
3. **Additions to the template, each for a reason:** an optional fixed `rowHeight` (MOTION's cards are wide and short, not square); an `appear` switch for the entrance (on by default, as the template); a remount, not an animation, when the grid first measures its columns (the server render guesses three, and animating out of the guess overhung a phone screen, failing the no-sideways-scroll sweep); latest-value refs written in a layout effect and DOM order held in state, as the React Compiler lint requires.
4. **The accessibility checks measure the settled page.** The axe checks (`e2e/accessibility.spec.ts`, the sample walkthrough) now wait for running animations to finish before measuring, because contrast is a property of the settled text, not of a frame mid-fade. The assertion is unchanged.

Consequences: a rearranging mode (drag, keyboard moves, saved order) was built first and removed on the owner's instruction; the component still supports it (`editable`), should it be wanted later.

### ADR-153 · The template's colour scheme, in liquid glass
Status: **built locally on 2026-10-07 on the owner's instruction ("Change Color schema as per the template which I have given you"; "Change the card styles, buttons and the background style to liquid glass style"). Not reviewed, merged or deployed.**

Decision:
1. **Colours: the supplied widget-grid template's palette** (shadcn's neutral zinc: ink `#09090b`, lines `#e4e4e7`, near-black primary `#18181b`; dark: `#0a0a0b` ground, `#fafafa` ink), with its status colours — emerald for good news, amber for warnings, rose for problems, blue first in the chart series. Changed in `globals.css` tokens only, so every screen follows; token names and roles are unchanged.
2. **A `good` token, apart from the accent.** The template's primary is near-black, so good news (favourable movements, a rising health score) moves from `text-accent` to `text-good` (emerald-700 / emerald-400) in the four places that colour by good news.
3. **One departure for accessibility:** muted text is zinc-600 `#52525b`, not the template's zinc-500 `#71717a`, which measures 4.4:1 on the sunken panel (below WCAG AA). Every status colour was measured at AA or better on its backgrounds, light and dark.
4. **Liquid glass:** `glass` (cards, panels, Home's widget cards, the top bars) and `glass-control` (secondary and destructive buttons) in the components layer: a translucent fill, `backdrop-filter: blur() saturate()`, a light inner top edge, a faint outer edge and a soft shadow. Buttons are capsules; the primary is a dark glass pill. The page has a fixed, faint blue/violet/emerald wash for the glass to frost. Card radius 0.5rem → 1rem. Surfaces stay opaque enough that text contrast holds over the wash.

5. **Strengthened the same day on the owner's instruction ("make the glass effect stronger"):** fill 62% → 40% white, blur 20 → 28px, saturation 200%, a diagonal sheen, a brighter top edge with an inner glow, a deeper shadow, and a stronger wash. The wash and the status colours were measured together, including where two wash colours overlap under text sitting on the bare page; to keep WCAG AA there, warning, problem and good-news text moved one or two shades darker (amber-900 `#78350f`, rose-800 `#9f1239`, emerald-800 `#065f46`).

Consequences: supersedes DESIGN.md's warm paper palette, green accent and "never a shadow" rule. The accessibility sweep and the sample walkthrough pass, both light-scheme. Reverting is one commit.

### ADR-154 · The owner's reference: sky, frosted tiles, indigo
Status: **built locally on 2026-10-07 on the owner's instruction (a reference screenshot of a glass real-estate interface: "and this color schema and the tiles style"). Not reviewed, merged or deployed.** Refines ADR-153's glass; replaces its zinc palette.

Decision:
1. **Colour scheme from the reference:** the page is a sky — dusty blue at the top to lavender, with a warm peach glow low on the right and a soft light glow top left (`--sky`, `--sky-glow`, `--sky-warm`); text is deep navy (`#1b2340`, muted `#434c69`); the accent is deep indigo (`#2e2f7f`, white on it at 11.5:1); lines are navy at low opacity. Status colours stay (emerald-900 `#064e3b` for good news, amber-900, rose-800). Every text colour measured at WCAG AA on the darkest part of the sky and on the glass. Dark scheme: a night sky (navy to dusk violet) with a light-indigo accent.
2. **Tile style from the reference:** bright frosted tiles (62% white, 24px blur, sheen, white edge, soft navy shadow), 28px corners everywhere (`--radius-card: 1.75rem`, Home's widget tiles `radius={28}`, 16px gaps), roomier padding (cards `px-6 py-5`, Home tiles `p-6`), and the top bar as a floating rounded glass tile rather than a full-width strip. Buttons remain glass capsules; the primary is indigo.
3. **Content unchanged:** the same cards, figures, links and order; only colour, shape and spacing.

Consequences: the accessibility sweep, the Home journeys and the sample walkthrough pass (light scheme).

### ADR-155 · The owner's reference dashboard: violet, white cards, a sidebar
Status: **built locally on 2026-10-07 on the owner's instruction (a reference dashboard image: "this is the Exact dashboard color scheme, card templates, button style, text styles"; scope chosen: everything — design system, sidebar layout, and the Departments page rebuilt as the hub, with real status only). Not reviewed, merged or deployed.** Supersedes ADR-153/154's glass and sky.

Decision:
1. **Colour:** white cards on the faintest lavender (`#faf9ff`) with a faint violet/pink glow and translucent petal artwork in the corners; a vivid violet brand (`#7c3aed`, white on it 5.7:1), pink as the second colour for icon tiles; near-black text (`#110d1f`) and grey-violet secondary text (`#5e5873`); status dots green/amber, status text green-700/amber-700/rose-700. Every text colour measured at WCAG AA on white, the page and the soft violet panel. Dark scheme keeps the roles.
2. **Type:** one sans throughout; headings bold (700) and tight. `--font-serif` now names the display face (a sans) so existing headings follow.
3. **Components:** `panel` (white, hairline, soft violet shadow, 16px radius) for every card; buttons with 12px corners — solid violet primary with a violet glow, violet-outline secondary, outline-rose destructive; badges as soft pills; section sub-navigation as a segmented control with the current tab a violet pill (`SectionTabs`).
4. **Layout:** `AppShell` — a white sidebar with the flower mark, an icon per section, the current item a solid violet pill, and the account links, from `lg`; a top bar with a menu below it. Used by the tenant app, the Command Centre and the platform area. Which links exist is still decided by `nav.tsx`/the layouts (RBAC §5); the shell only draws them.
5. **Departments page as the hub:** one reference-style card per department (icon tile, title, what it covers, the department tile's own headline and lines, quick-link pills within the section, a status dot from the tile's tone, "Open"), plus Accountant/CFO (with Command Centre access), Funding Readiness (when switched on) and Team & Clients (team size), a data-capture row, report shortcuts and the system overview. Every status and figure comes from `modules/departments` or a permission/flag check; no status is shown where MOTION has none.

6. **Brand details from the owner's crops (same day):** the mark is the owner's logo, generated in ChatGPT (owner's account, at their instruction) from the reference — four rounded petals, violet above and pink below — cut out onto transparency and cropped in the browser, downloaded with the owner's permission, and stored as `public/brand/motion-logo.png` (256px) and `src/app/icon.png` (browser-tab icon). "MOTION" in a medium-weight deep indigo (`--color-brand-ink`) with "Financial intelligence / for a brighter tomorrow." in violet; translucent lavender leaf sprigs — also generated in ChatGPT at the owner's instruction, cut out onto transparency (grain removed) and compressed to `public/brand/sidebar-leaves.webp` and `corner-leaves.webp` (~100 KB each) — at the sidebar's foot with "Smarter finance / brighter possibilities." and behind the page header's buttons; the accent moves to the reference's bluer violet `#6a45e5` (white on it 5.8:1). The sidebar shows the signed-in person (`api.my_profile`: name, else email; initials; role) linking to Account, and the four Data pages become one "Data & Forms" item with the pages as tabs (`data/layout.tsx`, `imports.review` only, as the Data menu was).

7. **Every page in the same design (owner: "Apply the same design to all the other pages"):** shared `PageHeader` (the Departments title band), `CardHeader` with an optional icon tile, `IconBadge`, `StatTile`, and `BrandedScreen` (wordmark, leaf artwork, white panel) for the pages outside the shell — sign-in, sign-up, password, choosing an organisation, invitation, onboarding, Account, legal. Home's figure cards, alert cards, action cards and the Command Centre's client cards carry icon tiles and outlined "Why? ›"-style links; every page's section cards carry tinted icon tiles. Presentation only: no text, accessible name, figure or logic changed — the full browser suite is the check.

Consequences: new dependency `lucide-react`. The accessibility sweep (all viewports, contrast, no sideways scroll), the journeys touching the shell and the sample walkthrough pass, light scheme.

### ADR-156 · Loans by security, fixed and current assets, VAT and Corporation Tax, currency and country
Status: **built locally on 2026-10-07 on the owner's instruction ("add a loans point — secured and unsecured loans clear immediately; fixed assets and current assets; VAT reporting and CT reporting; customize report"; "add currency selection for each company — we will serve UAE and UK companies"). Owner decisions taken the same day: loans are marked per account, never guessed; VAT quarters and scheme are set per company; Corporation Tax is an indicative estimate; the new areas appear both as pages and in the Custom report. Not reviewed, merged or deployed.**

Decision:
1. **Assets and loans are engine metrics** (engine 15.2.0, MINOR): `fixed_assets`, `other_long_term_assets`, `current_assets`, `total_assets`, `loan_balance`, `long_term_borrowing`, `loans_secured`, `loans_unsecured`, `loans_unmarked` — category totals from the balance family's cumulative statement for the month, under `debt_balance`'s rules exactly (no statement: NULL `no_balance_sheet`; a group with no line is a known zero only on a complete statement). Every existing value is unchanged — verified by diffing the golden corpus output against 15.1.0 with the new metrics removed (identical apart from the harness's positional ids) — and the golden hash is recorded for 15.2.0. Secured / unsecured / not marked partition borrowing owed.
2. **Secured or unsecured is the business's statement, not an inference**: `accounts.loan_security` (NULL = not yet marked), set per loan or long-term-liability account on the Accounts page through `api.set_account_loan_security` (`financials.edit`, audited, recalculates). Loans are named by category ("Loans", "Long-term borrowing"), not "short-term", because the category does not say when a loan falls due.
3. **VAT and Corporation Tax are read-time calculations** in a new `modules/tax`, not stored metrics: the engine's invoice VAT lives inside the SQL aggregate, and a quarter is not a month. VAT: the current rows of accepted, non-superseded, non-void invoices in the quarter — by issue date (standard) or by date paid in proportion to the amount paid (cash accounting); UK nine boxes (1, 3, 4, 5, 6, 7 from invoices; 2, 8, 9 stated as not recorded) and the UAE VAT201 summary (supplies and output VAT, expenses and recoverable VAT, net; the emirate split is not recorded). An invoice whose VAT is not stated is named and left out of the VAT, never guessed. The Flat Rate Scheme, an unregistered business and other countries get no return, in words. Corporation Tax: accounting profit before tax (the engine's monthly `net_profit` + `tax_expense`) over the financial year's complete months, uninterrupted from its start; UK (periods from 1 April 2023): 19% / 25% with marginal relief 3/200, limits divided by 1 + associated companies and reduced for a shorter span, due 9 months + 1 day after the year end; UAE (periods from 1 June 2023): 9% above AED 375,000, due 9 months after; Small Business Relief noted, not applied. Both are labelled indicative.
4. **Settings**: VAT quarters (the three UK stagger groups), VAT scheme and associated companies through `api.set_tax_settings` (`settings.manage`, audited; read at draw time, no recalculation). **Currency and country after creation** through `api.set_currency_and_country`: country can change at any time (it selects the tax rules); currency only while the organisation holds no ledger entries, balances, invoices, bank accounts or bank transactions — amounts are stored as stated and never converted, so changing the currency of existing figures would relabel them.
5. **Where it shows**: Money → Balance sheet (assets, borrowing, secured / unsecured / not marked, each with "Why?") and Money → Tax (VAT return by quarter, Corporation Tax estimate); a Tax & VAT card on Departments; and the Custom report's new areas — Loans, Assets, VAT, Corporation Tax — each with a fixed figures table stored in the report, produced even when the AI is unavailable.

Consequences: migration `20261018000001` (catalogued in DATABASE_ARCHITECTURE §14); FINANCIAL_ENGINE.md §3.4 rows; unit tests for the metrics (`balance-sheet-figures`) and the tax rules (`tax`); an integration test for the three functions. The Corporation Tax estimate is not a tax computation (no capital allowances, disallowances or losses), and the VAT return does not cover EU/Northern Ireland boxes, partial exemption, or the flat-rate scheme.

### ADR-157 · The AI provider key in Platform settings; the analyst on current models
Status: **built locally on 2026-10-07 on the owner's instruction ("add an API key in Settings for the owner of this app — remove the old one, add the new one and save"; owner decision: app-wide, in Platform settings). Not reviewed, merged or deployed.**

Decision:
1. **One app-wide key, managed by the platform owner** in Platform → Settings ("AI provider key"): stored ENCRYPTED in Supabase Vault (`vault.secrets`, `anthropic_api_key`), set or removed only by a super admin at aal2 with a recent sign-in (`api.set_ai_api_key`, `api.clear_ai_api_key`), shown only as its last four characters (`api.ai_api_key_status`, super admin), audited without the key, and read in clear only by the server (`api_server.anthropic_api_key`, service role). A new key is tried against the provider (a read-only model list) before it is stored. The server uses the stored key, refreshed each minute, else its `ANTHROPIC_API_KEY` setting. Migration `20261018000002` (Vault grants to `motion_definer`, including the decrypt function the view runs).
2. **The analyst on the models the key offers.** `claude-sonnet-4-5` is no longer offered; the model is `ANTHROPIC_MODEL`, default `claude-sonnet-4-6` (fewest grounding rejections in trials; `claude-sonnet-5-5` works). Changes the current models required: no `temperature` (refused); `max_tokens` 1500 → 4000 (answers were cut off and failed validation); model timeout 30 → 90 s, turn budget 45 → 120 s, route 60 → 150 s (plain questions take 25–70 s); a union-input tool's schema is offered as one object (the API refused a top-level `anyOf`); each tool result now carries its `seq` (the model had to count calls); and a NumberRef naming a number node's `display` or `value` field, a leading `data.`, or a dotted array index resolves to that node — the same number in the same result, never a different one. Prompt `analyst-v3.7`: the citation format stated exactly; one period per statement with comparisons through change fields; direction words on every change; no counts a tool did not return. The recorded eval fixture was re-recorded for v3.7.

3. **Tuning against the live questions (same day, owner approved spending API credit).** The thirteen live questions (`eval/live.ts`) were asked through the page three times. Baseline: 1 passed, 3 degraded, 8 failed, 1 refused. Fixes: answers capped at 8,000 tokens and asked to be short (most failures were answers cut off); an entity id may be a standard category KEY as well as a UUID (the contract required a UUID, so every answer naming an expense category exactly as the tool did was invalid — a latent defect); a long month name is the short one ("August 2026" = "Aug 2026"); a citation of a figure's wrapper resolves to the number it wraps; a metric's noun anywhere in the claim's sentence binds it when no other metric is named there (the six-token window still decides otherwise, so the swapped-metric trap stays caught); everyday synonyms per metric where unambiguous ("overdue", "turnover", "debtors"; never bare "profit" or "margin"); and the prompt states the refusal shape (opening sentence alone, figures in key findings), that a missing amount is a refusal not a clarification, and that "not covered" items carry no digits. Prompt `analyst-v3.8`; the recorded eval suite, with its traps, passes throughout. Third run: every question answered or correctly refused (1 failed answer), but most statements still withheld for vocabulary and binding reasons.

4. **Where the key is managed (owner, same day): the super admin's own profile.** The "AI provider key" card is on Account, rendered only for an active super admin and, with its key controls, only at aal2; no other user's profile shows it, and it is no longer on Platform settings. The first super admin is a separate login (`shaukinsv+admin@gmail.com`): a platform user may not be an organisation member (`app.platform_user_excludes_membership`), so the owner's own login could not hold the role.

Consequences: the analyst answers end to end with the owner's key; grounding still withholds many of the current models' statements for format reasons (long month names, counts, some row paths) — a tuning pass against the live evaluation suite is the next step. The owner's account needs a platform role and two-step sign-in (TOTP, switched off locally on request) to reach Platform settings.

### ADR-158 · The super admin decides each company's systems, creates companies and adds staff
Status: **built locally on 2026-10-07 on the owner's instruction ("only a super admin can create a new admin user"; "in the super admin panel the super admin can see all the companies; the other companies can only see their financials and other features"; "give permissions to use the tools for all the systems or departments — only super admin can decide which systems they can use"). Not reviewed, merged or deployed.**

Decision:
1. **Systems per company** (`tenancy/domain/modules.ts`): Banking, Customers, Actions & Requests, Reports, AI Analyst, Planning (Forecast, What-if, Budget), Tax & Balance sheet — new switches, ON unless switched off (`organizations.features.module_*`) so every existing company keeps what it had — and the two existing opt-in switches, Funding Readiness (`funding_readiness`) and AI document reading (`ai_pdf_extraction`), with their own semantics. Home, Money (profit and loss, cash, what is owed), Insights, Departments, Data & Forms, Notifications and Settings are always on.
2. **Only a super admin switches them**: `api.set_org_module` (aal2, recent sign-in, audited), merging one known key — not `update_organization`'s whole-object replace. Platform → Organisation → "Systems this company can use".
3. **A switched-off system is absent**: the access context carries the company's systems (`AccessContext.modules`, read once with the role); its sidebar items, Money tabs, Departments cards and pills, Home's actions band and the custom-report entry are not rendered; its pages answer 404 (`requireModulePage` in each section's layout — absent, not forbidden); the AI chat answers 404 when the Analyst is off; and the Analyst neither offers nor runs a tool of a switched-off system (`TOOL_MODULES`, checked when the tool list is built and again before each call).
4. **Companies created by the super admin**: `api.platform_create_organization` — the "platform path" `create_organization` has always pointed to — creates and sets up the company (chart, periods, country-appropriate timezone) without the super admin becoming a member (platform staff never are) and invites the owner; the invitation link is shown to send. Public sign-up is unchanged.
5. **Platform staff added by email**: the super admin invites an email (a new account receives a set-password email) and grants the role through `api.grant_platform_role` in their own session; staff are listed with emails (`api.platform_users_list`). An account that belongs to a company is refused by the existing exclusivity rule — staff need their own login.

Consequences: migration `20261018000003`; the entitlement is enforced in the application and the AI layer, while the database still serves a company's own data to its members under RLS (switching a system off hides it; it does not delete or withhold data the company already holds). Tests: `org-modules` (unit), `platform-companies-modules` (integration).

### ADR-159 · Two-step sign-in for platform staff is a setting; there is one super admin
Status: **built locally on 2026-10-07 on the owner's instruction ("remove the two-step verification and the authenticator app"; "make this ID a super admin shaukinsv@gmail.com"; "there will be only one super admin"). Not reviewed, merged or deployed.**

Decision:
1. **Two-step for platform staff is `platform_settings.platform_mfa_required`** (Platform → Settings, "Two-step sign-in required for platform staff"; changed only by a super admin with a recent sign-in, audited). ABSENT or true keeps ADR-044.1 unchanged (a platform user counts only at aal2); false lets a platform user count with a password sign-in. `app.is_platform_user`, `app.actor_has_aal2` and `api.my_platform_role` read it through `app.platform_mfa_required()` (migration `20261018000004`). The recent-sign-in requirement for sensitive super-admin actions is unchanged. Locally the setting is false and TOTP enrolment and verification are off in `supabase/config.toml`. A deployment that never sets it keeps two-step required.
2. **One super admin**: `api.grant_platform_role` refuses a second active super admin and refuses demoting the super admin; `api.revoke_platform_role` refuses removing the super admin (migration `20261018000005`; both are the only user paths to `platform_users`). "Add a platform admin" adds staff only; the super admin's row has no Revoke.
3. **The super admin is `shaukinsv@gmail.com`** (password sign-in). Because a platform user may not be a company member, the companies that login owned were moved to `shaukinsv+admin@gmail.com` (owner's choice: swap the two accounts).

Consequences: weaker sign-in protection for platform staff wherever the setting is false — the owner's decision, to be revisited before any deployment. Tests that assert the two-step default pin the setting (`withPlatformMfaRequired`) and restore the local value; `single-super-admin` (integration) covers the one-super-admin rule.

### ADR-160 · Confirm it's you; a company owner's password set by the super admin; search and activate in the company list
Status: **built locally on 2026-10-07 on the owner's instruction ("add option to set password"; "add search option to search company"; "active/deactivate from here also"; Account cards side by side). Not reviewed, merged or deployed.**

Decision:
1. **Confirm it's you.** The sensitive super-admin actions need a password sign-in from the last ten minutes (`app.require_super_admin(true)`), and the app had no way to renew it short of signing out. `confirmPassword` (tenancy) signs the current person in again with their password and replaces the session; the AI key form asks for the password, and every platform page has a "Confirm it is you" bar. A wrong password leaves the session as it was.
2. **Owner password on Create a company (optional).** With a password, the server creates the owner's login (email confirmed — the super admin vouches for it) and, once the company exists, makes it the owner through `api.platform_set_company_owner` (super admin, recent sign-in; only a company with no active owner; marks the owner invitation accepted; audited). An email that already has a login is refused by Auth (`email_exists`) and named — the super admin never sets an existing account's password; that person is invited instead. If the company is not created, the new login is deleted. Without a password the invitation link is shown as before.
3. **Invitations sent by the super admin are accepted.** `api.accept_invitation` required the inviter to be an active owner/admin member; the super admin never is, so the owner invitation of every company made by `api.platform_create_organization` (ADR-158) was refused. An inviter who is the active super admin now counts with owner authority. Migration `20261018000006`.
4. **Organisations list**: search by name, slug or legal name (server-side, all companies, the term reduced to letters, digits, spaces, `&`, `.` and `-` before it enters the PostgREST filter), and Deactivate / Activate on each row — the existing active ↔ suspended switch, now labelled Deactivated everywhere.
5. **Account**: for the super admin the page widens and the two cards sit side by side.

Consequences: integration tests for the invitation fix, the owner function (super admin only, once, recent sign-in) and the password input. The test fixture `createAuthUser` now writes empty token columns as GoTrue does: NULLs there broke GoTrue's admin user list for the whole local instance (and with it "Add a platform admin"); the local rows were repaired.

### ADR-161 · Two-step sign-in is removed
Status: **built locally on 2026-10-07 on the owner's instruction ("remove this completely from the entire code", of the platform users' two-step column, after "remove the two-step verification and the authenticator app"). Supersedes ADR-038.8, ADR-044.1 / R2-A-03 and ADR-159.1 wherever they require aal2 or TOTP; the historical documents that state those rules are not rewritten. Not reviewed, merged or deployed.**

Decision: MOTION has no two-step sign-in. A platform account (the one super admin, or staff) counts with a password sign-in.
- Database (migration `20261018000007`): `app.is_platform_user` is an active platform account; `app.org_role_of` no longer checks a factor; `app.aal`, `app.actor_has_aal2`, `app.platform_mfa_required` and `api.confirm_mfa_enrolment` are dropped; `profiles.mfa_enrolled_at` is dropped; `api.my_platform_role` and `api.platform_users_list` lose `has_aal2` / `two_step`; the `platform_mfa_required` setting is deleted.
- App: `/account/mfa` and the enrolment component are deleted; middleware no longer redirects platform accounts to it; the two-step column, the setting and every message about it are gone; the pure resolver (`tenancy/domain/resolve.ts`) has no `aal` input. Supabase TOTP enrolment and verification stay off in `config.toml`.
- What still guards the platform: one super admin (ADR-159), a password sign-in from the last ten minutes for the sensitive changes ("Confirm it is you", ADR-160), magic-link sign-in refused for platform accounts, and every RLS / assignment rule unchanged.

Tests: the assertions that a platform account WITHOUT two-step is refused tested the removed rule and were removed — the resolution fixtures' six "aal1" platform scenarios (each identical to its kept twin apart from the factor, verified by script), and the "at aal1 sees nothing" cases in rls-isolation, ai-tools, alerts-persist, forecast, scenarios, portfolio, portfolio-transport, portfolio-ai (the adviser's own aal1 read), receivables-recovery and platform-pages. The AI key test now proves a stale sign-in is refused and a password sign-in is enough. The test JWT no longer carries an `aal` claim.

Consequences: a stolen super-admin password is now enough to reach every company; the owner accepted this. Re-introducing two-step later means a new decision, not a setting.

### ADR-162 · Claude Haiku 4.5 is the default AI model
Status: **changed locally on 2026-10-07 on the owner's instruction ("i want haiku model"; "set this default"). Amends ADR-157.2. Not reviewed, merged or deployed.**

`DEFAULT_ANALYST_MODEL` is `claude-haiku-4-5-20251001` (the owner's key offers it); `ANTHROPIC_MODEL` still overrides it. Haiku is faster and cheaper; in the earlier trials Sonnet 4.6 had the fewest grounding rejections, so more Haiku answers may be withheld or degraded — the checks are unchanged.

### ADR-163 · The super admin chooses the AI model and its effort; time zone is a drop-down
Status: **built locally on 2026-10-07 on the owner's instruction ("add option to select AI models here", "and effort also", "add drop down to select time zone"). Not reviewed, merged or deployed.**

Decision:
1. **Model and effort** on Account (the AI provider key card): the models are the provider's list for the key in use (`GET /v1/models`), and the effort drop-down offers only the levels that model reports (`capabilities.effort`); a model without effort (Haiku 4.5) offers only its default. Stored as `platform_settings.ai_model = {model, effort}` through `api.set_ai_model` (super admin, recent sign-in, password confirmed, audited, shapes checked) and read by the server through `api_server.ai_model` (service role), refreshed each minute and at once on this server after a change. Precedence: the choice, else `ANTHROPIC_MODEL`, else the default (ADR-162). Effort is sent as `output_config.effort`. Migration `20261018000008`.
2. **A choice is proven before it is stored**: one small call with that model and effort and a REQUIRED tool call — what the analyst's final answer, document reading and the adviser briefing depend on. On 2026-10-07 the Claude 5 family (Sonnet 5.5, Opus 5.5, …) refuses a required tool call (`tool_choice` "tool"/"any" not supported), so they are listed but refused with a plain reason; making MOTION work with them is separate work.
3. **Time zone** on Account is a drop-down of the runtime's IANA zones with today's offset ("GMT+4 · Asia/Dubai"), the UK, UAE, India and Ireland first; a saved zone the list lacks is kept. The database still validates the name.

Tests: `ai-model-setting` (integration). The earlier recorded evaluation is unaffected (the eval names its own model and runs at that model's default effort).

### ADR-164 · OpenAI as a second AI provider; the sign-in page's links removed
Status: **built locally on 2026-10-07 on the owner's instruction ("make sure it's compatible with an OpenAI API key"; of the sign-in page's "New here? Create an account · Forgot your password?": "remove this"). Not reviewed, merged or deployed.**

Decision:
1. **An OpenAI key** beside the Anthropic one, under the same rules (ADR-157): Vault `openai_api_key`, `api.set_openai_api_key` / `clear_openai_api_key` / `openai_api_key_status` (super admin, recent sign-in, password confirmed, audited by its last four characters), `api_server.openai_api_key` (service role); checked with OpenAI (`GET /v1/models`) before it is stored. Its own card on Account. Else the deployment's `OPENAI_API_KEY`.
2. **The model choice names its provider**: `platform_settings.ai_model = {provider, model, effort}` (`api.set_ai_model(p_model, p_effort, p_provider)`); a stored choice without a provider is Anthropic. The list on Account groups Anthropic and OpenAI models — OpenAI's chat models that call tools (audio, image, embedding, moderation, realtime, search and legacy ones left out); effort is `reasoning_effort` (low / medium / high) on its reasoning models (o-series, GPT-5) only. The save-time trial (ADR-163.2) runs a required tool call against the chosen provider. Migration `20261018000009`.
3. **One seam, no SDK**: `modules/ai/data/openai-client.ts` translates the transport's Anthropic-shaped call — system parts, text / image / PDF / tool_use / tool_result blocks, tools, a required tool — into a Chat Completions request, and the reply back into the same content blocks (`tool_calls` → `tool_use`, `finish_reason` → stop reason, usage). Arguments that are not JSON become `{}` for the contract to refuse. The loop, the tools, the submit tool and grounding (§5, §7) are unchanged, so an OpenAI answer is held to exactly the same checks. One retry on 429 / 5xx / network, 90 s timeout. The evaluation (which names its model) stays on Anthropic.
4. **Sign-in page**: the "Create an account" and "Forgot your password?" links are removed (the super admin creates companies and their owners, ADR-158/160). `/sign-up` and `/forgot-password` still exist at their addresses, and the home page still links to sign-up.

Consequences: not proven against a live OpenAI key (none is available here): the translation is unit-tested (`openai-client`), the key and choice functions are integration-tested (`ai-model-setting`), and a fake key is refused by OpenAI in the browser. The grounding was tuned on Claude; OpenAI answers may be withheld or degraded more often until tuned.

### ADR-165 · One AI provider is active; each card chooses its own model and effort
Status: **built locally on 2026-10-07 on the owner's instruction ("add the option to select AI model and efforts" on the OpenAI card; "add a button to activate or inactivate the OpenAI key and the AI provider key — only one should be active"). Amends ADR-163/164. Not reviewed, merged or deployed.**

Decision: `platform_settings.ai_model` = `{active, anthropic: {model, effort}|null, openai: {model, effort}|null}` (migration `20261018000010`, converting an ADR-163/164 row). Each provider card on Account has its own model and effort drop-downs (`api.set_ai_model(.., p_provider)` stores that provider's choice and never changes which is active) and an Active / Inactive badge with a "Make active" button (`api.set_ai_active_provider`, super admin, recent sign-in, password confirmed, audited) — making one active makes the other inactive. OpenAI can be made active only with its key stored and a model chosen; its model cannot be cleared while it is active; removing the OpenAI key while it is active makes Anthropic active in the same transaction. `api_server.ai_model` returns the ACTIVE provider's choice in the shape the server already read, so the server is unchanged. Tests: `ai-model-setting` (integration).

### ADR-166 · Edit and delete a company from the organisations list
Status: **built locally on 2026-10-07 on the owner's instruction ("add an edit option for the created account and a delete option; when deleting, ask for confirmation — 'Are you sure you want to delete this?'"). Not reviewed, merged or deployed.**

Decision: each row of Platform → Organisations has **Edit** and **Delete**, each opening a dialog (`<dialog>`, focus kept inside, Escape closes).
- **Edit**: name, legal name, financial year start and plan through `api.update_organization` (the super admin's patch); country and currency through `api.set_currency_and_country`, which still refuses a currency change once the company holds records. Only what changed is sent.
- **Delete** asks "Are you sure you want to delete {name}?", says what it means, and defaults to "No, keep it". It is the existing deletion path, `api.request_deletion`: the company leaves use at once (`pending_deletion`) and `org.purge` erases its data for good after 30 days. Nothing is erased on the spot; the row shows "Deletion requested" with **Restore** (`api.cancel_deletion`) until then. Deleted companies leave the list.

No new database function. Tests: `platform-companies-modules` (integration: edit, schedule and restore, refusal to a stranger).

### ADR-167 · The super admin changes a company owner's sign-in email and password
Status: **built locally on 2026-10-07 on the owner's instruction ("let me change the password" and "and username", in a company's Edit dialog). Supersedes ADR-160.2's "the super admin never sets an existing account's password" for a company's owner. Not reviewed, merged or deployed.**

Decision: the Edit dialog has an **Owner login** section naming whose login it is, with the sign-in email (the username) and an optional new password; changing either needs the super admin's own password. `api.platform_company_owners` lists each company's owner login (super admin); `api.platform_owner_login_change` (migration `20261018000011`) authorises and records the change — the super admin with a recent sign-in, only the company's single active **owner** (never an admin, client, employee or platform account), an email that is valid and no other login uses — audited as `platform.owner_login_changed` with the old and new email, never the password. The server then sets it through the Auth admin API (email confirmed) and ends the owner's sessions, so the old details stop working everywhere at once. A company with no owner yet, or more than one, is refused with a reason. Tests: `platform-companies-modules` (integration); in the browser the old email and password were refused and the new ones signed straight in.

### ADR-168 · Delete a company for good, now
Status: **built locally on 2026-10-07 on the owner's instruction (for a company whose deletion is requested: "ask me 'Are you sure you want to delete it?' If I say yes, delete it. If I say no, don't."). Not reviewed, merged or deployed.**

Decision: a company showing "Deletion requested" has **Restore** and **Delete now**. Delete now asks "Are you sure you want to delete {name} permanently?", defaults to "No, keep it", and needs the super admin's password. `api.platform_purge_now` (migration `20261018000012`; super admin, recent sign-in, only a `pending_deletion` company, audited `platform.org_purge_now`) moves the request back past the thirty days and runs the queued `org.purge` job now (queueing one if none waits — the deletion trigger's idempotency key means a company deleted, restored and deleted again had none). The erasure is the existing purge: every tenant row, the audit trail redacted, every stored object, status `deleted`. The organisations list merges "Active?" into "Manage" so the row fits. Tests: `platform-companies-modules` (integration: refused unscheduled, stale or by anyone else; the job run to `succeeded`, rows gone); `org-purge` still passes.

### ADR-169 · The product becomes APX, in the client's dark design
Status: **built locally on 2026-10-13 on the owner's instruction (the client's sign-in screenshot: "the login page should look like this; the schema of the whole app should look like this"; the logo and background "exactly like this, but fine-finished", generated in ChatGPT). Supersedes ADR-155's look and ADR-164.4's removal of the sign-in links. Not reviewed, merged or deployed.**

Decision:
1. **Name.** Every name a user can see is now **APX** ("Finance in motion"): page titles, headings, emails, errors, reports and PDFs (producer "APX"), CSV names (`apx-<kind>-<date>.csv`), the AI's system prompt, tools and messages ("didn't pass APX's checks"). Code, database, environment, cookie and container names keep `motion`. Three database messages are re-created with APX (migration `20261018000013`, each function exactly as it stood otherwise). `PROMPT_VERSION` → `analyst-v3.9`, `BRIEFING_PROMPT_VERSION` → `adviser-v4.1`, because the prompt text changed.
2. **Colour.** Dark only: near-black ground `#09090b`, cards `#141417`, white text; the accent is the reference's hot red `#ff2d55`, the second colour orange `#ff8a4c`; primary buttons and the current sidebar item carry the reference's pink-and-orange gradient (`--brand-gradient`, `.bg-brand-gradient`) with near-black text. All tokens in `globals.css`; components unchanged apart from the violet glow shadows, now red.
3. **Logo.** The client's logo, recreated at high resolution in ChatGPT from their artwork, cropped and cut out of its black ground (`public/brand/apx-logo.png`, `apx-letters.png`). The old petal logo and leaf artwork are removed; corner shapes are the reference's pink/orange blobs (SVG). Favicon: the X (`src/app/icon.svg`).
4. **Sign-in.** The reference's screen: the client's background recreated in ChatGPT (`public/brand/apx-background.webp`, full-bleed), the logo and form over its black left-centre, and "Analyse, Plan, Execute, Grow" set on its pools in an SVG that crops exactly as the image does. The form: "Welcome back", Email and Password with icons, show/hide password, **Keep me signed in**, **Forgot password?**, a gradient "Log in →" pill and **"Don't have an account? Sign up"** (owner chose both links, as the design). Sign-up and the password pages share the layout.
5. **Keep me signed in.** Unticked (the default, as the design), the sign-in sets a lasting `apx_session_only` marker and a browser-session `apx_alive` cookie; a later request with the marker but not the session cookie is from a new browser session, and the middleware signs it out (`core/routing/session-persistence.ts`). Ticked, the marker is cleared and the session lasts as before. A browser that restores its previous session also restores session cookies, so there it survives a restart.

Consequences: the recorded AI evaluation (`test/fixtures/ai/recorded-tools.json`) is stamped `analyst-v3.8`; its version check fails until it is re-recorded after a live run, which costs API money and waits for the owner. Public sign-up is reachable from sign-in again: an account made there has no company until the super admin adds it to one. Tests: `session-persistence` (unit); e2e and sample-data sign-in selectors now use "Email", "Password" and "Log in".
