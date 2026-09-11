# MOTION — Phases 1–7 integration audit

> **Status: remediated.** Every HIGH and MEDIUM finding below is fixed, and four of the six LOW ones.
> The work, its root causes and its tests are in [`PHASE_1_7_REMEDIATION.md`](./PHASE_1_7_REMEDIATION.md);
> the decisions are ADR-090 … ADR-094. Findings are left written as they were found, in the present
> tense, because an audit rewritten after the fact stops being evidence of what was true. Each one
> carries its disposition, and §5 records the post-remediation re-run.

Date: 2026-09-11 · Branch `main` at `052d3b4` · Auditor: implementation agent, read-only pass
Scope: the twelve checks commissioned below, across the built surface up to and including alerts —
identity, roles, tenancy, the import engine, the calculation engine, the dashboard, the health score
and the alert engine. Nothing was changed. No finding was fixed.

> **Method.** Findings come from reading the code and the migrations, from querying the live local
> database's catalogue (policies, grants, triggers, enums), and from one HTTP probe against
> PostgREST. Every gate in the repository was run. Where a claim below is asserted rather than
> observed it says so.

---

## 1. Gate results (as audited, 2026-09-11, before remediation)

The post-remediation run is in §5.

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **pass**, no findings |
| Typecheck | `npm run typecheck` | **pass** |
| Unit | `npm run test:unit` | **1789 passed** (60 files) |
| AI eval corpus | `npm run ai:eval` | **132 passed** |
| Integration | `npm run test:integration` | **505 passed, 1 failed** (33 files) — the failure is a resource flake; see below |
| Schema drift | `npm run check:schema` | **pass** — 44 tables, 106 api functions, RLS forced everywhere, no write grants, no reachable `api_server` functions |
| pgTAP | `npm run db:test` | **925 passed** (13 files) |
| Production build | `npm run build` | **pass** |
| Playwright | `npx playwright test` | **47 passed** |

**The one integration failure** was `money-pages.test.ts > customers > shows one customer their own
months and their own invoices`, at 45.9 s — an order of magnitude above its neighbours in the same
file. The same file passed in full immediately before this audit (506/506 on the Phase 9 gate run)
with no change to the code under test since. Re-run on its own (`npm run test:integration -- money-pages`) it passes, 27/27. The
failure is environmental — this machine has ~8 GB of RAM and cannot hold a Supabase stack, a Next
build and a Vitest worker comfortably at once, and the same class of timeout has been diagnosed on
this machine before. **Treated as a flake, not a defect**, but the fact that a green suite depends on
what else is running is itself worth knowing.

---

## 2. Findings

| # | Severity | Finding | Disposition |
|---|---|---|---|
| H1 | **HIGH** | `withOrgScope` never sets `app.current_org`: both RPCs fail silently, so ADR-043's audit-scope guard has never executed | **Fixed** — ADR-090 |
| M1 | **MEDIUM** | A permission denial on a page renders a generic server-error screen or a 404 — never §7.4's denied state, and never HTTP 403 as §11 specifies | **Fixed** — ADR-091 |
| M2 | **MEDIUM** | The `actions` polymorphic guard has no mapping for `source_type = 'ai'`, the one source value that names a table | **Fixed** — ADR-092 |
| M3 | **MEDIUM** | ADR-030.1's stated single home for period completeness is unreachable code; the live rule lives in two other places | **Fixed** — ADR-093 |
| L1 | LOW | Route-table drift: two pages exist with no entry in `ROUTE_ARCHITECTURE.md` and no ADR; one documented route does not exist | Recorded — ADR-094 |
| L2 | LOW | `getAccessContext` and `resolveAccessFresh` are two copies of the access-resolution body | **Fixed** — ADR-094 |
| L3 | LOW | Two `minAssurance` functions with two rank tables, ordered in opposite directions | **Fixed** — ADR-094 |
| L4 | LOW | `imports.deleteDocument` is an unguarded, uncalled twin of `documents.deleteDocument`, exported from the module barrel | **Fixed** — ADR-094 |
| L5 | LOW | Health rule ids are untyped strings, so the label-parity test carries a hand-maintained list | **Open** — not blocking |
| L6 | LOW | `/home` is the only tenant page with no explicit permission gate | **Fixed** — ADR-094 |

**No CRITICAL findings.** Nothing found in this pass lets one tenant read another's data, lets a
role act beyond its matrix row, or puts an authoritative financial figure anywhere but the engine.

---

### H1 · `withOrgScope` never sets `app.current_org`, and says nothing when it fails

`src/core/db/service-client.ts:43` and `:51`

```ts
await db.rpc('set_config', {
  setting_name: 'app.current_org', new_value: organizationId, is_local: false,
});
```

`db` here is the default service-role client, so `.rpc()` addresses the **`public`** schema.
`set_config` does not exist in `public` — it exists only in `pg_catalog`, which is not exposed
(`supabase/config.toml` exposes `public`, `graphql_public`, `api`, `api_server`). PostgREST
therefore answers `PGRST202`, which I confirmed by probe against the running instance:

```
{"code":"PGRST202","message":"Could not find the function public.set_config(is_local, new_value, setting_name) in the schema cache"}
```

`supabase-js` does not throw on an RPC error; it returns `{ data: null, error }`. The result is
discarded at both call sites, so every job in the system makes two failing round trips and carries
on as though the scope were set.

**What is actually lost.** `app.audit()` (`supabase/migrations/20260905000005_app_helpers.sql:273`)
guards the service-role branch like this:

```sql
if p_org is not null
   and nullif(current_setting('app.current_org', true), '') is not null
   and current_setting('app.current_org', true)::uuid <> p_org then
  raise exception 'VALIDATION: audit organization does not match the scoped organization';
```

The middle conjunct is always false, so the check is skipped on every call. The guard has never run
in this codebase.

**Why this is HIGH and not CRITICAL.** The control is defence in depth, and the thing it defends
against is a server bug, not a hostile user: `app.audit` carries no `EXECUTE` grant for
`authenticated` at all, which is what actually prevents forgery, and every job's organisation still
comes from the `jobs` row rather than a payload. No cross-tenant exposure follows from this. What
makes it HIGH is that a stated, documented control is inert and looks enforced — the same shape as
the two latent bugs this project has already found and recorded (ADR-083's `fail_import_batch`,
ADR-078's cron middleware) — and that the failure is swallowed, which the working rules forbid
outright.

Note also that `is_local: false` would set a **session** GUC on a pooled PostgREST connection, which
does not belong to the caller for the duration of `fn` and is not reset between requests. Even if
the function name were corrected, this mechanism would not reliably scope what it claims to scope.

---

### M1 · A permission denial on a page is never the denied state, and never 403

`ROUTE_ARCHITECTURE.md §11` specifies, with its own footnote: *"`403*` = page renders the friendly
permission-denied state (`UX_ARCHITECTURE.md §7.4`) with HTTP 403; the organization's existence is
already known to these users, so 403 does not leak anything."* The matrix names `403*` for a client
on `/data/imports` and `/data/imports/new`, for a client and an employee on `/settings/team`, and
for admin/client/employee on `/settings/danger`.

Neither behaviour exists:

- Pages that call `assertCan` — `/settings/team:13`, `/settings/danger:11`, `/money/page.tsx:28` and
  others — throw `PermissionDenied`. There is no `forbidden.tsx`, and nothing maps the error to a
  status or a view, so `src/app/app/[orgSlug]/error.tsx` catches it and renders `ErrorView`:
  *"Something went wrong on our side. Your data is safe… send the reference below to support."*
  A permission boundary is presented to the user as a MOTION outage, with a support reference.
- Pages that call `notFound()` — `/data/imports:23`, `/data/imports/new:24`, `/reports:25`,
  `/evidence:29`, `/evidence/[bundleId]:49` — answer 404 where the matrix says 403.
- `DeniedState` and `PermissionGate` exist in `src/components/dashboard/states.tsx` and are imported
  by exactly one file: `src/app/dev/components/page.tsx`, the component gallery.

The API routes get this right — each maps `PermissionDenied` to 403 with a plain message. It is only
the page family.

**No security impact.** 404 is strictly more conservative than the specified 403, and the generic
error page discloses nothing. The cost is that a specified product behaviour is missing and a real
user is misinformed about why they cannot see something. `TEST_STRATEGY.md §14` schedules "§11 all
routes" for Phase 14, so no gate fails today; that gate would fail on at least six matrix rows.

---

### M2 · The polymorphic guard on `actions` does not cover `source_type = 'ai'`

`supabase/migrations/20260905000018_triggers_financial.sql:166`

```sql
create trigger same_org_ref_source before insert or update on public.actions
  for each row execute function app.same_org_ref(
    'source_id', 'source_type',
    'alert', 'alerts', 'health_score', 'health_scores', 'report', 'report_files');
```

`action_source_enum` has five values: `ai`, `alert`, `health_score`, `user`, `report`. `user` names
no table and is correctly absent. `ai` names `ai_messages` and is missing — and `app.same_org_ref`
treats an unmapped discriminator as "nothing to check" and returns `new`. So an `actions` row with
`source_type = 'ai'` gets no cross-organisation check from the database at all.

The invariant holds today because both writers scope the lookup themselves:
`api.create_action` re-reads the message as `where m.organization_id = p_org and m.id = v_src_id`
and raises `NOT_FOUND` otherwise, and `api.create_action_from_recommendation` derives the
organisation *from* the message. So there is no exploitable path.

What is wrong is the shape. ADR-034 / F-A-13 / R2-A-12 introduce this trigger precisely because a
composite foreign key cannot express a polymorphic reference, and the coverage for `actions` is now
split: three source types are guarded by the database, the fourth by a hand-written check inside two
functions. A third writer, or an edit to either function, loses the invariant with nothing to catch
it. Every other polymorphic column in the schema — I checked all twenty-one live triggers — maps
every discriminator value that names a table.

---

### M3 · The period-completeness rule does not live where the ADR says it lives

`ADR-030.1`: *"The rule lives in `core/periods` and is cited by both"* — Home/Insights/Reports and
the AI Analyst default to the same period because they call the same function. The module exists,
is fully commented against ADR-047.6, and exports the rule:

- `src/core/periods/completeness.ts:102` — `isPeriodComplete(period, hasActiveCashLikeAccount)`
- `src/core/periods/completeness.ts:131` — `latestCompletePeriod(coverage)`

**Nothing in `src/` imports either of them.** Their only caller is `test/unit/periods.test.ts`. The
rule that actually runs is written twice more:

- `src/modules/financial-engine/domain/coverage.ts:259` — `isPeriodComplete(coverage, period, bankAccounts)`, which decides `fiscal_periods.is_complete`;
- `src/modules/dashboard/services/home.ts:25` — `latestCompletePeriod(periods)`, which picks the first row whose stored `is_complete` is true.

The two live functions are not in conflict at runtime: the engine decides, the dashboard reads the
flag. But the two *implementations of the predicate* differ in shape — the core one tests
`bankCoverage === 'full'` against a three-valued enum, the engine one tests
`bankCoverageRatio >= 1` — and only one of them is reachable. A maintainer who follows ADR-030.1 to
`core/periods` will read, edit and test a rule that governs nothing, and the health score's
completeness gate (ADR-030.4) depends on the other one.

---

### L1 · Route-table drift, in both directions

Two pages exist with no row in `ROUTE_ARCHITECTURE.md §4` and no ADR recording the deviation:

- `src/app/app/[orgSlug]/evidence/page.tsx` — the `?metric=&period=` resolver that every "Why?" link points at;
- `src/app/app/[orgSlug]/insights/alerts/[alertId]/page.tsx` — the alert detail page (`SERVICE_ARCHITECTURE.md` does name `getAlert(ctx, alertId)`).

The project's own convention handles this properly elsewhere: `/home/health` is recorded as a
deviation in `ARCHITECTURAL_DECISIONS.md` ("This is a deviation from the route table and the second
one in the build"), and `/platform/ai-feedback/[id]` is recorded with its slice. These two were not.

In the other direction, `/app/[orgSlug]/settings/billing` is in the route table and the §11 matrix
behind a `billing` flag, and no such page exists — consistent with `MVP_SCOPE.md`, which puts
billing post-MVP, but the route table does not say so.

Both pages are correctly authorised; this is documentation drift, not an access finding. It is worth
recording because the database has a mechanical drift gate (`check:schema`) and the permission
matrix has one (`permissions:sync --print` parity), and the route table has none.

---

### L2 · Two copies of the access-resolution body

`src/modules/tenancy/services/resolve-access.ts:51` and `:78`. `resolveAccessFresh` and the memoised
`getAccessContext` have the same body: load the session user, call `api.my_context(p_slug)`, throw
`NotFound` on a missing row, build the context. The cached form could be
`cache(resolveAccessFresh)`. As written, any correction to how access is resolved — the one function
that decides what every request may see — has to be made twice or it is made once.

### L3 · Two `minAssurance`, two rank tables, opposite directions

- `src/modules/evidence/domain/assurance.ts:31` — `RANK` is `verified: 0 … inferred: 3`, weakest is the **highest** rank, takes a list, returns `null` for empty.
- `src/modules/financial-engine/domain/pnl.ts:143` — `ASSURANCE_ORDER` is `verified: 3 … inferred: 0`, weakest is the **lowest**, takes a pair, cannot return `null`.

Both implement "a derived figure is never firmer than its softest input" over the same four-value
ladder, and both are correct. Adding or reordering a level means editing two tables that are ordered
against each other. (`subtractMonths` is similarly doubled — `src/core/periods/months.ts:74` over
`YearMonth`, `src/modules/banking/domain/recurring.ts:184` over ISO dates with end-of-month
clamping — but those are genuinely different operations that happen to share a name.)

### L4 · An unguarded twin of a guarded delete, exported from the barrel

`src/modules/imports/services/index.ts:108` exports `deleteDocument(db, documentId)`: a bare RPC
wrapper with no `assertCan` and no object removal. `src/modules/documents/services/library.ts:82`
exports `deleteDocument(ctx, documentId)`: asserts `imports.review`, then removes the object and
logs when Storage refuses. The second is the one the product calls; the first has no caller in `src/`
and is re-exported from `@/modules/imports`.

Nothing is exposed — `api.delete_document` performs `app.require_permission(v_org, 'imports.review')`
itself — but a publicly exported, unguarded twin of a guarded operation is an invitation.

### L5 · Health rule ids are untyped, so the label-parity test is hand-maintained

`src/modules/health/domain/apply.ts:55` — `flatRule(rule: string, …)`, and `RuleApplication.rule` is
`string`. The rule ids (`P1`…`B4`) are string literals scattered through the six rule files. The
parity test that guarantees every rule has reader-facing words
(`test/unit/health-presentation.test.ts:79`) therefore enumerates the banded rules from the rule
tables and then appends `'C3', 'G2', 'G3', 'B1', 'B4'` by hand. A new non-banded rule ships without a
label and the test stays green; `RULE_LABELS[rule.rule] ?? rule.rule` then shows the raw code to the
reader in the explain panel.

### L6 · `/home` has no explicit permission gate

Every other tenant page opens with `assertCan(ctx, …)` or `if (!can(ctx, …)) notFound()`.
`src/app/app/[orgSlug]/home/page.tsx` calls `can(ctx, 'imports.create')` for a CTA and never checks
`dashboard.view`. This is correct today — every granted effective role holds `dashboard.view`, and
`suspended_member`'s entire grant is that one bit — but the page's protection is a property of the
matrix rather than a statement in the page, and the matrix is the thing most likely to change.

---

## 3. The twelve checks

### 1. Authentication works correctly — **pass**

Sessions are Supabase Auth cookies refreshed in `src/middleware.ts` on every matched request; the
matcher excludes only Next's static output. The parts that matter:

- **Fail closed.** With `NEXT_PUBLIC_SUPABASE_URL` or the anon key missing, middleware returns 503
  and serves nothing. This was previously a comment saying "fail closed" above a `return response`
  that let everything through (PRODUCTION_AUDIT L1, ADR-075); it is now the 503.
- **No session** → public passes; `/api/*` gets 401 JSON, never a redirect into a page with no POST;
  everything else redirects to `/sign-in?next=…` where `next` is filtered by `safeNextPath` to
  same-origin relative paths only (ADR-069).
- **Disabled accounts** are signed out on their next request whatever they asked for.
- **Platform accounts without a verified authenticator** can reach only `/account`, `/sign-in`,
  `/auth/callback`, `/legal`, `/api/health`; everything else redirects to `/account/mfa`. This is
  checked *before* family membership, so the ordering cannot be bypassed.
- **Cron routes** authenticate themselves with a constant-time `CRON_SECRET` compare and 404
  otherwise; they are public to middleware because Vercel Cron has no session (ADR-078).

Middleware never widens access. Organisation resolution is deliberately not done here — it needs the
database and must return a uniform 404, so it happens in the org layout (§8.7).

### 2. All five roles are enforced correctly — **pass**

The effective-role type is six-valued, not five: `super_admin`, `employee`, `owner`, `admin`,
`client`, plus `suspended_member`, which exists as a first-class value precisely so that a
`<> 'client'` branch cannot silently widen a suspended client's access (R2-A-07). `none` holds
nothing.

The matrix is transcribed once in `src/core/permissions/matrix.ts`, mirrored into
`public.role_permissions`, and a unit test regenerates it from `RBAC_MATRIX.md` and fails on drift.
Live counts agree with the source: 34 permissions; super_admin 34, owner 29, admin 26, employee 22,
client 9, suspended_member 1 (`dashboard.view`).

Three mechanisms keep this honest, and I verified each:

- `can(ctx, permission)` is the only question application code asks. The `motion/no-role-name-literals`
  ESLint rule fails any comparison against a role name outside `src/core/permissions/` and the two
  tenancy files, so the widening branch R2-A-07 describes cannot be written.
- The `◐` restrictions a permission bit cannot express (role ceilings, self-elevation, a client's
  acknowledge-only `alerts.manage`) live in `src/core/permissions/guards.ts` **and** again inside the
  `api.*` function that performs the write. `api.set_alert_status` refuses `v_role = 'client'`
  anything but `acknowledged` regardless of what the page believed.
- No RLS policy for `authenticated` uses a role negation. I checked the live catalogue: 98 policies,
  44 of them for `authenticated`, and the single `<>` among them is on `evidence_kind_enum`, not on a
  role.

### 3. Tenant isolation is enforced by RLS and server-side authorization — **pass**

Both layers are present and independent.

*Database.* Every table in `public` has `ENABLE` **and** `FORCE` row-level security, verified live by
`check:schema`. `authenticated` holds zero `INSERT`/`UPDATE`/`DELETE` on any table — confirmed
against `information_schema.role_table_grants`, and there are zero non-`SELECT` policies for
`authenticated`, so there is no write a permission bit alone could authorise. Every policy resolves
its organisation set through `app.accessible_org_roles()` (ADR-065's set form, evaluated once per
statement), which is the same function the application's role resolution calls.

*Application.* `getAccessContext(orgSlug)` builds the context from `api.my_context(p_slug)`, which
joins `organizations` to `app.accessible_org_roles()`. The organisation is addressed by the slug in
the URL and never taken from a request body (ADR-014). A caller with no access gets `NotFound`, which
the layout renders as the uniform 404 — never 403, so an organisation's existence is never confirmed
(SECURITY_MODEL §14). Every API route repeats the resolution and the permission check itself.

*Service role.* Exactly three files may read `SUPABASE_SERVICE_ROLE_KEY`, enforced by
`motion/no-service-role-outside-sanctioned-files`; `api_server.*` is reachable only through
`core/db/server-rpc.ts`; no `api_server` function is executable by `authenticated` (asserted by the
drift gate); each `api_server` function re-validates the passed actor rather than the session — e.g.
`build_metric_bundle_as` raises `NOT_FOUND` unless `app.has_permission_of(p_actor, v_org, 'financials.view')`.
Job workers scope by the `jobs` row, never a payload, and `motion/no-unscoped-service-query` fails
any service-role query without an `organization_id` filter. The one weakness in this area is H1, and
it is in the audit guard rather than in the scoping.

Coverage: `rls-isolation.test.ts` (write attempts on 13 tables, `api_server` from a user JWT,
cross-tenant reads as NOT FOUND, platform MFA at the database), `isolation-cases.test.ts` (cases 8, 9,
11, 13, 15 plus the platform-trail case), `api-governance.test.ts`, and pgTAP `03_rls_and_governance`
and `06_financial_rls`.

### 4. Platform employees only access assigned organizations — **pass**

One function decides, for both RLS and the application:
`app.accessible_org_roles()`, branch 2 (`supabase/migrations/20260905000005_app_helpers.sql`). An
employee's row appears only when **all** of these hold: the assignment is `status = 'active'`, the
`platform_users` row is `active` with `platform_role = 'employee'`, `app.is_platform_user()` is true
(which itself requires `app.aal() = 'aal2'`), the assignment window is open
(`starts_at <= now() < ends_at`), the organisation is not deleted, and the caller is not a super
admin. There is no branch that gives an employee an organisation they are not assigned to.

The actor-parameterised twin `app.org_role_of(p_actor, org)` applies the same conditions with
`app.actor_has_aal2(p_actor)` read from `profiles.mfa_enrolled_at`, because under `api_server` the
session is `service_role` and the JWT cannot answer.

Proven at three levels: pgTAP `02_access_resolution`; `isolation-cases.test.ts` case 8 (unassigned
employee sees nothing) and case 9 (revocation takes effect on the next request);
`alerts-persist.test.ts` (five tests: an employee sees only assigned organisations' alerts); and
`ai-tools.test.ts` (the unassigned employee passes the RBAC check — `authorized: true` — and is
stopped by RLS with an honest `NO_DATA`, which is what shows the two layers are separate).

One note, not a finding: CD-13's audit obligation is written for **super admins** and is implemented
for super admins only (`src/app/app/[orgSlug]/layout.tsx:38`). An assigned employee's visit writes no
`org.data_viewed`. That matches the documents — ARCHITECTURE.md §Risk 3 covers employees by
"explicit assignments only, owner-visible and revocable" rather than by per-view audit — but it is
worth knowing that "MOTION staff looked at my data" is visible in the owner's log for one of the two
staff roles.

### 5. Financial calculations are deterministic — **pass**

- **No ambient clock, no randomness.** `Math.random` appears nowhere in the engine, health or alerts.
  `new Date()` appears four times across all three, every one of them inside a comment explaining why
  it is *not* used. "Now" is injected: the engine's `asOf` is the organisation's timezone-local today
  (ADR-030.5) and the aggregation instant comes from the database row that Postgres stamped, not from
  the worker's clock — a distinction with its own test
  (`engine-determinism.test.ts`: *"aggregates as of the instant the database stamped on the run"*).
- **Exact arithmetic.** Money is `NUMERIC(18,2)` in Postgres, crosses the wire as a string, and
  becomes a `Decimal` in `src/core/money` and nowhere else; ratios are `NUMERIC(20,6)`; rounding is
  `ROUND_HALF_UP` applied once, at storage or at display. `motion/no-money-parsefloat` fails
  `parseFloat`/`Number` on any money-shaped expression.
- **Order independence.** The run fingerprint canonicalises by sorting every collection before
  hashing, so two runs over identical data fingerprint identically whatever order the database
  returned rows in; `engine-determinism.test.ts` asserts composition "does not depend on the order
  the aggregation handed the cells over in".
- **Versioned.** `ENGINE_VERSION` is stamped on every `calculation_runs` row with the bump rules
  written down (PATCH changes no golden output; MAJOR is any formula, precedence or category change
  and enqueues a full recalculation).
- **Layering.** The single SQL aggregation (`app.aggregate_periods`) sums in exact `NUMERIC`, once,
  and returns one row per period × source × category × account × counterparty × bank account; the
  TypeScript engine computes metrics from those rows and never iterates raw records. There is no
  second implementation of a metric in SQL.

Coverage: `engine-determinism.test.ts` (11 cases), `engine-end-to-end.test.ts > determinism (§1.1)`,
and the golden fixtures under `fixtures/`.

### 6. Dashboard values come from calculation services — **pass**

`src/modules/dashboard/data/repository.ts` states the rule and obeys it: *"Every figure comes from
`metric_current` joined to `metric_snapshots`, and from nowhere else."* Every `.from()` in that file
is `metric_current` or the period tables.

The view-model layer formats and does not compute. `changeFrom` reads a **variance snapshot** — a
figure the engine wrote — and formats it; it does not subtract two numbers. Records (invoices, bank
lines, accounts) are read on the Money pages, but only as the evidence behind a figure: listed,
filtered, sorted, never summed. Where a page needs a total no metric provides, the documented answer
is "—" with a reason.

The only arithmetic I found in the dashboard is sign and magnitude for ranking and favourability
(`src/modules/dashboard/services/insights.ts:106,117`), which produces no figure a reader sees as
money. `motion/no-arithmetic-in-components` fails money arithmetic anywhere under `src/app`, and the
integration suite asserts that every figure on Home equals its snapshot (`home-figures.test.ts`).

### 7. Health Score uses deterministic inputs — **pass**

Inputs are `metric_snapshots` rows carrying the snapshot id that produced each figure; the six
dimension evaluators run in a fixed array order so two runs write byte-identical breakdowns. Every
threshold, weight and band is declared once in `src/modules/health/domain/config.ts` and stamped onto
the row as `config_version = 'health.config.v1'` — weights 25/25/15/15/10/10 summing to 100 (asserted
by a test), baseline 50, clamp 0–100, `MIN_REQUIRED_COMPLETENESS = 0.6`, `PROXY_CAP = 70`,
`MIN_DIMENSIONS_FOR_SCORE = 3`.

The design refuses rather than guesses: no score at all for an incomplete period (ADR-030.4); a
dimension whose required metrics are thin is excluded with a stated reason rather than scored 50; a
dimension resting on bank proxies is capped at 70; surviving weights renormalise to 100 and the card
says "based on 4 of 6". The stored breakdown is authoritative — the overall score is computed from
the same rounded `weight_applied` values that are written, so §7.4's reproduction test (re-derive the
score from the breakdown JSON alone) is exact rather than approximate.

Nothing in the health path touches the AI: no reference to Anthropic or Claude exists anywhere in
`src/modules/health`. Read services (`services/read.ts`) load stored breakdowns and compute nothing.
Coverage: `health-score.test.ts` (completeness gate, exclusion, renormalisation, proxy cap, §7.4
reproduction, determinism, 0/100 boundaries) and `health-scores.test.ts` at the database.

### 8. Alerts use deterministic rules — **pass**

Eighteen rule keys, declared once in `src/modules/alerts/domain/catalogue.ts` with class
(`state`/`event`), family, metric key, subject type and supersession — as data, so the evaluator
sorts, caps and dedupes without a switch on rule keys, and so a test can assert that every rule in
the document has an implementation. `RULE_ORDER` is fixed, with `variance.significant` last so it can
see what already explains a period.

`evaluate.ts` is pure: it takes the period contexts, the existing alerts, `now` as an explicit ISO
string ("so the ninety-day cooldown is reproducible in a test") and the evaluator map, and returns
the inserts, revisions, status changes and resolutions to apply. It plans; it does not write. The
`PER_RUN_CAP = 25` and the critical exemption are in the plan, not in the persistence layer.

Dedupe keys encode the lifecycle difference exactly: `{rule}|{period}|{subject}` for an event,
`{rule}|state|{subject}` for a state — the absence of the period from a state key is what makes six
months of a persistent 55% customer one alert rather than six. `alerts.rules.v1` is written onto
every revision. No AI reference exists anywhere in `src/modules/alerts`.

### 9. Evidence hooks exist where required by the architecture — **pass**

`evidence_bundles.origin_table` is constrained by the live `same_org_ref_origin` trigger to six
origins, and each has a writer:

| Origin | Written by |
|---|---|
| `metric_snapshots` | `api_server.build_metric_bundle_as`, on first "Why?" (ADR-066) |
| `health_scores` | `score-run.ts:evidenceFor` — the run, then one item per distinct snapshot in the order the dimensions used them |
| `alerts` | `app.build_alert_bundle`, on **every** `alert_revisions` row (insert and revision alike) |
| `ai_messages` | `api_server.ai_persist_turn` |
| `actions` | `app.clone_bundle_for_action`, so an action keeps the evidence its source had |
| `report_files` | `api_server.record_report_file` |

`evidence_items.item_type` has twelve values; eleven name a table and all eleven are mapped in the
`same_org_ref_item` trigger. The twelfth, `query`, names no table by design — it carries a descriptor
instead, and `evidence_items_query_needs_hash` requires the RFC 8785 hash beside it. That hash is
computed in TypeScript through the single implementation in `modules/evidence` and never in SQL,
because a second canonicalisation would eventually disagree with the first and the disagreement would
look like a forged citation.

Bundles are immutable and hash-verified on read (ADR-066). The one gap in this area is M2.

### 10. No frontend-only security controls exist — **pass**

- No client component performs an authorisation check: of the 29 files under `src/app` carrying
  `'use client'`, none references `can(`, `assertCan` or `permissions.`. The role-dependent UI
  (`PrimaryNav`, `DataMenu`, the settings link, alert status options) is decided in server components
  from the server-built `AccessContext` and passed down as already-resolved booleans.
- Every server action re-resolves the context and asserts the permission before acting. All 17
  `'use server'` files do this; the three that do not (`invite`, `onboarding`, `account`) are the
  pre-organisation bootstrap flows, which have no organisation to authorise against and are
  authorised inside `api.accept_invitation` / `api.create_organization`.
- Every one of those checks is made again in SQL. `ADR-026` is the load-bearing rule: `authenticated`
  holds no write privilege on any table, so **every** mutation is an `api.*` `SECURITY DEFINER`
  function that re-derives the organisation and calls `app.require_permission`. A forged request that
  skips the page achieves nothing, and `rls-isolation.test.ts` proves it by attempting direct writes
  on 13 tables.
- Hidden means absent: `TEST_STRATEGY.md §2` requires hidden nav items to be absent from the DOM
  rather than `disabled`, and the nav components render nothing rather than a disabled control.

### 11. No duplicated business logic exists — **findings M3, L2, L3, L4**

The large-scale separations are clean and I could not find a second implementation of any metric,
threshold or rule:

- SQL aggregates (L0), TypeScript computes (L1) — no metric is computed twice.
- Health weights/thresholds/bands: one file, imported by the presentation layer rather than restated.
- Alert rules: one catalogue, one rule per file, supersession declared as data.
- Assurance labels: `UX_ARCHITECTURE.md §8.1` only, "deliberately not restated" in code.
- Descriptor hashing: one RFC 8785 implementation, with the reason written down.
- The `◐` guards are duplicated between TypeScript and SQL **on purpose**, with the SQL authoritative
  and the duplication documented at both ends — that is defence in depth, not drift.

The exceptions are the four findings: the completeness rule in three places with one dead (M3), the
access-resolution body twice (L2), `minAssurance` twice with inverted rank tables (L3), and the
unguarded `deleteDocument` twin (L4).

### 12. No major architectural drift exists — **pass, with L1**

The layering holds and is mechanically enforced. `app → modules → core`, downward only;
`core` may not import `modules` or `app`; `modules/*/domain/**` may import neither Supabase nor
`core/db` nor `next`/`react` (purity); modules are imported through their `index.ts` barrel only;
components and routes may not import `@supabase/*`, and only `modules/ai/data/claude-client.ts` may
import the Anthropic SDK. All of these are `no-restricted-imports` groups or local rules, and lint is
green.

The database and its documentation are checked against each other on every run:
`check:schema` diffs the live table list and the `api.*`/`api_server.*` catalogue against
`DATABASE_ARCHITECTURE.md` and additionally asserts RLS forced everywhere, no write grants for
`authenticated`, `motion_definer` ownership with a pinned `search_path` on every function in
`app`/`api`/`api_server` (one named exception, recorded), `SECURITY DEFINER` on every function that
touches a table, and no `api_server` function reachable by `authenticated`. It passes: 44 tables, 106
api functions.

Nineteen modules, 379 TypeScript files, 75 migrations, and the module boundaries match
`SERVICE_ARCHITECTURE.md`. The one drift I found is the route table (L1) — which is also the one
artefact in this list with no mechanical gate behind it.

---

## 4. What I did not verify

- **Behaviour under a real production deployment.** Everything here was read, or observed against
  the local Supabase stack. H1's probe was run against local PostgREST; the same exposed-schema
  configuration is in `supabase/config.toml`, but I did not confirm the production project's
  settings.
- **The §11 route → RBAC status matrix end to end.** No test exercises it (it is scheduled for
  Phase 14), and I did not drive a browser as each of the five roles. M1 is from reading the pages
  and the error boundary, not from observed HTTP statuses.
- **Load, timing and the NFR budgets.** ADR-065 records a 1800× improvement on a 50k-row read; I did
  not re-measure it.
- **Import engine internals** beyond their interaction with the checks above — the wizard, the
  validation gate, duplicate detection and PDF extraction were not audited line by line.
- **The AI analyst**, which is outside the commissioned phase range; it appears here only where its
  tools exercise tenant isolation.
- **Whether the single integration failure is flaky or real** beyond the retry recorded in §1.

---

## 5. Post-remediation re-run

Remediation is `PHASE_1_7_REMEDIATION.md`; decisions ADR-090 … ADR-095. The twelve checks were
re-run against the remediated tree.

| Check | Before | After |
|---|---|---|
| 1. Authentication | pass | pass, unchanged |
| 2. Five roles enforced | pass | pass, unchanged |
| 3. Tenant isolation (RLS + server-side) | pass, with H1 | **pass** — the scope is established per request and fails closed in both directions |
| 4. Employees only reach assigned organisations | pass | pass, unchanged |
| 5. Deterministic financial calculations | pass | **pass** — and the completeness predicate is now single-sourced (M3); the 81 existing cases passed untouched |
| 6. Dashboard provenance | pass | pass — the dashboard reader is renamed to say it reads the engine's answer |
| 7. Health-score inputs | pass | pass, unchanged |
| 8. Alert rules | pass | pass, unchanged |
| 9. Evidence hooks | pass, with M2 | **pass** — every discriminator mapped, two missing constraints added, a drift gate added |
| 10. No frontend-only security control | pass, with M1 | **pass** — denials are 403 + the §7.4 state, asserted by a new e2e project |
| 11. No duplicated business logic | M3, L2, L3, L4 | **pass** — one completeness predicate, one access resolution, one assurance ladder in `core`, one document delete |
| 12. No major architectural drift | pass, with L1 | pass — L1 recorded in ADR-094; the route table still has no mechanical gate |

### Gates, post-remediation

| Gate | Before | After |
|---|---|---|
| Typecheck | pass | **pass** |
| Lint | pass | **pass** |
| Unit | 1789 (60 files) | **1822 (61 files)** |
| AI eval corpus | 132 | **132** |
| Integration | 505 passed, 1 failed (33 files) | **519 passed, 0 failed (34 files)** |
| Schema drift | pass | **pass** — and one check richer |
| pgTAP | 925 (13 files) | **939 (13 files)** |
| Production build | pass | **pass** |
| Playwright | 47 | **52** |

Net new coverage: 33 unit, 13 integration, 14 pgTAP, 5 Playwright.

**Two of this audit's own observations are now gates rather than prose.** The drift script asserts
that every polymorphic discriminator value is mapped (demonstrated failing, then passing), and the
§11 status matrix — which §14 of `TEST_STRATEGY.md` defers to Phase 14 — is partly asserted today by
the `authz` Playwright project.

**One new finding, fixed** (ADR-095, not in this audit): the signed-download recency check refused
legitimate downloads whenever the database's clock ran ahead of the application's, which on two
hosts is ordinary. Found by re-running the gates, not by reading.

**The integration flake recorded in §1 is confirmed as environmental.** On the full-suite run with
seven idle Supabase containers still up, twelve `money-pages` cases failed on timeouts; with those
containers stopped the same suite passed. Nothing in the product changed between the two runs. A
green suite on this machine depends on what else is running, which is worth knowing and is not a
defect in the code.
