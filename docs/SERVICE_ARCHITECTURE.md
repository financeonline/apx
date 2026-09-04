# MOTION — Service Architecture

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-003, ADR-008, ADR-013, ADR-014, ADR-015, ADR-020, ADR-022), `DATABASE_ARCHITECTURE.md`, `RBAC_MATRIX.md`, `TENANCY_MODEL.md`, `IMPORT_ENGINE.md`, `AI_ARCHITECTURE.md`, `FINANCIAL_ENGINE.md`, `EVIDENCE_MODEL.md`
Consumed by: `IMPLEMENTATION_PLAN.md`, `TEST_STRATEGY.md`, `ROUTE_ARCHITECTURE.md`

Purpose: fix the boundaries so business logic lives in modules, not in React components or route files, and so every boundary can be tested alone.

---

## 1. Layering

```
src/app        Next.js routes, layouts, server components, server actions, route handlers, UI components
   │  imports only  ▼
src/modules    auth · tenancy · documents · imports · banking · financial-engine · health · alerts · evidence · ai · actions · reporting · audit
   │  imports only  ▼
src/core       permissions · money · periods · db · errors · logging
```

Rules (ESLint `no-restricted-imports` + `import/no-internal-modules`):

| From | May import | May not import |
|---|---|---|
| `src/app/**` | `src/modules/*/index.ts`, `src/core/*`, UI libs | any `src/modules/*/{domain,data,services}/**`, `@supabase/*` directly, `@anthropic-ai/*` |
| `src/modules/<m>/**` | own module files, other modules' `index.ts` (allow-list below), `src/core/*` | `src/app/**`, other modules' internals, `next/*` (except `next/cache` in services), `react` |
| `src/modules/<m>/domain/**` | `src/core/{money,periods,errors}` | any I/O: `src/core/db`, `fetch`, `@supabase/*`, `@anthropic-ai/*`, other modules |
| `src/core/**` | other `src/core/*`, node/std | `src/modules/**`, `src/app/**` |
| `src/modules/ai/data/claude-client.ts` | `@anthropic-ai/sdk` | — (only file allowed to) |
| `src/core/db/**` and `src/modules/*/data/**` | `@supabase/supabase-js`, `@supabase/ssr` | — (only files allowed to) |

Allowed cross-module dependencies (a directed acyclic list; anything else is a lint error):

```
tenancy      → auth, audit
documents    → tenancy, audit
imports      → documents, tenancy, banking (bank accounts), financial-engine (enqueue), audit
banking      → tenancy, financial-engine (metric read), audit
financial-engine → tenancy (periods), banking (read), audit
health       → financial-engine
alerts       → financial-engine, health, banking, evidence, audit
evidence     → financial-engine, banking, documents, imports (read)
ai           → financial-engine, health, alerts, evidence, banking, actions, documents, audit
actions      → evidence, tenancy, audit
reporting    → financial-engine, health, alerts, actions, evidence
audit        → (none)
```

Circularity is prevented by making `audit` and `core` leaf dependencies and by having `alerts`/`ai`/`reporting` consume, never be consumed by, `financial-engine`.

---

## 2. Module anatomy and conventions

```
src/modules/<name>/
  domain/     pure functions and types; no I/O; unit-tested with plain inputs
  schemas/    Zod schemas for inputs, outputs, DB rows (parse at every boundary)
  data/       repositories: the only code that calls Supabase; every function takes { db, orgId } from context
  services/   use cases; first parameter is AccessContext; call assertCan; orchestrate domain + data; write audit; enqueue jobs
  index.ts    the public API: exported service functions, public types, view-model types. Nothing else is importable.
```

Conventions:

- **Services own transactions and audit.** A service either completes and audits, or throws; repositories never audit.
- **Repositories are dumb.** Filters are explicit columns; no string-built SQL; `organization_id` is always the first filter and comes from `ctx.orgId`, never from arguments the caller could forge.
- **Domain is where the truth is.** Calculations, validation rules, dedupe hashing, alert rules, health scoring, grounding and period maths are `domain/` and have no idea a database exists.
- **View models.** Services return UI-ready shapes (`DashboardViewModel`, `AlertCardViewModel`) with money already formatted by `core/money` and periods labelled by `core/periods`, so components never format or compute.
- **Idempotent writes.** Any service that a job may retry accepts an idempotency key and is safe to call twice.
- **Naming.** `verbNoun` for services (`commitBatch`, `runCalculation`), `findX/listX/insertX/updateX` for repositories.

---

## 3. AccessContext and request lifecycle

```ts
type AccessContext = {
  userId: string;
  orgId: string | null;                 // null for /platform and /portfolio
  orgSlug: string | null;
  effectiveRole: 'super_admin'|'employee'|'owner'|'admin'|'client'|'none';
  permissions: ReadonlySet<Permission>;
  actorType: 'user'|'employee'|'platform_admin'|'system'|'ai';
  db: SupabaseClient;                   // user-session client (RLS on); service-role only inside jobs
  requestId: string;
  now: () => Date;
};
```

`resolveAccess(session, orgSlug?)` in `tenancy/services/resolve-access.ts` implements the order in `RBAC_MATRIX.md §1`, throws `NotFound` for `none` (never `Forbidden`, to avoid enumeration), and is memoised per request with `React.cache`.

| Entry point | How context is built | Notes |
|---|---|---|
| Server component under `/app/[orgSlug]` | `layout.tsx` calls `getAccessContext(params.orgSlug)`; children call the same memoised function | Layout also writes the super-admin read audit (`RBAC_MATRIX.md §3.6`) |
| Server action | First line `const ctx = await getAccessContext(orgSlug)` where `orgSlug` comes from a bound argument, then `assertCan` | Never trust ids in the form payload for tenancy |
| Route handler (`/api/**`) | `withAccess(handler)` wrapper parses session, slug from the body/route, builds ctx, maps errors (§6) | Streaming handlers (`/api/ai/chat`) build ctx before opening the stream |
| Job worker | `withOrgScope(orgId, jobId)` creates a service-role client, sets `app.current_org`, builds ctx with `actorType='system'`, `effectiveRole='super_admin'` for RLS-less writes, but services still run `assertCan` against a synthetic full permission set and every repository call asserts `organization_id = orgId` (lint `no-unscoped-service-query`) | The only place the service-role key exists |
| Middleware | Session presence and route family only; no DB access | Redirects to sign-in; never authorises |

---

## 4. Boundaries

For each boundary: responsibility · public services (name(inputs) → output [permission]) · must never · depends on · emits.

### 4.1 auth (`modules/auth`)
Responsibility: Supabase Auth wrappers — sign-in, sign-up, magic link, password reset, session refresh, profile sync.
Services: `signIn(creds)`, `signUp(email, password, name)`, `sendMagicLink(email)`, `resetPassword(email)`, `getSession()`, `updateProfile(ctx, patch)` [self], `disableUser(ctx, userId)` [platform.users.manage].
Never: decide authorization; read tenant tables.
Depends: core/db. Emits: audit `auth.signed_in`, `auth.password_reset`, `profile.updated`.

### 4.2 authorization (`core/permissions`)
Responsibility: the matrix (`catalogue.ts`, `matrix.ts`), `can`, `assertCan`, role guards (`canInviteRole`, `canChangeRole`, `canRevokeAssignment`), matrix sync script.
Never: touch the database; know about routes.
Depends: nothing. Emits: nothing.

### 4.3 tenant context (`modules/tenancy`)
Responsibility: organizations, memberships, invitations, assignments, access resolution, org switcher data, fiscal periods, seeding.
Services: `resolveAccess(session, slug)`; `createOrganization(ctx, input)` → org [self-serve: any signed-in user; platform: platform.orgs.manage]; `updateOrganization(ctx, patch)` [settings.manage]; `listMyOrganizations(ctx)`; `inviteMember(ctx, email, role)` [users.invite + `canInviteRole`]; `acceptInvitation(session, token)`; `changeMemberRole(ctx, userId, role)` [users.manage + `canChangeRole`]; `removeMember(ctx, userId)` [users.manage]; `initiateOwnershipTransfer(ctx, nomineeUserId)` / `acceptOwnershipTransfer(ctx, transferId)` [owner]; `createAssignment(ctx, orgId, employeeUserId, endsAt)` [assignments.manage]; `revokeAssignment(ctx, assignmentId, reason)` [assignments.manage or owner of that org]; `ensurePeriods(ctx, fromDate, toDate)` [system]; `requestDeletion(ctx)` [org.delete].
Never: bypass `canChangeRole`; delete rows; expose emails of other organizations.
Depends: auth, audit. Emits: audit `org.created`, `member.invited`, `member.joined`, `member.role_changed`, `member.removed`, `ownership.transferred`, `assignment.created`, `assignment.revoked`, `org.deletion_requested`; job `org.purge` (delayed 30 days).

### 4.4 data access (`core/db` + `modules/*/data`)
Responsibility: `createUserClient(session)`, `createServiceClient()`, typed row schemas, `withOrgScope`, `Decimal` parsing at the boundary (ADR-006), pagination helpers.
Never: be imported by `domain/`; format for display; accept string-built filters.
Depends: nothing. Emits: nothing.

### 4.5 documents (`modules/documents`)
Responsibility: upload validation (`IMPORT_ENGINE.md §4`), Storage writes, `source_documents`, signed URLs, text extraction, quarantine.
Services: `uploadDocument(ctx, file, declaredKind)` → `{documentId, …}` [imports.create]; `getDocumentUrl(ctx, documentId)` → signed URL [documents.view]; `listDocuments(ctx, filter)` [documents.view]; `extractText(ctx, documentId)` [system, job]; `deleteDocument(ctx, documentId)` [imports.review; only if unreferenced].
Never: return a URL without an audit event; parse rows (that is `imports`).
Depends: tenancy, audit. Emits: audit `document.uploaded`, `document.downloaded`, `document.quarantined`, `document.deleted`; job `document.extract`.

### 4.6 imports (`modules/imports`)
Responsibility: the pipeline in `IMPORT_ENGINE.md`.
Services: `startBatch(ctx, documentId, importType, opts)` [imports.create]; `parseBatch(ctx, batchId)` [system/imports.review]; `saveMapping(ctx, batchId, mapping)` [imports.review]; `confirmAccountMapping(ctx, batchId, accountMap)` [imports.review]; `getPreview(ctx, batchId)`; `validateBatch(ctx, batchId)`; `getReview(ctx, batchId, filter)`; `decideRows(ctx, batchId, decisions[])` [imports.review]; `fixRow(ctx, batchId, rowId, patch)` [imports.review]; `confirmPdfPage(ctx, batchId, page)`; `commitBatch(ctx, batchId)` [imports.review]; `rejectBatch(ctx, batchId, reason)`; `rollbackBatch(ctx, batchId, reason)` [imports.review]; `listBatches(ctx, filter)`; `getCoverage(ctx)` [dashboard.view].
Never: insert into target tables outside `app.commit_import_batch`; drop a row; call Claude except through `ai.extractStatementPage` (which is the ai module's extraction service, tools-free).
Depends: documents, tenancy, banking (bank account lookup/create), financial-engine (enqueue), audit. Emits: audit `import.started`, `import.mapped`, `import.committed`, `import.rejected`, `import.rolled_back`, `import.row_decided`; jobs `document.extract`, `import.commit_large`, `calculation.run`.

### 4.7 banking (`modules/banking`)
Responsibility: bank accounts, categorisation rules, transfer and recurring detection, banking view models, coverage.
Services: `listBankAccounts(ctx)` [banking.view]; `createBankAccount(ctx, input)` [financials.edit]; `setOpeningBalance(ctx, accountId, amount, date)` [financials.edit]; `categoriseTransactions(ctx, batchId | range)` [system]; `overrideCategory(ctx, txnId, accountId)` [banking.reconcile]; `markTransfer(ctx, txnId, pairId | null)` [banking.reconcile]; `detectRecurring(ctx, range)` [system]; `getBankingOverview(ctx, period)` → view model [banking.view]; `listTransactions(ctx, filter, page)` [banking.view].
Never: compute cash metrics (financial-engine does, from these rows); edit amounts or dates (corrections go through imports supersession).
Depends: tenancy, financial-engine (read snapshots for the overview), audit. Emits: audit `bank_account.created`, `bank_account.opening_balance_set`, `bank_txn.recategorised`, `bank_txn.transfer_marked`; job `calculation.run` after category/transfer changes.

### 4.8 financial calculations (`modules/financial-engine`)
Responsibility: `FINANCIAL_ENGINE.md` — metric registry, precedence, calculation runs, snapshots, variance.
Services: `enqueueCalculation(ctx, trigger, periodFrom, periodTo, refId)` [system/intelligence.recompute]; `runCalculation(ctx, runId)` [system, job]; `getMetric(ctx, key, periodId, dimension?)` [financials.view]; `getMetricTrend(ctx, key, from, to, dimension?)`; `getBreakdown(ctx, key, periodId, dimensionType, limit)`; `getVariance(ctx, key, periodId, compareTo)`; `getDashboard(ctx, periodId)` → `DashboardViewModel` [dashboard.view]; `getDataCoverage(ctx, range)` [dashboard.view]; `explainSnapshot(ctx, snapshotId)` → components + evidence descriptor [financials.view].
Never: read uncommitted or non-accepted records; compute in the request path (only jobs write snapshots; reads serve `is_current` rows); return a value without `basis` and `data_quality`.
Depends: tenancy (periods), banking (read accepted bank rows), audit. Emits: audit `calculation.failed`; job `alerts.evaluate` on success; run-completed hook consumed by `health` (same job).

### 4.9 health score (`modules/health`)
Responsibility: dimension rules, weights config, renormalisation, explanations (`FINANCIAL_ENGINE.md §7`).
Services: `computeHealth(ctx, runId, periodId)` [system, inside `calculation.run`]; `getHealth(ctx, periodId)` → score + breakdown [dashboard.view]; `getHealthHistory(ctx, from, to)`.
Never: read raw records (only `metric_snapshots`); change weights at runtime without a config version bump.
Depends: financial-engine. Emits: nothing (writes `health_scores`).

### 4.10 alerts (`modules/alerts`)
Responsibility: rule evaluation, dedupe/upsert, status workflow, evidence bundle creation, conversion to actions.
Services: `evaluateAlerts(ctx, runId)` [system, job]; `listAlerts(ctx, filter)` [dashboard.view]; `getAlert(ctx, alertId)`; `setAlertStatus(ctx, alertId, status, reason)` [alerts.manage; client → acknowledge only]; `createActionFromAlert(ctx, alertId, input)` [actions.create].
Rule catalogue (each a `domain/rules/*.ts` exporting `rule_key`, `rule_version`, thresholds; the canonical definitions, thresholds and templates are in `FINANCIAL_ENGINE.md §8`): `expense.spike_category`, `expense.spike_account`, `revenue.decline`, `margin.deterioration`, `cash.decline`, `cash.runway_low`, `receivables.deterioration`, `payables.deterioration`, `concentration.customer`, `concentration.supplier`, `recurring.amount_changed`, `recurring.missed`, `recurring.new`, `duplicate.transaction`, `bank.unusual_transaction`, `deviation.large_transaction`, `variance.significant`.
Never: compute metrics; delete alerts; fire without an evidence bundle.
Depends: financial-engine, health, banking, evidence, audit. Emits: audit `alert.status_changed`, `alert.converted_to_action`.

### 4.11 evidence (`modules/evidence`)
Responsibility: bundles/items, descriptor resolution, drill-down chain (`EVIDENCE_MODEL.md`).
Services: `createBundle(ctx, kind, origin, items[])` [system/ai/user context]; `getBundle(ctx, bundleId)` [financials.view; documents stripped for client]; `resolveDescriptor(ctx, descriptor, page)` → records [financials.view]; `traceRecord(ctx, type, id)` → import row, batch, document, source_ref [financials.view; document only with documents.view]; `getMetricEvidence(ctx, snapshotId)`.
Never: fabricate a descriptor; return records outside `ctx.orgId`.
Depends: financial-engine, banking, documents, imports (read). Emits: audit `evidence.viewed` (when a document is opened from evidence).

### 4.12 AI (`modules/ai`)
Responsibility: `AI_ARCHITECTURE.md` — chat, tools, grounding, evidence, feedback, quotas, extraction service for PDFs.
Services: `chat(ctx, conversationId | null, message)` → async iterable of stream events [ai.use]; `listConversations(ctx)`; `getConversation(ctx, id)`; `submitFeedback(ctx, messageId | alertId, type, comment)` [ai.use]; `reviewFeedback(ctx, feedbackId, status, note)` [platform.ai_feedback.review]; `extractStatementPage(ctx, documentId, page)` → schema rows [system, job].
Never: import Supabase outside `data/`; accept an org id from the model; write actions/alerts/records; expose the SDK.
Depends: financial-engine, health, alerts, evidence, banking, actions, documents, audit. Emits: audit `ai.answered`, `ai.refused`, `ai.feedback_submitted`, `ai.feedback_reviewed`; writes `ai_conversations`, `ai_messages`, `ai_tool_calls`, `ai_feedback`.

### 4.13 actions (`modules/actions`)
Responsibility: Action Centre (SOW §17).
Services: `createAction(ctx, input)` [actions.create]; `createFromRecommendation(ctx, messageId, index)` [actions.create]; `assignAction(ctx, actionId, ownerUserId)` [actions.assign; owner must be member/assigned employee]; `updateAction(ctx, actionId, patch)` [actions.create, or actions.update_own when owner = self, limited fields]; `setStatus(ctx, actionId, status, outcome?)`; `listActions(ctx, filter)` [actions.view]; `getActionsSummary(ctx)` for Home.
Never: delete; allow a client to reassign.
Depends: evidence, tenancy, audit. Emits: audit `action.created`, `action.assigned`, `action.status_changed`, `action.completed`.

### 4.14 reporting (`modules/reporting`)
Responsibility: Monthly Management Report (ADR-024) view model and PDF render job.
Services: `getMonthlyReport(ctx, periodId)` → `ReportViewModel` [reports.view]; `requestPdf(ctx, periodId)` → jobId [reports.generate]; `getReportFile(ctx, jobId)` → signed URL [reports.view].
Never: compute; call Claude in MVP.
Depends: financial-engine, health, alerts, actions, evidence. Emits: job `report.render`; audit `report.generated`, `report.downloaded`.

### 4.15 audit (`modules/audit`)
Responsibility: `audit(ctx, action, target, before?, after?, metadata?)` via `app.audit()`; querying for the org audit page and platform search.
Services: `record(ctx, event)`; `listOrgEvents(ctx, filter, page)` [audit.view]; `searchPlatformEvents(ctx, filter)` [system.manage].
Never: update or delete; store financial payloads for super-admin view events (metadata only).
Depends: nothing. Emits: nothing.

---

## 5. Background jobs (ADR-020)

- **Table:** `jobs` (`DATABASE_ARCHITECTURE.md §11`).
- **Enqueue:** `core/jobs.enqueue(db, { type, orgId, payload, idempotencyKey, runAfter? })`; the idempotency key is a unique index on `(job_type, idempotency_key) WHERE status IN ('queued','running')` so duplicate enqueues collapse (e.g. two imports committed in one minute → one calculation run covering both, because the run reads state at execution time).
- **Worker:** `POST /api/jobs/run` (Vercel Cron every minute, plus an immediate `fetch` "kick" after enqueue with `waitUntil`), secured by a bearer secret; claims up to 5 jobs with `UPDATE … WHERE status='queued' AND run_after <= now() ORDER BY run_after FOR UPDATE SKIP LOCKED RETURNING *`, sets `locked_at/locked_by`, runs each inside `withOrgScope`, and marks `succeeded`/`failed`. Work that may exceed the route budget (`document.extract` for >20 pages, `calculation.run` >36 periods, `org.purge`) is dispatched to a Supabase Edge Function with the same handler code.
- **Job types and payloads:**

| Type | Payload | Handler | Idempotency key |
|---|---|---|---|
| `calculation.run` | `{ orgId, trigger, triggerRefId, periodFrom, periodTo }` | financial-engine.runCalculation → health.computeHealth → enqueue `alerts.evaluate` | `orgId` (coalesces) |
| `alerts.evaluate` | `{ orgId, runId }` | alerts.evaluateAlerts | `orgId:runId` |
| `document.extract` | `{ orgId, documentId, batchId, method: 'pdf_text'|'pdf_claude' }` | documents.extractText → imports.parseBatch | `documentId:method` |
| `import.commit_large` | `{ orgId, batchId }` | imports.commitBatch (system ctx carrying the reviewer id in payload for audit) | `batchId` |
| `report.render` | `{ orgId, periodId, requestedBy }` | reporting render → Storage `reports/` | `orgId:periodId:date` |
| `org.purge` | `{ orgId }` | tenancy purge (Storage + rows) | `orgId` |
| `ai.eval` | `{ promptVersion }` | ai eval harness (CI/nightly) | `promptVersion` |

- **Retries:** exponential backoff `30s · 2^attempts` up to `max_attempts` (3; `calculation.run` 5). Non-retryable errors (`ValidationError`, `PermissionDenied`) go straight to `dead`.
- **Dead letter:** `status = dead` rows appear in `/platform/jobs` with the error; a super admin can requeue. Dead `calculation.run` jobs also set a dashboard banner for the organization ("figures may be out of date").
- **Observability:** each job logs `job_id`, `org_id`, `type`, `attempt`, duration; metrics for queue depth, oldest queued age, failure rate; alert to platform when oldest queued > 10 min.
- **Stale locks:** a job `running` for longer than its budget × 3 is returned to `queued` with `attempts + 1`.

---

## 6. Error model (`core/errors`)

| Class | When | HTTP | UI |
|---|---|---|---|
| `NotFound` | Org/record not in the caller's accessible set, or missing | 404 | Not-found state; never confirms existence |
| `PermissionDenied` | `assertCan` fails; role guards fail | 403 | Permission-denied state / toast; logged |
| `ValidationError` (with `issues[]`) | Zod parse fails; import rule violations on write | 422 | Field errors; import issue list |
| `ConflictError` | Optimistic concurrency; duplicate file; state machine violation | 409 | "Someone changed this; reload" or duplicate-file dialog |
| `QuotaExceeded` (with `resetAt`) | AI quotas, upload caps | 429 | Quota message with reset time |
| `UpstreamError` (with `provider`) | Claude, Storage, email | 502 | Fallback message; retry hint |
| `InternalError` | anything else | 500 | Generic error state; `requestId` shown |

Errors carry `requestId`; route wrappers serialise `{ code, message, issues?, requestId }`; server actions return `{ ok: false, error }` so components render states from `UX_ARCHITECTURE.md §8`. Stack traces never reach the client.

---

## 7. Data-flow walkthroughs

### 7.1 Import commit → calculation → alerts → dashboard
1. Reviewer clicks Commit → server action `commitBatchAction(orgSlug, batchId)`.
2. `getAccessContext` → `assertCan(ctx,'imports.review')` → `imports.commitBatch`.
3. Batch-level checks re-run; `app.commit_import_batch` transaction writes records with `record_status = accepted` and links rows.
4. `audit('import.committed')`; `enqueue('calculation.run', { trigger: 'import_commit', periodFrom: earliest affected, periodTo: 'latest' })`; kick worker.
5. Worker: `withOrgScope` → `financial-engine.runCalculation` reads accepted records + period balances + bank rows, applies precedence per metric/period, writes `metric_snapshots` (new `calculation_run_id`, previous `is_current=false`), then `health.computeHealth` writes `health_scores`.
6. Same job enqueues `alerts.evaluate` → rules read current snapshots → `evidence.createBundle` per alert → upsert `alerts` by `dedupe_key`.
7. `import_batches.calculation_run_id` set; Next.js `revalidateTag('org:{id}:metrics')`.
8. Home server component calls `financial-engine.getDashboard(ctx, period)` → view model from current snapshots, `alerts.listAlerts`, `actions.getActionsSummary` → rendered. No arithmetic in React.

### 7.2 AI question → answer → action
1. User submits in AI Analyst → `POST /api/ai/chat`.
2. `withAccess` → `assertCan(ctx,'ai.use')` → `ai.chat` (quota, conversation, period resolution).
3. Tool loop: each call `assertCan` → module service (e.g. `financial-engine.getMetric`) → typed result → `ai_tool_calls` row.
4. `submit_answer` → Zod → grounding → `evidence.createBundle(kind='ai_response')` → `ai_messages` persisted → `audit('ai.answered')` → answer streamed.
5. User clicks "Create action" on a recommendation → server action → `actions.createFromRecommendation(ctx, messageId, index)` copies title/issue/recommendation/priority, sets `source_type='ai'`, `source_id=messageId`, `evidence_bundle_id` → `audit('action.created')`.
6. Owner assigns and sets a due date → `actions.assignAction` → the Home widget and Actions page read `listActions`.

### 7.3 Employee revoked mid-session
1. Owner clicks Revoke on Settings → Team → `tenancy.revokeAssignment(ctx, assignmentId, reason)` → row `status='revoked'` → audit in org log and platform log.
2. Employee's next request: `resolveAccess` finds no active assignment → `effectiveRole='none'` → `NotFound` → the org disappears from `/portfolio`; any open page shows the not-found state on next navigation or server action.
3. RLS: the employee's JWT no longer resolves the org in `app.accessible_org_ids()`, so even a stale client-side fetch returns zero rows.
4. In-flight AI turn: tool calls after revocation fail `PermissionDenied`; the answer degrades; no data is returned.
5. Nothing the employee created is deleted; `actor_type='employee'` audit rows remain.

---

## 8. Keeping logic out of React

Rules, each enforced by lint or review:

1. **No money arithmetic in components.** Lint: `no-restricted-syntax` on binary `+ - * /` where an operand's type is `Money`/`Decimal` inside `src/app/**`; components display `display` strings from view models.
2. **No Supabase in components or route files.** Lint: `@supabase/*` restricted to `core/db` and `modules/*/data`.
3. **No Anthropic SDK outside `ai/data/claude-client.ts`.**
4. **Components receive view models.** Server components call `modules/*/index.ts` services and pass plain serialisable props; client components never fetch tenant data directly (no client-side Supabase queries in MVP).
5. **Formatting only in `core/money` and `core/periods`.** Lint bans `Intl.NumberFormat`, `toFixed`, `toLocaleString` and date formatting libraries outside those two modules.
6. **No permission logic in JSX.** Components receive booleans like `canImport` from the view model (computed by `can(ctx, …)` in the service/layout).
7. **No role names in code.** Lint: string literals `'owner'|'admin'|'client'|'employee'|'super_admin'` allowed only in `core/permissions` and `tenancy/domain`.
8. **No unscoped service-role queries.** Lint `no-unscoped-service-query` (custom rule) requires `.eq('organization_id', …)` on every builder chain created from the service client.
9. **Server actions are thin.** ≤ 15 lines: build ctx, parse input with Zod, call one service, return result.

---

## 9. Observability

- **Logs:** structured JSON via `core/logging`, fields `request_id`, `org_id`, `user_id` (hashed in production logs), `route`, `service`, `duration_ms`, `error.code`; never amounts, descriptions or document text.
- **Metrics:** request latency per route, job queue depth/age, calculation run duration by period count, AI grounding pass rate, tool denial count, import commit counts and failure codes, Storage bytes per org.
- **Tracing hooks:** `withSpan(name, fn)` around services and jobs; `request_id` propagated into jobs' payload and Claude request metadata.
- **Alerts to platform:** dead jobs, grounding pass rate < 95% over 1 h, any `PermissionDenied` from an AI tool spike, RLS policy errors (`42501`) anywhere.
- **Audit ≠ logs:** audit is a product feature stored in Postgres; logs are operational and expire.
