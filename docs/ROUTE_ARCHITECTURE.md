# MOTION — Route Architecture

Depends on: `RBAC_MATRIX.md`, `TENANCY_MODEL.md §7`, `ARCHITECTURAL_DECISIONS.md` (ADR-014, ADR-019, ADR-025), `UX_ARCHITECTURE.md`
Consumed by: `SERVICE_ARCHITECTURE.md`, `TEST_STRATEGY.md`, `IMPLEMENTATION_PLAN.md`

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-026, ADR-030, ADR-037, ADR-038. Findings addressed: F-A-01, F-A-03, F-A-04, F-A-07, F-A-11, F-A-12, F-B-08, F-B-15, F-D-07, F-D-09. See `RED_TEAM_REVIEW.md`.

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-043. Findings addressed: R2-A-02. Download and export handlers record access events through `api_server.record_access_event` before the signer mints a URL. See `RED_TEAM_REVIEW.md §6`.

Next.js App Router. Three route families, each with its own root layout and shell. Family membership is decided by the URL prefix and enforced in middleware.

## 1. Route tree

```
/                                     (public) marketing / sign-in redirect
/sign-in
/sign-up
/forgot-password
/reset-password
/invite/[token]
/legal/terms
/legal/privacy
/auth/callback                        (route handler: PKCE exchange)

/onboarding                           (authenticated, no org yet) create first organization
/select-organization                  (authenticated) org switcher when > 1 org
/account                              (authenticated) profile, password, sessions
/account/mfa                          (authenticated) TOTP enrolment; mandatory for platform users (ADR-038.8)

/app/[orgSlug]                        → redirects to /home
/app/[orgSlug]/home
/app/[orgSlug]/insights
/app/[orgSlug]/money                  → redirects to /money/profit-and-loss
/app/[orgSlug]/money/profit-and-loss
/app/[orgSlug]/money/cash
/app/[orgSlug]/money/banking
/app/[orgSlug]/money/receivables
/app/[orgSlug]/money/payables
/app/[orgSlug]/customers
/app/[orgSlug]/customers/[counterpartyId]
/app/[orgSlug]/actions
/app/[orgSlug]/actions/[actionId]
/app/[orgSlug]/reports
/app/[orgSlug]/reports/monthly/[period]
/app/[orgSlug]/analyst
/app/[orgSlug]/analyst/[conversationId]
/app/[orgSlug]/evidence/[bundleId]
/app/[orgSlug]/data/imports
/app/[orgSlug]/data/imports/new
/app/[orgSlug]/data/imports/[batchId]
/app/[orgSlug]/data/documents
/app/[orgSlug]/data/documents/[documentId]
/app/[orgSlug]/data/accounts
/app/[orgSlug]/settings
/app/[orgSlug]/settings/team
/app/[orgSlug]/settings/audit
/app/[orgSlug]/settings/billing       (feature flag: billing)
/app/[orgSlug]/settings/danger

/portfolio                            (platform_employee) assigned organizations

/platform                             (platform_super_admin)
/platform/organizations
/platform/organizations/[orgId]
/platform/users
/platform/assignments
/platform/jobs
/platform/ai-feedback
/platform/audit
/platform/settings

/api/jobs/run                         (POST, cron secret)
/api/imports/upload                   (POST, multipart)
/api/ai/chat                          (POST, streaming)
/api/documents/[documentId]/url       (GET)
/api/exports/[kind]                   (GET)
/api/reports/[reportId]/download      (GET)
/api/health                           (GET, public)
```

## 2. Public family

| Route | Purpose | Roles | Permissions | Flag | Render | Data loaded | Empty / denied |
|---|---|---|---|---|---|---|---|
| `/` | Product page; signed-in users redirected to their last org | any | — | — | Server | none | — |
| `/sign-in` | Email+password and magic link | anon | — | — | Client form in server page | none | Signed-in users redirected |
| `/sign-up` | Create account (email verification required) | anon | — | — | Client form | none | — |
| `/forgot-password`, `/reset-password` | Reset flow | anon | — | — | Client form | none | Invalid/expired token → friendly error, link to request again |
| `/invite/[token]` | Accept invitation | anon or signed-in | — | — | Server | `invitations` by token hash (validity only) | Invalid/expired → "This invitation is no longer valid"; org name shown only after validation |
| `/legal/*` | Terms, privacy, "not advice" statement (SOW §26) | any | — | — | Static | none | — |
| `/auth/callback` | PKCE code exchange, then redirect to `next` if allow-listed | anon | — | — | Handler | — | Bad code → `/sign-in?error=…` |

## 3. Authenticated — no organization context

| Route | Purpose | Roles | Permissions | Flag | Render | Data loaded | Empty / denied |
|---|---|---|---|---|---|---|---|
| `/onboarding` | Create the first organization (name, country, currency, fiscal year start) | signed-in with 0 memberships and no platform role | — | — | Server + client form | `tenancy.createOrganization` | Users with ≥1 org redirected to `/select-organization` or last org |
| `/select-organization` | Switcher | signed-in | — | — | Server | `tenancy.listAccessibleOrganizations` | 0 orgs → `/onboarding`; 1 org → redirect to it |
| `/account` | Profile, password, sessions, sign-out-everywhere | signed-in | — | — | Server + client forms | `profiles` self (column-limited update via `api.update_profile`, ADR-038.3) | — |
| `/account/mfa` | Enrol/verify TOTP | signed-in | — | — | Client | Supabase Auth MFA | Platform users are redirected here until enrolled |

## 4. Tenant family `/app/[orgSlug]/*`

All routes: `effectiveRole ∈ {owner, admin, client, employee, super_admin}` for the slug, else 404. `dashboard.view` is implied by any non-`none` role.

| Route | Purpose | Roles | Permissions | Flag | Render | Data loaded (services) | Empty / denied |
|---|---|---|---|---|---|---|---|
| `/home` | Executive dashboard (SOW §8) | all | `dashboard.view` | — | Server; charts client | `health.getCurrent`, `financialEngine.getHeadline(period)`, `financialEngine.getTrend(12)`, `alerts.listTop(5)`, `actions.listOutstanding(5)`, `imports.getCoverage` — period = latest complete month (ADR-030) | No data → onboarding empty state with "Add data" CTA; bank-only → bank-only variant (ADR-035); partial current month → "{Month} so far" line |
| `/insights` | What changed and why: variances, alerts, movements | all | `dashboard.view`, `financials.view` | — | Server | `alerts.list`, `financialEngine.getVariances(period)`, `financialEngine.getExpenseChanges` | No periods with 2 months → "Need two months to compare" |
| `/money/profit-and-loss` | P&L by standard category, drill to accounts | all | `financials.view` | — | Server | `financialEngine.getPnl(period)`, `expense_by_category`, `expense_by_account` | No P&L data → explains which imports produce a P&L |
| `/money/cash` | Opening/closing cash, movement, runway | all | `financials.view`, `banking.view` | — | Server | `financialEngine.getCash(period)` | No bank data → prompt to import a statement or enter opening balance (CD-06) |
| `/money/banking` | Bank accounts, transactions, categorisation, recurring, transfers | all (edit needs `banking.reconcile`) | `banking.view` | — | Server list; client table | `banking.listAccounts`, `banking.listTransactions(filters)`, `banking.listRecurring` | No accounts → add account / import statement |
| `/money/receivables`, `/money/payables` | Aging, overdue, days | all | `financials.view` | — | Server | `financialEngine.getReceivables/Payables(period)` | No invoices → basis note (CD-07) |
| `/customers` | Revenue by customer, concentration | all | `customers.view` | — | Server | `financialEngine.getCustomerRevenue(period)`, `counterparties.list(kind=customer)` | No customer data → explains sales invoice import |
| `/customers/[counterpartyId]` | One counterparty: revenue trend, invoices, transactions, actions | all (edit needs `customers.edit`) | `customers.view` | — | Server | `counterparties.get`, `invoices.listFor`, `financialEngine.getCustomerTrend` | Cross-org id → 404 |
| `/actions` | Action Centre list, filters | all | `actions.view` | — | Server; client filters | `actions.list` | None → "No actions yet" with create (if `actions.create`) |
| `/actions/[actionId]` | Detail, status, outcome, evidence | all | `actions.view` (+`actions.update_own` / `actions.assign`) | — | Server + client form | `actions.get`, `evidence.getBundle` | Cross-org → 404 |
| `/reports` | Report list (MVP: monthly) | all | `reports.view` | — | Server | `reporting.listAvailable` | No closed month → "First report available after month end" |
| `/reports/monthly/[period]` | Monthly Management Report view + PDF | all (PDF needs `reports.generate`) | `reports.view` | — | Server | `reporting.getMonthly(period)` | Period without data → 404-style empty |
| `/analyst` | New conversation | all | `ai.use` | — | Client chat shell | `ai.listConversations` | Quota exhausted → notice with reset time |
| `/analyst/[conversationId]` | Conversation | owner of conversation, org owner/admin | `ai.use` | — | Client | `ai.getConversation` | Other user's conversation → 404 |
| `/evidence/[bundleId]` | Evidence drawer as page (deep-linkable) | all (document items need `documents.view`) | `financials.view` | — | Server | `evidence.getBundle`, `evidence.resolveItems` | Cross-org → 404; client sees document items as "source document (restricted)" |
| `/data/imports` | Import history, replace/roll back, data coverage strip, export, recalculate (reached via the header Data menu, ADR-037) | owner, admin, employee, super_admin | `imports.review`; export button `data.export`; recalculate button `intelligence.recompute` | — | Server | `imports.listBatches`, `imports.getCoverage`, `calculationRuns.listRecent` | None → CTA |
| `/data/imports/new` | Upload wizard (Add data) | same | `imports.create` | — | Client wizard | `imports.listMappings` | — |
| `/data/imports/[batchId]` | Review, map, resolve, commit, roll back | same | `imports.review` | — | Client | `imports.getBatch`, `imports.listRows(status)` | Cross-org → 404 |
| `/data/documents` | Document library | same | `documents.view` | — | Server | `documents.list` | None → CTA |
| `/data/documents/[documentId]` | Viewer with page reference and linked batches | same | `documents.view` | — | Server + client viewer | `documents.get`, `documents.getSignedUrl` (via API) | Client role → 404 |
| `/data/accounts` | Chart of accounts and category mapping | same | `financials.edit` | — | Client table | `accounts.list` | — |
| `/settings` | Organization settings: name, legal name, industry, fiscal year start, base currency, timezone | owner, admin, super_admin | `settings.manage` | — | Server + client forms | `organizations.get` (writes via `api.update_organization`) | Employee/client → gear hidden; deep link → denied state |
| `/settings/team` | Members, invitations, MOTION advisers | owner, admin, super_admin | `users.view` (+`users.invite`, `users.manage`, `assignments.view`) | — | Server + client | `tenancy.listMembers`, `tenancy.listInvitations`, `tenancy.listAssignments` | — |
| `/settings/audit` | Org audit log | owner, admin, super_admin | `audit.view` | — | Server; client filters | `audit.query(org)` | — |
| `/settings/billing` | Plan | owner, super_admin | `billing.manage` | `billing` | Server | `organizations.get` | Flag off → 404 |
| `/settings/danger` | Delete organization, transfer ownership | owner, super_admin | `org.delete` | — | Client confirm | — | — |

## 5. Employee family

| Route | Purpose | Roles | Permissions | Flag | Render | Data loaded | Empty / denied |
|---|---|---|---|---|---|---|---|
| `/portfolio` | Cards for assigned organizations: name, health score, open alerts, last import | `platform_employee`, `platform_super_admin` (TOTP enrolled) | `assignments.view` | — | Server | `portfolio.list(ctx)` — one aggregate projection per data type filtered by `organization_id IN (select app.accessible_org_ids())`, cached per organization tag (ADR-038.13) | No assignments → "No client organizations assigned yet" |

## 6. Platform family `/platform/*`

All routes: `platform_super_admin` only with `aal2` (TOTP verified, ADR-038.8); everyone else 404; a super admin without TOTP is redirected to `/account/mfa`. Suspend, purge, role grants and assignment creation require re-authentication within the last 10 minutes.

| Route | Purpose | Permissions | Render | Data loaded | Empty / denied |
|---|---|---|---|---|---|
| `/platform` | Overview: org count, jobs failing, open feedback | `system.manage` | Server | `platform.getOverview` | — |
| `/platform/organizations` | List/create/suspend | `platform.orgs.manage` | Server + client | `platform.listOrganizations` | — |
| `/platform/organizations/[orgId]` | Org detail: members, assignments, flags, quotas, status, "open as staff" link (audited) | `platform.orgs.manage` | Server + client | `platform.getOrganization` | Unknown → 404 |
| `/platform/users` | Platform roles | `platform.users.manage` | Server + client | `platform.listPlatformUsers` | — |
| `/platform/assignments` | Assign employees ↔ organizations | `assignments.manage` | Client | `platform.listAssignments` | — |
| `/platform/jobs` | Job monitor, retry, quarantined uploads | `platform.jobs.view` | Client (polling) | `jobs.list` | — |
| `/platform/ai-feedback` | Review flagged insights | `platform.ai_feedback.review` | Client | `ai.listFeedback` | — |
| `/platform/audit` | Global audit search | `audit.view` | Server; client filters | `audit.queryAll` | — |
| `/platform/settings` | Defaults: AI quotas, alert defaults, health config version | `system.manage` | Client | `platform.getSettings` | — |

## 7. Route handlers

| Handler | Method | Auth | Permission | Rate limit | Notes |
|---|---|---|---|---|---|
| `/api/jobs/run` | POST | `CRON_SECRET` header (constant-time compare) | — | Vercel Cron only | Drains up to N jobs per call; returns counts |
| `/api/imports/upload` | POST multipart | session | `imports.create` for slug in form field resolved server-side | 20/h user, 100/day org | Runs `SECURITY_MODEL.md §8`; returns `source_document_id`, `batch_id` |
| `/api/ai/chat` | POST (SSE stream) | session | `ai.use` | 10/min user; org quota | Body `{conversationId?, message, orgSlug}`; org resolved from slug |
| `/api/documents/[documentId]/url` | GET | session | `documents.view` | 60/min | Calls `api_server.record_access_event('document.downloaded')` and passes the returned audit id to the signer, which verifies it before minting the 60-second URL (ADR-043.2/5); 404 cross-org |
| `/api/exports/[kind]` | GET | session | `data.export` | 10/h | `kind ∈ {ledger, bank_transactions, invoices, metrics}`; streams CSV using `description_normalized`; `api_server.record_access_event('export.created')` before the first byte |
| `/api/reports/[reportId]/download` | GET | session | `reports.view` | 30/h | Resolves `report_files` by `(organization_id, id)` (404 cross-org), writes `report.downloaded`, returns a 60-second signed URL from bucket `reports` (ADR-038.7) |
| `/api/health` | GET | none | — | 60/min IP | `{ok, version}`; no DB details |

Server actions (in `actions.ts` files colocated with pages) handle all other mutations: membership, invitations, assignments revoke, import mapping/review/commit/rollback, account mapping, bank categorisation, alert status, actions CRUD, settings, feedback. Each begins with `const ctx = await getAccessContext(orgSlug); assertCan(ctx, '…')` and then calls a module service, which performs the write by invoking the corresponding `api.*` SECURITY DEFINER function through the user-session client (`rpc`). No server action, route handler or component writes a table directly: the `authenticated` role has no INSERT/UPDATE/DELETE privilege on any table (ADR-026). Storage objects are never read or written with the user JWT; uploads and signed URLs go through `core/storage` (ADR-038.1).

## 8. Middleware

`middleware.ts` runs on every non-static request:

1. Refresh the Supabase session cookie (`@supabase/ssr`).
2. Classify the path: `public`, `auth-noorg`, `app`, `portfolio`, `platform`, `api`.
3. No session: `public` and `api/health` pass; everything else redirects to `/sign-in?next=<path>` (only relative paths accepted for `next`).
4. Session present, `profiles.disabled_at` set → sign out and redirect to `/sign-in?error=disabled`.
4a. Session present and the user has a `platform_users` row: if the session's `aal` is not `aal2`, redirect every request except `/account/mfa`, `/account` and sign-out to `/account/mfa` (ADR-038.8). `/auth/callback` refuses a magic-link exchange for platform users and shows "Platform accounts must sign in with a password and authenticator code".
5. Load the platform role (single cached query per request):
   - `platform_super_admin`: may access every family.
   - `platform_employee`: `/platform/*` → 404; `/app/[orgSlug]` allowed only if an active assignment exists (checked in layout, not middleware, to keep middleware light); `/` and `/select-organization` redirect to `/portfolio`.
   - Members: `/platform/*` and `/portfolio` → 404.
6. `/` with session → redirect to `profiles.last_active_org_id` slug only if that organization is in the user's accessible set (checked in the layout; a stale or foreign id is ignored, never resolved to a slug), else `/select-organization`.
7. `/app/[orgSlug]/*`: do not resolve access in middleware beyond session; the org layout does it (needs DB and returns 404 uniformly).
8. Attach `x-request-id` header; apply rate-limit buckets for `/api/*` and auth routes.

Suspended organization: the org layout injects a banner and the page components receive `ctx.permissions` reduced to `dashboard.view`.

## 9. Layout hierarchy and file conventions

```
app/
  layout.tsx                       root: fonts, theme, toaster, no auth
  (public)/layout.tsx              marketing shell
  (auth)/layout.tsx                requires session; minimal shell (onboarding, select-organization, account)
  app/[orgSlug]/layout.tsx         resolves slug → org, builds AccessContext (React.cache), 404 on none,
                                   renders customer shell: 7-item nav + Settings + "Add data" button + org switcher
  app/[orgSlug]/(sections)/…       one folder per nav item; section layouts add secondary nav (money/*)
  portfolio/layout.tsx             employee shell
  platform/layout.tsx              super admin shell (distinct visual identity)
  api/…/route.ts                   handlers
```

Per-route files: `loading.tsx` (skeleton matching the page's layout, `UX_ARCHITECTURE.md §8`), `error.tsx` (client boundary with `request_id` and "Try again"), `not-found.tsx` at `app/[orgSlug]/` (single uniform 404 used for unknown and inaccessible), `page.tsx` server component by default; client components only for forms, tables with filters, chat and charts.

`getAccessContext(orgSlug)` is the only way to obtain `AccessContext` in the tenant family; it is `React.cache`d so layout, page and server actions share one resolution per request.

## 10. URL and parameter conventions

- Organization slug: `[a-z0-9-]{3,40}`, immutable after creation; renaming the organization does not change the slug.
- All entity ids are UUIDs and validated with Zod before any query.
- Period parameter: `YYYY-MM` only (monthly granularity in MVP, ADR-030.6); ranges as `?from=YYYY-MM&to=YYYY-MM`; default period is the **latest complete month** (`fiscal_periods.is_complete`), the same rule the AI Analyst uses (`core/periods`).
- Filters live in search params (`?status=open&severity=high`) so views are shareable; never in cookies.
- Deep links to evidence (`/evidence/[bundleId]`), documents, batches, actions and conversations are org-scoped by URL; a bundle id from another organization returns 404 even for a user who is a member of both (the URL's slug must own the resource).
- Redirect targets after auth (`next`) must be same-origin relative paths.

## 11. Route → RBAC test matrix (stub for `TEST_STRATEGY.md`)

Expected HTTP status for a representative set. `member-B` = member of another organization; `emp-unassigned` = employee without assignment to this org.

| Route | owner | admin | client | employee (assigned) | emp-unassigned | member-B | super_admin | anon |
|---|---|---|---|---|---|---|---|---|
| `/app/A/home` | 200 | 200 | 200 | 200 | 404 | 404 | 200 (+audit) | 302 → sign-in |
| `/app/A/data/imports/new` | 200 | 200 | 403* | 200 | 404 | 404 | 200 | 302 |
| `/app/A/data/documents/[id]` | 200 | 200 | 404 | 200 | 404 | 404 | 200 | 302 |
| `/app/A/settings/team` | 200 | 200 | 403* | 403* | 404 | 404 | 200 | 302 |
| `/app/A/settings/billing` (flag off) | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 302 |
| `/app/A/settings/danger` | 200 | 403* | 403* | 403* | 404 | 404 | 200 | 302 |
| `/app/A/evidence/[bundle-of-B]` | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 302 |
| `/portfolio` | 404 | 404 | 404 | 200 | 200 | 404 | 200 | 302 |
| `/platform/organizations` | 404 | 404 | 404 | 404 | 404 | 404 | 200 | 302 |
| `POST /api/imports/upload` (org A) | 200 | 200 | 403 | 200 | 404 | 404 | 200 | 401 |
| `GET /api/documents/[A-doc]/url` | 200 | 200 | 403 | 200 | 404 | 404 | 200 | 401 |
| `POST /api/ai/chat` (org A) | 200 | 200 | 200 | 200 | 404 | 404 | 200 | 401 |
| Server action `inviteMember(role=owner)` | 200 | 403 | 403 | 403 | 404 | 404 | 200 | 401 |
| Server action `revokeAssignment` | 200 | 403 | 403 | 403 | 404 | 404 | 200 | 401 |
| `/app/A/data/imports` | 200 | 200 | 403* | 200 | 404 | 404 | 200 | 302 |
| `PATCH /rest/v1/ledger_entries?id=eq.X` (direct PostgREST with the user JWT) | 403† | 403† | 403† | 403† | 403† | 403† | 403† | 401 |
| `POST /rest/v1/jobs` (direct, any payload) | 403† | 403† | 403† | 403† | 403† | 403† | 403† | 401 |
| `GET /storage/v1/object/authenticated/source-documents/A/…` (direct with user JWT) | 400/403 | 400/403 | 400/403 | 400/403 | 400/403 | 400/403 | 400/403 | 401 |
| `/platform/organizations` as super admin without `aal2` | — | — | — | — | — | — | 302 → `/account/mfa` | — |
| `rpc('api.invite_member', role='owner')` as admin | 200 | 403 (function raises) | 403 | 403 | 404 | 404 | 200 | 401 |

`403*` = page renders the friendly permission-denied state (`UX_ARCHITECTURE.md §7.4`) with HTTP 403; the organization's existence is already known to these users, so 403 does not leak anything. `403†` = PostgREST `42501 permission denied` because `authenticated` holds no write privilege on any table (ADR-026); this is independent of RLS and of the caller's role.
