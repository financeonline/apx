# MOTION — Security Model

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-003, ADR-010, ADR-013, ADR-014, ADR-015, CD-11, CD-13, CD-17, CD-23, CD-24), `TENANCY_MODEL.md`, `RBAC_MATRIX.md`, `DATABASE_ARCHITECTURE.md`
Consumed by: `AI_ARCHITECTURE.md` (prompt-injection detail), `TEST_STRATEGY.md`, `IMPLEMENTATION_PLAN.md` (Phase 18)
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
 │  Next.js client components · anon key + user JWT · no writes to tables        │
 └───────────────┬───────────────────────────────────────────────┬──────────────┘
                 │ HTTPS (server actions / route handlers)       │ signed URL (60 s)
 ┌───────────────▼──────────────── Vercel (trusted server) ──────▼──────────────┐
 │ middleware → layout builds AccessContext → assertCan → services → data/       │
 │   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────────┐  │
 │   │ user client  │   │ job workers  │   │ AI tool loop (Claude untrusted)  │  │
 │   │ RLS applies  │   │ service role │   │ tools → services with caller ctx │  │
 │   └──────┬───────┘   │ withOrgScope │   └──────────────┬───────────────────┘  │
 └──────────┼───────────┴──────┬───────┴──────────────────┼──────────────────────┘
            │                  │                          │ HTTPS, API key server-only
 ┌──────────▼──────────────────▼───────────┐   ┌──────────▼───────────┐
 │ Supabase: Postgres (RLS forced) · Auth  │   │ Anthropic API        │
 │ Storage (private bucket, RLS)           │   │ (no tenant ids sent) │
 └─────────────────────────────────────────┘   └──────────────────────┘
```

Boundary rules: nothing crosses from browser to database except through server code; nothing crosses from the model to the database except through typed tools that carry the human caller's context; the service role never leaves the job worker.

## 2. The six enforcement layers

From `RBAC_MATRIX.md §4`. Each layer is written as if the others did not exist.

| # | Layer | Enforces | What it catches that others miss |
|---|---|---|---|
| 1 | Middleware | Valid session; route family matches role family; org slug resolvable | Unauthenticated hits, platform users wandering into `/app`, members hitting `/platform` |
| 2 | Layout / page | `effectiveRole ≠ none` for the slug; feature flag | Deep links to organizations the user is not part of (returns 404) |
| 3 | Server action / route handler | `assertCan(ctx, permission)` before any service call | A client role calling an upload action with a hand-crafted request |
| 4 | Service | Re-check for privileged operations; row-level constraints (last owner, role ceiling, assignee validity) | Logic bugs in a UI-facing action; rules a permission bit cannot express |
| 5 | Database RLS + constraints | Org access on every read; `app.has_permission()` on every write; composite FKs; triggers | Any bug in layers 1–4, including a forgotten `assertCan`; cross-org references even under bugs |
| 6 | AI tool gate | Same `assertCan` per tool; org id from context, never from the model | Model attempting to read another organization or a client asking for a document URL |

Test principle (`TEST_STRATEGY.md §2`): for each layer there is an adversarial test that disables or bypasses that layer and asserts the request still fails.

## 3. Identity and authentication (Supabase Auth)

| Setting | MVP value | Notes |
|---|---|---|
| Methods | Email + password; magic link | OAuth providers post-MVP; MFA (TOTP) post-MVP but the Auth project setting is enabled so users can opt in |
| Password policy | Minimum 12 characters; breached-password check enabled | Supabase "leaked password protection" on |
| Flow | PKCE for all browser flows | Server-side code exchange in `/auth/callback` route handler |
| Session | Access token 1 h; refresh token rotation on; refresh reuse detection on | `@supabase/ssr` cookie-based sessions, `HttpOnly`, `Secure`, `SameSite=Lax` |
| Idle timeout | 12 h without activity forces re-auth; absolute 30 days | Enforced by refresh-token expiry + middleware check of `profiles.disabled_at` |
| Redirect allow-list | Only production and preview domains, `/auth/callback`, `/invite/*` | Prevents open-redirect through magic links |
| Email verification | Required before an organization can be created or an invitation accepted | |
| Rate limits (auth) | Sign-in 10/15 min per IP+email; magic link 3/15 min per email; reset 3/h per email | Supabase Auth rate limits + edge rate limit |
| Account disable | `profiles.disabled_at` set → middleware rejects; Supabase user banned via admin API | Removal from the last organization does not disable the account |

Invitation lifecycle: token is 32 random bytes, stored as SHA-256 in `invitations.token_hash`, expires after 7 days, single-use, bound to the invited email (acceptance with a different signed-in email is refused). Accepting creates the membership in a transaction and writes `member.invited_accepted`.

## 4. Session revocation semantics
- Removal from an organization: context is resolved per request, so access ends on the next request; no session invalidation needed, but the app also calls Supabase `signOut({scope: 'others'})` for the removed user when the remover is an owner (defence against long-lived tabs).
- Employee assignment revoked: same; additionally the employee's open AI conversations for that org are archived.
- Platform role revoked: all sessions of that user are invalidated via the Auth admin API.
- Organization suspended: every member resolves to `dashboard.view` only; a banner explains.

## 5. Secrets and configuration

| Secret | Where | Rules |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env (server only) | Only imported by `src/core/db/service-client.ts`; ESLint rule forbids import elsewhere |
| `ANTHROPIC_API_KEY` | Vercel env | Only `src/modules/ai/provider/claude-client.ts` |
| `CRON_SECRET` | Vercel env | Compared with constant-time equality in `/api/jobs/run` |
| `SUPABASE_JWT_SECRET` | Not used by app code | Verification done by Supabase; never copied into app |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | The only `NEXT_PUBLIC_*` values; the anon key is safe only because RLS is forced on every table |

Rules: no secrets in the repository (`.env.example` only); rotation runbook for each secret with a 90-day cadence for API keys; preview deployments use a separate Supabase project; production secrets are readable only by two named maintainers in Vercel.

## 6. Database security

### 6.1 RLS design
- `ENABLE` and `FORCE ROW LEVEL SECURITY` on every table in `public` except `role_permissions` (read-only reference).
- Reads: `organization_id IN (SELECT app.accessible_org_ids())`.
- Writes: `app.has_permission(organization_id, '<permission>')` with the permission named per table (`DATABASE_ARCHITECTURE.md §11`).
- Governance tables add ceiling checks (`RBAC_MATRIX.md §3`).
- No `DELETE` policy on financial record tables, `audit_events`, `import_rows`, `source_documents`.
- Helper functions in schema `app` are `SECURITY DEFINER`, `STABLE`, with `SET search_path = public, pg_temp`; `app` schema is not exposed through PostgREST; `EXECUTE` granted to `authenticated` only for the three helpers.
- Views over `profiles` for member names are `security_invoker = false` with an explicit shared-org filter.
- PostgREST exposure: only schema `public`; `auth`, `storage`, `app` never exposed. Tables that the browser never needs (`ai_tool_calls`, `jobs`, `platform_settings`, `role_permissions` writes) also have `REVOKE` on the `anon` role.

### 6.2 Service-role confinement (ADR-013)
```ts
// src/core/db/service-client.ts (only importer of the service role key)
export async function withOrgScope<T>(orgId: string, fn: (db: ServiceDb) => Promise<T>): Promise<T>
// sets app.current_org via set_config for the transaction; wraps the client so every
// .from(table) call on a tenant table auto-applies .eq('organization_id', orgId);
// throws if a query on a tenant table omits it.
```
ESLint rule `motion/no-unscoped-service-query`: any call on the service client outside `withOrgScope` or outside `src/modules/*/data/jobs/**` fails CI. Platform-level jobs (`org.purge`) use `withPlatformScope(reason)` which writes an audit event first.

### 6.3 Constraints as security
Composite FKs (`TENANCY_MODEL.md §6`), last-owner trigger, platform-user exclusivity trigger, XOR on `evidence_items`, unique dedupe keys. These hold even if application code is wrong.

## 7. Storage security
- Single private bucket `source-documents`; public access disabled; no public buckets exist.
- Object path `{organization_id}/{document_id}/{original-filename}`; filename sanitised (ASCII, max 120 chars, no path separators).
- Storage RLS: `SELECT` where `(storage.foldername(name))[1]::uuid IN (SELECT app.accessible_org_ids()) AND app.org_role(...) <> 'client'`; `INSERT/UPDATE/DELETE` only by service role from server code.
- Uploads go browser → `/api/imports/upload` (server) → Storage, never direct-to-Storage from the browser, so validation (§8) runs before the object exists.
- Downloads: `/api/documents/[documentId]/url` checks `documents.view`, writes `document.downloaded` audit event, returns a signed URL valid 60 seconds, `Content-Disposition: attachment`.
- Extracted text (`extracted_text_path`) lives in the same bucket under the document folder with the same rules.
- Purge job deletes objects before rows and verifies emptiness.

## 8. Upload validation pipeline
Order is fixed; the first failure stops processing and sets `source_documents.status` accordingly.

| Step | Check | On failure |
|---|---|---|
| 1 | Size ≤ 25 MB; declared type ∈ {csv, xlsx, pdf} | 413 / 415; nothing stored |
| 2 | MIME sniffing by magic bytes (`file-type`), not extension; CSV must be valid UTF-8/UTF-16 text with no NUL bytes | `quarantined` |
| 3 | XLSX: ZIP structure valid; uncompressed size ≤ 250 MB and ratio ≤ 100:1 (zip bomb); no `vbaProject.bin` (macros rejected); external links stripped; formulas are read as cached values only — formulas are never evaluated | `quarantined` with reason |
| 4 | CSV/XLSX cell sanitisation: any cell starting with `=`, `+`, `-`, `@`, tab or CR is stored as text with a leading apostrophe on export (CSV-injection defence) | continue |
| 5 | PDF: parse with a hardened library in a worker; reject encrypted PDFs, JavaScript actions, embedded files, launch actions; page count ≤ 200 | `unreadable` or `quarantined` |
| 6 | Antivirus hook: interface `scanFile(path): Promise<ScanResult>`; MVP implementation is a no-op that records `scan_result.skipped = true`; ClamAV or a SaaS scanner plugs in without code changes elsewhere | `quarantined` |
| 7 | SHA-256 computed; duplicate file blocked (CD-12) | 409 with link to prior batch |
| 8 | Store object, insert `source_documents` row with `status = 'ready'`, audit `document.uploaded` | — |

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
- Tools are the only data path; the model never receives organization ids, user ids, or raw table rows beyond what a tool returns for the caller's organization.
- Every tool call is authorised with the human caller's `AccessContext` (layer 6) and logged to `ai_tool_calls`.
- Imported free text (descriptions, payee names, PDF text) is passed to the model inside delimited data blocks with an explicit "data, not instructions" framing, and is size-capped; the system prompt instructs the model to ignore instructions inside data.
- Output is a JSON structure validated by schema; numbers are grounded against tool outputs; ungrounded answers are degraded, never shown as fact.
- Data sent to Anthropic: metric values, category names, counterparty names, transaction descriptions for the caller's org only; never documents, never other organizations, never secrets. Anthropic API data-retention terms are recorded in the DPA (CD-23).

## 12. Audit logging

| Logged (always) | Never logged |
|---|---|
| Governance changes (trigger diff): memberships, assignments, platform roles, organizations, account category remaps, bank opening balances | Passwords, tokens, secrets, full session cookies |
| Service events: `import.created/committed/rolled_back/rejected`, `record.superseded`, `document.uploaded/downloaded/deleted`, `export.created`, `ai.answered` (message id, tool names, grounding status), `ai.feedback`, `alert.status_changed`, `action.created/assigned/status_changed`, `member.*`, `assignment.*`, `org.*`, `auth.sign_in/sign_out/failed` | Raw financial payloads in platform-level events (`organization_id IS NULL` rows carry ids only) |
| Super-admin tenant views: `org.data_viewed` with route (CD-13) | Free-text AI prompts in platform-level views (available only inside the org's own log) |
| Security events: rate-limit trips, quarantined uploads, permission denials (sampled 1:1 for denials, 1:10 for rate limits) | Unmasked bank account numbers (never stored anywhere) |

Properties: append-only (§6.1); `request_id` on every row; IP and user agent for user-initiated events; retention 7 years (NFR-14); owners/admins query their org's log in `/settings/audit`; super admins in `/platform/audit`. Purge redacts `before/after` payloads for deleted organizations but keeps the rows.

## 13. Super Admin access controls (CD-13)
- MVP: full read; every `/app/[orgSlug]/*` render for a super admin writes `org.data_viewed`; owners see these in their audit log under a "MOTION staff access" filter; a weekly digest of staff views is emailed to owners (post-MVP if not trivial).
- Super admins cannot write tenant financial data through the UI except via the same import/review flows as members, so their writes are indistinguishable in form and fully audited with `actor_type = 'platform_admin'`.
- Post-MVP: `support_access_grants (super_admin_user_id, organization_id, reason, expires_at)`; `app.accessible_org_ids()` third branch changes to consult it; UI forces reason entry.
- Super admin accounts require MFA as soon as MFA ships; until then, they are limited to named individuals with hardware-key-protected email.

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
- Deletion: owner or super admin sets `pending_deletion`; 30-day grace with a banner and a cancel option; `org.purge` job deletes Storage objects, then tenant rows in dependency order, then nulls `audit_events.before/after` for the org, keeping the events. Personal data of a user who leaves all organizations is retained 30 days then the profile is anonymised.
- Backups: Supabase PITR; restore drill documented; backups inherit region.
- Subprocessors: Supabase, Vercel, Anthropic, error-tracking vendor; listed in the DPA.

## 17. Incident response basics
1. Detect (§15 alert) → 2. Triage owner (on-call maintainer) within 1 h → 3. Contain: rotate the affected secret, suspend the affected organization or user, disable the affected route via feature flag → 4. Assess scope from `audit_events` and logs by `request_id` → 5. Notify affected organization owners within 72 h where personal data is involved → 6. Post-incident write-up in `docs/incidents/`. Runbooks for: leaked service key, leaked Anthropic key, suspected cross-tenant read, malicious upload, compromised super admin.

## 18. Pre-production security review checklist (SOW §23)
- [ ] Every `public` table has RLS enabled **and forced**; pgTAP suite `rls_all_tables` green.
- [ ] `role_permissions` parity test green; no route or action without `assertCan` (lint `motion/require-assert-can` on files under `src/app/**/actions.ts` and `src/app/api/**`).
- [ ] Cross-tenant adversarial suite green for all five roles (`TEST_STRATEGY.md §2`).
- [ ] Service-role usage confined (`motion/no-unscoped-service-query` clean); grep confirms single importer of the service key.
- [ ] No `NEXT_PUBLIC_*` secret; `.env.example` complete; secrets rotated before launch.
- [ ] Storage bucket private; signed URL TTL 60 s verified; direct object URL returns 400.
- [ ] Upload pipeline tests: macro XLSX, zip bomb, JS-bearing PDF, CSV formula injection, oversize, wrong magic bytes — all rejected with the correct status.
- [ ] CSP, HSTS, frame, nosniff, referrer headers present on all routes (automated header test).
- [ ] Rate limits verified for auth, upload, AI, exports.
- [ ] AI adversarial eval green: injected instructions in descriptions, cross-org id requests, period confusion, fabricated numbers (grounding), document URL requests by client role.
- [ ] Audit: governance triggers fire; document download and export events written; super-admin `org.data_viewed` written; no UPDATE/DELETE possible on `audit_events`.
- [ ] Org enumeration: unknown vs inaccessible slug indistinguishable.
- [ ] Session: refresh rotation on; removed member loses access on next request; revoked platform role invalidates sessions.
- [ ] Dependency audit: zero critical/high; SBOM produced.
- [ ] Error responses contain no stack traces or SQL.
- [ ] Backup restore drill completed; purge job tested on a synthetic org including Storage.
- [ ] DPA, subprocessor list and residency confirmed with the product owner (CD-23).
- [ ] Critical/high findings from the external or internal security review resolved and re-tested.
