# MOTION — Service Architecture

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-003, ADR-008, ADR-013, ADR-014, ADR-015, ADR-020, ADR-022), `DATABASE_ARCHITECTURE.md`, `RBAC_MATRIX.md`, `TENANCY_MODEL.md`, `IMPORT_ENGINE.md`, `AI_ARCHITECTURE.md`, `FINANCIAL_ENGINE.md`, `EVIDENCE_MODEL.md`
Consumed by: `IMPLEMENTATION_PLAN.md`, `TEST_STRATEGY.md`, `ROUTE_ARCHITECTURE.md`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026, ADR-029, ADR-030, ADR-031, ADR-032, ADR-033, ADR-034, ADR-036, ADR-037, ADR-038. Findings addressed: F-A-01, F-A-03, F-A-04, F-A-05, F-A-11, F-A-17, F-B-13, F-B-14, F-C-11, F-C-17, F-D-01, F-D-02, F-D-03, F-D-05, F-D-14, F-D-15, F-D-16. See `RED_TEAM_REVIEW.md`.

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-047 (R2-B-01..12: single `orgId` key for all calculation jobs incl. continuations, `restart_from`, superseded runs, per-tick worker_lost sweep, CPU-ms chunk budget, rollback promotion, recurring detection inside the chunk, 90-day retention); ADR-043 (`api_server.*` via `core/db/server-rpc.ts`; `record_access_event`; `commit_batch_as`; document register/finalize/delete order), ADR-044 (jobs act as `requested_by`; reclaimable locks; throttles; ownership transfer cancel; session revocation in app code), ADR-046 (change-set includes supersessions and merges). Findings addressed: R2-A-01, R2-A-02, R2-A-05, R2-A-09, R2-A-10, R2-A-11, R2-C-10. See `RED_TEAM_REVIEW.md §6`.

Purpose: fix the boundaries so business logic lives in modules, not in React components or route files, and so every boundary can be tested alone.

---

## 1. Layering

```
src/app        Next.js routes, layouts, server components, server actions, route handlers, UI components
   │  imports only  ▼
src/modules    auth · tenancy · documents · imports · banking · financial-engine · health · alerts · evidence · ai · actions · reporting · audit · portfolio
   │  imports only  ▼
src/core       permissions · money · periods · db · storage · jobs · errors · logging
```

Rules (ESLint `no-restricted-imports` + `import/no-internal-modules` + custom rules):

| From | May import | May not import |
|---|---|---|
| `src/app/**` | `src/modules/*/index.ts`, `src/core/*`, UI libs | any `src/modules/*/{domain,data,services}/**`, `@supabase/*` directly, `@anthropic-ai/*` |
| `src/modules/<m>/**` | own module files, other modules' `index.ts` (allow-list below), `src/core/*` | `src/app/**`, other modules' internals, `next/*` (except `next/cache` in services), `react` |
| `src/modules/<m>/domain/**` | `src/core/{money,periods,errors}` | any I/O: `src/core/db`, `fetch`, `@supabase/*`, `@anthropic-ai/*`, other modules |
| `src/modules/<m>/services/**` | `ctx.db.from()` for reads, `ctx.db.rpc('api.*')` for writes | `.insert/.update/.delete/.upsert` on any table (lint `no-direct-table-write`, ADR-026) |
| `src/core/**` | other `src/core/*`, node/std | `src/modules/**`, `src/app/**` |
| `src/modules/ai/data/claude-client.ts` | `@anthropic-ai/sdk` | — (only file allowed to) |
| `src/core/db/**` and `src/modules/*/data/**` | `@supabase/supabase-js`, `@supabase/ssr` | — (only files allowed to) |
| `src/core/db/service-client.ts` | imported by `src/modules/*/data/jobs/**`, `src/core/storage/signer.ts` and `src/core/db/server-rpc.ts` only | anything under `src/app/**` or `services/**` outside jobs (lint `no-service-client-outside-jobs`) |
| `src/core/storage/signer.ts` | service-role storage client via `withStorageScope(orgId)` | — (request-path use of the service role #1; ADR-038.1) |
| `src/core/db/server-rpc.ts` | service-role client used **only** to call `api_server.*` functions, always passing `{ actorUserId: ctx.userId, requestId: ctx.requestId }` | — (request-path use of the service role #2; ADR-043); lint `no-api-server-outside-server-rpc` forbids the string `api_server.` anywhere else |

Allowed cross-module dependencies (a directed acyclic list; anything else is a lint error):

```
tenancy      → auth, audit
documents    → tenancy, audit
imports      → documents, tenancy, banking (bank accounts), financial-engine (enqueue), ai (extractStatementPage), audit
banking      → tenancy, financial-engine (metric read), audit
financial-engine → tenancy (periods), banking (read), audit
health       → financial-engine
alerts       → financial-engine, health, banking, evidence, audit
evidence     → financial-engine, banking, documents, imports (read)
ai           → financial-engine, health, alerts, evidence, banking, actions, documents, audit
actions      → evidence, tenancy, audit
reporting    → financial-engine, health, alerts, actions, evidence
portfolio    → tenancy, health, alerts, imports (read-only aggregate projections, ADR-038.13)
audit        → (none)
```

Circularity is prevented by making `audit` and `core` leaf dependencies and by having `alerts`/`ai`/`reporting`/`portfolio` consume, never be consumed by, `financial-engine`. The `imports → ai` edge is the tools-free extraction entry point only.

---

## 2. Module anatomy and conventions

```
src/modules/<name>/
  domain/     pure functions and types; no I/O; unit-tested with plain inputs
  schemas/    Zod schemas for inputs, outputs, DB rows (parse at every boundary)
  data/       repositories: the only code that calls Supabase; read-only for the user client; jobs/ subfolder for service-role writers
  services/   use cases; first parameter is AccessContext; call assertCan; orchestrate domain + data; call api.* for writes; enqueue jobs
  index.ts    the public API: exported service functions, public types, view-model types. Nothing else is importable.
```

Conventions:

- **Writes go through `api.*` or `api_server.*` (ADR-026, ADR-043).** A service that mutates on the user's *intent* calls exactly one `api.*` SECURITY DEFINER function through `ctx.db.rpc()`; the function throttles, derives the actor from `auth.uid()`, checks `app.has_permission`, enforces the invariant (ceilings, last owner, supersede-never-update, batch gating, status transitions), writes the audit row and returns ids — all in one transaction. A service that records a *fact the server observed* (a validated AI turn, a scan result, a download, a server-originated job) calls the matching `api_server.*` function through `serverRpc(ctx, 'fn', args)` in `core/db/server-rpc.ts`, which uses the service role and passes the human actor explicitly; the function re-validates the actor in SQL. Services never call `.insert/.update/.delete/.upsert` on a table (lint `no-direct-table-write`); repositories are read-only for the user client. Jobs act as `jobs.requested_by` through `api_server.*` and never call `api.*`. The catalogue is `DATABASE_ARCHITECTURE.md §14`; each service below names the function it calls.
- **Services still assert.** `assertCan` runs in TypeScript before the RPC so the UI gets a fast, typed `PermissionDenied`; the SQL function re-checks so the RPC is safe when called by anything else.
- **Repositories are dumb.** Filters are explicit columns; no string-built SQL; `organization_id` is always the first filter and comes from `ctx.orgId`, never from arguments the caller could forge.
- **Domain is where the truth is.** Calculations, validation rules, dedupe hashing, alert rules, health scoring, grounding and period maths are `domain/` and have no idea a database exists.
- **View models.** Services return UI-ready shapes (`DashboardViewModel`, `AlertCardViewModel`) with money already formatted by `core/money` and periods labelled by `core/periods`, so components never format or compute.
- **Idempotent writes.** Any service that a job may retry accepts an idempotency key and is safe to call twice.
- **Naming.** `verbNoun` for services (`commitBatch`, `runCalculation`), `findX/listX` for repositories, `api.verb_noun` for SQL functions.

---

## 3. AccessContext and request lifecycle

```ts
type AccessContext = {
  userId: string;
  orgId: string | null;                 // null for /platform and /portfolio
  orgSlug: string | null;
  effectiveRole: 'super_admin'|'employee'|'owner'|'admin'|'client'|'suspended_member'|'none';
  permissions: ReadonlySet<Permission>;
  actorType: 'user'|'employee'|'platform_admin'|'system'|'ai';
  db: SupabaseClient;                   // user-session client: SELECT under RLS + rpc('api.*'); it holds no table write privilege
  requestId: string;
  now: () => Date;                      // org timezone-aware via core/periods/clock.ts
};
```

`resolveAccess(session, orgSlug?)` in `tenancy/services/resolve-access.ts` implements the order in `RBAC_MATRIX.md §1` (including organization and membership status, ADR-038.2), throws `NotFound` for `none` (never `Forbidden`, to avoid enumeration), and is memoised per request with `React.cache`.

| Entry point | How context is built | Notes |
|---|---|---|
| Server component under `/app/[orgSlug]` | `layout.tsx` calls `getAccessContext(params.orgSlug)`; children call the same memoised function | Layout also writes the super-admin read audit (`RBAC_MATRIX.md §3.6`) |
| Server action | First line `const ctx = await getAccessContext(orgSlug)` where `orgSlug` comes from a bound argument, then `assertCan`, then one service call | Never trust ids in the form payload for tenancy |
| Route handler (`/api/**`) | `withAccess(handler)` wrapper parses session, slug from the body/route, builds ctx, maps errors (§6) | Streaming handlers (`/api/ai/chat`) build ctx before opening the stream |
| AI tool loop | `resolveAccess` is re-run before **every** tool call; a changed role or permission set aborts the turn (`AI_ARCHITECTURE.md §4`) | The 45 s turn is not a permission cache |
| Job worker | `withOrgScope(job.organization_id, jobId)` — the organization id comes from the `jobs` row, never from `payload`; creates a service-role client, sets `app.current_org`, builds ctx with `actorType='system'` and `userId = job.requested_by` (the human who caused the job); every write goes through `api_server.*` with that actor, which re-validates the permission in SQL; services still run `assertCan` and every repository call asserts `organization_id = orgId` (lint `no-unscoped-service-query`) | Service-role use #3 |
| Storage signer | `withStorageScope(orgId)` asserts every object key starts with `${orgId}/` and requires an audit event id that it verifies (`api_server.record_access_event` row: same actor, same target, < 30 s old) | Request path; lint-confined to `core/storage/signer.ts` |
| Server RPC | `serverRpc(ctx, fn, args)` calls `api_server.*` with `actorUserId = ctx.userId`, `requestId = ctx.requestId` | Request path; lint-confined to `core/db/server-rpc.ts` (ADR-043) |
| Middleware | Session presence and route family only; no DB access | Redirects to sign-in; never authorises |

---

## 4. Boundaries

For each boundary: responsibility · public services (name(inputs) → output [permission] → `api.*` function for writes) · must never · depends on · emits.

### 4.1 auth (`modules/auth`)
Responsibility: Supabase Auth wrappers — sign-in, sign-up, magic link, password reset, session refresh, profile sync, MFA enrolment for platform users (ADR-038.8).
Services: `signIn(creds)`, `signUp(email, password, name)`, `sendMagicLink(email)` (refused for platform users), `resetPassword(email)`, `getSession()`, `enrolTotp(ctx)`, `updateProfile(ctx, patch)` [self → `api.update_profile`; columns limited per ADR-038.3], `disableUser(ctx, userId)` [platform.users.manage → `api.disable_user`; refused for a sole owner].
Never: decide authorization; read tenant tables; write `profiles.email` or `disabled_at` directly.
Depends: core/db. Emits: audit `auth.signed_in`, `auth.password_reset`, `auth.mfa_enrolled`, `profile.updated`, `user.disabled`.

### 4.2 authorization (`core/permissions`)
Responsibility: the matrix (`catalogue.ts`, `matrix.ts`), `can`, `assertCan`, role guards (`canInviteRole`, `canChangeRole`, `canRevokeAssignment`), matrix sync script that also generates the `role_permissions` migration used by `app.has_permission()`.
Never: touch the database; know about routes.
Depends: nothing. Emits: nothing.

### 4.3 tenant context (`modules/tenancy`)
Responsibility: organizations, memberships, invitations, assignments, access resolution, org switcher data, fiscal periods, seeding, deletion lifecycle.
Services: `resolveAccess(session, slug)`; `createOrganization(ctx, input)` → `api.create_organization` [self-serve: any signed-in non-platform user; platform: platform.orgs.manage]; `updateOrganization(ctx, patch)` → `api.update_organization` [settings.manage; `platform_org_settings` excluded]; `listMyOrganizations(ctx)`; `inviteMember(ctx, email, role)` → `api.invite_member` [users.invite + `canInviteRole`; pre-checks existing membership and platform-user exclusivity with friendly errors]; `acceptInvitation(session, token)` → `api.accept_invitation` (re-checks the inviter's current role, compares `auth.jwt()->>'email'`); `changeMemberRole(ctx, userId, role)` → `api.change_member_role` [users.manage + `canChangeRole`]; `removeMember(ctx, userId)` → `api.remove_member`; `initiateOwnershipTransfer` / `acceptOwnershipTransfer` / `cancelOwnershipTransfer` → `api.initiate_ownership_transfer` / `api.accept_ownership_transfer` / `api.cancel_ownership_transfer` [owner / nominee / owner; invariants in SQL per ADR-044.7]; `removeMember` calls `api.remove_member` and then revokes the removed user's other sessions through the Auth admin API in application code (SQL cannot); `createAssignment(ctx, orgId, employeeUserId, endsAt)` → `api.create_assignment` [assignments.manage, super admin with re-auth]; `revokeAssignment(ctx, assignmentId, reason)` → `api.revoke_assignment` [assignments.manage or owner of that org]; `ensurePeriods(ctx, from, to)` [system]; `requestDeletion(ctx)` → `api.request_deletion` [org.delete; trigger enqueues `org.purge` at +30 days]; `cancelDeletion(ctx)` → `api.cancel_deletion` [org.delete; marks the purge job `cancelled`]; `setLastActiveOrg(ctx, orgId)` → `api.set_last_active_org` (only an accessible org).
Never: bypass `canChangeRole`; delete rows; expose emails of other organizations; enqueue `org.purge` from a service.
Depends: auth, audit. Emits: audit `org.created`, `member.invited`, `member.joined`, `member.role_changed`, `member.removed`, `ownership.transferred`, `assignment.created`, `assignment.revoked`, `org.deletion_requested`, `org.deletion_cancelled`.

### 4.4 data access (`core/db`, `core/storage`, `core/jobs`, `modules/*/data`)
Responsibility: `createUserClient(session)`, `createServiceClient()` (jobs + signer only), typed row schemas, `withOrgScope`, `withStorageScope`, `Decimal` parsing at the boundary (ADR-006), pagination helpers, `core/jobs.enqueue` → `api.enqueue_job`.
Never: be imported by `domain/`; format for display; accept string-built filters; write tables from the user client.
Depends: nothing. Emits: nothing.

### 4.5 documents (`modules/documents`)
Responsibility: upload validation (`IMPORT_ENGINE.md §4`), Storage writes through the signer, `source_documents`, signed URLs, text extraction, quarantine.
Services: `uploadDocument(ctx, file, declaredKind)` → validation, then `api_server.register_document` (generates id and path), then Storage write via `withStorageScope` to that path, then `api_server.finalize_upload` (verifies the object, sets `ready`/`quarantined`) [imports.create]; on failure the signer deletes that key only (ADR-043.4); `getDocumentUrl(ctx, documentId)` → `api_server.record_access_event('document.downloaded')` returns the audit id, which the signer verifies before minting the 60 s URL [documents.view] (ADR-043.5); `listDocuments(ctx, filter)` [documents.view]; `extractText(ctx, documentId)` [system, job]; `deleteDocument(ctx, documentId)` → `api.delete_document` (marks `deleted`, returns the path) then object removal via the signer [imports.review; only if unreferenced]; `sendToAi` is not a service — the `document.extract` job writes `document.sent_to_ai` through `api_server.record_access_event` before the first page (ADR-033).
Never: return a URL without an audit event; expose a Storage policy to `authenticated`; parse rows (that is `imports`).
Depends: tenancy, audit. Emits: audit `document.uploaded`, `document.downloaded`, `document.quarantined`, `document.deleted`, `document.sent_to_ai`; job `document.extract`.

### 4.6 imports (`modules/imports`)
Responsibility: the pipeline in `IMPORT_ENGINE.md`.
Services: `startBatch(ctx, documentId, importType, opts)` → `api.start_import_batch` [imports.create]; `parseBatch(ctx, batchId)` [system/imports.review]; `saveMapping(ctx, batchId, mapping)` → `api.save_import_mapping` [imports.review]; `confirmAccountMapping(ctx, batchId, accountMap)` → `api.confirm_account_mapping`; `confirmBalanceBasis(ctx, batchId, basis)` → `api.save_import_mapping` (IMP-TB-012); `setStatementBalances(ctx, batchId, opening, closing)` → `api.set_statement_balances`; `getPreview(ctx, batchId)`; `validateBatch(ctx, batchId)`; `getReview(ctx, batchId, filter)`; `decideRows(ctx, batchId, decisions[])` → `api.decide_import_rows`; `fixRow(ctx, batchId, rowId, patch)` → `api.fix_import_row`; `confirmPdfPage(ctx, batchId, page)` → `api.confirm_pdf_page`; `commitBatch(ctx, batchId)` → `api.commit_import_batch`, or for > 5,000 rows `api_server.enqueue_job('import.commit_large')` with `requested_by = ctx.userId`, whose worker calls `api_server.commit_batch_as(requested_by, batch)` after re-validating that the reviewer still holds `imports.review` [imports.review]; `rejectBatch(ctx, batchId, reason)` → `api.reject_import_batch`; `rollbackBatch(ctx, batchId, reason)` → `api.rollback_import_batch` (promotes dependants' skipped rows into their own batches and resets `superseded_by` on restored rows, ADR-047.1/9) → `api.rollback_import_batch` (refuses when dependants exist); `replaceBatch(ctx, oldBatchId, newBatchId, reason)` → `api.replace_import_batch` [imports.review]; `listBatches(ctx, filter)`; `getCoverage(ctx)` [dashboard.view].
Never: insert into target tables outside `api.commit_import_batch`; drop a row; call Claude except through `ai.extractStatementPage`; offer plain roll back where Replace is required.
Depends: documents, tenancy, banking (bank account lookup/create), financial-engine (enqueue), ai (extraction), audit. Emits: audit `import.started`, `import.mapped`, `import.committed`, `import.rejected`, `import.rolled_back`, `import.replaced`, `import.row_decided`; jobs `document.extract`, `import.commit_large`, `calculation.run`.

### 4.7 banking (`modules/banking`)
Responsibility: bank accounts, categorisation rules, transfer and recurring detection, banking view models, coverage.
Services: `listBankAccounts(ctx)` [banking.view]; `createBankAccount(ctx, input)` → `api.create_bank_account` [financials.edit; refuses a duplicate masked identity, ADR-029.4]; `setOpeningBalance(ctx, accountId, amount, date)` → `api.set_opening_balance` [financials.edit]; `categoriseTransactions(ctx, batchId | range)` [system; writes `category_history` rows]; `overrideCategory(ctx, txnId, accountId)` → `api.override_bank_category` [banking.reconcile; writes `category_history`]; `markTransfer(ctx, txnId, pairId | null)` → `api.mark_transfer` [banking.reconcile]; `detectRecurring(ctx, range)` [system; invoked inside each calculation chunk before health, never as a separately timed job, with `detector_version` in the run fingerprint, ADR-047.11]; `getBankingOverview(ctx, period)` → view model [banking.view]; `listTransactions(ctx, filter, page)` [banking.view; `description_normalized` for clients].
Never: compute cash metrics (financial-engine does, from these rows); edit amounts or dates (corrections go through imports supersession); treat a cash↔card/loan pair as a cash transfer (ADR-028).
Depends: tenancy, financial-engine (read snapshots for the overview), audit. Emits: audit `bank_account.created`, `bank_account.opening_balance_set`, `bank_txn.recategorised`, `bank_txn.transfer_marked`; job `calculation.run` (coalesced, ADR-031.1) after category/transfer changes.

### 4.8 financial calculations (`modules/financial-engine`)
Responsibility: `FINANCIAL_ENGINE.md` — metric registry, precedence, calculation runs, snapshots, `metric_current` pointers, variance, period completeness.
Services: `enqueueCalculation(ctx, trigger, periodFrom, refId)` → `api.enqueue_job('calculation.run')` [system/intelligence.recompute]; `runCalculation(ctx, jobId)` [system, job: `app.aggregate_periods` → domain → snapshots + `metric_current` + `health` → `alerts.evaluate`; marks itself stale and loops when newer changes exist, ADR-031.1]; `getMetric(ctx, key, periodId, dimension?)` [financials.view]; `getMetricTrend(ctx, key, from, to, dimension?)`; `getBreakdown(ctx, key, periodId, dimensionType, limit)`; `getVariance(ctx, key, periodId, compareTo)`; `getDashboard(ctx, periodId)` → `DashboardViewModel` [dashboard.view]; `getDataCoverage(ctx, range)` [dashboard.view]; `explainSnapshot(ctx, snapshotId)` → components with snapshot ids + evidence descriptor [financials.view]; `remapAccount(ctx, accountId, category)` → `api.remap_account` [financials.edit; writes `account_category_history`; coalesced full-range run behind "Apply changes"].
Never: read uncommitted or non-accepted records; compute in the request path (only jobs write snapshots; reads serve `metric_current` rows); return a value without `basis` and `data_quality`; flip `is_current` (there is no such column; pointers are rewritten per run).
Depends: tenancy (periods), banking (read accepted bank rows), audit. Emits: audit `calculation.failed`, `calculation.stale_rerun`; job `alerts.evaluate` on success.

### 4.9 health score (`modules/health`)
Responsibility: dimension rules, weights config, renormalisation, explanations, summary sentence templates (`FINANCIAL_ENGINE.md §7`).
Services: `computeHealth(ctx, runId, periodId)` [system, inside `calculation.run`; condition-based inputs only — never reads `alerts` rows, ADR-035]; `getHealth(ctx, periodId)` → score + breakdown [dashboard.view]; `getHealthHistory(ctx, from, to)`; `getSummarySentence(ctx, periodId)` [dashboard.view].
Never: read raw records (only `metric_snapshots`); read alert statuses; change weights at runtime without a config version bump; score an incomplete period (ADR-030.4).
Depends: financial-engine. Emits: nothing (writes `health_scores` through the job).

### 4.10 alerts (`modules/alerts`)
Responsibility: rule evaluation, dedupe/upsert, revisions, status workflow, evidence bundle creation, conversion to actions.
Services: `evaluateAlerts(ctx, runId)` [system, job; writes `alert_revisions`, ADR-034; state rules keyed by subject, event rules by period, ADR-036; ≤ 25 new alerts per run]; `listAlerts(ctx, filter)` [dashboard.view]; `getAlert(ctx, alertId)` (current revision + history); `setAlertStatus(ctx, alertId, status, reason)` → `api.set_alert_status` [alerts.manage; client → acknowledge only; a severity increase re-opens an acknowledged alert]; `createActionFromAlert(ctx, alertId, input)` → `api.create_action_from_alert` [actions.create].
Rule catalogue (each a `domain/rules/*.ts` exporting `rule_key`, `rule_version`, `kind: 'state'|'event'`, thresholds; canonical definitions in `FINANCIAL_ENGINE.md §8`): `expense.spike_category`, `expense.spike_account`, `revenue.decline`, `margin.deterioration`, `cash.decline`, `cash.runway_low`, `receivables.deterioration`, `payables.deterioration`, `concentration.customer`, `concentration.supplier`, `recurring.amount_changed`, `recurring.missed`, `recurring.new`, `duplicate.transaction`, `bank.unusual_transaction`, `deviation.large_transaction`, `variance.significant`.
Never: compute metrics; delete alerts; rewrite an alert's text in place (revisions only); fire without an evidence bundle; fire variance rules on `basis_differs` or incomplete periods (ADR-030).
Depends: financial-engine, health, banking, evidence, audit. Emits: audit `alert.status_changed`, `alert.reevaluated` (severity before/after), `alert.converted_to_action`.

### 4.11 evidence (`modules/evidence`)
Responsibility: bundles/items, descriptor resolution with as-of semantics, derived-metric evidence, drill-down chain (`EVIDENCE_MODEL.md`).
Services: `createBundle(ctx, kind, origin, items[])` [system/ai/user context; via `api_server.ai_persist_turn` for AI bundles, job writers otherwise]; `getBundle(ctx, bundleId)` [financials.view; documents stripped for client; `ai_response` bundles require the origin owner or org owner/admin]; `resolveDescriptor(ctx, descriptor | descriptorHash, page)` → records as of the run [financials.view]; `traceRecord(ctx, type, id)` → import row, batch, document, source_ref [financials.view; document only with documents.view]; `getMetricEvidence(ctx, snapshotId)` (leaf descriptor or derived components).
Never: fabricate a descriptor; accept a descriptor from the model or the browser (hash only); return records outside `ctx.orgId`; resolve by current category when `as_of` is set.
Depends: financial-engine, banking, documents, imports (read). Emits: audit `evidence.viewed` (when a document is opened from evidence).

### 4.12 AI (`modules/ai`)
Responsibility: `AI_ARCHITECTURE.md` — chat, tools, grounding v2, evidence, feedback, quotas, extraction service for PDFs.
Services: `chat(ctx, conversationId | null, message)` → async iterable of stream events [ai.use; `api.create_conversation` for a new thread; `findConversation` bound to `(orgId, userId)`; `resolveAccess` per tool call; persistence of the user turn and of everything the server observed — structured response, grounding status and report, tool-call log, bundle — through `api_server.ai_persist_turn` via `serverRpc`, so no user JWT can write a "passed" answer (ADR-043; R2-A-01)]; `listConversations(ctx)`; `getConversation(ctx, id)` [owner of the conversation, or org owner/admin, read-only]; `submitFeedback(ctx, messageId | alertId, type, comment)` → `api.submit_ai_feedback` [ai.use]; `reviewFeedback(ctx, feedbackId, status, note)` → `api.review_ai_feedback` [platform.ai_feedback.review]; `extractStatementPage(ctx, documentId, page)` → schema rows [system, job; checks `ai_extraction_pages_per_day` and the token ceiling before each page; writes only `import_rows`/`import_batches`].
Never: import Supabase outside `data/`; accept an org id, user id or descriptor from the model; write actions/alerts/records; stream or store pre-`submit_answer` text; read quotas from `organizations.settings`.
Depends: financial-engine, health, alerts, evidence, banking, actions, documents, audit. Emits: audit `ai.answered`, `ai.refused`, `ai.context_changed`, `ai.feedback_submitted`, `ai.feedback_reviewed`; writes `ai_conversations`, `ai_messages`, `ai_tool_calls`, `ai_feedback` through `api_server.ai_persist_turn`.

### 4.13 actions (`modules/actions`)
Responsibility: Action Centre (SOW §17).
Services: `createAction(ctx, input)` → `api.create_action` [actions.create]; `createFromRecommendation(ctx, messageId, index)` → `api.create_action_from_recommendation` [actions.create; **refused unless the message's `grounding_status = passed`**, ADR-032.5; copies the three Statement texts and clones the bundle]; `assignAction(ctx, actionId, ownerUserId)` → `api.assign_action` [actions.assign; owner must be member/assigned employee]; `updateAction(ctx, actionId, patch)` → `api.update_action` [actions.create, or actions.update_own when owner = self, limited fields]; `setStatus(ctx, actionId, status, outcome?)` → `api.set_action_status`; `listActions(ctx, filter)` [actions.view]; `getActionsSummary(ctx)` for Home.
Never: delete; allow a client to reassign; create an action from a degraded or failed answer.
Depends: evidence, tenancy, audit. Emits: audit `action.created`, `action.assigned`, `action.status_changed`, `action.completed`.

### 4.14 reporting (`modules/reporting`)
Responsibility: Monthly Management Report (ADR-024) view model and PDF render job.
Services: `getMonthlyReport(ctx, periodId)` → `ReportViewModel` [reports.view; complete periods only]; `requestPdf(ctx, periodId)` → `api.enqueue_job('report.render')` → jobId [reports.generate]; `getReportFile(ctx, reportFileId)` → signed URL [reports.view; resolved by `(organization_id, id)` in `report_files`; `api_server.record_access_event('report.downloaded')` first, its id verified by the signer; bucket `reports`, ADR-038.7]. Exports (`/api/exports/[kind]`) likewise write `export.created` through `record_access_event` before streaming.
Never: compute; call Claude in MVP; mint a URL from a `jobs` id.
Depends: financial-engine, health, alerts, actions, evidence. Emits: job `report.render`; audit `report.generated`, `report.downloaded`; writes `report_files` (job).

### 4.15 audit (`modules/audit`)
Responsibility: querying the append-only log for the org audit page and platform search. Writing is not a service: every `api.*` function and every job writes through the internal `app.audit()`, whose actor, organization, ip, user agent and request id are derived inside the function and cannot be supplied by a caller (ADR-026.5).
Services: `listOrgEvents(ctx, filter, page)` [audit.view]; `searchPlatformEvents(ctx, filter)` [system.manage; `before/after` omitted for tenant rows until expanded, which writes `org.data_viewed`].
Never: expose an insert path; update or delete; store financial payloads for super-admin view events (metadata only); store emails, filenames or free text in `metadata` (ids only, ADR-038.9).
Depends: nothing. Emits: nothing.

### 4.16 portfolio (`modules/portfolio`)
Responsibility: read-only aggregate projections for `/portfolio` and `/platform/organizations` (ADR-038.13, F-D-16).
Services: `list(ctx)` → one statement each over current `health_scores`, open alert counts by severity and last committed batch, filtered by `organization_id IN (select app.accessible_org_ids())`, cached with `unstable_cache` tagged per organization [assignments.view or platform.orgs.manage].
Never: write; resolve per-organization context (that happens on navigation into an organization); aggregate across organizations the caller cannot access (RLS makes this impossible by construction).
Depends: tenancy, health, alerts, imports (read). Emits: nothing.

---

## 5. Background jobs

> **Revision 1.2 (ADR-041, ADR-047.7).** `calculation.run` is chunked: payload `{ trigger, triggerRefId, periodFrom, periodTo, cursor?, runId?, restart_from? }` (the organization comes from the `jobs` row, never from the payload); a chunk processes ≤ `CHUNK_PERIODS` months, then enqueues the next chunk with the same `runId` under the **same idempotency key `orgId`** that every calculation job uses, so at most one calculation job per organization is queued and runs never interleave; chunk bodies run in Supabase Edge Function background tasks within ≤ 1,500 CPU-ms and ≤ 60 s wall-clock; Vercel route handlers never run chunks. (ADR-020, ADR-026.4, ADR-031)

- **Table:** `jobs` (`DATABASE_ARCHITECTURE.md §9`), statuses `queued | running | succeeded | failed | dead | cancelled`.
- **Enqueue (ADR-043.3).** Two entry points, both SECURITY DEFINER. `api.enqueue_job(org, job_type, payload)` is user-callable for `calculation.run` (trigger forced to `recalc_manual`, permission `intelligence.recompute`) and `report.render` (`reports.generate`) only. `api_server.enqueue_job(actor, org, job_type, payload)` is called from server code through `serverRpc` for `document.extract` and `import.commit_large` (actor must hold `imports.review`), by workers for `alerts.evaluate`, `calculation.run` with any trigger and the platform jobs, and never for `org.purge`. Both validate `org` against the actor's accessible set **and** against the payload row (`batchId` → the batch's organization, `documentId`, `runId`, `periodId`), allow-list payload keys per type, derive `asOf`, `trigger` and `requested_by` (= the actor) rather than accept them, and merge idempotently among queued jobs. `org.purge` is inserted only by the trigger on `organizations.status → 'pending_deletion'` with `run_after = now() + 30 days`; `api.cancel_deletion` marks it `cancelled`; `api.requeue_job` refuses a purge unless the organization is still `pending_deletion` with a recorded request time (ADR-044.6).
- **Idempotency (ADR-047.7):** `(job_type, idempotency_key)` unique **among `queued` rows only**. Every `calculation.run` job — first chunk or continuation — carries the key `orgId`. A collision with a queued *first chunk* merges `payload.periodFrom = LEAST(existing, new)`; a collision with a queued *continuation* merges `payload.restart_from = LEAST(existing, new)`: the continuation finishes its chunk, marks the run `superseded`, and enqueues a fresh first chunk from `restart_from`. A chunk that finds `metric_current` for its boundary period pointing at another run exits `superseded`. A commit landing while a run is executing is caught by the stale check after the final chunk. `import_batches.calculation_job_id` records the job that will include the batch; `calculation_run_id` is written only by the run that did.
- **Worker:** `POST /api/jobs/run` (Vercel Cron every minute, plus an immediate `fetch` "kick" after enqueue with `waitUntil`), secured by a bearer secret; first runs `app.reclaim_stale_jobs()` (any `running` job whose `locked_at < now() − max_runtime(job_type) × 3` returns to `queued` with `attempts + 1`, ADR-044.6); then claims up to 5 jobs with `UPDATE … WHERE status='queued' AND run_after <= now() ORDER BY run_after FOR UPDATE SKIP LOCKED RETURNING *`, sets `locked_at/locked_by`, runs each inside `withOrgScope(job.organization_id)` — the organization comes from the row, every id in `payload` is looked up `(organization_id, id)`, and every write the job performs goes through `api_server.*` as `jobs.requested_by` — and marks `succeeded`/`failed`. Jobs whose organization is `suspended` or `pending_deletion` are requeued with backoff instead of run, except `org.purge`, which additionally waits until no other job for the organization is `running` and re-verifies `status = 'pending_deletion' AND deletion_requested_at <= now() - interval '30 days'`.
- **Runtime (ADR-031.4, ADR-041, ADR-047.7, CD-34).** Because L0 aggregation runs in SQL (`app.aggregate_periods`), chunk CPU in the worker is proportional to periods × dimensions, not rows. `calculation.run` chunks, `document.extract`, `import.commit_large` and `org.purge` run in Supabase Edge Function background tasks; the budget per calculation chunk is **≤ 1,500 CPU-ms and ≤ 60 s wall-clock** (NFR-04), and Vercel route handlers only drain short jobs. Spike S5 (`IMPLEMENTATION_PLAN.md §3`) verifies one 12-period chunk of `golden-mixed` against the CPU-ms budget in that runtime in Phase 0; fallback `CHUNK_PERIODS` 6, then CD-34.
- **Stale runs and stale locks (ADR-047.7).** On **every worker tick** (not only before a new run) the sweep inspects `calculation_runs` rows `running` whose latest chunk started longer than budget × 3 ago: if their continuation job is missing it is re-enqueued from `progress.cursor` (`attempts + 1`); after `max_attempts` the run is marked `failed (worker_lost)` and `metric_current` for its whole range is restored from `previous_snapshot_id`. The same sweep returns `committing` batches whose job is dead to `awaiting_review` (`error_summary.stage = 'commit'`). Chunk bodies are idempotent (they first delete their own run's snapshots for the chunk). A run that finishes and finds a batch commit/rollback, banking edit, `record_status_events` row (supersession, rejection, restore) or counterparty merge newer than its `started_at` re-runs immediately for the affected range (`calculation_runs.stale = true`, audit `calculation.stale_rerun`; the `record_superseded` and `counterparty_merged` triggers set the flag, ADR-046.2). The run records `as_of_ts` at its aggregation step; evidence resolves as of that instant. The Home banner is driven by "a `queued`/`running` job exists for this organization", never by `calculation_runs.status`.
- **Job types and payloads:**

| Type | Payload | Handler | Idempotency key |
|---|---|---|---|
| `calculation.run` | `{ trigger, triggerRefId, periodFrom, periodTo, cursor?, runId?, restart_from? }` (`asOf` derived by the worker) | financial-engine.runCalculation: fingerprint before writes (`no_change` short-circuit) → per chunk `app.aggregate_periods` → `banking.detectRecurring` → snapshots + `metric_current` (with `previous_snapshot_id`) → health for complete periods → next chunk; final chunk enqueues `alerts.evaluate` and runs the stale check; `scheduled` trigger = current period, `as_of_dependent` keys only (ADR-047.8) | `orgId` (first chunk merges `periodFrom`; continuation merges `restart_from`) |
| `alerts.evaluate` | `{ runId }` | alerts.evaluateAlerts (revisions, state/event keys, ≤ 25 per run) | `orgId:runId` |
| `document.extract` | `{ documentId, batchId, method: 'pdf_text'|'pdf_claude', pages?: number[] }` | documents.extractText → (pdf_claude) ai.extractStatementPage per page with quota checks → imports.parseBatch; `deferred_upstream` on provider outage; `max_attempts 8`, backoff capped at 15 min | `documentId:method` |
| `import.commit_large` | `{ batchId }` (actor = `jobs.requested_by`) | `api_server.commit_batch_as(requested_by, batchId)`: re-validates that the reviewer still holds `imports.review`, then runs the commit logic under the org lock, audited as that reviewer with `metadata.via_job` | `batchId` |
| `report.render` | `{ periodId }` (actor = `jobs.requested_by`) | reporting render → bucket `reports/{org}/{period}/{job}.pdf` → `report_files` row | `orgId:periodId:date` |
| `org.purge` | `{}` | tenancy purge (Storage prefixes `source-documents/{org}/` and `reports/{org}/`, then rows, then audit redaction per ADR-038.9); trigger-enqueued only | `orgId` |
| `storage.cleanup_orphans` | `{}` | nightly: delete objects with no `source_documents`/`report_files` row older than 24 h | `date` |
| `snapshots.compact` | `{}` | weekly: remove `metric_snapshots` not referenced by `metric_current`, `evidence_items`, `health_scores`, `alerts` or `alert_revisions` and older than 90 days (ADR-031.5, ADR-047.8 — the single retention figure) | `date` |
| `ai.eval` | `{ promptVersion }` | ai eval harness (CI/nightly) | `promptVersion` |

- **Retries:** exponential backoff `30s · 2^attempts` up to `max_attempts` (3; `calculation.run` 5; `document.extract` 8 with the cap above). Non-retryable errors (`ValidationError`, `PermissionDenied`, `QuotaExceeded`) go straight to `dead`.
- **Dead letter:** `status = dead` rows appear in `/platform/jobs` with the error; a super admin can requeue or, for `import.commit_large`, reset the batch; both emit audit `job.requeued` / `import.batch_reset` (ADR-038.11). Dead `calculation.run` jobs also set a dashboard banner for the organization ("figures may be out of date").
- **Observability:** each job logs `job_id`, `org_id`, `type`, `attempt`, duration; metrics for queue depth, oldest queued age, failure rate, stale re-runs; alert to platform when oldest queued > 10 min.

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
2. `getAccessContext` → `assertCan(ctx,'imports.review')` → `imports.commitBatch` → `ctx.db.rpc('api.commit_import_batch', { batch_id })`.
3. Inside the function: preconditions re-validated, org advisory lock, duplicate re-check, records inserted with `record_status = accepted`, invoice/balance supersession, `record_status_events`, rows linked, batch `period_start/period_end` set, `import_mappings` upserted, audit `import.committed`, `api.enqueue_job('calculation.run')` → `calculation_job_id`; one transaction.
4. Worker: `withOrgScope(job.organization_id)` → `financial-engine.runCalculation`: `app.aggregate_periods` → domain engine → `metric_snapshots` (append) + `metric_current` rewritten for the range → `health.computeHealth` → `health_scores`; run checks for newer changes and loops if stale; `import_batches.calculation_run_id` set for every batch the run included.
5. Same job enqueues `alerts.evaluate` → rules read `metric_current` snapshots → `alert_revisions` + `evidence` bundles → upsert `alerts` by `dedupe_key` (state or event key).
6. Next.js `revalidateTag('org:{id}:metrics')`.
7. Home server component calls `financial-engine.getDashboard(ctx, latestCompletePeriod)` → view model from `metric_current`, `alerts.listAlerts`, `actions.getActionsSummary` → rendered. No arithmetic in React.

### 7.2 AI question → answer → action
1. User submits in AI Analyst → `POST /api/ai/chat`.
2. `withAccess` → `assertCan(ctx,'ai.use')` → `ai.chat` (quota from `platform_org_settings`, `findConversation` bound to org and user, period resolution to the latest complete period).
3. Tool loop: each call `resolveAccess` → `assertCan` → module service (e.g. `financial-engine.getMetric`) → typed, branded result with untrusted text wrapped → `ai_tool_calls` row.
4. Forced `submit_answer` → Zod → grounding v2 → `evidence` bundle from surviving statements → `api_server.ai_persist_turn` → `audit('ai.answered')` → single answer event streamed.
5. User clicks "Create action" (enabled only for `passed`) → server action → `actions.createFromRecommendation(ctx, messageId, index)` → `api.create_action_from_recommendation` re-checks `grounding_status`, copies title/issue/recommendation/priority, sets `source_type='ai'`, `source_id=messageId`, clones the bundle → `audit('action.created')`.
6. Owner assigns and sets a due date → `actions.assignAction` → `api.assign_action` → the Home widget and Actions page read `listActions`.

### 7.3 Employee revoked mid-session
1. Owner clicks Revoke on Settings → Team → `tenancy.revokeAssignment` → `api.revoke_assignment` → row `status='revoked'` → audit in org log and platform log.
2. Employee's next request: `resolveAccess` finds no active assignment → `effectiveRole='none'` → `NotFound` → the org disappears from `/portfolio`; any open page shows the not-found state on next navigation or server action.
3. RLS: the employee's JWT no longer resolves the org in `app.accessible_org_ids()`, so even a stale client-side fetch returns zero rows; no table write privilege exists to abuse.
4. In-flight AI turn: `resolveAccess` before the next tool call detects the change and aborts the turn with the fallback message; `ai_tool_calls` records `context_changed`.
5. Nothing the employee created is deleted; `actor_type='employee'` audit rows remain.

### 7.4 Second import committed while a run is executing (F-D-01)
1. 09:00:10 batch A (March GL) commits → `api.enqueue_job('calculation.run', periodFrom = Mar)` → job J1 queued → worker starts J1 at 09:00:12 (`calculation_runs` R1 `running`, `started_at` 09:00:12).
2. 09:00:40 batch B (January TB) commits → `api.enqueue_job` finds no `queued` sibling (J1 is `running`) → inserts J2 (`periodFrom = Jan`); `import_batches.calculation_job_id = J2`.
3. R1 finishes at 09:01:05 and, before releasing the lock, checks for batches committed/rolled back or banking edits after 09:00:12: finds B → marks R1 `stale = true`, audit `calculation.stale_rerun`; J2 is already queued so no new job is needed (had J2 not existed, R1 would have re-enqueued for the affected range).
4. J2 runs R2 from January onward; `metric_current` for Jan–latest now reflects both batches; B's `calculation_run_id = R2`; A's stays R1 (still valid for March data, superseded by R2's pointers).
5. Home reads `metric_current` only, so at no point did it show figures that excluded committed data as "current" without a queued/running job banner.

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
10. **No direct table writes anywhere in `services/`.** Lint `no-direct-table-write`: `.insert/.update/.delete/.upsert` on the user client is forbidden; writes are `ctx.db.rpc('api.*')` (ADR-026). The user client's Postgres role has no write grant, so the rule is also enforced by the database.
11. **Service-role client only in `data/jobs/**` and `core/storage/signer.ts`.** Lint `no-service-client-outside-jobs`.
12. **Quotas and platform settings are read from `platform_org_settings`/`platform_settings`, never from `organizations.settings`.** Lint: string literal `'ai_quota'` allowed only in `core/permissions` and `ai/services/quota.ts`.
13. **No `api_server.*` call outside `core/db/server-rpc.ts`.** Lint `no-api-server-outside-server-rpc`: the string `api_server.` may appear only in that file and in migrations; services call `serverRpc(ctx, fn, args)`, which always injects the human actor and request id (ADR-043).

---

## 9. Observability

- **Logs:** structured JSON via `core/logging`, fields `request_id`, `org_id`, `user_id` (hashed in production logs), `route`, `service`, `duration_ms`, `error.code`; never amounts, descriptions or document text.
- **Metrics:** request latency per route, job queue depth/age, calculation run duration by period count, AI grounding pass rate, tool denial count, import commit counts and failure codes, Storage bytes per org.
- **Tracing hooks:** `withSpan(name, fn)` around services and jobs; `request_id` propagated into jobs' payload and Claude request metadata.
- **Alerts to platform:** dead jobs, grounding pass rate < 95% over 1 h, any `PermissionDenied` from an AI tool spike, RLS policy errors (`42501`) anywhere.
- **Audit ≠ logs:** audit is a product feature stored in Postgres; logs are operational and expire.
