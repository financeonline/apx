# MOTION — Implementation Plan

Depends on: every other document in `docs/`; especially `MVP_SCOPE.md`, `TEST_STRATEGY.md §15`, `ARCHITECTURAL_DECISIONS.md` (Part 1 for checkpoints)
Consumed by: the engineering team; the product owner (checkpoints in §7)

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026, ADR-031, ADR-032, ADR-033, ADR-038, ADR-039, CD-32 to CD-35. Findings addressed: F-D-17 (ordering, DESIGN.md timing, checkpoint consistency, verify-by lines), F-D-02 (spike S5), F-D-01/F-B-13 (stale-run loop), F-A-01 (api.* catalogue), F-A-12 (MFA), F-B-03/F-B-04/F-D-13 (import flows), F-C-01 (grounding v2). See `RED_TEAM_REVIEW.md`.

This plan orders the MVP build to minimise rework. It follows the brief's sequence — Foundation → Identity → Roles → Permissions → Tenancy → RLS → Data architecture → Import → Financial calculation engine → Dashboard → Health Score → Alerts → Evidence → AI Analyst → Actions → Reporting → QA → Security hardening — with the adjustments justified in §2 (evidence schema early; and, after the red-team review, `core/money`/`core/periods` and the Claude client earlier, DESIGN.md first, the summary sentence later — ADR-039). Sizes are relative (S ≈ a day, M ≈ 2–4 days, L ≈ 1–2 weeks, XL ≈ 2–4 weeks for one engineer); no dates.

Every slice is vertical (something you can load or run when it is done) and has a **Verify by** line naming an observable check, per the fable-5 plan rules. Phase exit gates are mechanical.

---

## 1. Team assumptions and working rules

- Two to three engineers: one owning data/engine/AI (backend-leaning), one owning app/UX, a third floating on imports and tests. One product owner available for the checkpoints in §7.
- Trunk-based development on `main` with short-lived branches; CI gates from `TEST_STRATEGY.md §1` block merge.
- `DESIGN.md` (fable-5 DESIGN phase) is produced in Phase 0/1 by the app engineer in parallel with identity work and locked before the first customer-facing page (sign-in) ships; no customer-facing component is styled before it exists (ADR-039).
- Supabase: one local instance per developer (`supabase start`), one shared `staging` project, one `production` project created in Phase 15.
- Migrations are written by hand in `supabase/migrations/` (no ORM); the permission mirror migration is generated (ADR-003).
- Each phase ends with a short written status in the fable-5 format (what I did / what I verified / what I did not verify).

---

## 2. The one sequence adjustment, and why

**Evidence schema moves forward into Data architecture (Phase 4); the calculation engine writes `evidence_query` descriptors from its first run (Phase 6).** The SOW places Evidence at Phase 9, after Dashboard, Health Score, Alerts and AI. If the `evidence_bundles`/`evidence_items` tables and the descriptor resolver did not exist until then, Dashboard "Why?" links, Health dimension explanations and Alert evidence would all need retrofitting, and every `metric_snapshots` row would have to be recomputed to gain an `evidence_query`. Building the schema and resolver early costs one M slice; retrofitting would cost rework across three phases. The **Evidence UI** (drawer, document viewer) still lands at its SOW position (Phase 10 here).

A second, smaller consequence of dependencies rather than a reordering: **Banking categorisation, transfer detection and recurring-payment detection land inside the Calculation Engine phase (Phase 6)**, because cash metrics, the Banking Health dimension and four alert families need them (`MVP_SCOPE.md §3`). Reconciliation stays post-MVP (CD-20).

**Red-team adjustments (ADR-039).** (a) `core/money` and `core/periods` move to Phase 4 slice 0 because the import validators, date transforms and `period_assign` need exact decimal parsing and period maths; building them in Phase 6 would have forced Phase 5 to hand-roll both. (b) `ai/data/claude-client.ts` and the tools-free `extractStatementPage` land in Phase 5 (mocked SDK) because the PDF path needs them; Phase 11 adds the analyst loop and grounding on top. (c) `DESIGN.md` moves to Phase 0/1. (d) The Home summary sentence moves to Phase 8 because it reads the health breakdown. (e) Phase 3 gains the `api.*` function catalogue and the no-write-grant migration (ADR-026) so every later phase writes through functions from the start. (f) Phase 6 gains `app.aggregate_periods`, `metric_current` and the stale-run loop (ADR-031), gated by spike S5.

---

## 3. Spikes (before Phase 1, timeboxed, scratch directory)

Riskiest first. Each spike ends with a `## Spike findings` note in this file's companion `PLAN.md` in the repo; spike code is deleted.

| # | Spike | Why it could sink the project | Proof required (timebox 0.5–1 day) |
|---|---|---|---|
| S1 | RLS + resolver parity | If `app.accessible_org_ids()` and `resolveAccess()` can disagree, isolation is unprovable | Local Supabase with two orgs, five roles, one assignment; a script running 40 scenarios through both and printing zero mismatches; pgTAP runs in CI |
| S2 | PDF text-layer parsing on three real bank statement layouts | CD-11 depends on deterministic parsing being viable for common layouts | A script that extracts date/description/amount/balance rows from three anonymised statements and reconciles to opening/closing balance; note which library (pdf.js text positions vs pdfplumber-style) worked |
| S3 | Claude tool loop with grounding check | ADR-010's numeric grounding must be implementable without false positives on formatted numbers | A script with two mocked tools and a real model call answering "why did profit fall"; grounding check passes on a good answer and fails on a planted fabricated number |
| S4 | XLSX parsing memory at 50k rows | Route handler memory/time limits on Vercel | Parse `bank-50k.xlsx` with streaming (SheetJS stream or `exceljs` streaming reader); record peak RSS and time; confirm the sync/queue threshold (CD-22) |
| S5 | 36-month, 100k-row calculation run in the real job runtime (F-D-02) | If neither Vercel routes nor Supabase Edge Functions can finish a full recalculation, every remap/engine bump dead-letters for the largest customers | `golden-mixed` scaled to 100k ledger rows; `app.aggregate_periods(org, from, to)` implemented as SQL and timed; the TypeScript engine consuming aggregates run inside the chosen worker (Edge Function background task first); record wall and CPU time against NFR-04 (< 5 min). If it fails, CD-34's container worker is adopted before Phase 6 starts |

If S2 fails on all three layouts, CD-11 is re-opened before Phase 5 (recommendation would become: Claude path with review is the *primary* PDF path, still gated). S5 runs after Phase 4 (it needs the schema) and before Phase 6.

---

## 4. Phases

### Phase 0 — Walking skeleton (S)
Goal: the app boots, one styled page renders, CI is green with every gate stage present.
Entry: repo created; Node 24.14, npm 11.13; Supabase CLI installed.
Slices:
1. `create-next-app` (Next.js 16.3.x, App Router, TypeScript strict, Tailwind v4), shadcn/ui init, ESLint with the four custom rules stubbed, Vitest, Playwright, pgTAP runner script. Verify by: `npm run typecheck && npm run lint && npm run test && npm run build` exit 0; `http://localhost:3000` shows a styled "MOTION" page.
2. `supabase init` + `supabase start`; empty first migration; `profiles` trigger from `auth.users`. Verify by: `supabase test db` runs one passing pgTAP test; a signup via the Supabase dashboard creates a `profiles` row.
3. CI workflow with all gates from `TEST_STRATEGY.md §1` (empty suites pass). Verify by: green check on a PR.
4. Folder skeleton `src/app`, `src/modules/*`, `src/core/*` with `index.ts` barrels and the `no-deep-module-import` lint rule live. Verify by: a deliberate deep import fails `npm run lint`.
5. `DESIGN.md` (fable-5 DESIGN phase): direction, font pair, palette tokens, chart palette; tokens loaded into Tailwind config; `/dev/components` renders the token sheet. Verify by: `test -f DESIGN.md && grep -cE '^\*\*(Direction|Fonts|Palette|Chart palette)' DESIGN.md` returns 4; Playwright screenshot of `/dev/components/tokens` at 1440 committed as the baseline for later visual diffs.
Exit gate: CI green; `README.md` documents local setup; `DESIGN.md` locked. Docs implemented: `ARCHITECTURE.md §3`, ADR-022, ADR-039.

### Phase 1 — Identity (M) — SOW Phase 1
Goal: users can sign up, sign in, reset passwords, accept invitations, and land somewhere sensible.
Entry: Phase 0.
Slices:
1. Public routes `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` with Supabase Auth (email+password, magic link). Verify by: Playwright signs up, signs out, signs in; reset email link works against local Inbucket.
2. `/account` (profile edit via `api.update_profile`, column-limited) and `/account/mfa` (TOTP enrolment). Verify by: name change persists after reload; a PATCH of `email` through the form is rejected with a field error; enrolling TOTP raises the session to `aal2` (`supabase.auth.mfa.getAuthenticatorAssuranceLevel()` returns `aal2`).
3. `/onboarding` (create organisation) and `/select-organization`; `profiles.last_active_org_id` redirect. Verify by: new user is sent to onboarding; user with one org lands on `/app/[slug]/home` (a placeholder page); user with two sees the picker.
4. Session middleware and route families (`ROUTE_ARCHITECTURE.md`). Verify by: unauthenticated `/app/x/home` redirects to sign-in preserving `next=`.
Exit gate: `TEST_STRATEGY.md §13` auth-flow rows green. Docs: `ROUTE_ARCHITECTURE.md` public + no-org sections.

### Phase 2 — Roles and permissions (M) — SOW Phase 1
Goal: the permission matrix exists in code and in the database, with parity proven.
Entry: Phase 1.
Slices:
1. `src/core/permissions/{catalogue,matrix,check}.ts`, `AccessContext` type, `can`/`assertCan`. Verify by: matrix unit test generated from `RBAC_MATRIX.md §2.1` passes.
2. Tables `platform_users`, `organizations`, `organization_memberships`, `organization_assignments`, `invitations` with triggers (last-owner, exclusivity) and audit-diff. Verify by: pgTAP trigger tests pass.
3. `scripts/sync-permission-matrix.ts` → `role_permissions` migration; `app.has_permission()`; `platform_org_settings` table. Verify by: pgTAP parity test passes; editing the matrix without re-running the script fails CI.
4. Membership services calling `api.invite_member`, `api.accept_invitation`, `api.change_member_role`, `api.remove_member`, `api.leave_organization`, `api.initiate_ownership_transfer`/`api.accept_ownership_transfer` (functions delivered in Phase 3 slice 0; stubbed here behind the same signatures); Settings → Team page. Verify by: journey 4 (invite admin) passes; ceiling and last-owner cases return the friendly errors.
5. Platform: `/platform/users` grant/revoke platform roles; `/platform/assignments` create; owner-side revoke in Settings → Team. Verify by: journey 7 core steps (assign, revoke) pass at service level.
Exit gate: `TEST_STRATEGY.md §2` all green. Docs: `RBAC_MATRIX.md`, ADR-002/003.

### Phase 3 — Tenancy, RLS and the write API (XL) — SOW Phase 1
Goal: every tenant table is isolated by RLS for reads, no table is writable by `authenticated`, every mutation is an `api.*` function with a per-role test, and adversarial access fails.
Entry: Phase 2; Spike S1 findings.
Slices:
0. No-write-grant migration (`REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM authenticated, anon` plus a default-privileges rule for future tables), the `api` schema exposed to PostgREST, the `app` schema hidden, and the first eight `api.*` functions from `DATABASE_ARCHITECTURE.md §14` (memberships, invitations, assignments, profile, organization update, `api.enqueue_job`, `app.audit` internal wrapper) each with `SET search_path = ''` and a pgTAP block per fixture role (ADR-026). Verify by: pgTAP `has_table_privilege('authenticated', t, 'INSERT|UPDATE|DELETE')` is false for every table; each function's role matrix test passes; a direct `PATCH /rest/v1/organization_memberships` with `ownerA`'s JWT returns 42501.
1. `app.is_super_admin()` (requires `aal2`), `app.accessible_org_ids()` and `app.org_role()` (both consult `organizations.status`; `suspended_member` mapping); RLS read policies on the Phase 2 tables. Verify by: pgTAP class tests for T-gov and Platform tables pass for all fixture roles including the suspended-org and suspended-membership fixtures.
2. `resolveAccess()` + `React.cache` per request; `app/[orgSlug]/layout.tsx` builds context; 404 for non-members. Verify by: isolation cases 1, 2, 8, 9, 10 pass.
3. Super-admin audited access banner and `org.data_viewed` audit row (including `/platform` tenant-content surfaces); `app.audit()` internal function with all actor fields derived; `audit_events` read policies; MFA middleware gate for platform users. Verify by: isolation cases 11 and 24 pass; `rpc('app.audit')` as `clientA` fails with "function does not exist"; Settings → Audit log lists the row for the owner; a super admin at `aal1` is redirected to `/account/mfa`.
4. Org switcher, employee `/portfolio` list as one aggregate projection (names only for now; scores join in Phase 8), suspended-org banner. Verify by: employee with two assignments sees two cards; unassigned sees empty state; the page issues one `portfolio.list` query (assert via query log count = 1 regardless of assignment count).
Exit gate: `TEST_STRATEGY.md §3` (including the `api.*` suite for the functions delivered so far) and §4 (cases 1, 2, 8–11, 15–18, 24) green. Docs: `TENANCY_MODEL.md`, `SECURITY_MODEL.md` isolation section, `DATABASE_ARCHITECTURE.md §14`, ADR-026, ADR-038.

### Phase 4 — Data architecture, including evidence schema (L) — SOW Phase 2 (+ part of 9)
Goal: every MVP table exists with constraints, indexes, RLS and the standard chart seeded per organisation; evidence tables and resolver exist; `core/money` and `core/periods` exist.
Entry: Phase 3.
Slices:
0. `core/money` (Decimal parsing at the boundary, `ROUND_HALF_UP`, formatting, direction) and `core/periods` (month maths, fiscal-year mapping, `clock.ts` injection, `is_complete` rule, org timezone). Verify by: rounding boundary tests (0.005) and format tests pass; `latestCompletePeriod()` returns the expected month for three fixture coverage patterns; lint `no-money-parsefloat` fails on a planted `parseFloat`.
1. `fiscal_periods` (with `is_complete`), `accounts` (+ seed of standard chart on org creation), `counterparties` (with `default_expense_category`), `account_category_history`. Verify by: creating an org seeds 26 system accounts; pgTAP RLS class tests pass; changing an account's category writes a history row.
2. `ledger_entries`, `period_balances` (with `period_start`, `balance_basis`), `invoices`, `bank_accounts`, `bank_transactions`, `recurring_payment_groups`, `category_history`, `record_status_events` with composite FKs, `same_org_ref` triggers and the `period_assign` trigger. Verify by: cross-org FK insert fails under service role; a polymorphic ref to org B raises `same_org_ref`; inserting an entry creates the missing fiscal period; a generated pgTAP test lists zero non-composite FK columns on tenant tables.
3. `source_documents`, `import_mappings`, `import_batches`, `import_rows` (SELECT gated on `imports.review`); Storage buckets `source-documents` and `reports` with **no** `authenticated` policies; `core/storage/signer.ts`. Verify by: client role lists zero documents and zero import rows; owner lists their own; a direct Storage list with any user JWT returns 0 objects; the signer throws for a key outside `ctx.orgId`.
4. `calculation_runs`, `metric_snapshots` (append-only), `metric_current`, `health_scores`, `alerts`, `alert_revisions`, `evidence_bundles`, `evidence_items`, `actions`, `ai_*`, `jobs` (with `cancelled`, `idempotency_key`), `report_files`, `platform_settings`, `platform_org_settings`, and the remaining `api.*` functions for these tables (`api.commit_import_batch`, `api.rollback_import_batch`, `api.replace_import_batch`, `api.supersede_record`, `api.decide_import_rows`, `api.set_alert_status`, `api.create_action`, `api.update_own_action`, `api_server.ai_persist_turn`, `api.submit_ai_feedback`, `api.request_deletion`, `api.cancel_deletion`, …). Verify by: full pgTAP suite green including the per-function role blocks; `evidence_item_xor` rejects a row with both/neither fields; `has_table_privilege` sweep still all-false.
5. `modules/evidence` descriptor resolver (`resolveDescriptor(ctx, descriptor, asOfRunId)`) with as-of semantics. Verify by: unit tests resolve a fixture descriptor to the expected ids twice identically.
6. `jobs` worker route + Vercel Cron config + `withOrgScope` (org from the row) + stale-lock recovery; `api.enqueue_job` type→permission map; deletion trigger enqueues `org.purge` with a 30-day delay; `api.cancel_deletion`. Verify by: enqueue a no-op job locally, worker drains it, `status='succeeded'`; a job whose payload carries another org id is scoped to its row's org (isolation case 19); `rpc('api.enqueue_job','org.purge')` as `ownerA` raises; a job `running` past budget × 3 is returned to `queued` with `attempts + 1` by the next worker tick; cancelling a deletion marks the purge job `cancelled`.
7. Spike S5 executed on this schema (see §3). Verify by: S5 findings recorded in `PLAN.md` with wall/CPU times under NFR-04, or CD-34 escalated.
Exit gate: pgTAP full suite green; `DATABASE_ARCHITECTURE.md` and the migration set match (a script diffs table/column lists and the `api.*` catalogue against `pg_proc`); S5 passed or CD-34 decided. Docs: `DATABASE_ARCHITECTURE.md`, `EVIDENCE_MODEL.md` schema, ADR-009, ADR-020, ADR-026, ADR-031, ADR-034.

### Phase 5 — Import engine (XL) — SOW Phase 3
Goal: CSV, XLSX and PDF files go through upload → review → commit with nothing discarded.
Entry: Phase 4; Spikes S2, S4; CD-01, CD-02, CD-03, CD-04, CD-11, CD-35 answered.
Slices:
0. `ai/data/claude-client.ts` (key, model ids, retries, timeouts, token accounting, prompt-version tag) and the tools-free `ai.extractStatementPage` with `untrusted()` wrapping and the page-output Zod schema, both against a mocked SDK. Verify by: unit tests with the mocked SDK pass; lint confirms the SDK is imported in one file; a page fixture containing instructions yields schema-valid rows only and the `notes` field never exceeds 200 chars.
1. Upload (dropzone, validation, virus/type/size, SHA-256, file-duplicate block linking to retryable batches) → `source_documents`; bank-account select/create with masked-identity uniqueness; statement opening-balance step. Verify by: rejected fuzz files show inline reasons; same file twice is blocked with a link; creating a second account with the same masked identity is refused; the typed opening balance appears on the batch.
2. CSV parser (encoding, delimiter, quoting) → `import_rows.raw_data`. Verify by: all CSV fixtures produce row counts equal to source lines.
3. XLSX parser (sheet select, merged cells, synonym-based header detection, preamble lines as `IMP-ROW-005`, total-row detection `IMP-ROW-004`, multi-period fan-out with per-row `period_start`, streaming for large). Verify by: XLSX fixtures pass including `pnl-12-months.xlsx` (12 periods, one batch) and `pnl-with-totals.xlsx` (totals excluded, `IMP-TOT-014` reconciles); 50k rows routed to queue and completes.
4. Column mapping step with header-signature suggestions and saved `import_mappings`; explicit date-format choice when ambiguous; trial-balance `balance_basis` confirmation (cumulative/movement); wizard steps derived per import type with saved-mapping skips and the zero-issue fast path. Verify by: re-importing a file with the same headers pre-fills the mapping and skips the sign/date questions; `dates-ambiguous.csv` cannot proceed without a choice; `tb-cumulative-q1.xlsx` requires the basis confirmation; a zero-issue batch renders the one-line review with Commit primary (Playwright).
5. Account mapping step (keyword suggestions → `standard_category`, unmapped → `uncategorised`). Verify by: GL fixture suggests ≥ 80% of accounts; unmapped accounts appear on the data quality list.
6. Row validation and issue codes (incl. `IMP-GL-011` opening-balance journals, `IMP-INV-010` invoice updates, `IMP-COV-014` re-export warning); duplicate detection with stable scope keys (exact, fuzzy, within-batch with the payroll default-keep rule, cross-batch); review table with plain-language issue groups, decisions and reasons. Verify by: `TEST_STRATEGY.md §5.2–5.3` rows pass; journeys 2 and 11 pass; `gl-jan-feb-renamed-account.csv` flags January rows as duplicates despite the rename.
7. `api.commit_import_batch` (org advisory lock, commit-time duplicate re-check, batch-scoped supersession by `balance_kind`, invoice supersession, `record_status_events`, `calculation_job_id` write-back; sync ≤ 5,000 rows, `import.commit_large` job above with the reviewer id in the payload), `api.rollback_import_batch` (dependency refusal, chain re-linking) and `api.replace_import_batch`; import history page with the coverage strip offering Replace; export and recalculate controls on `/data/imports`. Verify by: §5.4 rows pass; journeys 8 and 12 pass; two batches validated against an empty March collide at the second commit and return to review; a worker killed mid-commit leaves zero target rows and the batch in `awaiting_review` within 3 × budget.
8. PDF: text-layer extraction, deterministic table parser from S2 (every non-tabular line recorded), Claude extraction fallback behind `features.ai_pdf_extraction` with consent line, `document.sent_to_ai` audit, per-page completion and `deferred_upstream`, side-by-side page review, balance gate fed only by deterministic or typed balances, `IMP-PDF-002` line-count check, extraction page budget; scanned = store only. Verify by: journey 10 passes with mocked model; `statement-injected-balances.pdf` cannot pass the gate on the model's own balances; the 301st page in a day returns `QuotaExceeded`; a simulated provider outage puts the batch in `deferred_upstream` and it completes after the provider returns; scanned fixture ends `unreadable` with the friendly message.
Exit gate: `TEST_STRATEGY.md §15` Phase 5 rows green. Docs: `IMPORT_ENGINE.md`, ADR-011/012, ADR-027.1, ADR-029, ADR-033, ADR-035.

### Phase 6 — Financial calculation engine and banking intelligence (XL) — SOW Phase 4 (+ core of 13)
Goal: deterministic metrics for every period, with basis, assurance, data quality and evidence descriptors, from all supported sources.
Entry: Phase 5 committing golden datasets; Spike S5 passed (or CD-34 adopted); CD-05, CD-06, CD-07, CD-08, CD-09, CD-10, CD-28, CD-33 answered.
Slices:
1. `app.aggregate_periods(org, from, to)` SQL aggregation (per period × standard category × account × counterparty × bank account) and the TypeScript reference implementation used to cross-check it. Verify by: both produce identical sums on all golden organisations; the SQL version over the S5 dataset completes within the recorded budget.
2. Engine skeleton: `calculation_runs` with `as_of`, coverage tests (non-strict ledger coverage), source precedence per metric, append-only snapshot writer with the `metric_current` pointer rewrite per period range, `input_fingerprint` (including `as_of` for the current period), stale-run loop and worker-lost recovery. Verify by: running twice on `golden-service` yields identical fingerprints and values; two commits 1 s apart both appear in the final snapshots; a remap that empties a category leaves no `metric_current` pointer for it; a scheduled run with only `asOf` advanced updates `receivables_overdue`.
3. P&L metrics (revenue net of VAT per ADR-027.4, growth, gross profit/margin, operating expenses, operating profit, net profit/margin) with `components`, leaf `evidence_query` descriptors naming account ids, and derived descriptors naming component snapshot ids; cumulative-balance differencing with fiscal-year reset; opening-balance handling for ledger-basis balance-sheet metrics. Verify by: golden expected values match to the cent, including `golden-mixed` cumulative TBs; resolver returns rows that sum to each leaf value; the derived chain for `operating_profit` reaches both leaves.
4. Bank categorisation rules with `category_history`, user override, transfer pairing limited to cash-like pairs (card/loan repayments stay in cash outflows), recurring detection. Verify by: `bank-transfers.csv` pairs both legs; `bank-card-repayment.csv` keeps the £3,000 repayment in `cash_outflows`; `bank-recurring.csv` yields expected groups; recategorising a transaction writes a history row and the old run's descriptor still reconciles.
5. Cash metrics (inflows, outflows, net movement, opening/closing cash with CD-06 fallbacks). Verify by: `golden-retail` cash values match; missing opening balance yields NULL with reason, not 0.
6. Receivables, payables, aging, working capital, contribution, revenue and customer concentration, period-over-period variances (previous month, same month last year, trailing 3-month). Verify by: golden values match; property tests pass.
7. Breakdowns (by account, category, counterparty, bank account) as dimensioned snapshots. Verify by: top-5 expense movements for golden match expected.
8. Triggers for recalculation: commit, rollback, replace, account remap (5-minute coalesce behind "Apply changes"), opening-balance change; `fiscal_periods.is_complete` maintenance; "Updating your numbers" banner keyed to queued/running jobs. Verify by: §6.4 rows pass; fifteen remaps in five minutes produce one run; the banner disappears when the queue is empty even if a `calculation_runs` row was orphaned.
Exit gate: `TEST_STRATEGY.md §6` green; coverage ≥ 95% on `financial-engine/domain`. Docs: `FINANCIAL_ENGINE.md §1–6`, ADR-004/005/006/007/008, ADR-027, ADR-028, ADR-030, ADR-031, ADR-034.

### Phase 7 — Dashboard (L) — SOW Phase 5
Goal: Home and Money answer "how are we doing" from snapshots only.
Entry: Phase 6; `DESIGN.md` locked.
Slices:
1. Components with fixtures at `/dev/components`: `MetricCard` (single status badge from the canonical table), `TrendChart` (+ table fallback), `PeriodPicker` (monthly), `EmptyState`, `DataQualityBadge`, `PermissionGate`, the header Data menu. Verify by: a Playwright script visits every fixture state listed in `UX_ARCHITECTURE.md §6–7` at 375 and 1440, asserts no horizontal scroll and zero console errors, and commits screenshot baselines; a later visual diff > 0.1% fails CI.
2. Home levels 1–2 for the latest complete month (health card placeholder until Phase 8, CD-32 cards, basis line, "{Month} so far" line, bank-only variant). Verify by: every figure equals the `metric_current` snapshot for that month (integration assertion); `no-arithmetic-in-components` lint passes; with a partial April committed, Home opens on March and shows the April line; `golden-bank-only` renders the three-card variant.
3. Home levels 3–4 (trend, movements, AR/AP, data quality; risks/opportunities/actions widgets wired to empty data until later phases). Verify by: 12-month trend renders for golden; empty-state copy matches §6.
4. Money sub-pages: Profit & loss, Cash, Bank activity, Owed to you, You owe; Customers list and detail; `/data/accounts` mapping page. Verify by: journey 1 passes; responsive checks for these routes pass.
5. Insights: ranked movements with drivers (from dimensioned snapshots). Verify by: Insights lists the golden org's top movements in money order.
Exit gate: `TEST_STRATEGY.md §11` green for Home/Money/Insights/Customers; journey 1. Docs: `UX_ARCHITECTURE.md §3–5`, ADR-019.

### Phase 8 — Health score (M) — SOW Phase 6
Entry: Phase 7; CD-19 weights approved (this is the CD-19 checkpoint, see §7).
Slices:
1. `health/domain` rules (K3/B3 from conditions over snapshots), weights config, proxy cap 70, renormalisation, bands, complete-periods-only gate; summary-sentence templates (`summary-templates.ts`, moved here from Phase 7). Verify by: `TEST_STRATEGY.md §7` rule, determinism and reproduction tests pass; two runs on identical data with alerts dismissed in between give identical scores.
2. `health_scores` written by the engine run; `HealthScoreCard`; Home summary sentence; explainability panel per dimension; monthly history chart; portfolio cards join scores. Verify by: for golden March, the panel's rules sum to the displayed score; `golden-bank-only` shows a non-NULL score with the "based on bank data only" note.
Exit gate: §7 green. Docs: `FINANCIAL_ENGINE.md §7`, ADR-017.

### Phase 9 — Alerts (L) — SOW Phase 7
Entry: Phase 8; CD-18 defaults accepted.
Slices:
1. `alerts/domain` rule definitions (17 rules, state vs event keys), thresholds, severity, explanation templates with structured `threshold_summary` numbers, evidence bundle creation, `alert_revisions`. Verify by: fire/no-fire tests per rule pass; each alert has a non-empty bundle; six months of a persistent concentration produce one alert.
2. `alerts.evaluate` job after each run; dedupe, auto-resolve, suppression (`basis_differs`, incomplete periods, `duplicate_reviewed`, per-run cap 25), revision on re-evaluation with re-open on severity increase. Verify by: §8 tests pass.
3. Insights alerts list with filters and history; Home top risks; `AlertCard` with acknowledge/resolve/dismiss and undo. Verify by: client can acknowledge only; resolve animates and undo restores within 8 s.
Exit gate: §8 green (convert-to-action row deferred to Phase 12). Docs: `ARCHITECTURE.md` alert engine section, ADR-018.

### Phase 10 — Evidence UI (M) — SOW Phase 9
Entry: Phase 9 (schema exists since Phase 4).
Slices:
1. `EvidenceDrawer` levels statement → metric → calculation → records → document; "Why?" on every number; `/evidence/[bundleId]` page. Verify by: journey 3 evidence steps pass on golden; client sees locked document level.
2. Document viewer with page reference and 60-second signed URLs; download audit. Verify by: isolation cases 3–5 pass; audit row appears on download.
Exit gate: `TEST_STRATEGY.md §9` green. Docs: `EVIDENCE_MODEL.md` UI section.

### Phase 11 — AI Analyst (XL) — SOW Phase 8
Entry: Phase 10; Spike S3; CD-24, CD-25 confirmed.
Slices:
1. Analyst prompt assembly on the Phase 5 client: system prompt sections, `untrusted()` wrapping of every imported-text field, history replay rules, conversation binding to (org, user). Verify by: unit tests show every tool output string field passes through `untrusted()` (a lint rule enumerates tool output schemas); `findConversation` with another org's id throws `NotFound` before any model call.
2. Tool registry: the 15 tools (tool 13 accepts ids only), each with schema, `assertCan` plus `resolveAccess` re-run per call, org from context, branded numeric output types, `meta.periods`, output summary logging to `ai_tool_calls` via `api_server.ai_persist_turn`. Verify by: §10.1 role × tool matrix passes with mocked model; a demotion between two tool calls makes the second fail.
3. Tool loop with cap 8, period resolution (`period_context`, latest complete month), forced `submit_answer`, response contract v2 (every section a Statement, mandatory `NumberRef`, `entity_refs`), grounding v2 with path-value comparison, unit/sign/period/entity/direction checks, regenerate-then-degrade by removal. Verify by: §10.2 grounding v2 negatives all fail grounding; malformed-JSON cases pass; a text block before `submit_answer` is neither streamed nor stored.
4. `AnalystChat` UI: single validated answer event revealed section by section, badges from the canonical table, evidence bundle per answer, "Create action" only when grounding passed (wired in Phase 12), "Report this answer" → `ai_feedback`; quotas from `platform_org_settings`; unsupported-question template; "Facts we can show you" fallback; "Not covered" rendering for degraded answers. Verify by: journey 3 through the answer and evidence; quota case shows the friendly message; a degraded fixture shows removed statements under "Not covered" and no Create action buttons.
5. Eval harness with the 40-question set and injection corpus, recorded fixtures. Verify by: recorded run green; one live nightly run recorded in CI artifacts.
6. `/platform/ai-feedback` queue. Verify by: a flagged message appears with the organisation and can be marked reviewed.
Exit gate: `TEST_STRATEGY.md §10` green; §4 cases 6, 7, 20. Docs: `AI_ARCHITECTURE.md`, ADR-010/023, ADR-032.

### Phase 12 — Actions (M) — SOW Phase 10
Entry: Phase 11.
Slices:
1. `actions` services via `api.create_action`, `api.assign_action`, `api.set_action_status`, `api.update_own_action`; page with all SOW §17 fields; assign to member/employee; statuses; outcomes. Verify by: journey 9 passes; `api.update_own_action` as `clientA` raises on any column other than status/outcome.
2. Create from AI recommendation (refused when `grounding_status ≠ passed`), alert (pinning the revision), health dimension; Home outstanding-actions widget. Verify by: journey 3 completes; alert's `action_id` links; `createFromRecommendation` on a degraded message raises.
Exit gate: §8 convert row and journeys 3, 9 green. Docs: `SERVICE_ARCHITECTURE.md` actions section.

### Phase 13 — Reporting (M) — SOW Phase 17 (MVP subset, ADR-024)
Entry: Phase 12.
Slices:
1. `/reports` list and `/reports/monthly/[period]` on-screen report from current snapshots, alerts, actions and health score. Verify by: every figure equals its Home counterpart for the same period (snapshot test).
2. `report.render` job producing a PDF into bucket `reports` with a `report_files` row; download resolves by `(organization_id, id)` via signed URL; `report.downloaded` audit; purge removes the prefix. Verify by: PDF opens and matches the on-screen report; audit row written; isolation case 23 (other org's report id) returns 404.
Exit gate: Phase 13 row in `TEST_STRATEGY.md §15`. Docs: `ARCHITECTURE.md` reporting section.

### Phase 14 — QA (L) — SOW Phase 18 (part)
Entry: Phases 0–13.
Slices:
1. Full journey suite, responsive sweep on every route, axe pass, five-role visibility matrix. Verify by: `e2e:full` green on all viewports.
2. Golden dataset re-verification by a second engineer by hand for two months of each org. Verify by: signed-off spreadsheet stored under `test/fixtures/golden/VERIFIED.md`.
3. Empty/loading/error/success/denied state audit against `UX_ARCHITECTURE.md §6–7` on every page. Verify by: `test/e2e/states.spec.ts` enumerates every (page, state) pair from a fixture list, drives each one, asserts the expected copy is present, and stores a screenshot; the fixture list length equals the count of states in §6–7.
4. Performance: Home TTFB and LCP budgets on staging with 36 months of golden data. Verify by: Lighthouse ≥ 90 performance on Home at 1440 and 375.
Exit gate: `TEST_STRATEGY.md §15` Phase 14 row; quarantine list empty.

### Phase 15 — Security hardening and production readiness (M) — SOW Phase 18
Entry: Phase 14.
Slices:
1. `SECURITY_MODEL.md` checklist: headers, rate limits, upload fuzz, secrets scan, dependency audit, RLS coverage assertion, service-role grep. Verify by: `TEST_STRATEGY.md §13` all green.
2. Production Supabase project (region per CD-23), Vercel production env, secrets rotation procedure, backups and PITR verified, purge job dry-run on staging. Verify by: restore drill restores staging from a backup; purge of a test org leaves zero rows/objects and redacted audit rows.
3. External or independent security review of RLS, the `api.*` write surface, Storage, auth (incl. MFA), the job queue and AI tool boundaries; all critical/high findings closed (SOW §23). Verify by: `docs/security-review/findings.md` lists every finding with severity, the closing commit hash and the test id that now covers it; `grep -c 'Status: open' docs/security-review/findings.md` returns 0 for critical/high.
4. Runbooks: incident, key rotation, failed/stuck jobs (including "reset batch" and orphaned runs), AI and extraction outage, MFA recovery for platform users. Verify by: files exist and a second engineer executes the stuck-jobs runbook on staging against a deliberately killed `import.commit_large`, ending with the batch back in `awaiting_review`.
5. MFA rollout: every existing `platform_users` row enrolled; magic link disabled for platform users. Verify by: `select count(*) from platform_users p where not exists (select 1 from auth.mfa_factors f where f.user_id = p.user_id and f.status = 'verified')` returns 0 on production.
Exit gate: release checklist signed; MVP definition of done (§6) met.

---

## 5. Dependency graph

```
P0 skeleton (+ DESIGN.md)
 └─ P1 identity (+ MFA enrolment)
     └─ P2 roles/permissions
         └─ P3 tenancy/RLS + api.* write surface ── S1 spike
             └─ P4 data architecture (+ core/money, core/periods, evidence schema, jobs) ── S5 spike after
                 └─ P5 import engine (+ claude-client, extractStatementPage) ── S2, S4 spikes
                     └─ P6 calculation engine (+ banking, aggregate_periods, metric_current) 
                         ├─ P7 dashboard ─┐
                         │                ├─ P8 health ── P9 alerts ── P10 evidence UI ── P11 AI analyst ── S3 spike
                         │                │                                                   └─ P12 actions ── P13 reporting
                         └────────────────┘                                                                      └─ P14 QA ── P15 security/production
```

Post-MVP phases (SOW 11 Forecasting, 12 Scenarios, 13 Banking reconciliation, 14 Commercial, 15 Adviser platform, 16 Funding, 17 remaining reports) hang off P6 (engine), P11 (AI tools) and P3 (tenancy for adviser organisations) and do not block MVP release.

---

## 6. Milestones and definition of done

| Milestone | Phases here | SOW §21 phases | Size | Done when |
|---|---|---|---|---|
| M1 Foundation | P0–P3 | 1 | XL | Two isolated organisations, five roles, employee assignment, audited super-admin access, MFA for platform users, no table write grants and the `api.*` catalogue with per-role tests; `TEST_STRATEGY.md §2–4` green |
| M2 Data in | P4–P5 | 2, 3 | XL | Golden files import through review to commit on CSV, XLSX, PDF; nothing discarded |
| M3 Numbers right | P6–P7 | 4, 5 | XL | Home and Money show golden-verified metrics (including cumulative-TB and bank-only golden orgs) with basis and data quality, for the latest complete month; S5 budget met |
| M4 Intelligence | P8–P10 | 6, 7, 9 | L | Explainable health score, evidenced alerts, evidence drawer to document |
| M5 Analyst and action | P11–P13 | 8, 10, 17 (subset) | XL | Grounded AI answers with evidence become assigned actions; monthly report |
| M6 Release | P14–P15 | 18 | L | `MVP_SCOPE.md §5` acceptance table all observable checks pass; security review closed |
| Later | — | 11, 12, 13, 14, 15, 16, 17 | — | Each behind a feature flag (ADR-025), each with its own mini-plan |

**Definition of done for the MVP** = every row of `MVP_SCOPE.md §5` has been executed by someone other than the engineer who built it, with evidence (test run link or screenshot) attached; `TEST_STRATEGY.md §15` rows for phases 0–15 green; `SECURITY_MODEL.md` checklist signed; production deployed and the live URL passes journeys 1, 3 and 5 against a fresh organisation.

---

## 7. Product-owner checkpoints

> **Revision 1.2 (ADR-040).** Every decision below is already implemented on its adopted default. A checkpoint asks the product owner to *confirm or override* the default; nothing waits on an answer. Overrides are configuration or additive changes (ADR-040 table).

Decisions from `ARCHITECTURAL_DECISIONS.md` Part 1 consumed by each phase. Unanswered items proceed on the adopted default, with the assumption written into `PLAN.md` in the repo.

| Before | Decisions required | If unanswered |
|---|---|---|
| Phase 2 | CD-14 (owner cardinality/transfer), CD-15 (client capabilities), CD-16 (employee capabilities — adviser vs read-only support), CD-17 (documents/export rights) | Build the recommendations; CD-16 is the costliest to reverse (matrix + RLS + UI), so escalate it |
| Phase 3 | CD-13 (super admin access model) | Full access + audit (MVP recommendation) |
| Phase 4 | CD-09 (periods), CD-10 (currency), CD-22 (hosting/jobs), CD-23 (region/retention), **CD-34 (worker runtime fallback pre-approval)** | Recommendations; region must be confirmed before Phase 15 at the latest; without CD-34 pre-approval an S5 failure blocks Phase 6 |
| Phase 5 | CD-01 (authoritative SOW), CD-02 (adviser identity), CD-03 (accounting basis/precedence), CD-04 (account mapping), CD-11 (PDF path), CD-12 (duplicate definition), CD-30 (test data), **CD-35 (AI PDF extraction flag default)** | CD-03 and CD-11 are blocking: do not start slices 5–8 without them; CD-35 defaults to off |
| Phase 6 | CD-05 (profit definitions), CD-06 (opening cash), CD-07 (AR/AP source), CD-08 (contribution), CD-20 (reconciliation scope), CD-28 (transfers/refunds), CD-31 (contribution margin), **CD-33 (VAT treatment)** | Recommendations |
| Phase 7 | **CD-32 (Home profit cards)** | Six-card Level 2 per ADR-037 |
| Phase 8 | CD-19 (health weights and rules) — **this is the only CD-19 checkpoint; `FINANCIAL_ENGINE.md §7` and `ARCHITECTURAL_DECISIONS.md` CD-19 say "before Phase 8" to match** | Do not ship the score without sign-off; show "coming soon" card instead |
| Phase 9 | CD-18 (thresholds) | Platform defaults |
| Phase 11 | CD-24 (AI quotas), CD-25 (incorrect-insight workflow), CD-21 (no live feeds claim) | Recommendations |
| Phase 13 | ADR-024 (single report in MVP) | Recommendation |
| Phase 15 | CD-23 (DPA, jurisdiction), CD-26/27/29 (post-MVP confirmations for change control) | Release blocked on CD-23 only |

Checkpoint format: a 30-minute review at each phase entry, the CD items above on screen, decisions recorded as edits to `ARCHITECTURAL_DECISIONS.md` Part 1 with the date and the name of the decider.


---

## 9. Revision 1.2 notes (readiness)

- **ADR-040** — every open product decision (CD-01, 02, 03, 04, 11, 16, 19, 32–35) is now an adopted default with an override switch; no phase waits on an answer. The §7 checkpoints are read as "confirm or override the default".
- **ADR-041** — `calculation.run` is chunked (`CHUNK_PERIODS` = 12, chained with a cursor, progress on the run row, alerts after the last chunk). Phase 6 slices implement the chunk loop; the Home banner shows progress.
- **ADR-042** — spikes S1–S5 run in Phase 0 as verifications with settings-only fallbacks. S5 pass criterion: one 12-period chunk of `golden-mixed` (36 months, 100k ledger rows) completes in ≤ 1,500 CPU-ms and under 60 s wall-clock inside a Supabase Edge Function background task, measured three times (ADR-047.7); fallback = `CHUNK_PERIODS` 6.
- **ADR-043 to ADR-047 (round 2)** — Phase 3 adds the `api_server` schema, `motion_definer` ownership, throttles, column privileges, `ownership_transfers`, `append_only_guard` and the employee `aal2` gate; Phase 5 adds `balanceSign`, declared export ranges, credit-note negation, open-items confirmation, dependant promotion on rollback; Phase 6 adds the single-key chunk chain with `restart_from`, narrow scheduled runs, `aggregated_at` per chunk, state-alert re-open and two-pass capping; Phase 11 implements grounding v3 with the claim-grammar corpus test before the eval set. Spike S3 runs the grammar corpus; S5's pass criterion is ≤ 1,500 CPU-ms per chunk.
