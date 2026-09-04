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
Decision: **Platform roles** (`platform_super_admin`, `platform_employee`) live in `platform_users`. **Tenant roles** (`tenant_owner`, `tenant_admin`, `tenant_client`) live in `organization_memberships`. Employee → organization access lives in `organization_assignments`. One SQL function `app.accessible_org_ids()` and one TypeScript `resolveAccess(userId, orgId)` compute the effective role for a user in an organization. Effective roles are exactly one of: `super_admin`, `employee`, `owner`, `admin`, `client`, `none`.
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
Decision: One repository, one Next.js app, three layers with downward-only dependencies: `src/app` (routes, UI) → `src/modules/*` (one per service boundary: `auth`, `tenancy`, `documents`, `imports`, `banking`, `financial-engine`, `health`, `alerts`, `evidence`, `ai`, `actions`, `reporting`, `audit`) → `src/core/*` (`permissions`, `money`, `periods`, `db`, `errors`, `logging`). Every module has the same anatomy: `domain/` (pure functions, no I/O), `schemas/` (Zod), `data/` (repositories, the only place that touches Supabase), `services/` (use cases; take `AccessContext` first), `index.ts` (the only import surface; deep imports are ESLint errors). `financial-engine/domain` and `core/permissions` have no Next.js or Supabase imports so they unit-test in isolation. Not a Turborepo; nothing justifies it yet. (Layering and anatomy carried forward from the baseline.)

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
