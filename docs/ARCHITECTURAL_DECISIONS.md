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
Context (F-B-03, F-B-04, F-B-11, F-B-12, F-D-13, F-B-17 and the chain-rollback note): the v1.0 rules lost data on the two most common workflows (monthly invoice re-export, corrected statement re-import), superseded balances account-by-account, keyed dedupe on uuids that change with renames, and checked duplicates only at validation time.
Decision:
1. **Invoices.** A hit on `(invoice_type, counterparty_id, invoice_number)` is an *update candidate*: if any of `total_amount, amount_paid, paid_date, due_date, status` differ → issue `IMP-INV-010 updated` (warning, default keep) and commit supersedes the prior row; only fully identical rows are `IMP-DUP-001`. Receivables at a historical `asOf` use the row current at that date.
2. **Period balances.** Committing balance kind K for period P supersedes every accepted row of kind K for P from other batches (the partial unique index becomes `(organization_id, period_id, account_id, balance_kind)`); `IMP-COV-013` becomes an explicit confirmation naming the accounts that will be retired. Rollback restores the whole superseded batch and re-links any chain (A→B→C: rolling back B re-points C to A).
3. **Rollback dependencies.** `api.rollback_import_batch` finds committed batches whose rows were skipped as duplicates of the rows being rejected and refuses with "Batch X depends on N rows of this batch" unless called through the *replace* flow, which rolls back the old batch and commits the new one in one transaction (the new batch's duplicate pass is re-run after the rollback). The coverage strip offers "Replace" not "Roll back".
4. **Dedupe scope.** Ledger scope = `accounts.code` when present else the mapped account's `normalized_name`; bank scope = `(bank_name, sort_code_masked, account_number_masked)`; inline creation of a bank account whose masked identity already exists is refused and the existing account offered. Batch check `IMP-COV-014`: a GL/bank batch overlapping a committed batch by ≥ 1 full month with < 50% of overlapping rows matched as duplicates → warning "looks like a re-export with renamed accounts", requiring replace or explicit confirmation.
5. **Commit-time re-check.** `api.commit_import_batch` takes an org advisory lock and re-runs the cross-batch exact pass; any new collision returns the batch to `awaiting_review` with the rows re-flagged.
6. **Legitimate repeats.** Within-batch exact duplicates default to `keep` when ≥ 3 identical rows share a day or the description matches `/payroll|salary|wages/`; bulk "keep all exact with reason" exists; records committed from `reviewer_decision = keep` carry `duplicate_reviewed = true`, which `duplicate.transaction` excludes; the dismissed-alert cooldown applies to duplicate alerts of any severity.

### ADR-030 · Period completeness governs defaults, alerts, health and variance
Context (F-B-07, F-B-08, F-D-09, F-D-18): Home defaulted to a partial current month, the analyst to the latest complete month; the ledger coverage test never covered the last month, so month-end figures fell to the bank proxy and fired false decline alerts.
Decision:
1. `fiscal_periods.is_complete boolean` maintained by the engine: true when `period_end ≤ latest data date` for the chosen P&L source and cash coverage is full. Home, Insights, Reports and the AI default to the latest complete period; Home shows a slim "{Month} so far" line for a partial current month. The rule lives in `core/periods` and is cited by both.
2. Ledger coverage: `P.period_end ≤ batch.period_end` (non-strict) or an entry dated in the last 3 days of P. `import_batches.period_start/period_end` are set to min/max `entry_date`/`issue_date` for GL and invoice batches at commit.
3. `basis_differs` on a variance suppresses every variance-based alert rule and is treated as NULL by health rules; MetricCard renders "compared on a different basis" without a percentage.
4. Alerts on incomplete periods are limited to record-level rules (`duplicate.*`, `bank.unusual_transaction`, `recurring.*`); no health score is computed for incomplete periods; `partial_month` scales completeness by days covered.
5. `period_to = min(latest period with accepted P&L or bank records, current month in the organization's timezone)`; future-dated invoices contribute to AR/AP only. `organizations.timezone` added; all "today" derivations go through `core/periods/clock.ts`.
6. MVP period picker is **monthly only** (F-B-15); quarter/year views are post-MVP and require an `aggregation ∈ {sum, last, recompute}` attribute per registry key, materialised as snapshots with `period_kind`, never computed in the UI.

### ADR-031 · Calculation runs: coalescing, scope, fingerprint, runtime, storage
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
