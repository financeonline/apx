# MOTION — Phases 1–7 final audit (independent, post-remediation)

Date: 2026-09-11 · Tree `main` at `507e1a0` (clean) · Stance: hostile; the remediation was treated as
a claim to be broken, not a report to be read.

> **Method.** Every check below was made against the running local stack, not the documents. I wrote
> my own probes outside the repository — ~180 of them across four scripts — minted real user JWTs
> with the harness's secret, drove every `api.*` function cross-tenant, tried to write invalid
> references as a server bug would, walked the pages as four different signed-in callers, and only
> then ran the repository's own suites. No code was modified; fixtures were removed afterwards
> (verified: zero rows left). Where a probe of mine was mis-shaped I say so rather than counting it.

---

## 1. Verdict on each remediated finding

| # | Severity (as audited) | Claim in `PHASE_1_7_REMEDIATION.md` | Independently verified? |
|---|---|---|---|
| H1 | HIGH | Tenant scope established per request; fails closed on missing, wrong and malformed scope; forged header does nothing | **Yes** — §3.1, §3.2 |
| M1 | MEDIUM | Permission denial is 403 + the §7.4 denied state; 404 kept where disclosure matters | **Yes** — §3.6, with one residual (L-1) |
| M2 | MEDIUM | Every discriminator mapped; unmapped raises; no-table values refuse an id; two constraints added; drift gate detects | **Yes** — §3.7; the gate's detection re-proved by me |
| M3 | MEDIUM | One completeness predicate in `core/periods`, engine delegates, parity tested | **Yes** — §3.8 |
| L2/L3/L4/L6 | LOW | Access resolution, assurance ladder, delete twin, `/home` gate | **Yes** — §3.10, §3.9 |
| L1/L5 | LOW | Recorded / left open | Confirmed still open, as stated |
| ADR-095 | new | Signed-download recency tolerates clock skew | Confirmed; api e2e green |

---

## 2. Findings

**No CRITICAL. No HIGH. No MEDIUM.**

| # | Severity | Finding |
|---|---|---|
| L-1 | LOW | Six `/platform/*` pages still call `assertCan`, which would reach the error boundary (500) rather than the 403 path. Unreachable today: middleware rewrites the `/platform` family to 404 for anyone but an active super admin, and a super admin holds every permission. The remediation report's statement that `assertCan` now lives only in services, actions and routes is inaccurate for these six files. |
| L-2 | LOW | `RBAC_MATRIX.md` grants employees `platform.ai_feedback.review` (◐ assigned organisations) and ADR-082 widened the reads for them, but the only review surface is `/platform/ai-feedback`, which middleware closes to everyone except super admins. An employee holding the permission has nowhere to use it. Pre-existing; over-restriction, not exposure. |
| L-3 | LOW | Carried from the audit, unchanged: route-table drift is recorded (ADR-094) not corrected, and health rule ids remain untyped strings (L5). |

### L-1 · residual `assertCan` on platform pages

`src/app/platform/{organizations/[orgId],settings,ai-feedback,ai-feedback/[feedbackId],audit,jobs}/page.tsx`.
The exposure path is: a caller who passes middleware's family gate (`isActiveSuperAdmin`) but whose
`getPlatformContext()` resolves to `none`. Both read `api.my_platform_role`, and the only difference is
`has_aal2`, which middleware enforces earlier (step 4a) — so I could not construct the case. It stays
LOW because it is the same class of defect M1 fixed, in the one family M1 did not touch, and because
the report claims otherwise.

### L-2 · a permission with no surface

`ROUTE_ARCHITECTURE.md §6` row 154 lists `/platform/ai-feedback` under `platform.ai_feedback.review`;
`src/middleware.ts:198` admits only `isActiveSuperAdmin` to `/platform/*`. An assigned employee at
aal2 is told 404. Nothing leaks; the matrix and the route family simply disagree about who reviews.
Out of the remediation's scope and older than it.

---

## 3. The fourteen checks

### 3.1 Tenant context · 3.2 `withOrgScope` — **pass**

What I established, in order:

- **The transport is real.** A custom request header reaches `request.headers` in the database
  transaction-locally (probed with a throwaway function during the remediation; re-relied on here
  through every scoped call below).
- **The eight scoped functions are what the migration says.** Catalogue query: all eight are
  `SECURITY DEFINER`, owned by `motion_definer`, with a pinned `search_path`, executable by
  `service_role` and **not** by `authenticated`. `app.scope_org` and `app.require_scope` are
  executable by `authenticated`: **false**. `app.audit`: false. `app.accessible_org_roles`: true, as
  the policies require.
- **Fail-closed, live.** Scoped-to-A writes A: ok. Scoped-to-A writes B: `42501`. Unscoped
  `persist_alerts`: `42501`. Scope header `garbage`: "the organization scope header is not a uuid".
  Scoped-to-A audits B: refused. Scoped-to-A audits a platform-level (NULL) event: refused. Scoped-to-A
  with a run belonging to B: `NOT_FOUND`.
- **The browser cannot supply a scope.** An owner's JWT plus a forged `x-motion-org: <B>` header:
  `api_server.*` still `42501` (the grant stops it before any scope is read), and a `SELECT` on B's
  alerts through the same client returns 0 rows — the header has no effect on RLS at all.
- **The server-rpc path is scoped.** `test/integration/org-scope.test.ts` (13/13) enters
  `withOrgScope` and makes a `serverRpc` call naming another organisation; it is refused and writes
  nothing. Every job in the built app ran through this path during the Playwright runs
  ("health scores written", "alerts evaluated" in the server log).

The design claim that the header "can refuse a write and never authorise one" holds: both readers are
inside `service_role`-only functions, and the only operation on the value is equality against an
organisation the function resolved itself.

### 3.3 RLS — **pass**

Live catalogue: 44 tables, every one `ENABLE` + `FORCE`; `authenticated` holds zero
`INSERT/UPDATE/DELETE` grants; zero non-`SELECT` policies for `authenticated`; zero role negations in
any `authenticated` policy.

Cross-tenant reads as B's owner against A, twelve tables plus a PostgREST embed
(`alerts → evidence_bundles`): **0 rows, every time**. `api.my_context(A's slug)`: empty. Direct
writes as A's owner on nine tables: `42501`; updating their own alert row directly: `42501`; promoting
a client via table update: `42501`; a client self-elevating: `42501`.

### 3.4 Five-role authorization — **pass**

Every `api.*` function that takes an organisation or an organisation-owned id — **sixty-nine** of
them, seeded with real B-owned rows (alert, action, conversation, message, feedback, document, batch,
bank account, transactions, counterparty, invitation, job, assignment) — called as A's owner against
B: **every one refused** with `NOT_FOUND` or `PERMISSION_DENIED`, and B's rows were verified
untouched afterwards. Thirteen write and governance functions called as A's **client** against A:
every one `PERMISSION_DENIED` naming the missing permission. The ◐ rules hold in SQL: a client may
`acknowledge` and nothing else; an admin cannot invite an owner; an admin cannot request deletion.

### 3.5 Platform employee assignment — **pass**

Against organisation A, from the database with real JWTs: assigned employee at aal2 → context and
rows; the same employee at **aal1** → nothing; an assignment whose `ends_at` has passed → nothing;
an unassigned employee at aal2 → nothing; the assigned employee after `platform_users.status =
'suspended'` → nothing; a super admin at aal1 → nothing, at aal2 → everything. The assigned employee
sees nothing of B. An unassigned employee calling `api.set_alert_status`, `org_members`,
`create_action`, `org_audit_events`, `enqueue_job` on A: `NOT_FOUND` each time.

### 3.6 Forbidden / unauthorized semantics — **pass** (residual L-1)

Unauthenticated: every page family redirects to `/sign-in?next=<relative path>`; `/api/*` answers
401 JSON; the cron routes 404 to a missing or wrong secret; a garbage session cookie is treated as no
session; an `x-motion-org` header on a page request changes nothing.

Signed in, four callers, read from the rendered DOM (my first pass read Next's script payload and
mis-fired; the corrected read is what is reported):

- **client of A** — `/data/imports`, `/data/imports/new`, `/settings`, `/settings/team`,
  `/settings/audit`, `/settings/danger`: **403**, `<h1>` "You do not have access to this page.",
  body "Ask an owner or admin of this organisation if you need it", no "went wrong", no support
  reference. `/data/documents`: **404**, as §4's row requires. `/home`, `/money`, `/insights`,
  `/data/accounts`, `/reports`, `/actions`, `/customers`: 200. `GET /api/exports/ledger`: 403 with
  `PERMISSION_DENIED`; document URL: 403; `POST /api/imports/upload`: 403; export of B: 404.
- **admin of A** — `/settings/danger`: 403 + denied state; `/settings/team`: 200.
- **owner of A** — `/platform`, `/platform/organizations`, `/portfolio`, `/dev/components`
  (production build): **404**.
- **a stranger with their own organisation** — `/app/A/{home,settings/danger,data/imports,
  evidence,analyst,money}` and an A document id: **404** every time; A's name appears nowhere on
  their own pages.

The repository's `authz` and `api` Playwright projects: 22/22.

### 3.7 `same_org_ref` integrity (the audit's "org_ref_source") — **pass**

As a server bug would (direct SQL as `postgres`), thirteen invalid references, **every one refused**:
a bundle with an unknown `origin_table`; an A bundle whose origin is B's alert; an A action sourced
from an invented AI message; from B's alert; a `user` action carrying an id; an **UPDATE** moving an
action's source across organisations; an alert `none` with a subject id; an A alert whose account
subject belongs to B (re-probed with a real B account after my first fixture was NULL); a `query`
evidence item with a `ref_id`; an evidence item pointing at another organisation's alert; a
`scheduled` calculation run with a `trigger_ref_id`; an import row with a committed id and no table.
Through `api.create_action` with `p_source` (the argument I first mis-placed): a B alert →
`references another organization`; a B AI message → `NOT_FOUND`; a `user` source with an id →
refused. `create_action_from_alert` / `_from_recommendation` on B's rows: `NOT_FOUND`.

Independent catalogue query: no enum value of any discriminator is unmapped; all eight
`metric_snapshots` partitions carry the re-registered trigger. **I removed the `ai` mapping myself
and ran `check:schema`: it failed naming `actions.source_type = ai`; restored, it passed.** The gate
detects.

### 3.8 bankCoverage rule consistency — **pass**

`completenessHolds` in `src/core/periods/completeness.ts` is the only expression of the rule;
`financial-engine/domain/coverage.ts:isPeriodComplete` resolves the P&L source and calls it with
`bankCoverageFromRatio`; the dashboard reads the stored flag under a name that says so. Unit:
`engine-coverage` 42/42 including the truth-table parity block, `periods` green. `FINANCIAL_ENGINE.md
§2.2`'s "partial is a warning" sentence still conflicts with the formula and is still resolved in
favour of the formula — correctly flagged for the product owner, unchanged.

### 3.9 Route authorization — **pass** (L-1, L-2)

See §3.6 for behaviour. Statically: 28 tenant pages use `requirePermission`; the two documents pages
keep `notFound()` deliberately; `forbidden.tsx` exists at both levels; `authInterrupts` is on and the
build confirms it. The residuals are the six platform pages (L-1) and the employee review surface
(L-2).

### 3.10 `deleteDocument` twin authorization — **pass**

`grep` of every module barrel: `deleteDocument` is exported from `modules/documents` only. The
surviving function asserts `imports.review` and removes the object; `api.delete_document` re-checks
the permission in SQL. A client calling it on a foreign document: `NOT_FOUND`; as the sweep shows, on
any B document from A: `NOT_FOUND`.

### 3.11 Deterministic financial calculations — **pass**

No `Math.random`, `Date.now()` or `new Date()` in any code line of `financial-engine`, `health` or
`alerts` (the only hit is a comment saying never to). `engine-determinism`, `engine-coverage`,
`engine-compose`, `engine-pnl`, `engine-cash`: green; `engine-end-to-end > determinism (§1.1)`:
green. `ENGINE_VERSION` unchanged at `1.0.0`, which is right — no formula moved, and the 81
completeness cases passing untouched through the M3 change is the evidence.

### 3.12 Dashboard provenance — **pass**

`src/modules/dashboard/data/repository.ts` reads from exactly three tables: `metric_current` (×4),
`fiscal_periods`, `import_batches`. No AI reference anywhere under `dashboard`. `home-figures`
integration (every figure on Home equals its snapshot): green.

### 3.13 Health Score provenance · 3.14 Alert provenance — **pass**

No AI reference under `health` or `alerts`. `health-score` unit (gate, exclusion, proxy cap, §7.4
reproduction, determinism, boundaries) and `health-scores` integration: green. `alert-evaluate`
unit and `alerts-persist` integration (including the five employee-visibility cases): green. Both
engines take `now` as an explicit input.

---

## 4. Suites run

| Suite | Result |
|---|---|
| pgTAP (13 files) | **939 passed** |
| Unit — determinism, coverage, assurance ladder, periods, health, alerts, safe-next, permissions (13 files) | **358 passed** |
| Integration — `org-scope`, `rls-isolation`, `isolation-cases`, `api-governance`, `alerts-persist`, `ai-tools`, `health-scores`, `evidence-drawer`, `home-figures`, `engine-end-to-end`, `org-purge` (11 files) | **223 passed** |
| Playwright — `authz` + `api` projects | **22 passed** |
| `check:schema` | pass, and shown to fail when a mapping is removed |
| My own probes (4 scripts) | 180 assertions; every unexpected result traced to my fixture or call shape, none to the product |

Not re-run here: the full 519-case integration suite and the 52-case Playwright run, which the
remediation reports green at this same commit; the eleven security-relevant integration files were
re-run instead.

---

## 5. What I could not do

- **Sign in as an employee through the browser.** Platform accounts require TOTP, and the harness
  has no way to enrol one. Employee behaviour is proven at the database and API layers (§3.5) and by
  the middleware read; the page path for an employee was not driven end to end.
- **Produce a super admin with a resolved `none` context** to reach L-1's error path. Both gates read
  the same function; I found no way to make them disagree.
- **Test production PostgREST.** Every probe ran against the local stack; the exposed-schema list is
  in `supabase/config.toml`, and the transport claim depends on production matching it.

---

## 6. Final status

- **CRITICAL: 0**
- **HIGH: 0**
- **MEDIUM: 0**
- **LOW: 3** (L-1 residual `assertCan` on six unreachable platform pages; L-2 employees cannot reach
  the review surface their permission names; L-3 the two LOWs the remediation carried forward)

The HIGH finding is closed by a mechanism I could not defeat from the browser, from a forged header,
from a mis-scoped worker or from a malformed scope. Every MEDIUM is closed and each closure has a
gate behind it. Tenant isolation, authorization, RLS and the engine's determinism all held under
active attack. The three LOWs are inconsistencies, none of which admits a read or a write it should
not.

**READY FOR PHASE 8**
