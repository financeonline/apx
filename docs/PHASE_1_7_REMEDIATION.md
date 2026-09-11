# MOTION — Phases 1–7 remediation

Date: 2026-09-11 · Branch `main`, on top of `052d3b4` · Remediates `PHASE_1_7_INTEGRATION_AUDIT.md`
Decisions recorded: ADR-090 … ADR-094 · Migrations added: `20260911000001_org_scope.sql`, `20260911000002_polymorphic_refs.sql`

No product feature was added. Nothing beyond the audit's findings was changed.

> **Two corrections to the finding list as it was handed back.** The denied pages never returned
> HTTP 200 — they returned 404, or 500 through the tenant error boundary, which is why the defect
> was invisible to anything that only checked for success. And the trigger is `same_org_ref`, not
> `org_ref_source`; `same_org_ref_source` is one of its twenty-one registrations. The defects are
> the ones the audit describes and both are fixed below.

---

## Summary

| # | Severity | Finding | State |
|---|---|---|---|
| H1 | HIGH | `withOrgScope` never established `app.current_org`; both RPCs failed silently | **Fixed** (ADR-090) |
| M1 | MEDIUM | A permission denial rendered a 404 or a generic server error, never 403 + the denied state | **Fixed** (ADR-091) |
| M2 | MEDIUM | `same_org_ref` had no mapping for `actions.source_type = 'ai'` and passed unmapped values silently | **Fixed** (ADR-092) |
| M3 | MEDIUM | ADR-030.1's stated home for period completeness was unreachable; the rule lived in two other places | **Fixed** (ADR-093) |
| L1 | LOW | Route-table drift in both directions | **Recorded** (ADR-094) |
| L2 | LOW | `getAccessContext` duplicated `resolveAccessFresh` | **Fixed** (ADR-094) |
| L3 | LOW | Two `minAssurance`, two rank tables ordered against each other, two type declarations | **Fixed** (ADR-094) |
| L4 | LOW | An unguarded, uncalled `deleteDocument` twin exported from the imports barrel | **Fixed** (ADR-094) |
| L5 | LOW | Untyped health rule ids left the label-parity test hand-maintained | **Open** — see below |
| L6 | LOW | `/home` had no explicit permission gate | **Fixed** (ADR-094) |
| — | (new) | The signed-download recency check refused legitimate downloads under ordinary clock skew | **Fixed** (ADR-095) |

---

## H1 — the tenant scope on the server path

**Finding.** `withOrgScope(orgId, fn)` is what stands between a job draining organisation A and a
write naming organisation B. It asserted the scope with
`db.rpc('set_config', { setting_name: 'app.current_org', new_value: orgId, is_local: false })`, and
`app.audit` compared that setting against the organisation each event named (ADR-043).

**Root cause — two independent faults, both silent.**

1. `set_config` exists only in `pg_catalog`, which is not an exposed schema. PostgREST answered
   `PGRST202 · Could not find the function public.set_config`, confirmed by probe against the
   running instance. `supabase-js` returns an RPC error as a value rather than throwing, and both
   call sites discarded it. The setting was never set, so `app.audit`'s guard — which begins
   `current_setting('app.current_org', true) is not null` — was skipped on every call since Phase 4.
2. Even with the name resolved it could not have worked. `is_local => false` sets a **session**
   setting on whichever pooled PostgREST connection served that one request; it does not belong to
   the next request and is not reset between them. And `core/db/server-rpc.ts` keeps its **own**
   client, so every `api_server.*` call was made on a different connection from the one the scope
   was asserted on.

The guard is defence in depth — `app.audit` carries no `EXECUTE` grant for `authenticated`, which is
what actually prevents forgery, and a job's organisation always came from the `jobs` row — so no
cross-tenant exposure followed. What made it HIGH is that a documented control was inert while
looking enforced, and two errors were swallowed.

**Fix.** The scope travels as a request header, `x-motion-org`, on a service-role client built for
one organisation. PostgREST places request headers into `request.headers`, which is
**transaction-local** to that request: it cannot leak to the next request on the same pooled
connection, and it cannot be missing from a call that carried it. `app.audit` already reads that
setting for `ip` and `user_agent`. An `AsyncLocalStorage` scope makes `server-rpc.ts` select the
same client, so every `api_server.*` call made anywhere inside a job is scoped without threading a
parameter through every signature — which is the half that was missing entirely.

The header is not a trust input. It is set by the server from the `jobs` row, never from a browser;
it is only ever compared for equality against an organisation the function resolved for itself; and
both readers are `service_role`-only paths, so a value asserted with a user JWT reaches neither. It
can refuse a write; it can never authorise one. RLS is untouched.

Fail-closed in two places:

- `app.require_scope(p_org)` raises when no scope was established (`42501`) and when the scope names
  another organisation (`42501`). The eight `api_server.*` functions that only ever run inside a job
  call it before writing anything: `persist_alerts`, `finish_calculation_run`, `finish_chunk`,
  `finish_health`, `record_report_file`, `purge_organization`, `set_period_completeness`,
  `start_calculation_run`. Each was verified to have no request-path caller. Their bodies were
  otherwise edited mechanically from the deployed source, so nothing else could drift.
- `app.scope_org()` raises on a malformed header rather than returning NULL, because reading a
  corrupted scope as "no scope" is the fail-open reading of the thing being added.
- `app.audit` refuses an event whose organisation is not the scoped one — `is distinct from`, so a
  scoped worker cannot write a platform-level (NULL organisation) event either.

Functions reachable from a request as well as a job (`record_access_event`, `register_document`,
`commit_batch_as`, `ai_create_conversation`, `enqueue_job`, `finish_job`) keep validating a human
actor through `app.has_permission_of`; the audit equality check still refuses a scoped worker that
names the wrong organisation.

**Tests added** — `test/integration/org-scope.test.ts`, 13 cases:

| Requirement | Case |
|---|---|
| valid tenant context works | a scoped call to `set_period_completeness` succeeds |
| missing tenant context fails safely | the same call unscoped → `42501`, "no organization scope" |
| incorrect tenant context fails | the same call scoped to another organisation → `42501`, "does not match" |
| — | a non-uuid scope raises rather than reading as "no scope" |
| cross-tenant requests remain impossible | a scoped caller writing an audit event for another organisation is refused and writes nothing; a platform-level event from inside a scope is refused |
| the browser is not a source of scope | `authenticated` can execute neither helper, and cannot reach a scoped `api_server` function at all |
| service and server-side paths agree | inside `withOrgScope`, a `serverRpc` call naming the job's organisation succeeds and one naming another is refused — the `server-rpc.ts` path that carried no scope before |
| — | outside a scope, an ordinary page write still names its own organisation and succeeds |

Two pgTAP cases assert the same refusals at the database (`07_financial_api.test.sql`).

**Tests corrected, not weakened.** Three integration suites drove `api_server.*` through `psql`,
which sets neither `request.jwt.claims` nor `request.headers`; they now set both, as PostgREST does,
through a shared `serverSession(org)` helper. `org-purge.test.ts` called its handler bare while the
worker always wraps it in `withOrgScope` — it was testing a path production never takes, and now
runs it the way `runOne` does. `act_as_postgres()` in pgTAP clears the header, because pgTAP runs a
whole file in one transaction and a scope set by one case would otherwise stand for every case after
it.

**Verification.** 13/13 new integration cases; the nine previously failing `org-purge` cases pass;
pgTAP 939; full integration suite green.

---

## M1 — authorization semantics

**Finding.** `ROUTE_ARCHITECTURE.md §11` specifies "403* = page renders the friendly
permission-denied state (`UX_ARCHITECTURE.md §7.4`) with HTTP 403". Neither half existed.

**Root cause.** Two different wrong answers, and no test asserting either way (§11 coverage is
scheduled for Phase 14). A page calling `assertCan` threw `PermissionDenied`; nothing caught it, so
the tenant error boundary rendered *"Something went wrong on our side… send the reference below to
support"* with a 500 — a permission boundary presented to a customer as a MOTION outage. A page
calling `notFound()` answered 404. `DeniedState` and `PermissionGate` were built and imported only
by `/dev/components`, the gallery.

**Fix.** `experimental.authInterrupts` enabled — it is the only way a Server Component can set 403
and render its own UI, and the flag describes the API's stability rather than what it renders.
`app/[orgSlug]/forbidden.tsx` and `app/forbidden.tsx` render `DeniedState`.
`requirePermission(ctx, permission)` in `src/app/_lib/authz.ts` is the page-layer twin of
`assertCan`; 27 pages use it. `assertCan` stays in services, server actions (which return a
structured failure into the form, never a success) and API routes (which already mapped it to 403
with a plain message).

**What deliberately stays 404**, because 403 there would disclose something: the layout's uniform
404 for a caller with no role in the organisation (SECURITY_MODEL.md §14); any resource id belonging
to another organisation; and `/data/documents` and `/data/documents/[id]`, where §4's own row reads
"Client role → 404". 403 is only for a caller who already knows the organisation exists.

**Tests added** — `e2e/authorization-status.spec.ts`, a new `authz` Playwright project that signs in
as three callers rather than sharing one session, 5 cases:

- a client gets **403** and the denied state on `/data/imports`, `/data/imports/new`,
  `/settings/team`, `/settings/danger`, `/settings/audit`, and sees neither "something went wrong"
  nor a support reference;
- an owner gets 200 on the same pages;
- a stranger gets **404** on all of them, `/home` included;
- a document id stays **404** for a client;
- `GET /api/exports/ledger` answers **403** with `PERMISSION_DENIED` and no stack, SQL or internal
  identifier in the body.

**Verification.** 5/5 against the production build.

---

## M2 — polymorphic reference integrity

**Finding.** `app.same_org_ref` resolves a polymorphic reference's target table from its
discriminator and asserts `organization_id` equality. A value with no mapping returned `new`.

**Root cause.** The trigger could not distinguish "deliberately points at no table" from "somebody
forgot". `actions.source_type = 'ai'` names `ai_messages` and was never mapped, so the one
polymorphic column pointing at an AI message had no database check at all — the invariant held only
because `api.create_action` and `api.create_action_from_recommendation` re-read the message scoped
to the organisation themselves. A third writer, or an edit to either, would have lost it silently.
Two neighbouring gaps: `evidence_bundles.origin_table` is plain `text` and had no CHECK of any kind,
so the trigger's argument list was the only thing restricting it; and `evidence_item_xor` never tied
`item_type = 'query'` to the descriptor form, so a `query` row with a `ref_id` satisfied the xor and
then skipped the trigger.

**Fix.**

- A value naming no table maps **explicitly** to the reserved token `-`, and an id beside it is
  refused: a row that names no table must name no row.
- A value in neither list **raises**, naming the trigger to edit.
- A NULL discriminator (`import_rows.committed_table` before a commit) means "nothing yet" and
  asserts only that no id claims otherwise.
- `actions.source_type = 'ai'` → `ai_messages`. Every discriminator in the schema re-registered
  complete: `actions`, `alerts`, `calculation_runs`, `evidence_bundles`, `evidence_items`,
  `metric_snapshots`, `metric_current`, `import_rows` (×2).
- `evidence_bundles_origin_table_known` admits only the six origins EVIDENCE_MODEL.md §5 names.
- `evidence_items_query_is_descriptor` ties `item_type = 'query'` to `query_descriptor`.

**The gate that stops it recurring.** `check:schema` reads each `same_org_ref` trigger's arguments
out of `pg_trigger` and asserts that every value of its discriminator's enum is mapped. Adding an
enum value without saying what it points at is now a failed build. **Verified by removing the `ai`
mapping and watching the gate name both missing values**, then restoring it — a check that has never
been seen to fail is not a check.

**Tests added** — `supabase/tests/05_financial_triggers.test.sql`, 12 new cases covering every
discriminator family: a foreign-org and an invented `ai_messages` id on `actions`; a source id on a
`user` action and the valid no-source form; an id beside `standard_category` and `none` and their
valid forms; an unknown `origin_table` and a foreign-org bundle origin; a `query` item carrying a
`ref_id`; a `trigger_ref_id` on a trigger that names no row; and the two CHECK constraints asserted
in the catalogue, since a BEFORE trigger fires ahead of them and a caller never reaches them.

**One expectation changed deliberately.** A `standard_category` alert carrying another
organisation's account id previously asserted `lives_ok`. That was the behaviour, and it was the
hole: a cross-tenant id sat in a column nothing resolved and nothing checked. The implementation was
wrong, not the test's subject.

**Verification.** pgTAP 939 (was 925); the drift gate demonstrated failing and passing.

---

## M3 — one completeness predicate

**Finding.** ADR-030.1: "the rule lives in `core/periods` and is cited by both."

**Root cause.** `core/periods/completeness.ts` existed, was fully commented against ADR-047.6, and
was imported by nothing in `src/` — its only caller was its own unit test. The rule that ran was
`financial-engine/domain/coverage.ts`, which writes `fiscal_periods.is_complete`. The two asked
about bank coverage differently: `bankCoverage === 'full'` against a three-valued enum in one,
`bankCoverageRatio >= 1` in the other. They agreed; nothing made them.

**Fix.** `completenessHolds(facts)` in `core/periods` is the only place the rule is written.
`core.isPeriodComplete` adapts the period-coverage shape onto it. The engine's `isPeriodComplete`
keeps its signature and does the engine's own work — §2.3 precedence, the chosen source's latest
declared data date, which accounts are cash-like — then calls the same predicate.
`bankCoverageFromRatio` is the single conversion, so "full" means one thing on both sides. The
dashboard's `latestCompletePeriod` reads `fiscal_periods.is_complete` as the engine wrote it and is
renamed `latestCompletePeriodByFlag`: it is a reader, not a rule, and a name that looked like a rule
is how it came to be read as one.

The FINANCIAL_ENGINE.md §2.2 conflict ("partial bank coverage is a warning, not incompleteness"
beside a formula that requires `full`) is unchanged and still resolved in favour of the formula, in
the one module that now holds it. Flagged for the product owner, as before.

**Tests added** — `test/unit/engine-coverage.test.ts`: the two doors driven over the whole truth
table (11 combinations of P&L date × bank coverage × cash-like account) and held equal; the ratio
conversion checked at each boundary; and the same verdict reached from engine coverage as from the
facts behind it.

**Verification.** The existing 81 cases pass untouched — the first evidence that the two were one
rule — plus 13 new ones. No test was edited to match the implementation.

---

## Low-severity cleanup

- **L2.** `getAccessContext` is `cache(resolveAccessFresh)`. A correction to how access is resolved
  is made once.
- **L3.** `core/assurance` holds the ladder: levels, rank, `weakestOf`, `weakestIn`. Both modules
  delegate and keep their public names. It was declared three times before — two rank tables ordered
  against each other and two type declarations. New suite `test/unit/assurance-ladder.test.ts` (20
  cases) holds both surviving forms against the ladder over every pair.
- **L4.** `modules/imports`' unguarded `deleteDocument(db, id)` is gone. The guarded
  `modules/documents` one is the only path; the database enforced `imports.review` either way, so
  nothing was exposed.
- **L6.** `/home` calls `requirePermission(ctx, 'dashboard.view')`.
- **L1.** Recorded in ADR-094 rather than edited into a locked specification, the way `/home/health`
  and `/platform/ai-feedback/[id]` already were: `/app/[orgSlug]/evidence` and
  `/app/[orgSlug]/insights/alerts/[alertId]` exist with no row in the route table, and
  `/settings/billing` is in the table behind a flag and does not exist. Both pages are correctly
  authorised. The route table remains the one artefact with no mechanical drift gate.

### Found during remediation, and fixed

**The signed-download recency check refused legitimate downloads when two clocks disagreed** (ADR-095).
Not in the audit; found by re-running the gates. ADR-043.5 requires that nothing is signed without
the id of an audit event written in the same request, re-read and verified — and the recency test
was `ageSeconds >= 0 && ageSeconds <= 30`, where `created_at` comes from Postgres and the age is
measured against Node's clock. Those are two machines. This workstation's Docker VM runs ~200 ms
ahead of the host, so an event written and read back inside one request has a *negative* age and the
signer refused it: `/api/documents/[id]/url` answered "This download was not recorded, so it cannot
proceed" for a file the caller owned. In production the app server and the database are likewise
separate hosts and ordinary NTP skew would have done the same, intermittently, with a message that
reads like an attack was stopped.

The control is the upper bound — thirty seconds is what refuses an old event replayed to authorise a
fresh download. A lower bound of exactly zero only asserts that two clocks agree perfectly. Five
seconds of tolerance for a database clock running ahead, named and explained; the ceiling unchanged.
Caught by `e2e/api-documents.spec.ts`, which had been passing and began failing once the machine had
been up long enough to drift.

### Left open

- **L5 — health rule ids are untyped strings.** `flatRule(rule: string, …)` and
  `RuleApplication.rule: string` mean the label-parity test in `health-presentation.test.ts` carries
  a hand-maintained list (`'C3', 'G2', 'G3', 'B1', 'B4'`), so a new non-banded rule can ship without
  a reader-facing label and the test stays green. Closing it properly means a literal union over
  every rule id across the six rule files and the presentation map — a change to the health
  module's type surface, which is Phase 6 work rather than audit remediation, and the audit rated it
  LOW for the reason that the failure mode is a raw rule code in the explain panel rather than a
  wrong figure. Not blocking.

---

## Verification

Every gate, run against the remediated tree:

| Gate | Command | Before | After |
|---|---|---|---|
| Typecheck | `npm run typecheck` | pass | **pass** |
| Lint | `npm run lint` | pass | **pass** |
| Unit | `npm run test:unit` | 1789 (60 files) | **1822 (61 files)** |
| AI eval corpus | `npm run ai:eval` | 132 | **132** |
| Integration | `npm run test:integration` | 505 passed, 1 failed | **519 passed, 0 failed (34 files)** |
| Authorization + RLS + tenant isolation | included above | — | `org-scope` 13, `rls-isolation` 16, `isolation-cases` 10, `api-governance`, `alerts-persist`, `ai-tools` — all green |
| Schema drift | `npm run check:schema` | pass | **pass**, one check richer |
| pgTAP | `npm run db:test` | 925 (13 files) | **939 (13 files)** |
| Production build | `npm run build` | pass | **pass** |
| Playwright | `npx playwright test` | 47 | **52** |

Net new coverage: 33 unit, 13 integration, 14 pgTAP, 5 Playwright.

**The financial engine is unchanged in behaviour.** `engine-determinism`, `engine-coverage`,
`engine-pnl`, `engine-cash`, `engine-compose`, `engine-concentration` and
`engine-end-to-end > determinism (§1.1)` all pass, and the 81 completeness cases passed untouched
through the M3 consolidation — which is the evidence that one predicate replaced two rather than
changing either. No golden output moved; `ENGINE_VERSION` is unchanged at `1.0.0`, correctly, since
no formula, precedence or category set changed.

**One environmental note carried forward from the audit.** A full integration run with seven idle
Supabase containers still up produced twelve `money-pages` timeouts; with them stopped the same
suite passed 519/519 with no change to the product. A green suite on an 8 GB machine depends on what
else is running.

See `PHASE_1_7_INTEGRATION_AUDIT.md` §5 for the re-run of the audit's twelve checks.
