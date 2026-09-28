# Phase 15 — independent audit of `71fd748` (Adviser / CFO Command Centre, ADR-112/113/114)

> **Audited commit:** `71fd748dc60c43dd1f12e15d72b703c8203feeb2` on `main`, clean tree, in sync with `origin/main`. Previous audit target: `bab3a68`. Phase 14 baseline: `f5334be`.
>
> **Auditor:** independent Fable 5.1 session, 2026-09-28. Read-only on the repository: no source, test, migration or doc was modified; nothing committed or pushed. Probe scripts live in this scratchpad (`probes/grounding.probe.ts`, `probes/tenancy.probe.ts`, `probes/p8-bulk-orgs.ts`, `vitest.probe.config.ts`); the gate logs are `gate-*.log` beside them.
>
> **Verdict: GATE_# Verdict

All five `bab3a68` findings are closed and were re-attacked with independent probes: HIGH-A, HIGH-B, HIGH-C and MEDIUM-E hold under every access change tried (revocation, expiry, future start, suspension of account or organisation, demotion, deletion, aal1, client-only, stranger, forged ids, >1,000 rows). Tenancy is correct at the resolver, the statement and RLS, and the AI turn is scope-checked and throttled in the database before any model call. Counts are aggregates, exact, and never from a list.

One new MEDIUM stands against the contract ADR-113 §2 / ADR-114 §5 state and PHASE_15_IMPLEMENTATION §8 repeats ("a number the digest does not state … is removed"; "A number survives only when a cited fact matches it"): **M-1 — a figure written in words (`twenty per cent`, `a third`, `doubled`, `one and a half months`) is not seen by the grounding scan, survives, and is persisted and badged `Grounded`.** This is the same class the previous audit blocked on as MEDIUM-D (a fabricated financial figure surviving grounding with `passed`), narrowed to numerals in words. It is not a tenancy defect and the digest carries no financial fact for the model to misquote, but the Command Centre shows the sentence under a "Grounded" badge and stores it as such. The fix is small (reject or degrade sentences containing numeral words / fraction and multiplier words in the headline, summaries and notes — fail closed, as limitations already do) and should ship with L-2 (cited titles are stripped before the scan) since both live in `checkSentence`.

Recommended, non-blocking: L-3 (record the unit-spelling residual), L-4 and L-5 (docs), L-6 (super-admin >1,000 organisations: page through `my_organizations` / the summary, or state the cap), L-7 (`scenarios.test.ts` hook budget).

**NOT READY** — blocking finding: **M-1** (MEDIUM, `src/modules/portfolio/domain/briefing.ts:163,192-218`; reproduction `probes/grounding.probe.ts` P-D1/P-D2 and `probes/tenancy.probe.ts` P7). Everything else in Phase 15 is verified closed; a `71fd748`-plus-M-1 fix with the two probe cases added to `test/eval/portfolio-eval.test.ts` would be ready for Phase 16 on the evidence above, subject to the gates re-running green.
**

---

# Part A — Scope and method

What was audited: the five findings of the `bab3a68` audit and their claimed closure in ADR-114; tenancy and authorisation of every Command Centre surface (`/portfolio`, `/portfolio/alerts`, `/portfolio/actions`, `/portfolio/clients/[orgId]`, `/portfolio/analyst`), the services behind them (`src/modules/portfolio/**`), the two migrations (`20260924000001_portfolio_ai.sql`, `20260925000001_portfolio_integrity.sql`), the adviser AI path (`services/adviser.ts`, `domain/briefing.ts`, `api_server.portfolio_ai_begin_turn/finish_turn`) and the documents (`PHASE_15_IMPLEMENTATION.md`, ADR-112..114, `ROUTE_ARCHITECTURE.md §5.1`, `RBAC_MATRIX.md`, `DATABASE_ARCHITECTURE.md`, `SECURITY_MODEL.md`).

Method: every claim in the docs was treated as unverified. The repository's own tests were read, then attacked with independent probes against the local database using real JWTs minted by `test/integration/setup.ts#mintJwt` (so RLS and `security definer` scoping are the ones a browser meets), with fixtures written as `postgres` through `adminSql`, and cleaned up afterwards. The full gate set was then run sequentially on a database reset with `supabase db reset` (0 organisations, 0 users, 0 turns confirmed before the integration run).

Environment: colima started for this audit; Supabase local `supabase_db_MOTION`, PostgreSQL 17.6, PostgREST `max_rows = 1000`. No finsight or ascai containers were running. The Mac has ~8 GB RAM and was under memory pressure throughout (`vm_stat` free pages 4–7 k, i.e. 60–110 MB); `db reset` logged `supabase_storage_MOTION container is not ready: unhealthy` once (the same symptom the Phase 14 audit recorded) but exited 0, all migrations applied and storage was healthy before any gate ran.

---

# Part B — Re-verification of the five `bab3a68` findings

Each finding was re-attacked, not only re-read. "Probe" refers to `probes/tenancy.probe.ts` (DB, 16 cases, all passing after two probe-side fixes recorded below) and `probes/grounding.probe.ts` (pure, 10 cases).

## HIGH-A — counts derived from capped lists → CLOSED

- **Fix as shipped.** `api.portfolio_summary(p_orgs, p_today, p_due_soon_until)` (`supabase/migrations/20260925000001_portfolio_integrity.sql:28-107`) counts standing alerts by severity and open actions by the Action Centre's own predicates in one grouped statement over `orgs ∩ app.adviser_org_ids()`. `services/portfolio.ts:45-101` (`loadPortfolio`) reads every count and every attention reason from it; `loadPortfolioAlerts` / `loadPortfolioActions` (`:105-135`) return `CappedList{rows,total,truncated}` whose `total` comes from the aggregate, and `data/repository.ts:26-28` caps detail reads at 500 (below `max_rows`).
- **Probe P2.** Organisation A seeded with 1,330 standing alerts (700 critical 90 days old, 600 low 1 day old, 30 acknowledged high), 30 resolved/dismissed, 1,114 open actions (1,100 new low undated, 5 critical in-progress overdue, 3 high due in 3 days, 4 medium due exactly on the due-soon boundary and owned by the employee, 2 due one day past the boundary) plus 3 finished. The aggregate row, called directly over PostgREST with the owner's JWT, equalled an independent SQL count for every column: `alerts_standing 1330, alerts_critical 700, alerts_high 30, actions_open 1114, actions_overdue 5, actions_due_soon 7, actions_urgent 8, actions_urgent_on_time 3, actions_mine 0` (and `actions_mine 4` for the employee). `loadPortfolio` reported the same; `loadPortfolioAlerts` returned 500 rows / total 1,330 / truncated, all 500 critical; `attention` lens 500 / 1,114 / truncated with a critical row first; `overdue` 5 / 5 / not truncated; `mine` 4. Attention reasons: `700 critical alerts, 30 high alerts, 5 overdue actions, 3 urgent actions`.
- **SQL ↔ TypeScript agreement checked by reading:** `OPEN_STATUSES = ['open','in_progress']` (`modules/actions/domain/types.ts:42`) = the SQL `status in ('open','in_progress')`; `isOverdue` (`:69-71`) = `due_date < p_today`; `isDueSoon` (`domain/views.ts:41-44`) = `due_date between p_today and p_due_soon_until` with `DUE_SOON_DAYS = 7` passed from the one constant (`services/portfolio.ts:37`); lens `high` = `priority in ('critical','high')` in both `views.ts:58` and `repository.ts:190`.
- **Repository test** `test/integration/portfolio-scale.test.ts` (1,053 alerts / 1,023 actions / unauthorised org with 200 critical + 300 overdue) passed in the gate run.

## HIGH-B — health truncated by PostgREST `max_rows` → CLOSED

- **Fix as shipped.** The same statement ranks `health_current ⋈ health_scores ⋈ fiscal_periods` with `row_number() over (partition by organization_id order by period_start desc)` restricted to `p.is_complete`, and joins `rn = 1` and `rn = 2` (`portfolio_integrity.sql:82-104`): one row per organisation whatever the history. `health_current` is `primary key (organization_id, period_id)` (`20260905000016_tables_intelligence.sql:186`), so the ranking is over one row per scored month.
- **Probe P3.** Organisation B with complete months up to Aug 2026: scores May 90, Jun 81, Jul 58, Aug unscored, Oct (incomplete) 12 → aggregate returned `Jul 2026 / 58, previous Jun 2026 / 81`; then a null-score row on Aug (complete) → `Aug 2026 / score null, previous Jul 2026 / 58`, and `loadPortfolio` rendered `band null`, `trend null`, no attention reason, counted under `unscored` (an absence, never a zero).
- **Repository test** `portfolio-scale.test.ts` (45 × 24 scored months, none "Not yet scored"; edge cases none/one/gap/incomplete) passed in the gate run.

## HIGH-C — stored turns readable after revocation → CLOSED

- **Fix as shipped.** `app.adviser_org_ids()` (`portfolio_integrity.sql:18-25`) reads `app.accessible_org_roles()` filtered to the four adviser roles; the read policy is `app.is_super_admin() or (user_id = app.uid() and scope_organization_ids <@ array(select app.adviser_org_ids()))` (`:112-118`). pgTAP `14_portfolio.test.sql:31-33` pins that the policy text names `adviser_org_ids`.
- **Probe P4 (turns inserted as `postgres`, read with real JWTs over `from('portfolio_ai_turns').select(...)` with no filter).** Author employee at aal2 reads own two turns; at aal1 none; the owner reads only their own; client-only member and stranger none; super admin aal2 all, aal1 none. Revoking B hid the `{A,B}` turn and kept `{A}`; revoking A hid both; reassigning restored both; a stale in-memory context still read nothing through `listAdviserTurns`. `ends_at` in the past hid the turn; suspended platform account hid all; organisation B suspended hid `{A,B}` (role degrades to `suspended_member`, not an adviser role) while the owner's turn over A stayed; `pending_deletion` kept it; `deleted` hid it; a super admin at aal2 saw everything throughout. An admin of A demoted to client lost their turn, regained it on promotion, lost it again when their membership was suspended.
- **Repository test** `portfolio-ai.test.ts` HIGH-C block (A–G) passed in the gate run.

## MEDIUM-D — bag-of-numbers grounding → CLOSED for digits; a residual gap remains (new finding M-1 below)

- **Fix as shipped.** `buildDigest` (`domain/briefing.ts:74-125`) emits every number as a `Fact{id,subject,metric,words,period,value,unit}`; the forced tool schema carries `facts` ids per headline/summary/note (`services/adviser.ts:62-97`); `groundBriefing` (`briefing.ts:234-300`; `checkSentence` `:192-218`, `NUMBER` `:163`) keeps a sentence only if every digit-number in it matches a cited fact on value (decimal-exact), unit, subject (summary → that client or portfolio), metric word and named period; limitations may state no number; prompt version `adviser-v2.0`.
- **Probe (grounding.probe.ts).** The audit's original case (`Revenue declined 3%. Cash runway is 8 months. Profit margin is 14%.` with count facts 8 and 1 cited) is now `degraded` and the summary is replaced by the server sentence; `£412,000` in a headline is removed and replaced by the count sentence; `Health fell 23%` is rejected while `Health score fell 23 points` passes; the digest built from a real view carried only `count`/`score` units, so any `%`, `months` or `£` figure is ungroundable. P7 in the DB probe confirmed the digest handed to the fake model contained no organisation the caller does not advise, no money, exactly one tool, `toolChoice` forced.
- **What still gets through (measured, see M-1, L-2, L-3):** numbers written in words (`twenty per cent`, `one and a half months`, `a third`, `doubled`, `halved`) — status `passed`, stored as `passed` end to end (P7); an action **title** cited in `because` is stripped from the sentence before the number scan, so an action titled `3` launders `Revenue fell 3%` (`briefing.ts:199-200`); and the documented per-sentence residual (`Runway is 8, per the open action list.` grounded by `open_actions = 8`; `8pc`, `8 pct`, `8pp`, `8 pounds`, `8k` are all "bare" units and ground the same way).

## MEDIUM-E — unassigned employee got 404 → CLOSED

- **Fix as shipped.** `services/access.ts:57-68`: when the adviser set is empty, `resolvePlatformRole(db)` (`tenancy/services/resolve-access.ts:96-103`, `api.my_platform_role` = active + `app.aal() = 'aal2'`) decides; `permissionsFor(role).has('assignments.view')` is true only for `super_admin`/`employee` (`core/permissions/matrix.ts:28-30,49`; owner/admin hold it too but a member with no adviser organisation never reaches this branch as an adviser). `app/portfolio/page.tsx:15-25` renders the specified empty state; `analyst/page.tsx:37-39` hides the form.
- **Probe P5.** Unassigned employee at aal2 → empty context, `counts.clients 0`; at aal1 → `NOT_FOUND`; with an assignment whose `ends_at` is in the past → empty context (not 404); a client-only member whose JWT claims aal2 → `NOT_FOUND`. Repository test block passed in the gate run.

---

# Part C — Tenancy and authorisation

| Caller / condition | Direct `api.portfolio_summary` with real JWT (P1) | Turn read (P4) | `begin_turn` scope (P6) | Resolver |
|---|---|---|---|---|
| Client-only member, aal1 and aal2, asking for own org | 0 rows | none | refused | 404 |
| Stranger | 0 rows | none | refused | 404 |
| Employee aal1 | 0 rows | none | — | 404 |
| Employee aal2, asks `[A,B,C,random]` | A, B only | own, scope ⊆ current | `[A,random]` refused, `[]` refused (VALIDATION), expired-B refused, `mfa_enrolled_at` null refused; no row written in any case | A, B |
| Employee: `ends_at` past / `starts_at` future / revoked | that org gone | that org's turns gone | refused | gone |
| Platform account suspended | 0 rows | none | — | 404 |
| Organisation suspended | employee and owner lose it; super admin keeps it | same | — | same |
| Super admin aal1 / aal2 | 0 rows / all | none / all | — | 404 / all |
| Throttle | — | — | 11th `begin_turn` in a minute → `QUOTA` (`53400`) | — |

Other checks, by reading:
- Middleware (`src/middleware.ts:213-241`) keeps only the session and MFA gates for `/portfolio`; a platform account at aal1 is redirected to `/account/mfa` before the layout runs; the layout (`app/portfolio/layout.tsx:14-19`) converts `NotFound` into `notFound()` and rethrows anything else.
- `clients/[orgId]/page.tsx:20-27` 404s on any id outside `ctx.organisations` before any read, and reads detail for `[orgId]` only.
- Every detail statement carries the authorised ids **and** runs under the caller's RLS client (`repository.ts`); `alerts_select`, `health_current_select`, `health_scores_select` policies are `organization_id in (select app.accessible_org_ids())` (`20260905000019_privileges_rls_financial.sql:74-79`). Repository test "resolver bypassed, foreign id in the statement" passed.
- The AI digest is built from the resolver's view only (`adviser.ts:109-115`); the model gets one tool, forced (`:131-139`); text blocks are never read; `begin_turn` re-checks each scope id with `app.org_role_of` (`portfolio_ai.sql:79-84`) which requires an active assignment in window **and** `profiles.mfa_enrolled_at` for platform accounts; `finish_turn` requires `user_id = p_actor and status = 'pending'`.
- `api_server.*` is callable only by `service_role` (`app.role_claim()` check); a user JWT cannot insert into `portfolio_ai_turns` or execute `api_server.portfolio_ai_begin_turn` (repository test; pgTAP 14 privileges).
- Persisted answers hold organisation **names** and alert/action titles (`adviser.ts:165-177`); after revocation the whole row is invisible to the author (P4), and only a super admin at aal2 can read another person's turns (by design, as for `ai_feedback`).

---

# Part D — Numbers

- No count on any Command Centre page comes from a list: `CountsStrip`, page titles, lens tabs (`lensTotal`), client rows and attention reasons all read `PortfolioCounts` / `ClientCounts` from the aggregate. The only `.length` shown is `view.attention.length` (`app/portfolio/page.tsx:47`), which is the number of clients with reasons over the whole authorised population, not a capped list.
- The portfolio totals are JavaScript sums of per-organisation **integer counts** returned by SQL (`services/portfolio.ts:81-95`); exact, and no money is summed anywhere in the module. `motion/no-arithmetic-in-components` is on (`eslint.config.mjs:22`) and lint passes; the only date arithmetic is in `domain/presentation.ts`.
- Claude computes nothing authoritative: the digest carries counts and health scores only; the prompt forbids derived figures; digits in the output are grounded per fact (Part B, MEDIUM-D). Gap: words-as-numbers (M-1).

# Part E — Errors, mocks, RLS, migrations, docs

- Errors: `unwrap` throws `toMotionError` on every PostgREST error (`repository.ts:29-32`); `askAdviser` rethrows `QuotaExceeded`, records the turn as `failed`, returns a failed answer only for `UpstreamError` and rethrows everything else (`adviser.ts:155-162`); the server action reports through `fail()` (`analyst/actions.ts:26`). No swallowed error found.
- No mock or fake auth on production paths: the fake model transport is an injectable `AskOptions.transport` used only by tests; `createUserClient` is the session client everywhere.
- RLS not weakened: the only policy touched is the Phase 15 table's own select policy, which became stricter (`drop policy … create policy … adviser_org_ids`). No grant on an existing table changed (`git show --stat bab3a68 71fd748`).
- Migrations ↔ `DATABASE_ARCHITECTURE.md`: `portfolio_ai_turns` §7 entry, `portfolio_summary` and the two `api_server` writers are documented; schema-drift gate result in Part F.
- Docs vs behaviour: a suspended organisation is **not** advisable by its owner/admin or by an assigned employee (`accessible_org_roles` degrades the role to `suspended_member`), so the `organisation_suspended` attention reason (weight 45, ADR-112 §4) is reachable only for a super admin — consistent with the resolver but not stated in `PHASE_15_IMPLEMENTATION.md §7` (L-4). `ROUTE_ARCHITECTURE.md:157` still describes `/portfolio` data as `portfolio.list(ctx) … cached per organization tag (ADR-038.13)`, which is the pre-Phase-15 text (L-5).

---

# Part F — Gates (clean database, sequential)

Run in this order on the database reset above; no two gates overlapped. Logs: `gate-integration.log`, `gate-integration-rerun.log`, `gate-scenarios-rerun2/3.log`, `gate-eval.log`, `gate-pgtap-schema-build.log`, `gate-playwright.log`, `gate-playwright-rerun.log`.

| Gate | Command | Claimed at `71fd748` | Measured | Result |
|---|---|---|---|---|
| Lint | `npm run lint` | pass | no output, exit 0 (2 m 33 s) | PASS |
| Typecheck | `npm run typecheck` | pass | exit 0 | PASS |
| Unit | `npm run test:unit` | 2,026 | **73 files, 2,026 passed** | PASS |
| Integration (full, sequential) | `npm run test:integration` | 744/745 (ai-eval-record flaky) | **688 passed, 8 failed, 49 skipped of 745, 50 files, 24 m 34 s.** All three Phase 15 files green: `portfolio` 17/17, `portfolio-scale` 7/7, `portfolio-ai` 13/13. `ai-eval-record` **passed** this run (1 of 1 measured). The 8 failures + 49 skips are in four Phase ≤14 files under memory pressure: `home-figures` (hook timeout 60 s; one `PGRST303 JWT issued at future`, host/VM clocks 2 s apart), `money-pages` (3 × `InternalError` from the same PostgREST hiccup), `org-purge` (2 × 30 s test timeout + 1 assertion after a timed-out predecessor), `scenarios` (`beforeAll` hook timeout 60 s → 49 skipped, `afterAll` then fails on `last_owner_guard`). | **PARTIAL** — see rerun |
| Integration rerun, one file at a time | `npx vitest run --project integration <file>` | — | `home-figures` **21/21**, `money-pages` **27/27**, `org-purge` **11/11**. `scenarios` **0/49 (49 skipped)** on three attempts, every time `Hook timed out in 60000ms` at `scenarios.test.ts:130` (`beforeAll` seeds ≥5 organisations with pipeline history; 138–177 s on this machine). Across the full run and the reruns, **696 of 745 distinct tests were measured passing** (688 in the full run + the 8 that failed there and passed alone), **0 measured failing**, and the 49 `scenarios` tests were never executed on this machine. | PASS except `scenarios` (**not run**, environment) |
| AI eval | `npm run ai:eval` | 189 | **2 files, 189 passed** | PASS |
| pgTAP | `npm run db:test` | 1,053 | **17 files, 1,053, "All tests successful"**; `14_portfolio` ok (14 plans) | PASS |
| Schema drift | `npm run check:schema` | 55 tables / 121 fns | **55 tables, 121 api functions, RLS forced everywhere, no write grants, no reachable server functions** | PASS |
| Production build | `npm run build` | pass | exit 0, 1 m 30 s | PASS |
| Playwright (run 1) | `npm run e2e` | 69 + 1 skip | **15 passed, 3 failed, 52 did not run.** `[setup]` timed out at `auth.setup.ts:150 waitForURL(/evidence/record/bank/)` (90 s), so `evidence` and `sweep` never ran; `journey-12` and `journey-13` timed out; **`journey-15-command-centre` passed (39.7 s)** | FAIL (environment) |
| Playwright (rerun, once, as the brief allows) | `npm run e2e` | 69 + 1 skip | **70 passed, 0 failed, 0 skipped, 9.0 m** — `journey-15` 58.9 s; axe on `Command Centre`, `Command Centre alerts`, `Command Centre actions`, `Adviser analyst` zero serious/critical; overflow sweep at 375/768/1440 green. (The claimed "1 skip" is `analyst-page.spec.ts`'s conditional `test.skip`; it did not skip here.) | PASS |
| Auditor probes | `npx vitest run --config vitest.probe.config.ts` / `npx tsx probes/p8-bulk-orgs.ts` | — | `tenancy.probe.ts` **16/16**; `grounding.probe.ts` 7/10 — the 3 "failures" are M-1 and L-2 (the probe asserts the documented guarantee); `p8-bulk-orgs.ts` printed the 1,000-row truncation (L-6) | see Part G |

Environment notes for the record: free memory 60–110 MB throughout; the first `db reset` reported `supabase_storage_MOTION … unhealthy` and recovered on its own; the `[setup]` Playwright failure and the four integration files that timed out are all long fixture pipelines (imports + queue drains) and each passed alone except `scenarios`, whose 60 s hook budget this machine could not meet. Playwright run 1 left one `a11y-owner@…e2e.motion` user and its organisation behind (setup failed before its cleanup); run 2 tagged its own fixtures.


---

# Part G — Findings

## G.1 New findings on `71fd748`

| ID | Severity | Where | What, reproduction, evidence |
|---|---|---|---|
| **M-1** | MEDIUM (AI grounding; not tenancy, not a stored financial figure) | `src/modules/portfolio/domain/briefing.ts:163` (`NUMBER` regex), `:192-218` (`checkSentence`) | Grounding only sees digit sequences. A figure written in words survives with status `passed` and is **persisted as `passed`**: `probes/grounding.probe.ts` P-D1 `"Revenue fell by twenty per cent and cash runway is one and a half months."` → `passed`, summary kept verbatim; P-D2 `"Revenue fell by a third; costs doubled; margin halved."` → `passed`. End to end through `askAdviser` with a fake transport (`probes/tenancy.probe.ts` P7) the same sentence was stored in `portfolio_ai_turns.answer` with `grounding_status = passed`. ADR-114 §5 states "A number survives only when a cited fact matches it"; the prompt tells the model to quote figures exactly, but the *server-side* guarantee ADR-113 §2 / PHASE_15 §8 make ("a number the digest does not state … is removed") does not hold for numerals in words. The digest carries no money/percent/months facts (P-D10), so every such sentence is a fabrication by construction. Blocking? See verdict: it is a defect in the stated contract, not a tenancy or financial-figure defect, and it is behind the model's own instruction. |
| **L-2** | LOW | `briefing.ts:199-200, :274` | Title laundering: the titles of alerts/actions cited in `because` are stripped from the sentence before the number scan (so a title's own numbers do not fail grounding). An action **titled** `3` cited in `because` makes `"Revenue fell 3% this quarter."` pass (P-D5, `passed`). Titles are tenant-written text, so a tenant can seed a numeric title; the effect is confined to that tenant's own adviser and needs the model to cite it. |
| **L-3** | LOW (documented residual, measured) | `briefing.ts:210-215` | Per-sentence metric/unit pairing: `open_actions = 8` cited grounds `"Runway is 8, per the open action list."` and `8pc / 8 pct / 8pp / 8 pounds / 8k` (all "bare" to `unitOf`) in a sentence that contains the word "action" (P-D3, P-D4, all `passed`). ADR-114 §5 records the per-sentence limitation; the unit-spelling variants are not recorded. |
| **L-4** | LOW (doc) | `docs/PHASE_15_IMPLEMENTATION.md §7`, ADR-112 §4 | The `organisation_suspended` attention reason (weight 45) is unreachable for an owner, admin or employee: `app.accessible_org_roles()` degrades their role on a suspended organisation to `suspended_member`, which is not an adviser role, so the organisation leaves their portfolio (probe P1 "a suspended organisation": employee and owner lose it; super admin keeps it). Only a super admin can see the reason. Behaviour is consistent with the resolver; the docs present it as a general rule. |
| **L-5** | LOW (doc) | `docs/ROUTE_ARCHITECTURE.md:157` | The `/portfolio` row's "Data loaded" cell still reads `portfolio.list(ctx) … filtered by organization_id IN (select app.accessible_org_ids()), cached per organization tag (ADR-038.13)` — the pre-Phase-15 text. The actual read is `api.portfolio_summary` + two feeds, uncached (`force-dynamic`). §5.1 directly below is correct. |
| **L-6** | LOW (scale, super admin only) | `api.my_organizations()` / `api.portfolio_summary` through PostgREST | With 1,005 non-deleted organisations, a super admin's `api.my_organizations()` returned **1,000 rows** and `portfolio_summary` over 1,005 ids returned **1,000 rows** (`probes/p8-bulk-orgs.ts`; PostgREST `max_rows = 1000` applies to set-returning RPCs too). ADR-114 §3 says "PostgREST's row limit is never relied on"; that is true per organisation (health is one row each) but not for the number of organisations. Not reachable by an employee, owner or admin at realistic scale; a super admin's Command Centre would silently omit organisations beyond 1,000. No page states a wrong count *for the organisations shown*; the `Clients` count would be 1,000. |
| **L-7** | LOW (test hygiene) | `test/integration/scenarios.test.ts:130-215` | The file's `beforeAll` seeds 5+ organisations with history through the pipeline and exceeds vitest's 60 s hook timeout under this machine's memory pressure (three runs: 60 s hook timeout each, 49 skipped). Its `afterAll` then races the still-running fixture and fails on `app.last_owner_guard` (`CONFLICT: an organization must keep at least one active owner`), leaving eight `auth.users` rows behind. Pre-existing (Phase 12 file, untouched by Phase 15). |

## G.2 Carried-forward known items (non-blocking, not worse)

| ID | Severity | Status on `71fd748` |
|---|---|---|
| MEDIUM-2 (Phase 14) `ai-eval-record` nondeterminism | MEDIUM (test) | passed in this run (1 of 1 measured); not re-measured across repeated runs; the missing `loadAlerts` tiebreaker is unchanged |
| Phase 13 MEDIUM-4 | MEDIUM (layout) | not re-tested; no Phase 15 file touches the transactions table |
| LOW-1…15 (Phase 14) | LOW | unchanged; no Phase 13/14 financial file changed in `bab3a68` or `71fd748` (`git show --stat`) |


---

# Part H — Not verified, and why

- The claim that every ADR-114 blocker test fails on `bab3a68` (PHASE_15_IMPLEMENTATION §12) was not reproduced: it needs `bab3a68`'s migrations on a second database, and this machine can run one Supabase stack.
- No live model call was made (no Anthropic key in `.env.local`); the adviser path was exercised with a fake transport, so the real model's compliance with "quote numbers exactly" is unmeasured. The grounding guard is what the audit relies on, and its gaps are M-1/L-2/L-3.
- An employee's browser session (`/portfolio` at aal2 through the UI) is not e2e-tested by the repository (needs TOTP) and was not driven by this audit either; the boundary is proven at the database/API layers above.
- No latency benchmark was run (the docs make no timing claim).

---

# Verdict

All five `bab3a68` findings are closed and were re-attacked with independent probes: HIGH-A, HIGH-B, HIGH-C and MEDIUM-E hold under every access change tried (revocation, expiry, future start, suspension of account or organisation, demotion, deletion, aal1, client-only, stranger, forged ids, >1,000 rows). Tenancy is correct at the resolver, the statement and RLS, and the AI turn is scope-checked and throttled in the database before any model call. Counts are aggregates, exact, and never from a list.

One new MEDIUM stands against the contract ADR-113 §2 / ADR-114 §5 state and PHASE_15_IMPLEMENTATION §8 repeats ("a number the digest does not state … is removed"; "A number survives only when a cited fact matches it"): **M-1 — a figure written in words (`twenty per cent`, `a third`, `doubled`, `one and a half months`) is not seen by the grounding scan, survives, and is persisted and badged `Grounded`.** This is the same class the previous audit blocked on as MEDIUM-D (a fabricated financial figure surviving grounding with `passed`), narrowed to numerals in words. It is not a tenancy defect and the digest carries no financial fact for the model to misquote, but the Command Centre shows the sentence under a "Grounded" badge and stores it as such. The fix is small (reject or degrade sentences containing numeral words / fraction and multiplier words in the headline, summaries and notes — fail closed, as limitations already do) and should ship with L-2 (cited titles are stripped before the scan) since both live in `checkSentence`.

Recommended, non-blocking: L-3 (record the unit-spelling residual), L-4 and L-5 (docs), L-6 (super-admin >1,000 organisations: page through `my_organizations` / the summary, or state the cap), L-7 (`scenarios.test.ts` hook budget).

**NOT READY** — blocking finding: **M-1** (MEDIUM, `src/modules/portfolio/domain/briefing.ts:163,192-218`; reproduction `probes/grounding.probe.ts` P-D1/P-D2 and `probes/tenancy.probe.ts` P7). Everything else in Phase 15 is verified closed; a `71fd748`-plus-M-1 fix with the two probe cases added to `test/eval/portfolio-eval.test.ts` would be ready for Phase 16 on the evidence above, subject to the gates re-running green.

---

> **Archival note — added with ADR-115, not part of the audit.** This record was copied verbatim on 2026-09-28 from the auditor's session scratchpad, where it would not have survived the session. Nothing above was edited.
> - The auditor's own text on line 5 reads `**Verdict: GATE_# Verdict` and is kept as written.
> - The probe files it names (`probes/*.ts`, `vitest.probe.config.ts`) and the gate logs lived in that scratchpad and are not in the repository. The grounding probe cases are carried into `test/eval/portfolio-eval.test.ts` and `test/unit/portfolio-quantities.test.ts`.
> - M-1 and L-2 (and the L-3 residual) are addressed by ADR-115. Whether they are closed is for the next independent audit to decide.

