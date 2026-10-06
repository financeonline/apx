# MOTION — System Architecture

Status: Architecture phase v1.0 (2026-09-04). This is the entry document. Read it first, then the specialised documents it points to.
Source of truth for scope: `SOW_v2_extracted.md`. Source of truth for decisions: `ARCHITECTURAL_DECISIONS.md`.

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026 to ADR-039 and CD-32 to CD-35. Findings addressed at the overview level: F-A-01, F-A-04, F-A-12, F-B-01, F-B-02, F-C-01, F-D-01, F-D-06. See `RED_TEAM_REVIEW.md`.

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-040 to ADR-046. Adopted defaults for open decisions, chunked calculation runs, the `api_server` schema, database-side MFA and throttles, grounding v3. See `RED_TEAM_REVIEW.md §6`.

## 0. Document map

| Document | Answers |
|---|---|
| `PRODUCT_REQUIREMENTS.md` | What the SOW asks for, requirement by requirement, with MVP flags and open questions |
| `ARCHITECTURAL_DECISIONS.md` | The 30 decisions the product owner must confirm (Part 1) and the 25 decisions engineering has taken (Part 2) |
| `MVP_SCOPE.md` | What is inside the MVP line and what is explicitly outside |
| `TENANCY_MODEL.md` | How organizations, members and platform staff relate; how isolation is guaranteed |
| `RBAC_MATRIX.md` | The five roles and every permission |
| `SECURITY_MODEL.md` | Threats, enforcement layers, secrets, storage, audit, review checklist |
| `DATABASE_ARCHITECTURE.md` | Every table, column class, index, RLS policy |
| `FINANCIAL_ENGINE.md` | Every metric, its formula, edge cases, the Health Score and the Alert Engine |
| `IMPORT_ENGINE.md` | CSV/XLSX/PDF ingestion from upload to commit |
| `EVIDENCE_MODEL.md` | How any statement traces back to a source document |
| `AI_ARCHITECTURE.md` | Claude integration, tools, response contract, defences |
| `UX_ARCHITECTURE.md` | The customer experience for a non-technical owner, per role |
| `ROUTE_ARCHITECTURE.md` | The route tree and per-route authorization |
| `SERVICE_ARCHITECTURE.md` | Module boundaries, service contracts, jobs, error model |
| `TEST_STRATEGY.md` | What is tested, how, and the CI gates |
| `IMPLEMENTATION_PLAN.md` | Build order, slices, verify-by lines, checkpoints |
| `RED_TEAM_REVIEW.md` | The independent adversarial review of v1.0, every finding with its fix, and the readiness verdict |

## 1. What MOTION is

MOTION sits above a business's accounting, banking and commercial systems. It ingests their exports, validates them, computes financial truth deterministically, detects what changed, explains why through an AI Financial Analyst, recommends actions, and lets management assign and track them, with every material number traceable to a source document.

The pipeline is fixed and every module maps onto one stage:

```
DATA ──▶ VALIDATION ──▶ CALCULATION ──▶ INTELLIGENCE ──▶ AI ANALYSIS ──▶ RECOMMENDATION ──▶ ACTION ──▶ OUTCOME
 │           │              │               │                │                 │              │           │
documents  imports    financial-engine   health, alerts       ai            ai (contract)   actions    actions
banking    banking    (snapshots)        evidence          (tools)        + alerts          (assign)   (outcome)
```

Two invariants hold everywhere:

1. **Financial truth is deterministic.** Only `financial-engine` produces numbers; it writes them as immutable `metric_snapshots`. The UI, the alerts, the health score, the reports and the AI all read the same rows. Claude never calculates (ADR-008, ADR-010).
2. **Tenant isolation is structural.** Every tenant row carries `organization_id`; RLS on every tenant table bounds reads; the `authenticated` role holds no table write privilege, so every write is a `api.*` SECURITY DEFINER function that checks the same permission matrix and enforces the invariants (ADR-026); one access resolver in SQL and TypeScript; permissions are strings checked at six layers (ADR-002, ADR-003, `RBAC_MATRIX.md §4`).

## 2. Actors

| Actor | Role key | Lives in | Sees |
|---|---|---|---|
| Owner of a customer business | `tenant_owner` | `organization_memberships` | Their organization(s), all features, governance |
| Administrator inside a customer business | `tenant_admin` | `organization_memberships` | Same data as owner; cannot bill, delete, or touch owners |
| Client (customer-side user) | `tenant_client` | `organization_memberships` | Read + AI + own actions; no imports, documents, users |
| My Employee (platform adviser) | `platform_employee` | `platform_users` + `organization_assignments` | Only assigned organizations, operating not governing; `/portfolio` |
| Super Admin (platform operator) | `platform_super_admin` | `platform_users` | `/platform`; tenant data with audited access (CD-13) |

Owner and Super Admin are different families and are never merged. Employees have no access to anything they are not explicitly assigned to (`TENANCY_MODEL.md §5`).

## 3. Technology stack (pinned)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 24.14, npm 11.13 | Toolchain baseline recorded 2026-09-04 |
| Framework | Next.js 16.3.x, App Router, React Server Components, Server Actions | Vercel hosting assumed (CD-22) |
| Language | TypeScript strict, `noUncheckedIndexedAccess` | |
| UI | Tailwind CSS v4, shadcn/ui (owned source in `src/components/ui/shadcn`, themed with MOTION's tokens; ADR-151); charts are MOTION's own SVG — the SOW's "Recharts or equivalent" | Design tokens decided in the DESIGN phase before build |
| Validation | Zod at every boundary | |
| Money | `decimal.js`; Postgres `NUMERIC(18,2)` | ADR-006 |
| Database | Supabase PostgreSQL 16 with RLS, pgTAP | ADR-013 |
| Auth | Supabase Auth (email/password, magic link; MFA post-MVP) | |
| Storage | Supabase Storage private bucket `source-documents` | `TENANCY_MODEL.md §8` |
| Jobs | Postgres `jobs` table + Vercel Cron for short jobs; Supabase Edge Function background tasks for chunked calculation runs (`CHUNK_PERIODS` = 12) | ADR-020, ADR-041 |
| AI | Anthropic Claude via `src/modules/ai/provider` only | ADR-023; model ids configurable |
| Parsing | `papaparse` (CSV), `exceljs`/`xlsx` streaming (XLSX), `pdfjs-dist` text layer (PDF) | `IMPORT_ENGINE.md §5` |
| Testing | Vitest, pgTAP, Playwright, AI eval harness | ADR-021 |
| Observability | Structured logs with request/org/user ids; Sentry-class error tracking | `SERVICE_ARCHITECTURE.md §9` |

## 4. Logical architecture

```
┌──────────────────────────────── Browser ────────────────────────────────┐
│  Next.js client components (shadcn/ui, Recharts)  — reads via RLS only  │
└───────────────┬───────────────────────────────────────────┬──────────────┘
                │ server actions / route handlers            │ /api/ai/chat (stream)
┌───────────────▼───────────────────────────────────────────▼──────────────┐
│ src/app  (routes, layouts, middleware)  builds AccessContext per request │
├──────────────────────────────────────────────────────────────────────────┤
│ src/modules  auth · tenancy · documents · imports · banking ·            │
│              financial-engine · health · alerts · evidence · ai ·        │
│              actions · reporting · audit                                 │
│   each: domain/ (pure) → schemas/ → data/ (only Supabase caller) →       │
│         services/ (assertCan, orchestrate, audit) → index.ts             │
├──────────────────────────────────────────────────────────────────────────┤
│ src/core  permissions · money · periods · db · errors · logging          │
└───────┬──────────────────────────────┬───────────────────────┬───────────┘
        │ user-session client:          │ service-role client   │ Anthropic API
        │ SELECT under RLS + rpc(api.*) │ (jobs + core/storage  │ (server only,
┌───────▼──────────────────────────────▼──────────┐  signer only)        typed tools)
│ Supabase: Postgres (RLS reads; api.* SECURITY   │
│   DEFINER writes; app.* helpers; jobs; no table │
│   write grants for authenticated)               │
│   Auth (TOTP for platform users) · Storage      │
│   (private buckets, signed URLs only)           │
└──────────────────────────────────────────────────┘
```

Dependencies point downward only. Deep imports across modules are ESLint errors (ADR-022). Business logic never lives in React components (`SERVICE_ARCHITECTURE.md §8`). Writes never happen against tables: services call `api.*` functions through `rpc()` (ADR-026); the SQL functions are invariant guards and writers, the TypeScript modules remain the calculators and orchestrators.

## 5. Key data flows

**Import → truth.** Upload → `source_documents` → `import_batches`/`import_rows` (parse, map, validate, dedupe) → human review → `api.commit_import_batch` (re-checks duplicates under an org lock, supersedes batch-wide, ADR-029) into `ledger_entries` / `period_balances` / `bank_transactions` / `invoices` → `calculation_runs` (SQL aggregation, stale-run loop, ADR-031) → `metric_snapshots` + `metric_current` pointers + `health_scores` → `alerts.evaluate` → `alerts` with `alert_revisions` and `evidence_bundles`. Nothing is discarded; rejected rows stay in `import_rows`; a corrected file replaces its predecessor in one transaction.

**Question → answer → action.** User asks → `ai.service` binds the conversation to (organization, user), resolves the period (latest complete month) and context → Claude calls typed tools with the user's `AccessContext`, re-resolved before every call → the final call is forced to `submit_answer`; text blocks are discarded → every number, entity name and direction word is grounded against the exact tool field it cites (ADR-032) → evidence bundle built from tool outputs → one validated answer event streamed → "Create action" (only when grounding passed) copies the recommendation into `actions` with the bundle.

**Evidence chain.** Any number on any screen → `metric_snapshots` row (components, basis, formula, engine version) → `evidence_query` resolved to records → record's `source_document_id` + `source_ref` → page/row in the viewer. Clients stop at records; other roles reach the document (CD-17).

## 6. Cross-cutting rules

| Rule | Enforced by |
|---|---|
| No `NEXT_PUBLIC_` secret, no Anthropic/service-role key in the browser | Env schema check at boot; CI secret scan |
| No table write privilege for `authenticated`; every mutation is an `api.*` SECURITY DEFINER function with a per-role pgTAP test | Migration `REVOKE`; pgTAP `has_table_privilege` sweep (ADR-026) |
| Storage is reached only through signed URLs minted server-side; no `storage.objects` policy for `authenticated` | `core/storage/signer.ts` + pgTAP (ADR-038.1) |
| Platform users authenticate with TOTP (`aal2`) before any platform or portfolio surface | Middleware + `app.is_super_admin()` (ADR-038.8) |
| The current value of a metric is the row pointed to by `metric_current`; snapshots are append-only | Engine writer + tests (ADR-031.5) |
| No Supabase client in React components; no money arithmetic in components | ESLint rules `no-restricted-imports`, `no-money-math-in-ui` |
| The service role exists in exactly three places: job workers (`withOrgScope`), the Storage signer, and `core/db/server-rpc.ts` for `api_server.*` calls (ADR-043); every service-role query is org-scoped | Lint rules `no-unscoped-service-query`, `no-service-role-outside-sanctioned-files` |
| Every tenant table has RLS + composite FKs | pgTAP suite enumerates tables |
| Every metric value has basis, assurance and data quality | DB NOT NULL + engine tests |
| Every alert and AI finding has evidence | DB constraint + eval harness |
| Every governance change and document access is audited | Triggers + service events |
| Post-MVP modules are dark behind `organizations.features` | ADR-025 |

## 7. Post-MVP attachment points

Forecasting/scenarios read `metric_snapshots` and write their own `forecast_*` tables; CRM extends `counterparties`; the adviser command centre is a projection over `organization_assignments`; funding readiness is another rules engine over snapshots; the report suite renders from snapshots, alerts and actions. None require changes to the tenancy or evidence models (`TENANCY_MODEL.md §9`, `MVP_SCOPE.md §4`).

## 8. Architectural red flags — the 20 biggest ways this project fails

Likelihood and impact on a High / Medium / Low scale. Prevention names the control that already exists in these documents.

| # | Risk | Likelihood | Impact | Prevention |
|---|---|---|---|---|
| 1 | **Double-counted or wrong headline numbers** because overlapping sources (TB, GL, invoices, bank) are summed | High | High | Precedence rule with recorded basis (CD-03, ADR-005); golden datasets that include overlapping sources; basis shown on every card |
| 2 | **Cross-tenant data leak** through a missed RLS policy, an unscoped service-role query, a direct PostgREST write, or an id accepted from the client | Medium | Critical | RLS on every tenant table with `FORCE`, no table write grants for `authenticated` and `api.*` functions (ADR-026), composite FKs plus `same_org_ref` triggers (ADR-034), `withOrgScope` + lint, jobs scoped from the row not the payload, pgTAP enumeration test, org from slug only, 404 on unknown org |
| 3 | **Insider access by platform staff** unnoticed | Medium | High | Explicit assignments only, owner-visible and revocable; super-admin reads audited (CD-13); time-boxed support grants post-MVP |
| 4 | **Claude states a number, name or direction that the data does not support** | High | High | Grounding v2 (ADR-032): mandatory `NumberRef` compared against the exact tool field, unit/sign/period agreement, entity and direction grounding, every section a Statement, forced `submit_answer`, degrade by removal; eval harness with planted confusions |
| 5 | **Prompt injection via transaction descriptions or PDFs** steers the analyst | Medium | High | Untrusted-data delimiters, tool outputs as data not instructions, read-only tools, no tool that writes, injection corpus in CI |
| 6 | **PDF bank statements fail to parse** and the SOW promise is broken, or LLM-extracted rows reach the ledger unreviewed | High | High | CD-11: deterministic first, Claude fallback stamped `inferred` + mandatory review, balance reconciliation gate; spike on 3 real layouts before Phase 3 |
| 7 | **Metric drift**: same metric computed differently in two places (UI, report, AI), or two screens defaulting to different periods | Medium | High | Snapshots via `metric_current` are the only source (ADR-008, ADR-031.5); one default-period rule in `core/periods` for Home and the AI (ADR-030); monthly-only picker in MVP; lint bans arithmetic in components; engine_version stored |
| 8 | **Misclassified accounts** silently corrupt margins | High | Medium | Mapping confirmation step, `uncategorised` → `incomplete` never excluded (CD-04); remap triggers recalculation and audit |
| 9 | **Silent data loss during import** (skipped rows, dropped duplicates) | Medium | High | Every row persisted in `import_rows` with status; row-count equality test; review must resolve errors before commit |
| 10 | **Opening balances unknown** so cash figures are off by a constant | High | Medium | CD-06 ordered sources; "unknown" state instead of zero; onboarding asks for opening balance |
| 11 | **Health Score nobody can defend** | Medium | High | Deterministic rules with visible thresholds, breakdown stored, product sign-off gate (CD-19), band language "indicative" |
| 12 | **Alert fatigue** makes users ignore the Insights page | High | Medium | State-vs-event keys so a persistent condition is one alert (ADR-036), per-run cap of 25, `basis_differs` and incomplete-period suppression (ADR-030), minimum amounts, dedupe, auto-resolve, revisions instead of silent rewrites (ADR-034), three-alert cap on Home |
| 13 | **Non-technical owner is overwhelmed** by density or jargon | High | High | Seven-item nav, progressive disclosure, plain-language rules, one CTA on empty states, role-specific landing (`UX_ARCHITECTURE.md`) |
| 14 | **Post-MVP scope creep** (CRM, forecasting, adviser dashboard) delays the core journey | High | High | `MVP_SCOPE.md` with hard-dependency table; feature flags; change control (SOW §28) |
| 15 | **Request timeouts or dead jobs** on large imports or 36-month recalculations | Medium | Medium | Job queue (ADR-020), 5,000-row synchronous cap, SQL-side aggregation so run CPU scales with periods not rows (ADR-031.4), spike S5 with the CD-34 fallback runtime, stale-run recovery, advisory lock per org |
| 16 | **AI cost blow-out** from unbounded usage | Medium | Medium | Per-org quotas and per-user rate limits (CD-24), 8-tool-call cap, prompt caching, token accounting per org |
| 17 | **Secrets or documents exposed** via public bucket, long signed URLs, or `NEXT_PUBLIC_` misuse | Low | Critical | Private bucket, 60-second URLs, download audit, env schema, CI secret scan |
| 18 | **Ambiguous dates and formats** (D/M/Y vs M/D/Y, parentheses negatives) shift transactions across periods | High | Medium | Explicit format choice when ambiguous, row flags, preview before commit (`IMPORT_ENGINE.md §6`) |
| 19 | **RLS and application authorization disagree** so tests pass on one and the other leaks | Medium | High | One matrix generated into `role_permissions`, pgTAP parity test, shared fixtures for `resolveAccess` vs `app.org_role()` |
| 20 | **Undecided product questions** (adviser identity, accounting basis, weights, jurisdiction, VAT, profit cards) get decided implicitly in code | High | High | Part 1 and Part 4 CDs of `ARCHITECTURAL_DECISIONS.md` with blocking flags; checkpoints in `IMPLEMENTATION_PLAN.md` before the phase that needs each answer |
| 21 | **A second import committed while a calculation run is executing is silently excluded** and Home shows current-but-wrong figures | High | High | Coalescing only on queued jobs, stale-run loop, affected periods from every change since the last successful run, `calculation_run_id` set only by the run that included the batch (ADR-031, F-D-01) |
| 22 | **Trial balances treated as monthly movements** multiply revenue by the months elapsed in the fiscal year | High | Critical | Cumulative vs movement basis per batch, differencing with fiscal-year reset, natural-sign storage, `no_prior_trial_balance` gap handling, cumulative golden fixture (ADR-027, F-B-02) |
