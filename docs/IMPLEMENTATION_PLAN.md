# MOTION — Implementation Plan

Depends on: every other document in `docs/`; especially `MVP_SCOPE.md`, `TEST_STRATEGY.md §15`, `ARCHITECTURAL_DECISIONS.md` (Part 1 for checkpoints)
Consumed by: the engineering team; the product owner (checkpoints in §7)

This plan orders the MVP build to minimise rework. It follows the brief's sequence — Foundation → Identity → Roles → Permissions → Tenancy → RLS → Data architecture → Import → Financial calculation engine → Dashboard → Health Score → Alerts → Evidence → AI Analyst → Actions → Reporting → QA → Security hardening — with one adjustment, justified in §2. Sizes are relative (S ≈ a day, M ≈ 2–4 days, L ≈ 1–2 weeks, XL ≈ 2–4 weeks for one engineer); no dates.

Every slice is vertical (something you can load or run when it is done) and has a **Verify by** line naming an observable check, per the fable-5 plan rules. Phase exit gates are mechanical.

---

## 1. Team assumptions and working rules

- Two to three engineers: one owning data/engine/AI (backend-leaning), one owning app/UX, a third floating on imports and tests. One product owner available for the checkpoints in §7.
- Trunk-based development on `main` with short-lived branches; CI gates from `TEST_STRATEGY.md §1` block merge.
- `DESIGN.md` (fable-5 DESIGN phase) is produced during Phase 4 and locked before Phase 7 (Dashboard); no customer-facing component is styled before it exists.
- Supabase: one local instance per developer (`supabase start`), one shared `staging` project, one `production` project created in Phase 15.
- Migrations are written by hand in `supabase/migrations/` (no ORM); the permission mirror migration is generated (ADR-003).
- Each phase ends with a short written status in the fable-5 format (what I did / what I verified / what I did not verify).

---

## 2. The one sequence adjustment, and why

**Evidence schema moves forward into Data architecture (Phase 4); the calculation engine writes `evidence_query` descriptors from its first run (Phase 6).** The SOW places Evidence at Phase 9, after Dashboard, Health Score, Alerts and AI. If the `evidence_bundles`/`evidence_items` tables and the descriptor resolver did not exist until then, Dashboard "Why?" links, Health dimension explanations and Alert evidence would all need retrofitting, and every `metric_snapshots` row would have to be recomputed to gain an `evidence_query`. Building the schema and resolver early costs one M slice; retrofitting would cost rework across three phases. The **Evidence UI** (drawer, document viewer) still lands at its SOW position (Phase 10 here).

A second, smaller consequence of dependencies rather than a reordering: **Banking categorisation, transfer detection and recurring-payment detection land inside the Calculation Engine phase (Phase 6)**, because cash metrics, the Banking Health dimension and four alert families need them (`MVP_SCOPE.md §3`). Reconciliation stays post-MVP (CD-20).

---

## 3. Spikes (before Phase 1, timeboxed, scratch directory)

Riskiest first. Each spike ends with a `## Spike findings` note in this file's companion `PLAN.md` in the repo; spike code is deleted.

| # | Spike | Why it could sink the project | Proof required (timebox 0.5–1 day) |
|---|---|---|---|
| S1 | RLS + resolver parity | If `app.accessible_org_ids()` and `resolveAccess()` can disagree, isolation is unprovable | Local Supabase with two orgs, five roles, one assignment; a script running 40 scenarios through both and printing zero mismatches; pgTAP runs in CI |
| S2 | PDF text-layer parsing on three real bank statement layouts | CD-11 depends on deterministic parsing being viable for common layouts | A script that extracts date/description/amount/balance rows from three anonymised statements and reconciles to opening/closing balance; note which library (pdf.js text positions vs pdfplumber-style) worked |
| S3 | Claude tool loop with grounding check | ADR-010's numeric grounding must be implementable without false positives on formatted numbers | A script with two mocked tools and a real model call answering "why did profit fall"; grounding check passes on a good answer and fails on a planted fabricated number |
| S4 | XLSX parsing memory at 50k rows | Route handler memory/time limits on Vercel | Parse `bank-50k.xlsx` with streaming (SheetJS stream or `exceljs` streaming reader); record peak RSS and time; confirm the sync/queue threshold (CD-22) |

If S2 fails on all three layouts, CD-11 is re-opened before Phase 5 (recommendation would become: Claude path with review is the *primary* PDF path, still gated).

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
Exit gate: CI green; `README.md` documents local setup. Docs implemented: `ARCHITECTURE.md §3`, ADR-022.

### Phase 1 — Identity (M) — SOW Phase 1
Goal: users can sign up, sign in, reset passwords, accept invitations, and land somewhere sensible.
Entry: Phase 0.
Slices:
1. Public routes `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` with Supabase Auth (email+password, magic link). Verify by: Playwright signs up, signs out, signs in; reset email link works against local Inbucket.
2. `/account` (profile edit, timezone). Verify by: name change persists after reload.
3. `/onboarding` (create organisation) and `/select-organization`; `profiles.last_active_org_id` redirect. Verify by: new user is sent to onboarding; user with one org lands on `/app/[slug]/home` (a placeholder page); user with two sees the picker.
4. Session middleware and route families (`ROUTE_ARCHITECTURE.md`). Verify by: unauthenticated `/app/x/home` redirects to sign-in preserving `next=`.
Exit gate: `TEST_STRATEGY.md §13` auth-flow rows green. Docs: `ROUTE_ARCHITECTURE.md` public + no-org sections.

### Phase 2 — Roles and permissions (M) — SOW Phase 1
Goal: the permission matrix exists in code and in the database, with parity proven.
Entry: Phase 1.
Slices:
1. `src/core/permissions/{catalogue,matrix,check}.ts`, `AccessContext` type, `can`/`assertCan`. Verify by: matrix unit test generated from `RBAC_MATRIX.md §2.1` passes.
2. Tables `platform_users`, `organizations`, `organization_memberships`, `organization_assignments`, `invitations` with triggers (last-owner, exclusivity) and audit-diff. Verify by: pgTAP trigger tests pass.
3. `scripts/sync-permission-matrix.ts` → `role_permissions` migration; `app.has_permission()`. Verify by: pgTAP parity test passes; editing the matrix without re-running the script fails CI.
4. Membership services: invite, accept, change role, remove, leave, transfer ownership; Settings → Team page. Verify by: journey 4 (invite admin) passes; ceiling and last-owner cases return the friendly errors.
5. Platform: `/platform/users` grant/revoke platform roles; `/platform/assignments` create; owner-side revoke in Settings → Team. Verify by: journey 7 core steps (assign, revoke) pass at service level.
Exit gate: `TEST_STRATEGY.md §2` all green. Docs: `RBAC_MATRIX.md`, ADR-002/003.

### Phase 3 — Tenancy and RLS (M) — SOW Phase 1
Goal: every tenant table is isolated by RLS and the resolver, and adversarial access fails.
Entry: Phase 2; Spike S1 findings.
Slices:
1. `app.is_super_admin()`, `app.accessible_org_ids()`, `app.org_role()`; RLS on the Phase 2 tables. Verify by: pgTAP class tests for T-gov and Platform tables pass for all fixture roles.
2. `resolveAccess()` + `React.cache` per request; `app/[orgSlug]/layout.tsx` builds context; 404 for non-members. Verify by: isolation cases 1, 2, 8, 9, 10 pass.
3. Super-admin audited access banner and `org.data_viewed` audit row; `app.audit()` function; `audit_events` policies. Verify by: isolation case 11 passes; Settings → Audit log lists the row for the owner.
4. Org switcher, employee `/portfolio` list (names only for now), suspended-org banner. Verify by: employee with two assignments sees two cards; unassigned sees empty state.
Exit gate: `TEST_STRATEGY.md §3` and §4 (cases 1, 2, 8–11, 15) green. Docs: `TENANCY_MODEL.md`, `SECURITY_MODEL.md` isolation section.

### Phase 4 — Data architecture, including evidence schema (L) — SOW Phase 2 (+ part of 9)
Goal: every MVP table exists with constraints, indexes, RLS and the standard chart seeded per organisation; evidence tables and resolver exist.
Entry: Phase 3.
Slices:
1. `fiscal_periods`, `accounts` (+ seed of standard chart on org creation), `counterparties`. Verify by: creating an org seeds 26 system accounts; pgTAP RLS class tests pass.
2. `ledger_entries`, `period_balances`, `invoices`, `bank_accounts`, `bank_transactions`, `recurring_payment_groups` with composite FKs and `period_assign` trigger. Verify by: cross-org FK insert fails under service role; inserting an entry creates the missing fiscal period.
3. `source_documents`, `import_mappings`, `import_batches`, `import_rows`; Storage bucket and policies. Verify by: client role lists zero documents; owner lists their own; storage policy test passes.
4. `calculation_runs`, `metric_snapshots`, `health_scores`, `alerts`, `evidence_bundles`, `evidence_items`, `actions`, `ai_*`, `jobs`, `platform_settings`. Verify by: full pgTAP suite green; `evidence_item_xor` rejects a row with both/neither fields.
5. `modules/evidence` descriptor resolver (`resolveDescriptor(ctx, descriptor, asOfRunId)`) with as-of semantics. Verify by: unit tests resolve a fixture descriptor to the expected ids twice identically.
6. `jobs` worker route + Vercel Cron config + `withOrgScope`. Verify by: enqueue a no-op job locally, worker drains it, `status='succeeded'`; a job with mismatched org fails (isolation case 14).
7. `DESIGN.md` produced (fable-5 DESIGN phase) in parallel by the app engineer. Verify by: file names direction, font pair, palette tokens, chart palette; tokens loaded into Tailwind config and `/dev/components` shows them.
Exit gate: pgTAP full suite green; `DATABASE_ARCHITECTURE.md` and the migration set match (a script diffs table/column lists). Docs: `DATABASE_ARCHITECTURE.md`, `EVIDENCE_MODEL.md` schema, ADR-009, ADR-020.

### Phase 5 — Import engine (XL) — SOW Phase 3
Goal: CSV, XLSX and PDF files go through upload → review → commit with nothing discarded.
Entry: Phase 4; Spikes S2, S4; CD-01, CD-02, CD-03, CD-04, CD-11 answered.
Slices:
1. Upload (dropzone, validation, virus/type/size, SHA-256, file-duplicate block) → `source_documents`. Verify by: rejected fuzz files show inline reasons; same file twice is blocked with a link.
2. CSV parser (encoding, delimiter, quoting) → `import_rows.raw_data`. Verify by: all CSV fixtures produce row counts equal to source lines.
3. XLSX parser (sheet select, merged cells, total-row detection, streaming for large). Verify by: XLSX fixtures pass; 50k rows routed to queue and completes.
4. Column mapping step with header-signature suggestions and saved `import_mappings`; explicit date-format choice when ambiguous. Verify by: re-importing a file with the same headers pre-fills the mapping; `dates-ambiguous.csv` cannot proceed without a choice.
5. Account mapping step (keyword suggestions → `standard_category`, unmapped → `uncategorised`). Verify by: GL fixture suggests ≥ 80% of accounts; unmapped accounts appear on the data quality list.
6. Row validation and issue codes; duplicate detection (exact, fuzzy, within-batch, cross-batch); review table with decisions and reasons. Verify by: `TEST_STRATEGY.md §5.2–5.3` rows pass; journey 2 passes.
7. Transactional commit (sync ≤ 5,000 rows, queued above) → target tables, enqueue `calculation.run`; import history page; rollback. Verify by: §5.4 rows pass; journey 8 passes.
8. PDF: text-layer extraction, deterministic table parser from S2, Claude extraction fallback with side-by-side page review, balance reconciliation gate, scanned = store only. Verify by: journey 10 passes with mocked model; scanned fixture ends `unreadable` with the friendly message.
9. Bank statement specifics: `bank_accounts` create/select in the wizard, statement opening/closing balances captured. Verify by: statement import sets `import_batches.statement_*_balance`.
Exit gate: `TEST_STRATEGY.md §15` Phase 5 rows green. Docs: `IMPORT_ENGINE.md`, ADR-011/012.

### Phase 6 — Financial calculation engine and banking intelligence (XL) — SOW Phase 4 (+ core of 13)
Goal: deterministic metrics for every period, with basis, assurance, data quality and evidence descriptors, from all supported sources.
Entry: Phase 5 committing golden datasets; CD-05, CD-06, CD-07, CD-08, CD-09, CD-10, CD-28 answered.
Slices:
1. `core/money` (Decimal, rounding, formatting, direction) and `core/periods`. Verify by: rounding boundary tests and format tests pass.
2. Engine skeleton: `calculation_runs`, source precedence per metric, snapshot writer with `is_current` flip and `input_fingerprint`. Verify by: running twice on `golden-service` yields identical fingerprints and values.
3. P&L metrics (revenue, growth, gross profit/margin, operating expenses, operating profit, net profit/margin) with `components` and `evidence_query`. Verify by: golden expected values match to the cent; resolver returns rows that sum to each value.
4. Bank categorisation rules, user override, transfer pairing, recurring detection. Verify by: `bank-transfers.csv` pairs both legs; `bank-recurring.csv` yields expected groups.
5. Cash metrics (inflows, outflows, net movement, opening/closing cash with CD-06 fallbacks). Verify by: `golden-retail` cash values match; missing opening balance yields NULL with reason, not 0.
6. Receivables, payables, aging, working capital, contribution, revenue and customer concentration, period-over-period variances (previous month, same month last year, trailing 3-month). Verify by: golden values match; property tests pass.
7. Breakdowns (by account, category, counterparty, bank account) as dimensioned snapshots. Verify by: top-5 expense movements for golden match expected.
8. Triggers for recalculation: commit, rollback, account remap, opening-balance change; "Updating your numbers" banner. Verify by: §6.4 rows pass.
Exit gate: `TEST_STRATEGY.md §6` green; coverage ≥ 95% on `financial-engine/domain`. Docs: `FINANCIAL_ENGINE.md §1–6`, ADR-004/005/006/007/008.

### Phase 7 — Dashboard (L) — SOW Phase 5
Goal: Home and Money answer "how are we doing" from snapshots only.
Entry: Phase 6; `DESIGN.md` locked.
Slices:
1. Components with fixtures at `/dev/components`: `MetricCard`, `TrendChart` (+ table fallback), `PeriodPicker`, `EmptyState`, `DataQualityBadge`, `PermissionGate`. Verify by: every state in `UX_ARCHITECTURE.md §6–7` renders in the fixture page at 375 and 1440.
2. Home levels 1–2 (health card placeholder until Phase 8, summary sentence, four numbers, basis line). Verify by: figures equal `metric_snapshots` rows; `no-arithmetic-in-components` lint passes.
3. Home levels 3–4 (trend, movements, AR/AP, data quality; risks/opportunities/actions widgets wired to empty data until later phases). Verify by: 12-month trend renders for golden; empty-state copy matches §6.
4. Money sub-pages: Profit & loss, Cash, Bank activity, Owed to you, You owe; Customers list and detail; `/data/accounts` mapping page. Verify by: journey 1 passes; responsive checks for these routes pass.
5. Insights: ranked movements with drivers (from dimensioned snapshots). Verify by: Insights lists the golden org's top movements in money order.
Exit gate: `TEST_STRATEGY.md §11` green for Home/Money/Insights/Customers; journey 1. Docs: `UX_ARCHITECTURE.md §3–5`, ADR-019.

### Phase 8 — Health score (M) — SOW Phase 6
Entry: Phase 7; CD-19 weights approved.
Slices:
1. `health/domain` rules, weights config, renormalisation, bands; summary templates. Verify by: `TEST_STRATEGY.md §7` rule and reproduction tests pass.
2. `health_scores` written by the engine run; `HealthScoreCard`; explainability panel per dimension; monthly history chart. Verify by: for golden March, the panel's rules sum to the displayed score.
Exit gate: §7 green. Docs: `FINANCIAL_ENGINE.md §7`, ADR-017.

### Phase 9 — Alerts (L) — SOW Phase 7
Entry: Phase 8; CD-18 defaults accepted.
Slices:
1. `alerts/domain` rule definitions (12 families), thresholds, severity, explanation templates, evidence bundle creation. Verify by: fire/no-fire tests per rule pass; each alert has a non-empty bundle.
2. `alerts.evaluate` job after each run; dedupe, auto-resolve, suppression. Verify by: §8 dedupe/auto-resolve/suppression tests pass.
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
1. `ai/claude-client.ts` abstraction (key, model, retries, token accounting, prompt versions). Verify by: unit tests with a mocked SDK; no other module imports the SDK (lint).
2. Tool registry: the 15 tools, each with schema, `assertCan`, org from context, output summary logging to `ai_tool_calls`. Verify by: §10.1 role × tool matrix passes with mocked model.
3. Tool loop with cap 8, period resolution (`period_context`), response contract validation, numeric grounding check with regenerate-then-degrade. Verify by: §10.2 grounding and malformed-JSON cases pass.
4. `AnalystChat` UI: streaming sections, statement-kind badges, evidence bundle per answer, "Create action" (wired in Phase 12), "Report this answer" → `ai_feedback`; quotas and rate limits; unsupported-question template; "Facts we can show you" fallback. Verify by: journey 3 through the answer and evidence; quota case shows the friendly message.
5. Eval harness with the 40-question set and injection corpus, recorded fixtures. Verify by: recorded run green; one live nightly run recorded in CI artifacts.
6. `/platform/ai-feedback` queue. Verify by: a flagged message appears with the organisation and can be marked reviewed.
Exit gate: `TEST_STRATEGY.md §10` green; §4 cases 6–7. Docs: `AI_ARCHITECTURE.md`, ADR-010/023.

### Phase 12 — Actions (M) — SOW Phase 10
Entry: Phase 11.
Slices:
1. `actions` services and page with all SOW §17 fields; assign to member/employee; statuses; outcomes; client own-update path. Verify by: journey 9 passes; `app.action_update_own` restricts columns.
2. Create from AI recommendation, alert, health dimension; Home outstanding-actions widget. Verify by: journey 3 completes; alert's `action_id` links.
Exit gate: §8 convert row and journeys 3, 9 green. Docs: `SERVICE_ARCHITECTURE.md` actions section.

### Phase 13 — Reporting (M) — SOW Phase 17 (MVP subset, ADR-024)
Entry: Phase 12.
Slices:
1. `/reports` list and `/reports/monthly/[period]` on-screen report from current snapshots, alerts, actions and health score. Verify by: every figure equals its Home counterpart for the same period (snapshot test).
2. `report.render` job producing a PDF to Storage; download via signed URL; audit. Verify by: PDF opens and matches the on-screen report; audit row written.
Exit gate: Phase 13 row in `TEST_STRATEGY.md §15`. Docs: `ARCHITECTURE.md` reporting section.

### Phase 14 — QA (L) — SOW Phase 18 (part)
Entry: Phases 0–13.
Slices:
1. Full journey suite, responsive sweep on every route, axe pass, five-role visibility matrix. Verify by: `e2e:full` green on all viewports.
2. Golden dataset re-verification by a second engineer by hand for two months of each org. Verify by: signed-off spreadsheet stored under `test/fixtures/golden/VERIFIED.md`.
3. Empty/loading/error/success/denied state audit against `UX_ARCHITECTURE.md §6–7` on every page. Verify by: checklist file with a screenshot per state.
4. Performance: Home TTFB and LCP budgets on staging with 36 months of golden data. Verify by: Lighthouse ≥ 90 performance on Home at 1440 and 375.
Exit gate: `TEST_STRATEGY.md §15` Phase 14 row; quarantine list empty.

### Phase 15 — Security hardening and production readiness (M) — SOW Phase 18
Entry: Phase 14.
Slices:
1. `SECURITY_MODEL.md` checklist: headers, rate limits, upload fuzz, secrets scan, dependency audit, RLS coverage assertion, service-role grep. Verify by: `TEST_STRATEGY.md §13` all green.
2. Production Supabase project (region per CD-23), Vercel production env, secrets rotation procedure, backups and PITR verified, purge job dry-run on staging. Verify by: restore drill restores staging from a backup; purge of a test org leaves zero rows/objects and redacted audit rows.
3. External or independent security review of RLS, auth and AI tool boundaries; all critical/high findings closed (SOW §23). Verify by: findings log with closure evidence.
4. Runbooks: incident, key rotation, failed jobs, AI outage. Verify by: files exist and a second engineer executes the failed-jobs runbook on staging.
Exit gate: release checklist signed; MVP definition of done (§6) met.

---

## 5. Dependency graph

```
P0 skeleton
 └─ P1 identity
     └─ P2 roles/permissions
         └─ P3 tenancy/RLS ── S1 spike
             └─ P4 data architecture (+ evidence schema, jobs, DESIGN.md)
                 └─ P5 import engine ── S2, S4 spikes
                     └─ P6 calculation engine (+ banking) 
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
| M1 Foundation | P0–P3 | 1 | L | Two isolated organisations, five roles, employee assignment, audited super-admin access; `TEST_STRATEGY.md §2–4` green |
| M2 Data in | P4–P5 | 2, 3 | XL | Golden files import through review to commit on CSV, XLSX, PDF; nothing discarded |
| M3 Numbers right | P6–P7 | 4, 5 | XL | Home and Money show golden-verified metrics with basis and data quality |
| M4 Intelligence | P8–P10 | 6, 7, 9 | L | Explainable health score, evidenced alerts, evidence drawer to document |
| M5 Analyst and action | P11–P13 | 8, 10, 17 (subset) | XL | Grounded AI answers with evidence become assigned actions; monthly report |
| M6 Release | P14–P15 | 18 | L | `MVP_SCOPE.md §5` acceptance table all observable checks pass; security review closed |
| Later | — | 11, 12, 13, 14, 15, 16, 17 | — | Each behind a feature flag (ADR-025), each with its own mini-plan |

**Definition of done for the MVP** = every row of `MVP_SCOPE.md §5` has been executed by someone other than the engineer who built it, with evidence (test run link or screenshot) attached; `TEST_STRATEGY.md §15` rows for phases 0–15 green; `SECURITY_MODEL.md` checklist signed; production deployed and the live URL passes journeys 1, 3 and 5 against a fresh organisation.

---

## 7. Product-owner checkpoints

Decisions from `ARCHITECTURAL_DECISIONS.md` Part 1 that must be answered before the phase that consumes them. Unanswered items proceed on the documented recommendation, with the assumption written into `PLAN.md` in the repo.

| Before | Decisions required | If unanswered |
|---|---|---|
| Phase 2 | CD-14 (owner cardinality/transfer), CD-15 (client capabilities), CD-16 (employee capabilities — adviser vs read-only support), CD-17 (documents/export rights) | Build the recommendations; CD-16 is the costliest to reverse (matrix + RLS + UI), so escalate it |
| Phase 3 | CD-13 (super admin access model) | Full access + audit (MVP recommendation) |
| Phase 4 | CD-09 (periods), CD-10 (currency), CD-22 (hosting/jobs), CD-23 (region/retention) | Recommendations; region must be confirmed before Phase 15 at the latest |
| Phase 5 | CD-01 (authoritative SOW), CD-02 (adviser identity), CD-03 (accounting basis/precedence), CD-04 (account mapping), CD-11 (PDF path), CD-12 (duplicate definition), CD-30 (test data) | CD-03 and CD-11 are blocking: do not start slices 5–8 without them |
| Phase 6 | CD-05 (profit definitions), CD-06 (opening cash), CD-07 (AR/AP source), CD-08 (contribution), CD-20 (reconciliation scope), CD-28 (transfers/refunds) | Recommendations |
| Phase 8 | CD-19 (health weights and rules) | Do not ship the score without sign-off; show "coming soon" card instead |
| Phase 9 | CD-18 (thresholds) | Platform defaults |
| Phase 11 | CD-24 (AI quotas), CD-25 (incorrect-insight workflow), CD-21 (no live feeds claim) | Recommendations |
| Phase 13 | ADR-024 (single report in MVP) | Recommendation |
| Phase 15 | CD-23 (DPA, jurisdiction), CD-26/27/29 (post-MVP confirmations for change control) | Release blocked on CD-23 only |

Checkpoint format: a 30-minute review at each phase entry, the CD items above on screen, decisions recorded as edits to `ARCHITECTURAL_DECISIONS.md` Part 1 with the date and the name of the decider.
