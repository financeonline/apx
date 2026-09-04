# MOTION — Security Model

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-003, ADR-010, ADR-013, ADR-014, ADR-015, CD-11, CD-13, CD-17, CD-23, CD-24), `TENANCY_MODEL.md`, `RBAC_MATRIX.md`, `DATABASE_ARCHITECTURE.md`
Consumed by: `AI_ARCHITECTURE.md` (prompt-injection detail), `TEST_STRATEGY.md`, `IMPLEMENTATION_PLAN.md` (Phase 18)

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026 (writes only via `api.*` RPC; `app` internal; audit derived server-side; job enqueue guard), ADR-033 (statement text does reach Anthropic under a flag, with audit and budget), ADR-038 (Storage signed-URL-only, suspension at the database, column-limited profiles, masked bank identifiers, `platform_org_settings`, audited `/platform` tenant views, report files, MFA for platform users, purge redaction, `search_path = ''`, audited platform settings and requeues, lifecycle jobs). Findings addressed: F-A-01, F-A-03, F-A-04, F-A-05, F-A-06, F-A-07, F-A-08, F-A-09, F-A-10, F-A-11, F-A-12, F-A-14, F-A-15, F-A-16, F-A-17, F-C-13, F-D-14; CSV-encoding contradiction (F-B below-the-cut). See `RED_TEAM_REVIEW.md`.

Target baseline: **OWASP ASVS 4.0 Level 2** for all customer-facing surfaces; Level 3 controls where noted for the AI and Storage paths.

## 1. Threat model

### 1.1 Assets, in order of sensitivity
1. Tenant financial records (`ledger_entries`, `bank_transactions`, `invoices`, `period_balances`) and source documents (bank statements contain account numbers, payee names, salaries).
2. Derived intelligence (`metric_snapshots`, `health_scores`, `alerts`, AI conversations) — reveals business condition.
3. Identity data (`profiles`, memberships, invitations).
4. Platform secrets: Supabase service-role key, Anthropic API key, cron secret, database credentials.
5. Audit log integrity.

### 1.2 Actors
| Actor | Trust | Typical attack |
|---|---|---|
| Anonymous internet | None | Credential stuffing, enumeration, upload abuse, DoS |
| Authenticated member of org A | Trusted within A only | IDOR to org B, privilege escalation to owner, exfiltration by export |
| Client role | Read-and-participate | Reaching source documents or write paths through the AI or deep links |
| Platform employee | Trusted for assigned orgs only | Reaching unassigned orgs; retaining access after revocation |
| Super Admin | Highest | Insider snooping (CD-13); credential compromise multiplies impact |
| Malicious file author | None | Payloads inside CSV/XLSX/PDF: formulas, macros, embedded JS, zip bombs, prompt-injection text in descriptions |
| The model (Claude) | Untrusted output | Fabricated figures, following injected instructions, requesting cross-tenant data |
| Third parties (Supabase, Vercel, Anthropic) | Contractual | Outages, data-handling terms (SOW §26) |

### 1.3 Trust boundaries

```
 ┌──────────────────────────── Browser (untrusted) ─────────────────────────────┐
 │  Next.js client components · anon key + user JWT (role `authenticated`:       │
 │  SELECT under RLS + EXECUTE on api.* only; no table write privilege)          │
 └───────────────┬───────────────────────────────────────────────┬──────────────┘
                 │ HTTPS (server actions / route handlers)       │ signed URL (60 s)
 ┌───────────────▼──────────────── Vercel (trusted server) ──────▼──────────────┐
 │ middleware → layout builds AccessContext → assertCan → services →             │
 │   reads: user client (RLS)     writes: rpc('api.*') as the user               │
 │   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────────┐  │
 │   │ Storage      │   │ job workers  │   │ AI tool loop (Claude untrusted)  │  │
 │   │ signer       │   │ service role │   │ tools → services with caller ctx │  │
 │   │ (service     │   │ withOrgScope │   │ persisted via api.ai_persist_turn│  │
 │   │  role, path- │   │ (org from    │   └──────────────┬───────────────────┘  │
 │   │  asserted)   │   │  jobs row)   │                  │                      │
 └──────────┬───────┴───┴──────┬───────┴──────────────────┼──────────────────────┘
            │                  │                          │ HTTPS, API key server-only
 ┌──────────▼──────────────────▼───────────┐   ┌──────────▼───────────────────────┐
 │ Supabase: Postgres (RLS forced on reads;│   │ Anthropic API                    │
 │ api.* SECURITY DEFINER for writes) ·    │   │ (tool outputs; statement page    │
 │ Auth · Storage (no user policies)       │   │  text only under CD-35 flag)     │
 └─────────────────────────────────────────┘   └──────────────────────────────────┘
```

Boundary rules: the browser can read what RLS allows and call `api.*` functions — nothing else; every write is a function that re-derives the actor from the JWT and re-checks permission and invariants in SQL (ADR-026); nothing crosses from the model to the database except through typed tools that carry the human caller's context and one persistence function; the service role exists in exactly two places — job workers (`withOrgScope`, org taken from the `jobs` row) and the Storage signer (`src/core/storage/signer.ts`, path-asserted).

## 2. The six enforcement layers

From `RBAC_MATRIX.md §4`. Each layer is written as if the others did not exist.

| # | Layer | Enforces | What it catches that others miss |
|---|---|---|---|
| 1 | Middleware | Valid session; route family matches role family; org slug resolvable | Unauthenticated hits, platform users wandering into `/app`, members hitting `/platform` |
| 2 | Layout / page | `effectiveRole ≠ none` for the slug; feature flag | Deep links to organizations the user is not part of (returns 404) |
| 3 | Server action / route handler | `assertCan(ctx, permission)` before any service call | A client role calling an upload action with a hand-crafted request |
| 4 | Service | Re-check for privileged operations; row-level constraints (last owner, role ceiling, assignee validity) | Logic bugs in a UI-facing action; rules a permission bit cannot express |
| 5 | Database: RLS + `api.*` functions + constraints | Org access on every read; **no table write privilege**; every write is a SECURITY DEFINER function that re-checks permission, ceiling and invariants and writes audit; composite FKs and `same_org_ref` triggers | Any bug in layers 1–4, including a forgotten `assertCan`; a stolen JWT used against PostgREST directly; cross-org references even under bugs |
| 5b | Storage | No policies for `authenticated`; reads only via signed URLs minted after permission + audit | Direct Storage REST listing/downloads with a user JWT |
| 6 | AI tool gate | Same `assertCan` per tool, `resolveAccess` re-run per tool call; org id from context, never from the model | Model attempting to read another organization, a client asking for a document URL, a role change mid-turn |

Test principle (`TEST_STRATEGY.md §2`): for each layer there is an adversarial test that disables or bypasses that layer and asserts the request still fails.

## 3. Identity and authentication (Supabase Auth)

| Setting | MVP value | Notes |
|---|---|---|
| Methods | Email + password; magic link (tenant users only) | OAuth providers post-MVP. **MFA (TOTP) is mandatory in MVP for every `platform_users` row** and opt-in for tenant users; magic-link sign-in is refused for platform users at `/auth/callback` (ADR-038.8) |
| Password policy | Minimum 12 characters; breached-password check enabled | Supabase "leaked password protection" on |
| Flow | PKCE for all browser flows | Server-side code exchange in `/auth/callback` route handler |
| Session | Access token 1 h; refresh token rotation on; refresh reuse detection on | `@supabase/ssr` cookie-based sessions, `HttpOnly`, `Secure`, `SameSite=Lax` |
| Idle timeout | 12 h without activity forces re-auth; absolute 30 days | Enforced by refresh-token expiry + middleware check of `profiles.disabled_at` |
| Redirect allow-list | Only production and preview domains, `/auth/callback`, `/invite/*` | Prevents open-redirect through magic links |
| Email verification | Required before an organization can be created or an invitation accepted; `api.accept_invitation` compares `invitations.email` with `auth.jwt()->>'email'`, never with `profiles.email` | |
| Step-up | Platform users: `aal2` required by `app.is_super_admin()` and by the `/platform`/`/portfolio` layouts; re-authentication within 10 minutes required for `platform.users.manage`, suspend, `org.delete`, and creating assignments | ADR-038.8 |
| Rate limits (auth) | Sign-in 10/15 min per IP+email; magic link 3/15 min per email; reset 3/h per email | Supabase Auth rate limits + edge rate limit |
| Account disable | `profiles.disabled_at` set → middleware rejects; Supabase user banned via admin API | Removal from the last organization does not disable the account |

Invitation lifecycle: token is 32 random bytes, stored as SHA-256 in `invitations.token_hash`, expires after 7 days, single-use, bound to the invited email (acceptance with a different signed-in email is refused); at most one pending invitation per `(organization, email)`; inviting an existing member or a platform user fails with a friendly error inside `api.invite_member`. Accepting runs entirely inside `api.accept_invitation`, which re-validates the inviter's current role and ceiling, creates the membership and writes `member.invited_accepted`.

## 4. Session revocation semantics
- Removal from an organization: context is resolved per request, so access ends on the next request; no session invalidation needed, but the app also calls Supabase `signOut({scope: 'others'})` for the removed user when the remover is an owner (defence against long-lived tabs).
- Employee assignment revoked: same; additionally the employee's open AI conversations for that org are archived.
- Platform role revoked: all sessions of that user are invalidated via the Auth admin API.
- Organization suspended: every member resolves to `dashboard.view` only; a banner explains.

## 5. Secrets and configuration

| Secret | Where | Rules |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env (server only) | Imported by exactly two files: `src/core/db/service-client.ts` (job workers, `withOrgScope`) and `src/core/storage/signer.ts` (signed URLs, uploads, deletes; asserts the object key starts with the caller's `organization_id`); ESLint rule forbids import elsewhere (ADR-013 as amended by ADR-038.1) |
| `ANTHROPIC_API_KEY` | Vercel env | Only `src/modules/ai/provider/claude-client.ts` |
| `CRON_SECRET` | Vercel env | Compared with constant-time equality in `/api/jobs/run` |
| `SUPABASE_JWT_SECRET` | Not used by app code | Verification done by Supabase; never copied into app |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | The only `NEXT_PUBLIC_*` values; the anon key is safe only because RLS is forced on every table |

Rules: no secrets in the repository (`.env.example` only); rotation runbook for each secret with a 90-day cadence for API keys; preview deployments use a separate Supabase project; production secrets are readable only by two named maintainers in Vercel.

## 6. Database security

### 6.1 Privileges, RLS and the function surface (ADR-026)
- `REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM authenticated, anon` plus matching default privileges. End users can only SELECT (under RLS) and EXECUTE the functions in schema `api`.
- `ENABLE` and `FORCE ROW LEVEL SECURITY` on every table in `public` except `role_permissions` (read-only reference). Reads: `organization_id IN (SELECT app.accessible_org_ids())`, narrower where the table says so (`import_rows`, `import_batches`, `import_mappings` need `imports.review`; `source_documents` and Storage exclude `client`; `ai_conversations`/`ai_messages` are owner-or-admin scoped; report files need `reports.view`).
- Writes: one `SECURITY DEFINER` function per use case in schema `api` (`DATABASE_ARCHITECTURE.md §14` is the exhaustive list of what `authenticated` may execute). Each derives the actor from `auth.uid()`, validates the organization against the accessible set (foreign id → `NOT_FOUND`), checks `app.has_permission()`, enforces ceilings, last-owner, no-self-elevation, supersede-not-update, batch gating and status transitions in SQL, and writes `app.audit()` in the same transaction.
- Schema exposure: PostgREST exposes `public` (tables, SELECT) and `api` (functions). `app` is internal: `REVOKE ALL ON SCHEMA app FROM public, anon, authenticated`, with EXECUTE granted to `authenticated` only on the three RLS helpers `app.accessible_org_ids()`, `app.org_role(uuid)`, `app.is_super_admin()` (they are referenced from policies). `app.audit()` is not callable by users; its actor, organization, `ip`, `user_agent` and `request_id` fields are derived inside the function from `auth.uid()` and `current_setting('request.headers', true)`.
- Every `app.*`/`api.*` function is `SECURITY DEFINER`, `STABLE` where read-only, with `SET search_path = ''` and every reference schema-qualified (`public.…`, `auth.uid()`); `REVOKE ALL ON FUNCTION … FROM public` then explicit grants. pgTAP asserts `proconfig`, `prosecdef` and grants for every function.
- Suspension is a database fact: `app.accessible_org_ids()` joins `organizations.status`; `app.org_role()` returns `suspended_member` (mapped to `dashboard.view` only) for suspended organizations and NULL for suspended memberships; `app.is_super_admin()` requires `aal2`.
- `profiles`: own-row updates are limited by `api.update_profile` to `full_name, avatar_url, timezone, onboarding_state, last_active_org_id`; `email` only via the auth-sync trigger; `disabled_at` only via `api.disable_user`.
- Views over `profiles` for member names are `security_invoker = false` with an explicit shared-organization filter.
- Tables the browser never needs to read (`ai_tool_calls`, `jobs`, `platform_settings`, `platform_org_settings`) also have `REVOKE SELECT` from `anon`; `anon` can SELECT nothing in `public` except what the public pages need (nothing in MVP).

### 6.2 Service-role confinement (ADR-013)
```ts
// src/core/db/service-client.ts (only importer of the service role key)
export async function withOrgScope<T>(job: JobRow, fn: (db: ServiceDb) => Promise<T>): Promise<T>
// orgId is taken from job.organization_id — never from job.payload — and every payload id is
// looked up (organization_id, id); wraps the client so every .from(table) call on a tenant
// table auto-applies .eq('organization_id', orgId); throws if a query on a tenant table omits it.
```
ESLint rule `motion/no-unscoped-service-query`: any call on the service client outside `withOrgScope` or outside `src/modules/*/data/jobs/**` fails CI. Jobs enter the queue only through `api.enqueue_job(job_type, payload)`, which maps the type to a required permission, sets `organization_id` from the caller's context, strips any organization id from the payload, and rejects `org.purge`, `ai.eval`, `storage.cleanup_orphans` and `snapshots.compact` from non-service callers (F-A-03). `org.purge` is enqueued only by the trigger on `organizations.status → 'pending_deletion'` with `run_after = now() + 30 days`, is cancelled by `api.cancel_deletion`, waits for zero running jobs of that organization, and re-verifies status and age before deleting anything. Platform-level jobs use `withPlatformScope(reason)`, which writes an audit event first.

### 6.3 Constraints as security
Composite FKs (`TENANCY_MODEL.md §6`), last-owner trigger, platform-user exclusivity trigger, XOR on `evidence_items`, unique dedupe keys. These hold even if application code is wrong.

## 7. Storage security
- Two private buckets: `source-documents` and `reports`; public access disabled; no public buckets exist.
- **No `storage.objects` policies for `authenticated` or `anon`** (ADR-038.1; F-A-04). A user JWT can neither list nor fetch objects through the Storage REST API. The only reader is `src/core/storage/signer.ts`, which uses a storage-scoped service client, asserts that the requested key starts with `${ctx.orgId}/`, requires the id of an audit event written in the same request, and returns a signed URL valid 60 seconds with `Content-Disposition: attachment`.
- Object paths: `source-documents/{organization_id}/{document_id}/{original-filename}` (filename sanitised: ASCII, max 120 chars, no separators) and `source-documents/{organization_id}/{document_id}/text.json` for extracted text; `reports/{organization_id}/{period}/{job_id}.pdf`.
- Uploads go browser → `/api/imports/upload` (server) → validation (§8) → signer writes the object → `api.register_document`; never direct-to-Storage from the browser. If the row insert fails after the object write, the signer deletes the object; `storage.cleanup_orphans` (nightly) removes any object with no `source_documents`/`report_files` row.
- Downloads: `/api/documents/[documentId]/url` checks `documents.view`, writes `document.downloaded`, then mints the URL; `/api/reports/[reportId]/download` checks `reports.view`, resolves `report_files` by `(organization_id, id)`, writes `report.downloaded`, then mints the URL. Client role never reaches either.
- Deletion: `api.delete_document` succeeds only after the signer has removed the object (and its `text.json`); the purge job deletes `source-documents/{org}/` and `reports/{org}/` before rows and verifies emptiness.

## 8. Upload validation pipeline
Order is fixed; the first failure stops processing and sets `source_documents.status` accordingly.

| Step | Check | On failure |
|---|---|---|
| 1 | Size ≤ 25 MB; declared type ∈ {csv, xlsx, pdf} | 413 / 415; nothing stored |
| 2 | MIME sniffing by magic bytes (`file-type`), not extension; CSV must decode as text under the detection order in `IMPORT_ENGINE.md §4` (BOM → UTF-8/UTF-16 strict → Windows-1252 fallback) with no NUL bytes; undecodable bytes reject | `quarantined` |
| 3 | XLSX: ZIP structure valid; uncompressed size ≤ 250 MB and ratio ≤ 100:1 (zip bomb); no `vbaProject.bin` (macros rejected); external links stripped; formulas are read as cached values only — formulas are never evaluated | `quarantined` with reason |
| 4 | CSV/XLSX cell sanitisation: any cell starting with `=`, `+`, `-`, `@`, tab or CR is stored as text with a leading apostrophe on export (CSV-injection defence) | continue |
| 5 | PDF: parse with a hardened library in a worker; reject encrypted PDFs, JavaScript actions, embedded files, launch actions; page count ≤ 200 | `unreadable` or `quarantined` |
| 6 | Antivirus hook: interface `scanFile(path): Promise<ScanResult>`; MVP implementation is a no-op that records `scan_result.skipped = true`; ClamAV or a SaaS scanner plugs in without code changes elsewhere | `quarantined` |
| 7 | SHA-256 computed; duplicate file blocked (CD-12) | 409 with link to prior batch |
| 8 | Signer stores the object; `api.register_document` inserts the row with `status = 'ready'` and writes `document.uploaded` | — |

Quarantined files are retained for 30 days for investigation, are never downloadable by tenants, and are visible to super admins in `/platform/jobs`.

## 9. Input validation
- Every server action, route handler, tool input and job payload is parsed with a Zod schema from `src/modules/*/schemas/` before any logic runs; unknown keys are stripped; ids are `z.string().uuid()`; periods are `YYYY-MM`; money is `z.string()` parsed to `Decimal` (never `z.number()`).
- Organization id is never accepted from the client; it comes from the slug in the URL resolved server-side (ADR-014). Any schema containing `organizationId` from the client fails a lint check.
- Import row data is treated as untrusted text everywhere it is rendered (React escapes by default; no `dangerouslySetInnerHTML` anywhere; lint-enforced).
- Length caps: description 500 chars, action fields 4,000 chars, AI user message 4,000 chars.

## 10. Web application hardening
- **CSRF**: Server actions are protected by Next.js origin checking; `serverActions.allowedOrigins` set to production and preview hosts. Route handlers that mutate require a same-origin `Origin` header and are not CORS-enabled.
- **Headers** (set in `next.config` headers): `Content-Security-Policy` with nonce-based `script-src 'self' 'nonce-…'`, `object-src 'none'`, `frame-ancestors 'none'`, `connect-src 'self' https://*.supabase.co`, `img-src 'self' data: blob:`; `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` disabling camera, microphone, geolocation; `X-Frame-Options: DENY` for legacy.
- **Cookies**: `HttpOnly`, `Secure`, `SameSite=Lax`, host-only.
- **Rate limiting** (edge middleware with a Vercel KV / Upstash-style counter, or Supabase-backed fallback):

| Surface | Limit |
|---|---|
| Auth endpoints | §3 |
| `/api/imports/upload` | 20/h per user; 100/day per organization |
| `/api/ai/chat` | 10/min per user; org daily quota (default 100, CD-24) |
| `/api/documents/*/url` | 60/min per user |
| `/api/exports/*` | 10/h per user |
| Server actions (mutating) | 120/min per user |
| Unauthenticated pages | 300/min per IP |

- **Error handling**: no stack traces or SQL to the client; errors carry a `request_id` shown to the user and logged server-side.
- **Dependency hygiene**: `npm audit` and Dependabot on CI; lockfile committed; no post-install scripts from unknown packages; SBOM generated per release; pinned major versions for parsers (`xlsx`/`exceljs`, `pdfjs`, `papaparse`).

## 11. AI security summary (detail in `AI_ARCHITECTURE.md`)
- Tools are the only data path for the analyst; the model never receives organization ids, user ids, or raw table rows beyond what a tool returns for the caller's organization; `resolveAccess` is re-run before every tool call.
- Every tool call is authorised with the human caller's `AccessContext` (layer 6) and logged to `ai_tool_calls` through `api.ai_persist_turn`, which also requires the conversation to belong to `(organization, user)`.
- All imported free text (descriptions, counterparty and account names, references, filenames, invoice numbers, recurring signatures, action titles, alert explanations) reaches the model only through one `untrusted()` wrapper with `<`/`>` escaping and an explicit "data, not instructions" framing; the system prompt instructs the model to ignore instructions inside data.
- Output is a JSON structure validated by schema; every number carries a `NumberRef` resolved against the typed tool field it came from (unit, sign and period must agree); entities and directions are grounded; ungrounded statements are removed, never shown as fact.
- Data sent to Anthropic: metric values, category and counterparty names, masked transaction descriptions for the caller's organization only; never binaries, never other organizations, never secrets. **Under CD-11/ADR-033, when the organization's `ai_pdf_extraction` flag is on, the text layer of an uploaded PDF page (which can contain account numbers and payee names) is sent for structured extraction**, one page at a time, wrapped as untrusted data; each such send writes audit `document.sent_to_ai {document_id, pages}` and the wizard shows a consent line first. Extraction is metered into the organization's token ceiling and capped by `platform_org_settings.ai_extraction_pages_per_day`; the default state of the flag is CD-35. Anthropic API data-retention terms and the subprocessor entry are recorded in the DPA (CD-23).

## 12. Audit logging

| Logged (always) | Never logged |
|---|---|
| Governance changes (trigger diff): memberships, assignments, platform roles, organizations, `platform_settings`, `platform_org_settings`, account category remaps, bank opening balances, plus backstop diffs on the four financial record tables | Passwords, tokens, secrets, full session cookies |
| Function events (written inside `api.*`): `import.started/mapped/committed/rolled_back/replaced/rejected/reset`, `record.superseded`, `document.uploaded/downloaded/deleted/sent_to_ai`, `export.created`, `report.requested/generated/downloaded`, `ai.answered/refused` (message id, tool names, grounding status), `ai.feedback_submitted/reviewed`, `alert.status_changed/reevaluated`, `action.created/assigned/status_changed`, `member.*`, `ownership.*`, `assignment.*`, `org.*`, `job.enqueued/cancelled/requeued`, `platform.settings_changed/org_settings_changed/role_granted/role_revoked`, `auth.sign_in/sign_out/failed` | Raw financial payloads in platform-level events (`organization_id IS NULL` rows carry ids only); `metadata` values other than ids (allow-list per action) |
| Super-admin tenant views: `org.data_viewed` with route under `/app/*`, and with `{surface, target_id}` for `/platform` surfaces that render tenant content (ai-feedback items, audit payload expansion, organization detail) (CD-13, ADR-038.6) | Free-text AI prompts in platform-level views (available only inside the org's own log) |
| Security events: rate-limit trips, quarantined uploads, permission denials (sampled 1:1 for denials, 1:10 for rate limits) | Bank account numbers and sort codes printed inside statement lines: stored verbatim in `import_rows.raw_data` and `bank_transactions.description_raw` (both readable only with `imports.review`/non-client roles), masked to `****1234` in `description_normalized`, which is the only form shown to clients, sent to the model, or exported (ADR-038.4). MOTION's own `bank_accounts` rows hold last-4 only |

Properties: append-only; rows are written only by the internal `app.audit()` whose actor, organization, `ip`, `user_agent` and `request_id` are derived server-side (F-A-05); IP and user agent for user-initiated events; retention 7 years (NFR-14); owners/admins query their org's log in `/settings/audit`; super admins in `/platform/audit` (tenant rows show `before/after` only on expansion, which is itself audited). Purge redacts `before`, `after`, `metadata` (→ `'{}'`), `ip` and `user_agent` for the deleted organization but keeps the rows (ADR-038.9).

## 13. Super Admin access controls (CD-13)
- MVP: full read; every `/app/[orgSlug]/*` render for a super admin writes `org.data_viewed`, and so does every `/platform` surface that renders tenant content (opening an ai-feedback item, expanding an audit payload, viewing an organization's detail page) with `{surface, target_id}` (ADR-038.6); owners see all of these in their audit log under a "MOTION staff access" filter; a weekly digest of staff views is emailed to owners (post-MVP if not trivial).
- Super admins cannot write tenant financial data through the UI except via the same import/review flows as members, so their writes are indistinguishable in form and fully audited with `actor_type = 'platform_admin'`.
- Post-MVP: `support_access_grants (super_admin_user_id, organization_id, reason, expires_at)`; `app.accessible_org_ids()` third branch changes to consult it; UI forces reason entry.
- Super admin and employee accounts require TOTP MFA from day one (ADR-038.8): enrolment is forced by the `/platform` and `/portfolio` layouts, `app.is_super_admin()` requires `aal2`, magic-link sign-in is refused for platform users, and destructive platform actions require re-authentication within 10 minutes.

## 14. Organization enumeration prevention
- Unknown slug, or known slug without access → identical 404 page and identical timing profile (both paths resolve the slug and role before rendering).
- Invitation acceptance shows the organization name only after the token validates.
- Error messages never say "you are not a member"; they say "not found".
- `/api/*` handlers return 404 for cross-org ids (documents, batches, evidence, actions), 403 only for a *known-accessible* org where a permission is missing.

## 15. Logging, monitoring, alerting
- Error tracking (Sentry-class) on server and client with PII scrubbing (emails hashed, no request bodies).
- Structured JSON logs with `request_id`, `user_id`, `organization_id`, `route`, `duration_ms`; log level `warn` for permission denials, `error` for RLS violations surfaced as Postgres errors (these should never happen and page the on-call).
- Security alerts (email/Slack): > 20 permission denials per user per hour; any `quarantined` upload; any super-admin role grant; job failures > 3 consecutive; AI grounding failure rate > 10% over an hour; auth failures > 100/h from one IP.
- Uptime checks on `/`, `/sign-in`, `/api/health`.

## 16. Data lifecycle, deletion, residency (CD-23)
- Region: single Supabase region matching customer jurisdiction (assumed London); Vercel functions pinned to the nearest region; no tenant data in analytics tools.
- Deletion: owner or super admin calls `api.request_deletion` → `status = 'pending_deletion'`, `deletion_requested_at` set, and the trigger enqueues `org.purge` with `run_after = now() + 30 days`; a banner offers cancel, which calls `api.cancel_deletion` (status back to `active`, purge job `cancelled`). The purge job waits for zero running jobs of the organization, re-verifies status and age, deletes `source-documents/{org}/` and `reports/{org}/`, then tenant rows in dependency order, then redacts `audit_events.before/after/metadata/ip/user_agent` for the organization, keeping the events (ADR-038.9). Personal data of a user who leaves all organizations is retained 30 days then the profile is anonymised.
- Backups: Supabase PITR; restore drill documented; backups inherit region.
- Subprocessors: Supabase, Vercel, Anthropic, error-tracking vendor; listed in the DPA.

## 17. Incident response basics
1. Detect (§15 alert) → 2. Triage owner (on-call maintainer) within 1 h → 3. Contain: rotate the affected secret, suspend the affected organization or user, disable the affected route via feature flag → 4. Assess scope from `audit_events` and logs by `request_id` → 5. Notify affected organization owners within 72 h where personal data is involved → 6. Post-incident write-up in `docs/incidents/`. Runbooks for: leaked service key, leaked Anthropic key, suspected cross-tenant read, malicious upload, compromised super admin.

## 18. Pre-production security review checklist (SOW §23)
- [ ] Every `public` table has RLS enabled **and forced**; pgTAP suite `rls_all_tables` green.
- [ ] `authenticated` and `anon` hold no INSERT/UPDATE/DELETE privilege on any `public` table (pgTAP `no_table_writes`); a direct `PATCH /rest/v1/ledger_entries` with an owner JWT returns 403/42501.
- [ ] Every `api.*` function in `DATABASE_ARCHITECTURE.md §14` has a pgTAP test invoked as each of the eight fixture roles; `search_path = ''`, `prosecdef` and grants asserted for every `api.*`/`app.*` function; `app` schema not exposed.
- [ ] `api.enqueue_job` rejects `org.purge`/`ai.eval` from a user JWT and ignores any organization id in `payload`; worker scopes from `jobs.organization_id`.
- [ ] Suspension enforced at the database: a suspended organization's owner JWT gets zero rows from write functions and `dashboard.view`-only reads.
- [ ] `same_org_ref` triggers present on every polymorphic reference column; pgTAP enumerates FK columns on tenant tables and finds none non-composite.
- [ ] `role_permissions` parity test green; no route or action without `assertCan` (lint `motion/require-assert-can` on files under `src/app/**/actions.ts` and `src/app/api/**`).
- [ ] Cross-tenant adversarial suite green for all five roles (`TEST_STRATEGY.md §2`).
- [ ] Service-role usage confined (`motion/no-unscoped-service-query` clean); grep confirms single importer of the service key.
- [ ] No `NEXT_PUBLIC_*` secret; `.env.example` complete; secrets rotated before launch.
- [ ] Both buckets private with **no** `storage.objects` policies for `authenticated`/`anon`; listing with a user JWT returns zero objects; signed URL TTL 60 s verified; direct object URL returns 400; signer refuses a key outside the caller's organization.
- [ ] TOTP enrolment enforced for every `platform_users` row; magic link refused for platform users; `app.is_super_admin()` false below `aal2`.
- [ ] Upload pipeline tests: macro XLSX, zip bomb, JS-bearing PDF, CSV formula injection, oversize, wrong magic bytes — all rejected with the correct status.
- [ ] CSP, HSTS, frame, nosniff, referrer headers present on all routes (automated header test).
- [ ] Rate limits verified for auth, upload, AI, exports.
- [ ] AI adversarial eval green under grounding v2 (ADR-032): injected instructions in descriptions, names, filenames and PDF text; cross-org id requests; period confusion; wrong-metric/wrong-period/flipped-sign numbers rejected; entity misattribution rejected; digits in recommendations without `NumberRef` rejected; document URL requests by client role; model-authored descriptors rejected by tool 13.
- [ ] `document.sent_to_ai` audit written for every Claude extraction page; extraction blocked when `ai_pdf_extraction` is off or the page budget is exhausted.
- [ ] Audit: governance triggers fire; document download and export events written; super-admin `org.data_viewed` written; no UPDATE/DELETE possible on `audit_events`.
- [ ] Org enumeration: unknown vs inaccessible slug indistinguishable.
- [ ] Session: refresh rotation on; removed member loses access on next request; revoked platform role invalidates sessions.
- [ ] Dependency audit: zero critical/high; SBOM produced.
- [ ] Error responses contain no stack traces or SQL.
- [ ] Backup restore drill completed; purge job tested on a synthetic org including Storage.
- [ ] DPA, subprocessor list and residency confirmed with the product owner (CD-23).
- [ ] Critical/high findings from the external or internal security review resolved and re-tested.
