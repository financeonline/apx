# MOTION — Production Audit

Audited: `main` at `6212e89`, 2026-09-08. Local Supabase (`supabase_db_MOTION`, Postgres 17), 57 migrations applied.
Reviewer stance: hostile. Nothing below is a style preference; every finding is either executed against the live database or traced to a specific line.

Against: `PRODUCT_REQUIREMENTS.md`, `RBAC_MATRIX.md`, `TENANCY_MODEL.md`, `SECURITY_MODEL.md`, `FINANCIAL_ENGINE.md`, `EVIDENCE_MODEL.md`, `AI_ARCHITECTURE.md`, `MVP_SCOPE.md`.

**Method.** Read the tenancy/permission core, middleware, every route handler, the signer, and all 95 `api.*` / 21 `api_server.*` function bodies as installed (not as written in migrations). Dumped every RLS policy and grant. Ran live probes with real JWTs through PostgREST for the suspension, evidence-poisoning and RLS-cost cases; probe fixtures were removed afterwards (0 rows left). Nothing in the repository was changed.

**Remediation (2026-09-08, ADR-065 to ADR-075).** Every finding below except H3 is fixed on `main`, one commit per phase, each gated by the full suite. Rows in the summary carry `· fixed`; each section opens with a **Status** line naming the migration/ADR. H3 is being built phase by phase (ADR-076–082: the AI analyst is complete — persistence, tools, loop, route, page, evaluation harness and review queue; ADR-080 fixed the engine's missing variances on the way); the PDF path is in — text-layer (ADR-083, which also fixed N3–N6 below) and Claude-assisted with review (ADR-084, ADR-085); CSV export (ADR-086) and the Documents page (ADR-087) are in; the remaining platform pages follow. N1 below was found after the audit by that work.

---

## Summary

| # | Severity | Finding |
|---|---|---|
| C1 | **Critical** · *fixed* | Every tenant-data RLS policy evaluates `app.org_role(organization_id)` **per row**. A member's `count(*)` over 50,000 ledger rows takes **22.7 s**. → 12 ms after ADR-065. |
| C2 | **Critical** · *fixed* | Any member with `financials.view` — a **client** included — can write a fabricated, immutable evidence bundle for any metric via `api.build_metric_bundle`; owners then see it as the system's evidence. No audit event. → function dropped; server-side builder verifies every item against the figure's own tree (ADR-066). |
| C3 | **Critical** · *fixed* | `org.purge` has no job handler. "Delete this organisation" schedules a job that will die. Customer data is never deleted, and nothing surfaces the dead job. → handler + `api_server.purge_organization` + `/platform/jobs` (ADR-067). |
| H1 | High · *fixed* | A suspended organisation's "frozen Home" (promised by four documents) cannot render: the rows it needs are denied to `suspended_member`. Members see "add your first file" under the suspension banner. → periods and the current snapshots admit the role; Home skips the record test while suspended (ADR-068). |
| H2 | High · *fixed* | Open redirect in `/auth/callback?next=/\evil.com`. → one parse-then-compare rule in `core/routing`, used by all three `next` consumers (ADR-069). |
| H3 | High | MVP scope gaps: no AI Analyst at all (acceptance criteria 9–12 unmeetable), PDF import refused, no CSV export, no Documents page (uploaded files cannot be deleted from the UI), no platform jobs/audit/feedback/settings pages. |
| M1 | Medium · *fixed* | Upload route buffers the whole multipart body before the 25 MB check; the comment claims the opposite. No throttle on upload. → header-first limit, 20/h + 100/day throttles (ADR-070). |
| M2 | Medium · *fixed* | Errors swallowed: evidence drawer turns every failure (500, 429) into 404; three platform pages discard query errors and render "empty". → only NOT_FOUND is a 404; query errors throw (ADR-070). |
| M3 | Medium · *fixed* (was worse) | Commit-time duplicate re-check runs pass 2 only; contract §9.3 promises passes 1 and 2. A concurrent invoice commit surfaces as a raw `23505` message. → every invoice update collided at commit; insert-pending→supersede→accept + pass 1 at commit (ADR-073). |
| M4 | Medium · *fixed* | `api_rate_limits` grows without bound (one row per user × bucket × minute, never deleted). → pruned nightly by the platform sweep, which is now actually scheduled (ADR-074). |
| M5 | Medium · *fixed* | `api.cancel_job` lets an owner/admin cancel *any* queued job of their org, including `org.purge`; only a super admin can requeue. → limited to the two user-requestable types and to the requester (ADR-071). |
| M6 | Medium · *fixed* | Audit log UI shows the latest 100 events with no paging, filter or target — the SQL supports offset/500. → offset paging + target column (ADR-072). |
| N1 | High · *fixed* | Found after the audit, by ADR-078's route test: the middleware redirected every anonymous `/api/*` call to `/sign-in`, so `/api/jobs/run` and `/api/jobs/nightly` — called by Vercel Cron with no session — would never have run in production; the e2e helper called them from a signed-in page. Cron routes are now public to the middleware (they authenticate themselves, ADR-074) and anonymous `/api/*` answers 401 JSON per ROUTE_ARCHITECTURE §237. → ADR-078. |
| N2 | High · *fixed* | Found after the audit by the eval corpus recorder: the engine never wrote `B.variance.*` snapshots — `computeVariance` existed, was tested, and had no caller — so every variance-based health rule, alert rule, the growth metrics, the change line and the analyst's change tools read nothing. The audit's fixtures were single months, which is why it did not show. → ADR-080. |
| N3 | High · *fixed* | `api_server.fail_import_batch` never worked (text assigned to an enum column, 42804): no parse or validation failure ever marked a batch `failed` with its reason. → ADR-083. |
| N4 | High · *fixed* | The §6.4 date transform was never called by the pipeline: every non-ISO date column failed `IMP-DATE-001` on every row. → ADR-083. |
| N5 | High · *fixed* | The §6.4 number transform was never called: a thousands separator dropped the cell from the sum, so such statements could not reconcile. → ADR-083. |
| N6 | Medium · *fixed* | `source_documents.has_text_layer`/`page_count` were probed at upload and never written; `import_batches.extraction_method` was never set (XLSX stamped `csv`); the header line was validated as a data row. → ADR-083. |
| L1–L6 | Low · *all fixed* | Fail-open middleware comment, dead-end `fix_import_row`, absent session revocation, silent depth truncation in the signer, stale promise in `revoke_assignment`, missing audit on bundle creation. → ADR-075 (L1–L5), ADR-066 (L6). |

---

## Critical

### C1 · RLS cost is linear in rows × a SECURITY DEFINER function call

**Status: fixed** — migration `20260908000001_rls_set_membership.sql`, ADR-065. Same read after: 12 ms (from 22,724 ms). Guarded by the migration's own check and by pgTAP `06_financial_rls` (plan shape asserted).

**Location.** 21 policies of the form `app.org_role(organization_id) = ANY(...)` and 4 of the form `app.has_permission(organization_id, ...)` — `ledger_entries`, `bank_transactions`, `invoices`, `period_balances`, `metric_snapshots`, `import_rows`, `evidence_bundles`, `counterparties`, … (`select relname from pg_policy … where polqual like '%app.org_role(organization_id)%'`). Helpers: `app.org_role()` → `app.accessible_org_roles()` (three-way UNION with joins), both `SECURITY DEFINER`.

**Problem.** `organization_id IN (select app.accessible_org_ids())` is a hashed subplan and costs nothing. The second predicate, `app.org_role(organization_id)`, takes a column argument and is therefore re-executed for every candidate row. Each execution runs `accessible_org_roles()` — three unions over `organizations`, `organization_assignments`, `platform_users`, `organization_memberships` — inside the RLS filter.

**Measured.** 50,000 accepted `ledger_entries` in one organisation, read as its owner via a real `authenticated` JWT:

```
select count(*) from public.ledger_entries where organization_id = $org;
 Seq Scan on ledger_entries (actual rows=50000)
   Filter: (… AND (app.org_role(organization_id) = ANY ('{owner,admin,employee,super_admin,client}')))
   Buffers: shared hit=901017
 Execution Time: 22724.800 ms
```

The same shape with an `entry_date` range: 22,169 ms. ~0.45 ms per row, 18 buffer hits per row, all spent inside the policy function.

**Why it matters.** Every page under `/app/[orgSlug]` reads under these policies with the user's client. A small business with two years of bank statements (~20–50k rows) gets a 10–25 s page. The engine reads through `api_server.*` (service role, no policy) so it is unaffected — which means the dashboard will be the thing that times out, not the calculation. Next's `maxDuration` and Vercel's function limits will convert this into 504s, not slowness.

**Reproduction.**
```sql
-- as postgres, in the local DB
do $$ declare v_uid uuid := gen_random_uuid(); v_org uuid; v_p uuid; v_a uuid; begin
  insert into auth.users (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
  values (v_uid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','perf@x.test','x',now(),now(),now());
  perform set_config('request.jwt.claims', json_build_object('sub',v_uid,'role','authenticated','email','perf@x.test','aal','aal1')::text, true);
  perform set_config('role','authenticated',true);
  v_org := api.create_organization('Perf');
  perform set_config('role','postgres',true);
  select id into v_p from fiscal_periods where organization_id=v_org and period_start='2026-05-01';
  select id into v_a from accounts where organization_id=v_org and standard_category='revenue' limit 1;
  insert into ledger_entries (organization_id,entry_date,period_id,account_id,direction,amount,currency,description,record_status,assurance_level)
  select v_org,'2026-05-01'::date+(g%28),v_p,v_a,'credit',100+(g%900),'GBP','row '||g,'accepted','verified' from generate_series(1,50000) g;
  perform set_config('probe.uid',v_uid::text,false); perform set_config('probe.org',v_org::text,false);
end $$;
select set_config('request.jwt.claims', json_build_object('sub',current_setting('probe.uid'),'role','authenticated','email','perf@x.test','aal','aal1')::text, false);
set role authenticated;
explain (analyze, buffers) select count(*) from ledger_entries where organization_id = current_setting('probe.org')::uuid;
```

**Recommended fix.** Make the role predicate a set-membership test on a value computed once per statement, never per row:
```sql
using (organization_id in (select r.organization_id from app.accessible_org_roles() r
                            where r.role in ('owner','admin','employee','super_admin','client')))
```
The planner hashes the subquery (as it already does for `accessible_org_ids()`), and the `SECURITY DEFINER` call runs once. Same treatment for `app.has_permission(organization_id, …)` policies (`import_*`, `report_files`): `organization_id in (select r.organization_id from app.accessible_org_roles() r join role_permissions rp on rp.role = r.role where rp.permission = '…')`. Re-run the pgTAP suite (the semantics are identical) and add a perf gate: a member read over 50k rows must plan without a per-row function call.

---

### C2 · A client can author the evidence the owner sees

**Status: fixed** — migration `20260908000002_metric_bundle_server_side.sql`, ADR-066. `api.build_metric_bundle` is dropped; `api_server.build_metric_bundle_as` re-derives the snapshot's tree and refuses any item outside it; unique index per snapshot; audited; the drawer verifies every stored descriptor hash on read.

**Location.** `api.build_metric_bundle(p_snapshot, p_items jsonb)` — `SECURITY DEFINER`, granted to `authenticated`, permission `financials.view` (which the `client` role holds). Consumer: `src/modules/evidence/services/build-metric.ts:239`. Renderer: `src/app/app/[orgSlug]/evidence/[bundleId]/page.tsx:264` (`block.label`), `src/modules/evidence/services/drawer.ts:335–360` (resolves `query_descriptor` and prints a reconciliation sentence against it).

**Problem.** The function validates only that each `item_type` is in the metric vocabulary. Every other field — `label`, `claim`, `query_descriptor`, `descriptor_hash`, `assurance_level` — is written verbatim from the caller's JSON. The bundle is then (a) attributed `created_by_type = 'system', created_by = null`, (b) immutable (`append_only_guard`), (c) returned to every later caller for that snapshot ("idempotent by (organization, snapshot)"), and (d) not audited. The application computes the items server-side, but the function is reachable directly through PostgREST with any member JWT.

**Executed.** Organisation with an owner and a client; one `revenue` snapshot. The client called the function with a `query` item labelled `FABRICATED BY CLIENT`, claim text `Revenue was £1 and the owner is lying`, and a descriptor selecting **payroll** rows. Then the owner opened the figure exactly as the drawer does:

```
client build_metric_bundle → bundle b69629d9-…
owner  build_metric_bundle → bundle b69629d9-…  (SAME bundle as the client made)
owner sees: [{metric_snapshot "Revenue"}, {query "FABRICATED BY CLIENT", claim "Revenue was £1 …", descriptor {table: ledger_entries, categories: [payroll]}}]
bundle attribution: {"created_by_type":"system","created_by":null}
audit rows for evidence_bundles: 0
```

The drawer will resolve the payroll descriptor, show payroll rows as the evidence behind revenue, and print "does not reconcile" — a system-attributed statement that the owner's revenue figure has no support. A `ref_id` pointing at another organisation is caught (`same_org_ref_item`, `20260905000018_triggers_financial.sql:152`); descriptor content is not.

**Why it matters.** `EVIDENCE_MODEL.md` §8.6/§9 makes the bundle the thing an owner, an accountant or a lender can rely on; the function's own comment says items reaching it are "evidence nobody produced" only if the *type* is wrong. A disgruntled client (the least-privileged tenant role) can permanently attach a false statement, under the system's name, to any figure in the organisation — including the ones the Monthly Management Report is built from. There is also no unique index on `(organization_id, kind, origin_table, origin_id)`, so the "loser of the race discards its own" comment is untrue: two concurrent first clicks produce two bundles.

**Reproduction.** With a client JWT: `POST /rest/v1/rpc/build_metric_bundle` (schema `api`) with `p_snapshot = <any snapshot id in the org>` and `p_items = [{item_type:'query', label:'…', claim:'…', query_descriptor:{…}, descriptor_hash:'<sha256 hex>', assurance_level:'verified'}]`. Then open `/app/{slug}/evidence/{bundle}` as the owner.

**Recommended fix.** Move bundle construction behind `api_server` (the walk in `build-metric.ts` already runs on the server): `api_server.build_metric_bundle_as(p_actor, p_snapshot)` that re-derives items from `metric_snapshots.evidence_query` itself and accepts no item payload — the snapshot is its own evidence root (ADR-034), so the caller has nothing legitimate to add. Revoke `api.build_metric_bundle` from `authenticated`. Add a unique index on `evidence_bundles (organization_id, kind, origin_table, origin_id)` where `kind = 'metric'`, and audit `evidence.bundle_built` with the actor. Until then, the drawer must at minimum verify `descriptor_hash` against a canonical re-hash of `query_descriptor` and refuse a descriptor whose `table`/`categories` are not those of the snapshot's own `evidence_query`.

---

### C3 · Organisation deletion never happens

**Status: fixed** — migration `20260908000003_org_purge.sql`, handler `src/modules/jobs/handlers/org-purge.ts`, `/platform/jobs`, ADR-067. Integration-tested end to end: rows, objects, audit redaction, refusals, idempotence, and the queue path.

**Location.** Trigger `app.enqueue_purge_on_deletion` (`20260905000007_triggers.sql:200`) enqueues `org.purge` with `run_after = now() + 30 days`. Registered handlers (`src/modules/jobs/handlers/index.ts`): `calculation.run`, `alerts.evaluate`, `import.commit_large`, `report.render`, `storage.cleanup_orphans`. `src/modules/jobs/services/worker.ts:53` fails any other type with "No handler is registered for …". `api_server.claim_job` explicitly lets `org.purge` through for non-active organisations, so it *will* be claimed.

**Problem.** Thirty days after an owner confirms deletion on `/settings/danger`, the job runs three times (`max_attempts = 3`), fails three times, and is marked `dead`. `TENANCY_MODEL.md` §34 promises: remove Storage objects, hard-delete tenant rows, redact `audit_events`. None of it occurs. There is no `/platform/jobs` page (MVP §2.2 lists a jobs monitor), so nobody sees the dead job.

**Why it matters.** The product tells a customer their data will be gone in 30 days. It will not be — ledgers, bank statements, source documents and the extracted text sidecars stay indefinitely, still readable by any super admin. That is a retention promise the UI makes and the system breaks, silently.

**Reproduction.** `api.request_deletion(org)` as owner → `select job_type, run_after from jobs where organization_id = org` shows `org.purge`. Set `run_after = now()` and hit `/api/jobs/run` with the cron secret → `status = 'failed'`, error "No handler is registered for org.purge"; after two more drains, `dead`.

**Recommended fix.** Either build the handler (the sweep primitives already exist in the signer: `listObjectsForOrganization`, `removeObjectsForOrganization`; the SQL side needs `api_server.purge_organization(p_org)` that re-verifies `status = 'pending_deletion'` and `deletion_requested_at <= now() − 30 days`, waits for zero running jobs, hard-deletes, redacts, and sets `status = 'deleted'`), or remove the danger-zone action until it exists. In both cases: a job that dies must be visible — at minimum `/platform/jobs` filtered to `dead`, and a `job.dead` audit event on the organisation.

---

## High

### H1 · Suspended organisation: the frozen Home cannot render

**Status: fixed** — migration `20260908000004_frozen_home_rows.sql`, ADR-068. `fiscal_periods` and the `metric_snapshots` rows `metric_current` points at admit `suspended_member`; `loadHome` no longer asks the record-level first-run question while suspended. Proven by pgTAP (current snapshots visible, history not) and an integration test that suspends a computed organisation and reads the same figures back.

**Location.** RLS policies on `fiscal_periods`, `metric_snapshots`, `ledger_entries`/`bank_transactions`/`invoices`/`period_balances` (allow-list of the five real roles, correctly excluding `suspended_member`). Consumers: `src/modules/dashboard/data/repository.ts:14` (comment claiming the frozen Home renders), `:140` (`loadPeriods` → `fiscal_periods`), `:45` (`metric_snapshots!inner`), `:192` (`hasAcceptedRecords` → record tables); `src/modules/dashboard/services/home.ts:215` (`!hasRecords → first_run`).

**Problem.** `TENANCY_MODEL.md` §115, `RBAC_MATRIX.md` §103, `SECURITY_MODEL.md` §122 and `DATABASE_ARCHITECTURE.md` §173 all say the five tables that admit `suspended_member` — `organizations`, `metric_current`, `health_current`, `health_scores`, `alerts` — are what "lets the member see the frozen Home". But `metric_current` and `health_current` are **pointer** tables; the values live in `metric_snapshots`, and the period comes from `fiscal_periods`. Both deny `suspended_member`.

**Executed.** Same organisation, owner JWT, before and after `update organizations set status='suspended'`:

| table | active | suspended |
|---|---|---|
| role from `api.my_context` | owner | suspended_member |
| `fiscal_periods` | 5 | **0** |
| `metric_current` | 1 | 1 |
| `metric_snapshots` | 1 | **0** |
| `metric_current` ⋈ `metric_snapshots` (the join Home issues) | 1 | **0** |
| `health_scores` | 1 | 1 |

`loadHome` then finds no periods and no accepted records and returns `{ kind: 'first_run' }`: the member sees "Add your first file" beneath "This organisation is suspended".

**Why it matters.** Suspension is a billing/compliance action taken against a paying customer. The specified behaviour — figures frozen, banner on top — is what makes it non-destructive from the customer's side. What ships instead looks like their data has been wiped. The code comment asserts the opposite of what the database does, and no test covers the suspended read path (the pgTAP suite asserts `suspended_member` is *excluded* from these tables, which is the half that works).

**Reproduction.** Any organisation with a computed month; `update organizations set status='suspended'`; open `/app/{slug}/home` as a member.

**Recommended fix.** Decide which half of the contract is wrong. Either (a) admit `suspended_member` on `fiscal_periods` and on `metric_snapshots` **only for rows currently pointed to by `metric_current`** (`exists (select 1 from metric_current c where c.snapshot_id = metric_snapshots.id)`), and make `loadHome` skip `hasAcceptedRecords` when `organizationStatus = 'suspended'`; or (b) rewrite the four documents to say a suspended organisation sees the banner and nothing else, and render a dedicated suspended state instead of `first_run`. Add an integration test that suspends an organisation and asserts the Home view model still carries the last figures.

### H2 · Open redirect in the PKCE callback

**Status: fixed** — `src/core/routing/safe-next.ts` (`safeNextPath`), applied in the callback, the sign-in form and the middleware; ADR-069. Unit-tested against every listed form and re-checked so the result can never resolve off-origin when parsed again.

**Location.** `src/app/auth/callback/route.ts:15`: `nextParam.startsWith('/') && !nextParam.startsWith('//')`, then `NextResponse.redirect(new URL(next, url.origin))`. Same check client-side at `src/components/auth-form.tsx:30` feeding `router.push(safeNext)`.

**Problem.** WHATWG URL parsing treats `\` as `/` in special schemes. Verified in Node:

```
"/\\evil.com"   -> https://evil.com/
"/\\\\evil.com" -> https://evil.com/
```

A magic-link or password-reset email that lands on `/auth/callback?code=…&next=/\evil.com` completes the exchange (session cookies set) and then 302s the user to `evil.com`. The attacker needs only to get a victim to start a magic-link flow with that `next` (the sign-in page forwards the query string), which is a phishing primitive on the product's own domain immediately after authentication.

**Reproduction.** `curl -I 'https://<host>/auth/callback?code=x&next=/\evil.com'` → `Location: https://evil.com/` (the code exchange fails but the `next` computation precedes nothing that checks it; with a valid code the redirect is the success path).

**Recommended fix.** Normalise then compare: `const target = new URL(next, origin); if (target.origin !== origin) target = '/'`. Apply the same in `auth-form.tsx` (do not trust `router.push` to keep an external URL internal) and in `middleware.ts` `relativeTarget` for consistency. Add a unit test with `/\evil.com`, `/\\evil.com`, `/%5Cevil.com`, `//evil.com`, `/./\evil.com`.

### H3 · MVP scope: what the documents call MVP is not present

`MVP_SCOPE.md` §2 and §5 are explicit. Against them:

| MVP item | State | Evidence |
|---|---|---|
| §2.10 AI Analyst — 15 tools, chat, grounding, evidence per answer, quotas | **Absent.** No `/analyst` route, no `/api/ai/chat`, no Anthropic SDK in `package.json`, `src/modules/ai` has no `data/` or `services/` and **zero importers** outside itself (`grep "from '@/modules/ai'"`). | `nav.tsx:67` hides it (`built: false`). Acceptance criteria 9, 10, 11, 12 cannot be exercised. `api.create_conversation`, `ai_*` tables, `client.ai.use` exist without a consumer. Prompt-injection and hallucination pathways therefore cannot be audited — there is nothing to inject into. |
| §2.3 PDF import (store, text extraction, deterministic parse, Claude-assisted with review) | **Refused.** `src/modules/imports/services/wizard.ts:91`: "PDF statements are not ready yet." | `document.extract` job type exists with no handler; `api.confirm_pdf_page` exists with no caller. |
| §2.11 source-document viewer with page reference; Documents page | **Absent.** `data/documents` `built: false` (`nav.tsx:82`). | Consequence: `api.delete_document` has **no caller in `src/app`** — a customer cannot delete a file they uploaded. Level 4 of the evidence drawer downloads the file; there is no viewer. |
| §2.14 CSV export of ledger, bank transactions, invoices, metrics | **Absent.** No `/api/exports/[kind]`; no `text/csv` producer. | |
| §2.2 Platform: jobs monitor, AI feedback queue, global audit search, org detail/feature flags, settings | **Absent.** `/platform` has organisations, users, assignments only. | Compounds C3 (dead jobs invisible) and M5. |
| §2.1 org lifecycle: deletion | Enqueued, never executed | C3. |

Everything else in §2 is present and, where I tested it, behaves as specified. This is listed as High rather than as a scope note because acceptance criteria 9–12 are the SOW's stated bar and are untestable in this build; the RBAC matrix, the nav, the permission set and the schema all carry the AI surface as if it were live.

**Recommended fix.** Either ship the AI slice, PDF path, exports, Documents page and platform pages before calling this the MVP, or amend `MVP_SCOPE.md` §2 and §5 to what is built — and remove `ai.use` from the `client` row and the "Analyst" entry from the nav until then, so the matrix describes the product.

---

## Medium

### M1 · Upload size check runs after the whole body is in memory; no throttle

**Status: fixed** — `checkDeclaredLength` judges `Content-Length` before `request.formData()`; the route throttles 20/h per user and 100/day per organisation as ROUTE_ARCHITECTURE §5 specifies; ADR-070. Unit-tested; Playwright posts an oversized body and an over-quota series through the real route.
**Location.** `src/app/api/imports/upload/route.ts:38–49`. `await request.formData()` materialises every part in memory; `file.size` is read afterwards. The comment ("Checked before the body is read into memory") is false. There is no `throttle()` call on this route (the document and report routes have 60/min and 30/h); `api_server.register_document` throttles nothing either.
**Why.** Any `imports.create` holder can post multi-GB bodies to a Node function; the first thing that fails is the function's memory, not the guard. With no rate limit, a single member can fill the `source-documents` bucket at 25 MB per request.
**Fix.** Check `content-length` before parsing (reject > 26 MB up front), stream to a temp file or reject on the first oversized chunk, and `throttle(ctx, 'upload', 30, '1 hour')` — ROUTE_ARCHITECTURE §164-style — before reading the body.

### M2 · Errors swallowed into "not found" and "empty"

**Status: fixed** — the evidence page rethrows everything but `NOT_FOUND`; the three platform pages throw on a query error instead of rendering an empty list; ADR-070.
**Location.** `src/app/app/[orgSlug]/evidence/[bundleId]/page.tsx:60`: `loadEvidenceDrawer(...).catch(() => null); if (view === null) notFound();` — a throttled (`QUOTA`), a database error, a descriptor-compile bug, all become 404. `src/app/platform/organizations/page.tsx:14`, `assignments/page.tsx:18`, `users/page.tsx:16`: `const { data } = …; data ?? []` — the `error` is never read; a failing query renders "No organisations".
**Why.** "Do not silently swallow errors" is a standing constraint. A super admin looking at an empty organisations list during an outage will act on it. An owner told a bundle "could not be found" after a 500 has no path forward and nothing is logged.
**Fix.** Catch `NotFound` only (`isMotionError(e) && e.code === 'NOT_FOUND'`), rethrow everything else; `unwrap(data, error)` on the platform pages as every module repository already does.

### M3 · Commit-time duplicate re-check is narrower than the contract

**Status: fixed, and wider than stated** — the real `app.commit_import_batch` failed for EVERY validated invoice update candidate, not only the concurrent case: it inserted the new row `accepted` before superseding the old one, and `invoices_identity_unique` is partial on exactly that state (ADR-029.1's supersession never reached commit; nothing tested it). Migration `20260908000006`: insert `pending` → supersede → accept; `rerun_dedupe` gains pass 1 for invoices and re-points stale targets along the chain; ADR-073. Four integration tests through the real function.
**Location.** `app.rerun_dedupe` (pass 2, `dedupe_hash` only). `IMPORT_ENGINE.md` §9.3: "re-runs passes 1 and 2". `invoices_identity_unique` partial index on `(organization_id, invoice_type, counterparty_id, invoice_number)`.
**Why.** Two reviewers, two tabs, two invoice re-exports: the second commit inserts an invoice whose identity now collides with one committed since validation. Pass 1 (identity → supersede) is not re-run, so the insert hits the unique index and the whole transaction aborts with `ConflictError: duplicate key value violates unique constraint "invoices_identity_unique"` — the batch stays `awaiting_review` with no row re-flagged and a Postgres sentence on screen, instead of "N rows now duplicate a batch committed at {time}".
**Fix.** Extend `rerun_dedupe` for `invoices` with the identity join; set `duplicate_of_id` and `IMP-INV-010` so the commit path supersedes rather than collides.

### M4 · `api_rate_limits` has no retention

**Status: fixed** — `api_server.prune_rate_limits` (2-day keep) runs in the platform-wide sweep, and the sweep is finally scheduled: `/api/jobs/nightly` + `api_server.enqueue_nightly_sweep`, idempotent per date, cron at 02:00 UTC; ADR-074.
**Location.** `app.throttle` upserts `(actor_user_id, bucket, window_start)`; 1-minute windows for `rpc`, per user, per bucket. `DATABASE_ARCHITECTURE.md` §247 assigns retention to `storage.cleanup_orphans`; ADR-064 records it as unbuilt.
**Why.** One active user ≈ 1,440 `rpc` rows/day plus one per other bucket; 200 users ≈ 300k rows/day into a table with a unique index that every `api.*` call upserts into. It will not fall over this month; it will get slower every month.
**Fix.** `delete from api_rate_limits where window_start < now() − interval '2 days'` in the nightly sweep (which also needs an enqueuer — ADR-064's "Still missing").

### M5 · Any owner/admin can cancel any queued job of their organisation

**Status: fixed** — `api.cancel_job` refuses any type outside `calculation.run`/`report.render` and any job the caller did not request; ADR-071.
**Location.** `api.cancel_job` — permission `intelligence.recompute`, no job-type check; `api.requeue_job` — super admin only.
**Why.** Cancelling `org.purge` leaves the organisation `pending_deletion` with no purge (moot today, see C3, but the invariant is wrong). Cancelling `alerts.evaluate` or `storage.cleanup_orphans` silently removes background behaviour the platform relies on. `jobs_select` is super-admin only, so the user cancels a job they cannot even see — the id has to come from elsewhere.
**Fix.** Restrict to the two user-requestable types `api.enqueue_job` already enumerates (`calculation.run`, `report.render`) and to `requested_by = app.uid()`.

### M6 · Audit log UI is a fixed window of 100

**Status: fixed** — the page pages 50 at a time (fetching one extra to know if an older page exists) and shows the target table; ADR-072.
**Location.** `src/app/app/[orgSlug]/settings/audit/page.tsx:14` (`limit: 100`, no offset, no filter, no target column). `api.org_audit_events` accepts `p_offset` and up to 500.
**Why.** MVP §2.14 "Audit log UI for owners/admins"; CD-13 promises the owner can see every super-admin view. After 100 events (a busy import day) older staff-access rows are unreachable from the product.
**Fix.** Page by offset, filter by action family, show `target_table`/`target_id`.

---

## Low

**Status: all six fixed** — ADR-075 *(correction: that commit's gate line claimed the schema-drift check green; it was not — the check flagged the deliberate `postgres` ownership of `revoke_user_sessions` from the moment it existed, and stayed red until the exception was allow-listed in `scripts/check-schema-drift.ts` alongside the pgTAP one, in the AI Slice 1 commit. No code was wrong; the report was.)* (L1 middleware 503; L2 `fix_import_row` dropped until re-validation exists; L3 `api_server.revoke_user_sessions` wired into member removal by an owner and platform-role revocation; L4 signer logs unvisited prefixes; L5 `revoke_assignment` archives the employee's conversations) and ADR-066 (L6 `evidence.bundle_built`).

- **L1 · Middleware "fail closed" fails open.** `src/middleware.ts:81`: with `NEXT_PUBLIC_SUPABASE_URL`/anon key unset the request passes through with no family check. Server layouts (`platform/layout.tsx`, `app/[orgSlug]/layout.tsx`) still guard, so this is a wrong comment plus a lost defence layer, not a hole. Return 503.
- **L2 · `api.fix_import_row` is a dead end.** No UI calls it; nothing re-validates a `pending` row; `assert_batch_committable` refuses `pending` rows. A direct call parks the batch until rejected or replaced. Either build the re-validate step or revoke the function.
- **L3 · Session revocation on removal does not exist.** `api.remove_member` comment: "Session revocation is performed by tenancy.removeMember in application code". `src/modules/tenancy/services/membership.ts:155` calls the RPC and nothing else. RLS makes data access moot; the stated control is absent.
- **L4 · Signer depth budget truncates silently.** `src/core/storage/signer.ts:217–219`: the comment says a deeper tree "makes the walk stop and say so"; the loop stops and says nothing. Safe direction (nothing deleted), but a report of skipped prefixes is what the comment promises.
- **L5 · `api.revoke_assignment` promises to archive the employee's conversations** "once `ai_conversations` exists". It exists. Moot while H3 stands; wrong once it does not.
- **L6 · Bundle creation is unaudited and misattributed.** Part of C2, but standalone: `api.build_metric_bundle` writes `created_by_type='system'` for a user-initiated call and writes no `audit_events` row.

---

## What was checked and held

Listed so the absence of a finding is not read as an absence of a check.

- **Tenant isolation / RLS.** FORCE RLS on all 44 tables; `authenticated` holds no INSERT/UPDATE/DELETE anywhere; `audit_events_*` partitions carry SELECT grants with **zero** policies (default deny). Every record-table FK is organisation-composite (`(organization_id, x)`), so a cross-organisation id in `mapped_data` fails at commit. `api_server.*` functions all carry the `service_role` claim guard; the drift script confirms none is reachable through PostgREST. `SUPABASE_SERVICE_ROLE_KEY` is read in exactly three files. Cross-organisation ids to `api.*` resolve to `NOT_FOUND`, not `PERMISSION_DENIED`.
- **Role resolution.** `app.accessible_org_roles()` matches `RBAC_MATRIX.md` §22 order; platform branches require `aal2` at the database (`app.is_platform_user()`), so an employee at `aal1` reads nothing regardless of middleware. Assignment window (`starts_at`/`ends_at`) enforced in the same function. Suspended membership → null; suspended organisation → `suspended_member` (its consequence is H1).
- **Owner/admin.** `change_member_role` checks ceiling on current and target role and refuses self-elevation; ownership transfer re-checks both parties at acceptance under the org advisory lock, with expiry; `revoke_assignment` allows owner or super admin; `create_assignment` requires super admin with re-auth.
- **Client.** `source_documents` policy is an allow-list excluding `client`; `/api/documents/[id]/url` checks `documents.view`; `set_alert_status` restricts a client to `acknowledged`; page guards on imports/settings/team/accounts require permissions the client lacks. Its `alerts.manage`/`ai.use` grants match the matrix (the latter is dead — H3).
- **Invitations.** Token returned once, stored as SHA-256; acceptance bound to the JWT email, requires confirmed email, refuses platform accounts, re-checks the inviter's current role.
- **Source-document access.** Audit-first signing: the audit row is the signer's input, re-read and checked for actor, target, org and age ≤ 30 s; keys asserted under `${orgId}/`; 60 s TTL, attachment disposition, `cache-control: no-store`.
- **Financial calculations.** Spot-checked against `FINANCIAL_ENGINE.md` §3: `cash_runway_months` (3-period mean burn, NULL + `cash_positive` when not burning, 0 when cash ≤ 0, 36 as a display cap only), `receivables_overdue` (`due_date < asOf` strict, no-due-date rows excluded and counted as `no_due_dates`), `gross_margin`/`net_margin` (revenue 0 → `comparison_is_zero`, negative revenue → `negative_revenue` warning), `net_profit` identity with all five components. Money as strings, `ROUND_HALF_UP`; the `no-arithmetic-in-components` and `no-money-parsefloat` rules are enforced. ADR-063's clock defect and its three follow-ups are closed at `6212e89`.
- **Import integrity.** Every non-empty source line becomes a row (integration-tested); commit is one transaction under the org lock; `assert_batch_committable` refuses error rows, unvalidated rows, batch-level errors, missing confirmations, missing range, unconfirmed AI pages; rollback promotes dependants and re-links supersession chains rather than deleting; replace is rollback+commit in one transaction with conflict abort.
- **Duplicate detection.** Passes 1–5 of §9.2 exist in `domain/dedupe.ts` (invoice update candidates, cross-batch hash, within-batch with the payroll/batch-payment exception, ±1-day fuzzy, re-export detection). Commit-time re-check exists (M3 narrows it).
- **Evidence traceability.** Snapshots carry `evidence_query`; descriptors are hashed (RFC 8785) and resolved as-of the chunk instant; `same_org_ref_item` refuses a foreign `ref_id`; bundles are append-only. (C2 is the hole in the wall.)
- **Audit.** Every mutating `api.*` function writes `app.audit(...)` except `build_metric_bundle` (L6) and the two AI conversation functions; `api.commit_import_batch`/`rollback_import_batch` audit inside `app.*`. Super-admin tenant views are recorded (`org.data_viewed`). 500-class errors serialise as "Something went wrong." — no SQL text reaches the client.
- **Jobs.** `claim_job` uses `FOR UPDATE SKIP LOCKED`, reclaims stale workers, defers work for non-active organisations; cron endpoint refuses without a secret, constant-time compare, 404 not 401.
- **Prompt injection.** `domain/untrusted.ts` wraps imported strings and caps length; the claim grammar and grounding v3 are unit-tested. None of it is wired to a model (H3), so this is a review of code paths that do not yet execute.

## Not verified

- **Mobile responsiveness** on pages outside the Playwright sweep: evidence drawer, `imports/[batchId]`, `settings/team`, `settings/audit`, `actions/[actionId]`, `customers/[counterpartyId]`, `home/health`. The sweep (11 pages × 4 viewports, 320 px included, zero horizontal scroll) passed on the pages it covers. Not exercised here.
- **`router.push('/\\evil.com')`** in a real browser (H2's client-side twin) — reasoned from the identical guard, not executed.
- **Last-owner trigger** on `delete`/`update` of `organization_memberships` — relied on the pgTAP suite (847 assertions, green at `6212e89`), not re-derived.
- **AI hallucination / tool permissions / quotas** — nothing to test (H3).
- **Behaviour under Vercel function limits** for C1 — measured in Postgres only; the 504 is inferred.

## Ordering

Fix C1 first: it is a policy rewrite with no semantic change and it makes the product usable at real data sizes. C2 next: it is the only finding that lets the lowest-privileged tenant role write something the highest reads as truth. C3 and H1 are both "the product says X, the system does not-X" and both hit the customer at the worst moment (leaving, or being suspended). H2 is a one-line fix with a test. H3 is a decision, not a patch.
