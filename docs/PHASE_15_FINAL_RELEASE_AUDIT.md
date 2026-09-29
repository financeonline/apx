# Phase 15 — Final Independent Release Audit (Adviser / CFO Command Centre)

- **Audited commit:** `33a182f5074246aaf1de31bae2d28b9da721e81a` ("Phase 15 final quantitative grounding closure (ADR-115)").
- **Baseline:** `71fd748`.
- **Date:** 2026-09-28/29.
- **Auditor:** independent session. Memory notes, ADRs, commit messages and implementation reports were treated as unverified claims. Every claim below was reproduced against the repository and a local database reset with `supabase db reset`.
- **Repository:** read-only. No file in `~/Desktop/MOTION` was modified, nothing was committed or pushed, and Phase 16 was not started. `git status --porcelain` is empty after all runs; test artefacts went to gitignored paths (`e2e/.shots`, `e2e/.auth`, `.next`) or to this folder.
- **Artefacts in this folder:**
  - Probes: `probes/pure-grounding.test.ts`, `probes/pure-grounding2.test.ts`, `probes/db-boundary.test.ts`, `probes/db-scale.test.ts`, `probes/db-superadmin.test.ts`, `pw/audit.pw.ts`, `pw/p13.pw.ts`.
  - Configs: `vitest.pure.config.ts`, `vitest.db.config.ts`, `pw.config.ts`.
  - Outputs: `probe-grounding-results.{txt,json}`, `probe-grounding2-results.txt`, `probe-db-*.log`, `probe-ui*.log`, `shots/`.
  - Gate logs: `gate-*.log`, `gates-summary.log`, `integration.json`, `unit.json`, `eval.json`, `e2e.json`.

## Verdict

**NOT READY FOR PHASE 16**

The tenancy, authorisation, revocation, scale-count and financial-truth work holds. HIGH-A, HIGH-B and HIGH-C were each re-attacked and are closed. The brief's own M-1 and L-2 reproduction sentences are now handled correctly.

Adviser grounding still stores `passed` for materially false quantitative statements, and the page then shows them under the **Grounded** badge. Every example below uses the digest that production builds (`buildDigest`), and three of them were stored as `passed` end to end through `askAdviser`:

- "3 clients need attention." (the truth is 2)
- "FA Alpha has 1 critical alert as well as 3 high alerts." (the truth is 3 critical and 1 high)
- "Its health score rose from 38 to 61." (the score fell from 61 to 38)
- "Its current health score is 61." (it is 38)

The Command Centre also fails with an INTERNAL error for any adviser with 201 or more organisations (HTTP 414 from PostgREST).

These are new MEDIUM findings in AI grounding (material correctness) and in scale. Under the brief's release criteria they block release.

---

## 1. Repository state

| Check | Result |
|---|---|
| HEAD | `33a182f5074246aaf1de31bae2d28b9da721e81a` |
| Branch | `main` |
| `origin/main` after `git fetch` | `33a182f5074246aaf1de31bae2d28b9da721e81a` (in sync) |
| `33a182f` exists | yes (`git cat-file -t` → commit) |
| Working tree | clean before and after the audit |
| Commits `71fd748..33a182f` | exactly one: `33a182f` |

`git diff --stat 71fd748..33a182f` shows 14 files, +1412/−101:

- **Docs:** `AI_ARCHITECTURE.md`, `ARCHITECTURAL_DECISIONS.md`, `PHASE_15_IMPLEMENTATION.md`, `PHASE_15_INDEPENDENT_AUDIT.md` (new), `ROUTE_ARCHITECTURE.md`, `UX_ARCHITECTURE.md`.
- **E2E:** `e2e/journey-15-command-centre.spec.ts`.
- **Source:** `src/modules/portfolio/domain/briefing.ts`, `src/modules/portfolio/domain/quantities.ts` (new), `src/modules/portfolio/index.ts`, `src/modules/portfolio/services/adviser.ts`.
- **Tests:** `test/eval/portfolio-eval.test.ts`, `test/integration/portfolio-ai.test.ts`, `test/unit/portfolio-quantities.test.ts` (new).

No migration, RLS, authorisation or Phase 13/14 file changed in `33a182f`.

Across all of Phase 15 (`f5334be..33a182f`, 45 files):
- The only migrations are `20260924000001_portfolio_ai.sql` and `20260925000001_portfolio_integrity.sql`.
- No file under `src/modules/{ai,alerts,financial-engine,banking,commercial,health,actions,evidence}` changed.
- Outside `/portfolio`, the only UI change is a Command Centre link in `src/app/app/[orgSlug]/layout.tsx`.

## 2. Environment

- **Machine:** macOS, 8 GB RAM, heavy memory pressure (`vm_stat` free pages about 5,000).
- **Containers:** only the `supabase_*_MOTION` stack was running; no other project's stack.
- **Port 3100:** free before Playwright ran.
- **Clean database:** `supabase db reset` before the gate run, and again before Playwright.
- **Model:** no `ANTHROPIC_API_KEY`. Every adviser path used an injected fake transport.

## 3. Gates (clean database, run one after another)

| Gate | Command | Measured |
|---|---|---|
| db reset | `npm run db:reset` | rc 0 |
| Typecheck | `npm run typecheck` | rc 0 |
| Lint | `npm run lint` | rc 0, no output |
| Unit | `vitest --project unit` | **74 files, 2,095 passed / 2,095** |
| AI eval | `vitest --project eval` | **2 files, 242 passed / 242** |
| Schema drift | `npm run check:schema` | "55 tables, 121 api functions, RLS forced everywhere, no write grants, no reachable server functions" |
| pgTAP | `npm run db:test` | **17 files, 1,053 tests, All tests successful** |
| Integration (full run) | `vitest --project integration` | **50 files, 747 tests: 746 passed, 1 failed, 0 skipped**, 335.6 s |
| Build | `npm run build` | rc 0 |
| db reset | `npm run db:reset` | rc 0 |
| Playwright | `npx playwright test` | **69 passed, 1 skipped, 0 failed** (2.0 min) |

Integration detail:
- `scenarios.test.ts` ran all **49 of 49** in the full run.
- The one failure is `ai-eval-record.test.ts` (see §3.1).
- Phase 15 files: `portfolio.test.ts` 17/17, `portfolio-scale.test.ts` 7/7, `portfolio-ai.test.ts` 15/15.
- Phase 13/14 and security files, all green:

| File | Result |
|---|---|
| `evidence-reconciliation-sweep` | 1/1, printing **"SWEEP checked 100, mismatches 0"** |
| `evidence-invoice-basis` | 5/5 |
| `evidence-provenance` | 14/14 |
| `evidence-drawer` | 33/33 |
| `evidence-void-invoice` | 5/5 |
| `evidence-merged-counterparty` | 4/4 |
| `evidence-documents` | 6/6 |
| `banking` | 20/20 |
| `bank-commercial-population` | 12/12 |
| `ledger-commercial-population` | 10/10 |
| `commercial` | 11/11 |
| `engine-invoice-golden` | 17/17 |
| `ai-gross-profit-availability` | 8/8 |
| `ai-tools` | 23/23 |
| `ai-answer` | 7/7 |
| `rls-isolation` | 42/42 |
| `isolation-cases` | 10/10 |
| `org-scope` | 13/13 |
| `session-revocation` | 2/2 |

Playwright detail:
- `journey-15-command-centre` passed (7.6 s).
- The axe sweep passed on Command Centre, Command Centre alerts, Command Centre actions and Adviser analyst.
- The overflow sweep passed at 320, 375, 768 and 1440 px.
- The one skip is the conditional skip in `evidence-provenance.spec.ts:54` ("another organisation's record is 404").

### 3.1 Known nondeterministic test: `ai-eval-record`

- **Full run:** failed once, with `get_alerts #16 output shape: expected [ Array(24) ] to deeply equal [ Array(25) ]` at `ai-eval-record.test.ts:231`.
- **Re-run alone, four times:** passed 4 of 4 (`gate-aievalrecord-rerun{1..4}.log`).
- **Signature:** the same as the documented pre-existing flake. `keyPaths` describes an array by its first element, so the golden organisation's alert set or order changes the key set (`PHASE_12_IMPLEMENTATION.md §16`, ADR note at `ARCHITECTURAL_DECISIONS.md:1338`).
- **Scope:** Phase 15 touched nothing in `src/modules/ai`, `src/modules/alerts` or `test/fixtures`, so this does not hide a new failure. It was not modified or suppressed.

## 4. Grounding (§3–§13, §36)

**Method.** `groundBriefing` and `buildDigest` were driven directly with 265 cases, in two groups:
- synthetic financial-fact digests, to test the validator's rules;
- the digest `buildDigest` makes from a `PortfolioView`, which is what production feeds the model.

The worst cases were then replayed end to end through `askAdviser` with a fake transport on the database. Each case ends in one of three verdicts:
- **ok:** the result matched the expected contract;
- **MISMATCH:** the result contradicted it;
- **observe:** no expectation was set.

Tally: 170 ok, 56 MISMATCH, 39 observe. The full table is in `probe-grounding-results.txt`.

| Group | ok | MISMATCH | observe |
|---|---|---|---|
| number words (§4) | 15 | 0 | 0 |
| multipliers (§5) | 18 | 0 | 1 |
| fractions (§5) | 7 | 0 | 0 |
| approximation / vague (§5) | 11 | 0 | 4 |
| claim-level (§7) | 7 | 0 | 1 |
| two figures in one clause (§8) | 8 | **9** | 3 |
| wrong metric (§9) | 4 | 0 | 2 |
| wrong period (§10) | 7 | **5** | 3 |
| wrong unit (§12) | 11 | 0 | 3 |
| wrong organisation (§11) | 9 | 0 | 4 |
| titles (§6, L-2) | 12 | **3** | 3 |
| health (production facts) | 7 | **12** | 0 |
| bypass hunting (production facts) | 37 | **21** | 12 |
| honest answers (false positives) | 17 | **6** | 0 |

### 4.1 What is closed

**Number words (§4).** These pass only with an exact fact:
- "Revenue fell by twenty per cent."
- "Revenue declined twenty-five percent." (a 25% fact passes; a 20% fact does not)
- "Runway is one and a half months." (also "1½", "1.5")

These fail against the example digest (revenue decline 20%, open actions 8, runway 3 months):
- "Revenue declined eight percent."
- "Runway is eight months."

The claim also fails when the fact is uncited, or when only another metric's fact is cited.

**Multipliers and fractions (§5).**
- Each of these passes only with a `multiple` fact of the right value and direction: doubled, halved, twofold, 3x, twice as much, cut by half, one half.
- A 100% or 50% percent fact does not ground "doubled" or "halved".
- "Three times higher" has no value and is never grounded.
- These are all removed: "about 20%", "roughly doubled", "more than 20%", "significantly lower", "fell sharply", "~20%", "at least 20%", "a fifth", "a third", "half of".
- Production digests hold no `multiple` facts, so every multiplier sentence is removed in production.

**Claim level (§7).**
- "Revenue fell 8% while runway is 3 months." with runway = 2 is removed. The same holds with `and`, `,`, `with`, and with no connector at all.
- In a mixed summary, the valid sentence stays, the invalid one is removed, and the status is `degraded`, which renders as "Partly grounded".

**Wrong metric (§9).** All removed:
- "Cash runway declined 8%."
- "Profit margin is 8%."
- "Revenue declined 3%."

**Wrong unit (§12).** 8%, 8 months, £8, 8 points, 8 pp, 8 AED and a bare 8 are all distinct, and "Revenue declined 8 months" is removed.

**Wrong organisation (§11).** Closed in the pure probe and through the analyst on the database:
- A and B hold identical counts. In the database probe the model cites A's fact for B in a summary, the headline and a note. The status is `degraded`, B's summary becomes the server sentence, and no "has 3 critical alerts" text survives (`probe-db-boundary.log`).

**L-2 titles (§6).**
- With the title "Revenue issue 3", "Revenue declined 3%." is removed.
- `“Revenue issue 3”%` is removed.
- An unquoted "Revenue issue 3 is open." is removed.
- A quoted, cited title stands.
- A quoted title that is not cited is removed.

**Refusal and limitations.**
- A refusal carrying "20%" is replaced by the server sentence (`not_applicable`).
- Limitations with "twenty per cent", "3" or "halved" are removed. "Revenue figures are not in the data." is kept.

### 4.2 What is not closed

These are new findings. All of them use production digest facts unless a row says otherwise.

#### **F-1 (MEDIUM) — a count fact grounds a claim about a different quantity**

**Where.** `src/modules/portfolio/domain/briefing.ts:96-117`, `:268-291`.

**Mechanism.** `binds()` checks that ONE of the fact's words appears in the clause:
- `portfolio/clients` has `words: ['client','organisation','organization']` and no `excludes`.
- The predicate the number is attached to is never checked.

**Reproduction** (`probe-grounding2-results.txt`). The portfolio has 12 clients, 3 needing attention, 5 healthy, 2 unscored, 3 critical alerts at one client, and 11 open actions at two clients. Each sentence below is `passed`:

| Sentence | Truth |
|---|---|
| "12 clients need attention." | 3 |
| "12 of 12 clients need attention." | 3 of 12 |
| "12 clients are healthy." | 5 |
| "12 clients are at risk." | — |
| "12 clients have critical alerts." | 1 |
| "3 clients have critical alerts." | 1 client; the 3 is the alert count |
| "11 clients have open actions." | 2 |
| "Acme Trading completed 8 actions." | 8 is the open count |
| "Acme Trading resolved 3 critical alerts." | the 3 alerts are still standing |

**End to end** (`probe-db-boundary.log`, "misstatement e2e"). With 3 clients, of which 2 need attention, `askAdviser` stored `grounding_status = passed` for:
- the headline "3 clients need attention.";
- the note "Across the portfolio 3 clients have critical alerts.".

`listAdviserTurns` returns `passed`, so `/portfolio/analyst` renders the **Grounded** badge (`analyst/page.tsx:10-15,45-52`).

**Why MEDIUM.** This is the same class the previous audits blocked on (MEDIUM-D, M-1): a number that exists in a fact grounds a claim that fact does not state. It misstates the portfolio's headline figure under a Grounded badge.

#### **F-2 (MEDIUM) — current and previous health score, and direction, are not bound**

**Where.**
- `briefing.ts:126-127`: `health_score` and `previous_health_score` share `words: ['health','score']` and carry no direction.
- `:282`: the period check accepts ANY period named in the clause. When no period is named, it accepts any fact period.
- `:200-201`: closed lists of direction verbs.

**Reproduction** (Aug 2026 = 38, Jul 2026 = 61, change = 23 down). Each sentence is `passed`:
- "Its health score rose from 38 to 61."
- "Its health score went from 38 to 61."
- "Its health score recovered from 38 to 61."
- "Its health score is 61."
- "Its current health score is 61."
- "Its latest health score is 61."
- "Its health score improved to 61."
- "Its health score rose to 61."
- "Its health score is 61, down from 38."
- "Its health score is 61 this month."
- "Its health score was 38 last month."
- **"Its health score rose from 38 in Jul 2026 to 61 in Aug 2026."** Both named periods are wrong, and it still passes.
- "Its health score is 61 in Jul 2026 and 38 in Aug 2026" also passes (that one is true).

For a client whose score went up 2 (70 → 72), each of these is `passed`:
- "health score slumped 2 points"
- "sank 2 points"
- "tumbled 2 points"
- "dipped from 72 to 70"
- "slid from 72 to 70"

**Why MEDIUM.** The health score is the Command Centre's primary figure. A deterioration can be presented as an improvement under "Grounded".

**Documentation.** ADR-115 documents "relative periods ('this quarter', 'last month') are not read as a period". The consequence is not documented: with no period named, a claim binds to either month's fact, and wrong explicit periods in one clause also pass.

**Brief §10.** "relative periods … should not be guessed" fails. Synthetic results:
- "Revenue declined 2% this month / this quarter / in the latest month / year to date" pass against an Aug-only 2% fact while a Sep fact exists.
- "Revenue declined 8% last month" passes against the Sep fact.

#### **F-3 (MEDIUM) — two figures in one clause swap; the documented residual is understated**

**Where.** `src/modules/portfolio/domain/quantities.ts:145` (`CLAUSE_BREAK`), `briefing.ts:305-313` (clause governance).

**Mechanism.** Clauses break only on `, ; : ( - and but while whilst whereas although though yet with however plus because since after due to following which so`. Many ordinary connectives are not breaks: `as`, `as well as`, `then`, `when`, `against`, `alongside`, `on`, `of`, `compared with`.

**Synthetic reproduction** (revenue decline 8%, margin decline 14%). Each is `passed`:
- "Revenue fell 14% as margin fell 8%."
- "Revenue fell by 14% as margin fell by 8%."
- "Revenue fell 14% then margin fell 8%."
- "Revenue fell 14% when margin fell 8%."
- "Revenue fell 14% as did margin by 8%."
- "Revenue fell 14% against a margin decline of 8%."
- "Revenue fell 14% alongside margin falling 8%."
- "Revenue fell 14% as well as margin at 8%."
- "Revenue fell 14% margin 8%."

**Production reproduction** (3 critical, 1 high, 8 open actions). Each is `passed`:
- "has 8 critical alerts as well as 3 open actions"
- "has 8 critical alerts against 3 open actions"
- "has 8 critical alerts alongside 3 open actions"
- "has 1 critical alert as well as 3 high alerts"
- "has 3 high alerts of 1 critical alerts"
- "health score 3 critical alerts 38"

**End to end.** `askAdviser` stored `passed` for "FA Alpha … has 1 critical alert as well as 3 high alerts." (truth: 3 critical, 1 high).

**Documentation.** ADR-115 and `PHASE_15_IMPLEMENTATION.md` describe the residual as "two claims in ONE clause with no break between them … only when both values exist in cited facts". The second condition is accurate. The first is not: ordinary connectives count as "no break". The values need not coincide, and the output misstates a metric.

**Classification.** MEDIUM, not LOW. The brief requires this assessment, and the probe shows a material misstatement under the Grounded badge.

**Does production carry such facts today?** Yes. Every client has 5–6 count and score facts that can be cited together, so swaps between counts are reachable now. Percent, months and money facts do not exist yet, so revenue/margin swaps are latent until they do.

#### **F-4 (MEDIUM, same class as M-1) — quantity words and non-ASCII digits are not seen**

**Where.** `quantities.ts:104-139,323-356` (closed vocabulary) and `claims.ts` (`\d` is ASCII-only; NFKC does not fold Arabic-Indic digits).

**Reproduction.** Each is `passed`, and each is false:

| Sentence | Truth |
|---|---|
| "Alpha Ltd has a couple of critical alerts." | 3 |
| "Alpha Ltd has a pair of critical alerts." | 3 |
| "Alpha Ltd has a single critical alert." | 3 |
| "Alpha Ltd has a dozen overdue actions." | 2 |
| "None of Alpha Ltd's actions are overdue." | 2 overdue |
| "Alpha Ltd does not have any critical alerts." | 3 |
| "Both clients need attention." | 1 of 2 |
| "All clients are healthy." | — |
| "Alpha Ltd has III critical alerts." | 3; Roman numeral |
| "Alpha Ltd has ٥ critical alerts." | 3; Arabic-Indic 5 |
| "Its health fell for the third consecutive month." | ordinal used as a count |

Fullwidth "５" is caught, because NFKC folds it.

**Documentation.** ADR-115 documents only '"None" is not read as zero'.

**Why MEDIUM.** M-1 was "quantitative claims written in words are not seen". These are the same class, in common English ("a couple of", "a single", "both"), and they reach the Grounded badge.

#### **F-5 (MEDIUM) — the Command Centre errors for any adviser with 201 or more organisations**

**Where.** `src/modules/portfolio/data/repository.ts:130-137` (`loadStandingAlerts`), `:146-153` (`loadRecentAlerts`), `:198-212` (`loadOpenActions`), `:221-228` (`loadRecentlyFinishedActions`). Each is a PostgREST GET with `.in('organization_id', [...ids])`.

**Measured** (`probe-db-superadmin.log`), as a super admin at aal2 with 1,005 organisations:
- `loadPortfolio` over the first k organisations: **k ≤ 200 OK; k = 201 → `INTERNAL: Something went wrong`**.
- A raw recent-alerts request of the same shape: k = 200 → HTTP 200; **k = 201 → HTTP 414 "URI too long"**.
- `api.portfolio_summary` is a POST and is unaffected.

**Affected routes.** Every route that calls `loadPortfolio`: `/portfolio`, `/portfolio/alerts`, `/portfolio/actions`, `/portfolio/clients/[orgId]`, and the adviser analyst (`askAdviser` loads the portfolio first).

**Who is affected.**
- A super admin sees every organisation, so any platform with 201 or more organisations.
- An owner, admin or employee advising 201 or more.

**Caveats.** This was measured on the local stack's gateway. The hosted gateway's limit may differ, but it is finite and was not measured.

**Also measured (carried over as L-6).** `my_organizations` returns 1,000 of 1,005 organisations, and the summary returns 1,000 rows. This contradicts `PHASE_15_IMPLEMENTATION.md:76` ("max_rows … is never relied on for correctness").

**Why MEDIUM.** It fails closed with no wrong data, but the phase's primary surface is unavailable at a realistic practice or platform size, and the scale claims in the docs do not hold.

#### LOW findings

- **L-A (residual of L-2).** A quoted, cited title whose text IS the figure passes. With an action titled "20%": "Revenue fell by “20%”.", "Revenue is down “20%” on last month." and "Its margin is “20%”." are all `passed`. The guard (`quantities.ts:241-251`) checks only for a unit next to the quotes. Action titles are tenant-written; the model must choose to quote it.
- **L-B.** Hedge and unit spelling gaps:
  - "Revenue fell 20%-plus." is `passed` (the hedge is not read).
  - "Alpha Ltd's critical alerts rose 3 per-cent." is `passed`: "per-cent" is read as a bare 3 and bound to the count.
- **L-C (false positives).** 6 of 23 honest, true sentences were degraded:
  - "Alpha Ltd has 3 critical and 1 high alert."
  - "…8 open actions, 2 of them overdue."
  - "…2 overdue actions among its 8 open actions."
  - "…4 standing alerts, 3 of them critical."
  - "…8 open actions and 2 are overdue."
  - "Across the portfolio, 3 critical alerts and 2 overdue actions stand."

  This fails closed, and the prompt steers away from these forms. It is still frequent enough to erode the badge's value.
- **L-D.** The digest's per-client detail is taken from the global 500-row worst-first list (`adviser.ts:111-114`, `briefing.ts:152-158`). In the scale probe, client Q (4 critical, 3 overdue) got 0 alert and 0 action detail rows because another client's 700 critical alerts filled the cap. The counts facts were correct. The model cannot cite Q's alerts.
- **L-E (mobile).** `/portfolio/clients/[orgId]` overflows the page horizontally when the organisation name is long:
  - measured **373 px at 320** and **318 px at 375**, with a ~75-character name;
  - the cause is the "Open {name}" button in `PageHeader`'s `shrink-0` action slot (`src/components/ui/surfaces.tsx:28`);
  - every other Phase 15 route measured 0 px at 320, 375, 768 and 1440.
- **L-F (accessibility, minor).** axe `empty-table-header` (minor, best-practice, not WCAG A/AA) on `/portfolio` `th:nth-child(7)` at 768 and 1440 px. No WCAG A/AA violation on any Phase 15 route at any width (tags wcag2a/aa, 21a/aa, 22aa, best-practice).
- **L-G.** There is no daily adviser quota. The only limit is `app.throttle(p_actor,'portfolio_ai',10,'1 minute')` (`20260924000001_portfolio_ai.sql:86`), which allows up to 14,400 model calls per user per day. This is a cost exposure limited to authenticated advisers.

**Observation (not a finding).** For an employee whose JWT claims aal2 but whose profile has no `profiles.mfa_enrolled_at`:
- the resolver returns their assigned organisation (`probe-db-boundary.log`);
- `begin_turn` refuses them (`PERMISSION_DENIED`).

The two layers read MFA from different places. It is not exploitable without a forged JWT, because a real aal2 session implies a verified factor, and it pre-dates Phase 15.

## 5. Grounding badge (§14)

- `src/app/portfolio/analyst/page.tsx:10-15,45-52` maps `turn.groundingStatus` from `portfolio_ai_turns.grounding_status` to the labels: `passed` → Grounded, `degraded` → Partly grounded, `not_applicable` → No figures, `failed` or null → Not answered.
- Nothing on the client computes it. The status is written only by `api_server.portfolio_ai_finish_turn` (service role).
- In the UI probe, a stored `degraded` turn showed "Partly grounded" and a `passed` turn showed "Grounded". Journey 15 asserts the same.

**PASS for the mechanism.** The badge faithfully reflects a server status that F-1 to F-4 show can be wrong.

## 6. AI data boundary (§15) and stored-turn revocation (§16)

Probe: `probe-db-boundary.log`. Setup: an employee assigned A, B and E; C unassigned.

**Model context.**
- The system text and digest do not contain C's name, C's id, or C's alert id.
- The user's own question text contains the name, which is user-supplied.
- Tools = `["submit_briefing"]`, `toolChoice = {type:'tool', name:'submit_briefing'}`. There is no database tool and no organisation lookup.

**Forged scope** through `beginPortfolioTurn`:

| Attempt | Result |
|---|---|
| [A, C] | `PERMISSION_DENIED` |
| [C] | `PERMISSION_DENIED` |
| random id | `PERMISSION_DENIED` |
| [] | `VALIDATION` |
| stranger as actor for A | `PERMISSION_DENIED` |
| employee without TOTP for A | `PERMISSION_DENIED` |

**Direct database attempts** with the employee's JWT:
- insert, update and delete on `portfolio_ai_turns` → `42501`;
- calling `api_server.portfolio_ai_begin_turn` → `42501 permission denied for schema api_server`;
- `api.portfolio_summary([A, C])` → a row for A only.

**Revocation.** Turns were made over {A, B, E} and {A, B}. Each turn was read three ways: via `listAdviserTurns` (fresh context), via a stale in-memory context, and by id directly through PostgREST.

| Step | {A,B,E} turn | {A,B} turn |
|---|---|---|
| baseline | visible (all 3 reads) | visible |
| B revoked | 0 | 0 |
| B reassigned | visible | visible |
| A revoked | 0 | 0 |
| E `ends_at` in the past | 0 | visible |

**Other readers.**
- 0 rows for: employee at aal1, the owner of A/B/E (not the author), another adviser (admin of A), a client of A, a stranger (including `select *`), a super admin at aal1, and the employee with a forged random id.
- 1 row for a super admin at aal2. This is by design (the governance read in the policy).

**RLS catalogue.** `portfolio_ai_turns` has RLS forced (`relforcerowsecurity = t`). Its select policy is `app.is_super_admin() OR (user_id = app.uid() AND scope_organization_ids <@ ARRAY(SELECT app.adviser_org_ids()))`. `authenticated` holds SELECT only.

**Result: PASS.**

## 7. Authorisation, zero assignment, scope (§17, §20)

| Caller | Resolver | Portfolio |
|---|---|---|
| Employee with 0 assignments, aal2 | empty context | `counts.clients = 0` |
| Employee with 0 assignments, aal1 | `NOT_FOUND` | — |
| Suspended employee | `NOT_FOUND` | — |
| Client of A | `NOT_FOUND` | direct `portfolio_summary([A])` → `[]` |
| Stranger | `NOT_FOUND` | — |
| Super admin, aal1 | `NOT_FOUND` | — |
| Super admin, aal2 | all organisations | — |
| Client in A and owner of M2 | `[M2:owner]` only | direct `portfolio_summary([A, M2])` → `["M2"]` |
| Owner | own organisations | — |
| Admin of A | `[A:admin]` | — |

- `/portfolio` renders the "You haven't been assigned to any organisations yet." empty state when the scope is empty (`src/app/portfolio/page.tsx:16-25`).
- The analyst hides the form when the scope is empty (`analyst/page.tsx:35-37`).
- `layout.tsx` converts `NOT_FOUND` to `notFound()`.
- Journey 15 confirmed the client's 404 on all six routes.
- The zero-assignment state was verified at the resolver and in the page code. It was not driven in a browser, because an employee session needs TOTP.

**Result: PASS.**

## 8. Scale and aggregates (§18, §19, §21, §27)

Probe: `probe-db-scale.log`.

**HIGH-A.** P has 700 old critical alerts (140 of them acknowledged) and 1,100 high-priority overdue actions. Q has 4 new critical alerts, 1 high alert, 3 overdue actions and 2 in-progress actions. R is unauthorised, with 300 critical alerts and 400 actions.
- Portfolio counts: critical 704, standing 705, open 1,105, overdue 1,103. Q: critical 4, overdue 3. R contributed nothing.
- Q is in the attention queue: "4 critical alerts; 3 overdue actions; 1 high alert".
- The alert detail list has 500 rows (0 of them Q's) with total 705, `truncated = true`. The note reads "Showing the first 500 of 705, worst first. Every count on this page is the full number."
- The open-action list has 500 rows of 1,105; the overdue list has 500 rows of 1,103.
- **PASS.**

**HIGH-B.** 50 organisations, 24 scored complete months each (Sep 2025 – Aug 2027). Each organisation has a distinct latest score (30 + i) and previous score (90 − i).
- 0 "Not yet scored"; 0 wrong latest or previous values.
- At-risk clients are in the queue.
- The query is a single `api.portfolio_summary` call. It ranks `health_current ⋈ health_scores ⋈ fiscal_periods` with `row_number()` per organisation over complete periods (`20260925000001_portfolio_integrity.sql`) and returns one row per organisation, so the PostgREST row cap does not truncate months.
- **PASS.**

**Performance.**
- `loadPortfolio` makes 3 HTTP requests whether it covers 2 or 50 organisations (one POST `rpc/portfolio_summary`, two GETs for the recent feeds). The three detail reads make 3 more. There is no per-organisation loop.
- Crude local timings (not a benchmark): `loadPortfolio` for 50 organisations took 8–11 ms over 5 runs; for 2 organisations, 17 ms.
- No latency benchmark under realistic load was performed.
- **FINDINGS:** F-5 (URI length) and L-6 (1,000-row truncation for super admins).

## 9. Financial truth, Phase 13/14 regression (§22–§25)

- **No authoritative calculation in Phase 15.**
  - The portfolio sums per-organisation integer counts (`services/portfolio.ts:81-95`) and computes nothing monetary.
  - Health comes from Phase 6 `health_current`/`health_scores`, with `bandFor` from `@/modules/health`.
  - Alerts and actions use the Phase 7/10 tables with `OPEN_STATUSES = ['open','in_progress']`, `DUE_SOON_DAYS = 7` and the same lens predicates.
  - The digest holds only counts and scores.
- **Reconciliation sweep:** "SWEEP checked 100, mismatches 0".
- **Phase 14 suites:** the files in §3 passed.
- **Phase 13 suites:** `banking` 20/20 and `bank-commercial-population` 12/12 passed; journey-13 passed.
- **Phase 13 MEDIUM-4, measured.** The transactions page overflows by **178 px at 375** and **233 px at 320**. The cause is the filter nav in the page-header action slot ("All / Money in / Money out / … / Look like transfers"), not the table (the table sits in its own `overflow-x:auto` wrapper) and not the org header Phase 15 edited (Home and Banking overflow 0 px). Phase 15 changed no file behind that page.
- **Result: PASS** (not worsened).

## 10. RLS and security (§26)

**Migrations.** `20260924000001_portfolio_ai.sql` and `20260925000001_portfolio_integrity.sql`; there is nothing newer.

**`portfolio_ai_turns`.**
- Owned by `motion_definer`, with RLS enabled and forced.
- Insert, update, delete and truncate are revoked from `authenticated` and `anon`.
- Writes happen only through the two `api_server` functions. Both are SECURITY DEFINER with `search_path = ''`, executable only by `service_role` (`proacl`), and check `app.role_claim() = 'service_role'`.
- `begin_turn` checks every scope id against `app.org_role_of(actor)`.
- `finish_turn` requires `user_id = p_actor AND status = 'pending'`.

**`api.portfolio_summary` and `app.adviser_org_ids`.** Both are definers with `search_path = ''`, executable by `authenticated`. The scope is `unnest(p_orgs) ∩ app.adviser_org_ids()`, which is bound to the caller's own identity.

**Direct attempts.** All refused (§6). pgTAP (1,053 tests) and the schema-drift gate are green.

**Result: PASS.**

## 11. Mobile (§28) and accessibility (§29)

**Probe setup** (`probe-ui.log`). An owner of 2 organisations, one with a 75-character name, 620 alerts and 30 overdue actions, and 2 stored turns. Routes: `/portfolio`, `/portfolio/alerts`, `/portfolio/actions`, `/portfolio/actions?view=overdue`, `/portfolio/analyst`, and `/portfolio/clients/{A,B}`. Widths: 320, 375, 768 and 1440.

**Overflow.** 0 px everywhere except `/portfolio/clients/A`: 373 px at 320 and 318 px at 375 (L-E). **Mobile: FINDINGS.**

**Structure and accessibility.**
- Exactly one h1 per page, and heading levels do not skip.
- axe reported 0 violations of any impact, except `empty-table-header` (minor) on `/portfolio` at 768 and 1440.
- Keyboard order on the analyst: header links → "Ask about the clients you advise" textarea (labelled) → Ask button → answer links. Every stop has a visible focus indicator.
- **Accessibility: PASS** (the one minor best-practice item is L-F).

## 12. Documentation (§34)

**Accurate:**
- The badge mapping, and that it is decided on the server.
- The tool boundary (one forced tool).
- Current-access revocation.
- The empty state for an employee with no assignments.
- The caps with authoritative totals and the truncation note.
- That no live Claude model was run.
- "None is not read as zero" and "relative periods are not read" (both documented).

**Not accurate:**
- **Grounding claims.** ADR-115 §2, `PHASE_15_IMPLEMENTATION.md §8`, `UX_ARCHITECTURE.md` ("Grounded: every quantitative claim, in digits or in words, was bound to a fact MOTION holds") and `ROUTE_ARCHITECTURE.md` state that each claim is bound on metric, period and direction. F-1, F-2 and F-4 contradict this.
- **The residual.** It is described as "no break between them", which understates F-3.
- **Period behaviour.** The consequence of the relative-period residual (binding to either month) is not described.
- **Row limits.** `PHASE_15_IMPLEMENTATION.md:76` claims PostgREST `max_rows` is never relied on, but it truncates super admins at 1,000 organisations (L-6), and the 201-organisation URI limit (F-5) is not documented.

**Documentation: FINDINGS.**

## 13. Phase 16 scope (§35)

A search of `src`, `supabase`, `e2e`, `test` and `scripts` for funding readiness, funding score, funding report and "phase 16" finds only a pre-existing comment in `src/modules/health/domain/config.ts:31` (a reserved dimension) and planning docs. There is no Phase 16 table, route, workflow, AI or migration. **NOT STARTED.**

## 14. Remaining findings on the brief's LOW list (§33)

| Item | Assessment |
|---|---|
| No daily adviser quota | LOW (L-G): 10/min only. |
| Financial figures beyond the digest | The digest holds counts, scores, titles and names only; no leak observed. Alert titles written by the engine may contain phrases like "under two months"; the model sees these as quoted titles. LOW. |
| Employee browser journey needs TOTP | A limitation, covered at the database and API layers. |
| No client-list pagination | LOW on its own. Superseded at scale by F-5, which fails at 201 organisations. |
| No last-data-date column | LOW. |
| Previous-scored-month trend semantics | LOW as display. As a grounding input it feeds F-2. |
| Acknowledged alerts in attention | By design, and counted consistently (140 acknowledged critical alerts counted). LOW. |
| No latency benchmark | Confirmed: no benchmark; only the crude local timings in §8. |

## 15. What could not be verified

- **Live Claude behaviour.** There is no API key. The safety invariant was tested with the deterministic grounder and a fake transport only. How often a real model writes the F-1 to F-4 sentence shapes is unmeasured. The findings rest on the server accepting them, not on model frequency.
- **An employee's browser session** (it needs TOTP).
- **The hosted gateway's URI limit** (F-5 was measured on the local Kong stack).
- **Whether ADR-115's "33 eval cases fail on `71fd748`"** holds. This was not re-run on a second database.

## 16. Release criteria (§36)

**Closed:** M-1 (as reproduced by the brief), L-2 (as reproduced), HIGH-A, HIGH-B, HIGH-C.

**New MEDIUM findings present:**
- **F-1:** a count grounds a different quantity; "3 clients need attention" was stored as `passed`.
- **F-2:** current and previous health score and direction swap, including wrong explicit periods.
- **F-3:** two-figure swap across common connectives; reproduced end to end.
- **F-4:** quantity words and non-ASCII digits (an M-1 residual).
- **F-5:** 201+ organisations → HTTP 414 → Command Centre error.

**Untouched:** tenant isolation, authorisation, the AI data boundary, financial truth and the evidence sweep all hold.

The brief blocks release on any material AI-grounding problem or any new MEDIUM. **NOT READY FOR PHASE 16.**

---

> **Archival note — added with ADR-116 and ADR-117, not part of the audit.** This record was copied verbatim on 2026-09-29 from the auditor's session scratchpad, where it would not have survived the session; nothing above was edited. The probe files and logs it names lived in that scratchpad and are not in the repository. Findings F-1…F-4 are addressed by ADR-116 and F-5 (with L-6) by ADR-117; whether they are closed is for the next independent audit to decide.

> **Later note (with ADR-118).** The second final release audit (`docs/PHASE_15_FINAL_RELEASE_AUDIT_2.md`, of `48f2c4f`) found F-1, F-2 and F-4 still open under ADR-116; ADR-118 replaces the prose channel with a structured briefing. Whether they are closed is for the next independent audit to decide.
