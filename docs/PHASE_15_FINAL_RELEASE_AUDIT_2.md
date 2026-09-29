# Phase 15 — Final Independent Release Audit 2 (Adviser / CFO Command Centre)

- **Audited commit:** `48f2c4f25351a984466a870adc725c0648e673b2`, "Phase 15 final grounding and portfolio transport closure (ADR-116, ADR-117)".
- **Baseline:** `33a182f`, audited NOT READY in `docs/PHASE_15_FINAL_RELEASE_AUDIT.md`.
- **Date:** 2026-09-29.
- **Method:** I treated memory notes, ADRs, commit messages and implementation docs as claims, not evidence. Every result below was reproduced against the repository and a local database reset with `supabase db reset`.
- **Repository:** read-only. No file in `~/Desktop/MOTION` was modified, and nothing was committed or pushed. `git status --porcelain` was empty before and after the audit.
- **Where the artefacts are:** everything lives in this folder.
  - Probes: `probes/pure-grounding.test.ts`, `probes/pure-digestsize.test.ts`, `probes/db-boundary.test.ts`, `probes/db-boundary2.test.ts`, `probes/db-scale.test.ts`, `uiprobe/ui-turns.test.ts`, `pw/audit.pw.ts`.
  - Configs: `vitest.*.config.ts`, `pw.config.ts`.
  - Outputs: `probe-grounding-results.txt`, `probe-db-boundary.log`, `probe-db-boundary2.log`, `probe-db-scale.log`, `probe-digest-size.txt`, `probe-catalog.log`, `probe-ui.log`.
  - Gate logs: `g-*.log`, `integration.json`, `e2e.json`.
  - `node_modules` is a symlink to the repository's, so the configs can resolve.

## Verdict: **NOT READY FOR PHASE 16**

ADR-116 is a real architectural improvement:
- The model can no longer write a figure.
- Every number shown is rendered by the server from a typed digest fact, so figures cannot be swapped or re-valued. F-3 is closed.
- Fact ids are authorised against the digest built from the caller's view.

ADR-117 closes F-5 and L-6. The Command Centre loads at 201, 250, 1,005 and 1,053 organisations with correct counts. Scope, revocation, isolation, HIGH-A/B/C, financial truth and every gate hold.

However, the answer text shown under the **Grounded** badge still carries false quantitative claims. Unverified model prose is concatenated directly after server fact sentences in the same paragraph, and the prose filter is a word list with gaps. I stored each of the following end to end through `askAdviser` with `grounding_status = passed`, and the UI rendered each one under **Grounded**:

| # | What the page showed | Truth |
|---|---|---|
| 1 | "The portfolio has 3 clients. They need attention." | 3 of 3 in that fixture. In the pure probe, "12 clients … They need attention." with 3 needing attention also `passed`. This is the F-1 headline example. |
| 2 | "AU Alpha … has 3 open actions. They are overdue." | 1 of 3 overdue. ADR-116 says exactly this re-qualification is impossible. |
| 3 | "AU Alpha … has 3 standing critical alerts. They have been resolved." | Still standing. This is F-1's "resolved 3 critical alerts". |
| 4 | "AU Alpha …'s health score for Jul 2026 was 61. That is its latest score." | Latest is 38. This is F-2's "current health score is 61". |
| 5 | "…'s health score fell 23 points, from 61 … to 38 …. Its health has improved." | F-2 direction reversed. |
| 6 | "AU Alpha … does not have any critical alerts." | 3 critical. This is the previous audit's F-4 sentence, word for word. |
| 7 | "Only one of the clients needs attention." | 3 need attention. |
| 8 | "Not one of the clients has overdue work." | 2 clients have overdue actions. |

These are F-1, F-2 and F-4 reproduced under the new contract. Their severity class, MEDIUM, is the one that blocked `33a182f`: a materially false quantitative statement under the Grounded badge.

The implementation's own test for the F-4 sentence was changed from the audited "Alpha Ltd does not have any critical alerts." to `'It does not have any critical alerts... none.'` (`test/eval/portfolio-eval.test.ts:228`). The added word "none" is what gets it caught. The sentence as audited still passes.

---

## 1. Repository state

| Check | Result |
|---|---|
| HEAD | `48f2c4f25351a984466a870adc725c0648e673b2` |
| Branch | `main` |
| `origin/main` after `git fetch` | `48f2c4f…` (local = origin) |
| 48f2c4f exists | `git cat-file -t` → commit |
| Working tree | clean before and after (`git status --porcelain` empty) |
| Commits 33a182f..48f2c4f | exactly one: `48f2c4f` |

`git diff --stat 33a182f 48f2c4f`: 23 files, +1892/−1405.
- **Docs:** `AI_ARCHITECTURE.md`, `ARCHITECTURAL_DECISIONS.md`, `DATABASE_ARCHITECTURE.md`, `PHASE_15_FINAL_RELEASE_AUDIT.md` (new), `PHASE_15_IMPLEMENTATION.md`, `ROUTE_ARCHITECTURE.md`, `UX_ARCHITECTURE.md`.
- **E2E:** `journey-15-command-centre.spec.ts`.
- **Source:**
  - `portfolio/data/repository.ts`
  - `portfolio/domain/briefing.ts`
  - `portfolio/domain/free-text.ts` (new)
  - `portfolio/domain/quantities.ts` (deleted)
  - `portfolio/index.ts`
  - `portfolio/services/adviser.ts`
  - `portfolio/services/portfolio.ts`
  - `tenancy/services/organizations.ts` (`listMyOrganizations` now paged; this affects every caller of the resolver, not only the portfolio)
- **Migration:** `20260929000001_portfolio_transport.sql` (new).
- **pgTAP:** `14_portfolio.test.sql`.
- **Tests:**
  - `test/eval/portfolio-eval.test.ts`
  - `test/integration/portfolio-ai.test.ts`
  - `test/integration/portfolio-transport.test.ts` (new)
  - `test/unit/portfolio-free-text.test.ts` (new)
  - `test/unit/portfolio-quantities.test.ts` (deleted)

Across Phase 15 (`f5334be..48f2c4f`), no file under these modules changed: `src/modules/{ai,alerts,financial-engine,banking,commercial,health,actions,evidence}` and `src/components/ui`.

## 2. Environment

- macOS with 8 GB RAM, under memory pressure (about 4,000–8,000 free pages).
- Only the `supabase_*_MOTION` containers were running; no other project's stack.
- Port 3100 was free before and after.
- No `ANTHROPIC_API_KEY`. Every adviser path used an injected fake transport.

## 3. Gates (clean DB, sequential)

| Gate | Result |
|---|---|
| typecheck | rc 0 |
| lint | rc 0, no output |
| unit | **74 files, 2,099 / 2,099 passed** |
| AI eval | **2 files, 224 / 224 passed** |
| db:reset | rc 0 |
| integration (full run, one pass) | **51 files, 757 / 757 passed, 0 failed, 0 skipped**, 830.6 s |
| pgTAP | **17 files, 1,068 tests, "All tests successful"** |
| schema drift | "55 tables, 125 api functions, RLS forced everywhere, no write grants, no reachable server functions" |
| build | rc 0 |
| db:reset | rc 0 |
| Playwright | **69 passed, 1 skipped, 0 failed** (7.5 min) |

- The Playwright skip is the conditional skip at `evidence-provenance.spec.ts:54`.

Integration detail:
- `scenarios` ran **49/49** in the full run.
- Phase 15 files: `portfolio` 17/17, `portfolio-scale` 7/7, `portfolio-ai` 17/17, `portfolio-transport` 8/8. That suite logged "[F-5] super admin: 1005 organisations, 6 requests, 298 ms".
- The reconciliation sweep printed **"SWEEP checked 100, mismatches 0"**.

| Suite | Passed |
|---|---|
| evidence-invoice-basis | 5/5 |
| evidence-provenance | 14/14 |
| evidence-drawer | 33/33 |
| evidence-void-invoice | 5/5 |
| evidence-merged-counterparty | 4/4 |
| evidence-documents | 6/6 |
| banking | 20/20 |
| bank-commercial-population | 12/12 |
| ledger-commercial-population | 10/10 |
| commercial | 11/11 |
| engine-invoice-golden | 17/17 |
| ai-gross-profit-availability | 8/8 |
| ai-tools | 23/23 |
| ai-answer | 7/7 |
| rls-isolation | 42/42 |
| isolation-cases | 10/10 |
| org-scope | 13/13 |
| session-revocation | 2/2 |
| money-pages | 27/27 |
| health-scores | 19/19 |
| actions | 27/27 |
| alerts-persist | 23/23 |

- **`ai-eval-record`**: 1/1 passed in the full run. Its known nondeterministic signature (`get_alerts #N output shape` array length) did not occur in this run. It was not modified, and nothing is hidden behind it.

## 4. Grounding (F-1…F-4, the fact architecture, honest prose)

### 4.1 What the model can and cannot author (the input and output contracts)

**Input.** `SubmissionSchema` (`briefing.ts:212-230`) defines what the model may submit:
- A statement is `{kind:'text'|'facts', text?: string≤400, facts?: string[]≤6}`.
- There is no value, unit, period or direction field.
- Zod strips unknown keys, so a probe submission with `value:'99'` parsed to keys `["kind","facts"]`.
- An object in place of a fact id fails the schema.

**What the model is shown.** Each fact appears as `{id, type, period, says}` (`briefing.ts:200-202`).

**Rendering.** `renderFacts` (`:270-276`) writes each fact's own `statement`, built in `buildDigest` (`:117-197`) from the view's aggregates. Several counts about one client share one sentence, with each phrase kept with its own noun.
- Reversed ids render "has 3 open actions and 3 standing critical alerts" in the e2e probe, never swapped.
- Text sent inside a facts statement is never shown. "99 open actions" was rendered as "has 3 open actions" (stored `passed`, with a `removed` note).

**Authorisation** (`:331-337`):
- a forged id → `degraded`;
- another client's fact in a client block → dropped, `degraded`;
- valid plus invalid in one statement → the valid fact renders and the turn is `degraded`;
- an unknown client ref → dropped;
- `kind:'text'` carrying facts → dropped;
- a refusal carrying facts → `not_applicable` with the fallback headline.

A wrong-period or wrong-metric fact can only render its own period and metric. For example, citing `previous_health_score` renders "…for Jul 2026 was 61".

**Result: structured facts, server rendering and fact authorisation are PASS.**

### 4.2 Where it fails: prose beside and around facts

A block's parts are joined with a space (`briefing.ts:318-341`). A `text` statement placed after a `facts` statement lands in the same paragraph, immediately after the server's figure. The page renders the paragraph as one `<p>` (`src/app/portfolio/analyst/page.tsx:61,75,96`), so nothing distinguishes a verified sentence from an unverified one.

The prose filter (`free-text.ts`) cannot see anaphora ("They", "It", "That"), so the model can re-qualify, negate or re-date the figure just stated.

**Pure probe** (`probe-grounding-results.txt`). Each row below is `passed`:
- F-1, client combinations: 8 of 10 passed. Examples:
  - "has 3 open actions. They are overdue."
  - "has 8 standing critical alerts. They are not critical."
  - "has 1 overdue action. It is not overdue."
- F-1, note combinations: 4 of 7 passed. Examples: "The portfolio has 12 clients. They need attention." (3 need attention); "…They are healthy."
- F-2 combinations: 6 of 6 passed. Examples:
  - "…for Jul 2026 was 61. That is its latest score."
  - "…fell 23 points… Its health has improved."
  - "…is 38 (At risk). Its health is recovering."
  - "Its current health score is higher than before."
- F-3 prose: "…has 8 standing critical alerts. Alpha Ltd has more open actions than critical alerts." passed (a false comparison: 3 < 8). This is prose, not a swapped figure.

**End to end** (`probe-db-boundary.log`, `probe-ui.log`). The rows in the Verdict table were stored `passed`, returned by `listAdviserTurns` as `passed`, and rendered by the production build under **Grounded**. The analyst card read:

> "Grounded · The portfolio has 2 clients. They need attention. … has 3 open actions. They are overdue. It does not have any critical alerts."

The truth for that card was 206 critical alerts, and 1 of the 3 actions overdue.

### 4.3 F-4 number forms that get through the prose rule

Of 117 adversarial prose sentences, 43 were caught.

**Caught:**
- digits in any script: superscript ², circled ⑧, 𝟖, fullwidth ８, Arabic-Indic ٥;
- 𝐞𝐢𝐠𝐡𝐭 (NFKC folds it) and uppercase III / Ⅲ;
- number, cardinality and multiplier words: "twenty five", "a score of", trio, dozen, half-dozen, handful, couple, pair, single, both, all, none, every, halved, tenfold, ten-fold, "a factor of three", "cut in two";
- ordinals: "third consecutive month", "twenty-ninth";
- periods: "this month", August, Q3, "year to date", "last month";
- percent: "%".

**Passed, carrying a count, zero, size or rank** (each would be false against the digest used):

| Form | Sentences that passed | Cause |
|---|---|---|
| Negated counts | "does not have any critical alerts", "does not have critical alerts", "has not got any overdue actions", "lacks critical alerts", "is free of critical alerts", "has no open, overdue or critical alerts", "has no outstanding items / problems / concerns / red flags / overdue work", "Not one of its actions is overdue", "No one of its actions is overdue" | `TOTALITY_WORDS`, `free-text.ts:48-50` |
| "one" through the idiom exemption | "Only one of its actions is overdue.", "Just one of the clients needs attention." | `IDIOMS`, `free-text.ts:66` |
| Misspelled or joined number words | twentyfive, tweny, fourty, eigth | `\b` word boundaries |
| Obfuscated number words | eig-ht, "e i g h t", "eigh­t" (soft hyphen), "eig​ht" (zero-width space), "ei‍ght" (ZWJ) | `normalise`, `src/modules/ai/domain/claims.ts:74-82`, does not strip `\p{Cf}` |
| Lowercase Roman numerals | ii, iii | `free-text.ts:75` is uppercase-only |
| Latin-script foreign number words | vingt, zwei, cinco, dix, drei, acht, tres, ocho, otto | only non-Latin scripts are caught |
| Collective nouns | quartet, brace | not in the list |
| Comparatives and superlatives | "more alerts than Beta Ltd", "the most critical alerts in the portfolio", "the lowest health score in the portfolio", "the fewest alerts" | not in the list |
| Totality through verbs | "has resolved its critical alerts", "has completed its actions", "has cleared its alerts", "cleared its backlog", "Its actions are overdue, to the last" | not in the list |
| Currency and size words | "a few pounds / quid / grand", "a fortune", "a fraction of", "record low", "an order of magnitude" | not in the list |
| Indefinite-article counts | "has an alert", "has a solitary critical alert", "an overdue action, just the one" | not in the list |
| Others | "Most actions are overdue." (only "most of" is listed), "since the spring" (season), "Its latest month is worse than the last." | not in the list |

**Client-name laundering.** Names are removed from the text before the scan (`free-text.ts:97-99`). If a client is literally named "Twelve", "Both" or "None", then "Twelve clients need attention." / "Both need attention." / "None are overdue." are `passed`. This is contrived; LOW.

**Why these block.** The documents assert things that do not hold:
- ADR-116 §2 and `PHASE_15_IMPLEMENTATION.md §8`: "no model text is placed beside a figure".
- ADR-116: "F-1 to F-3 are closed by construction … the model cannot attach a figure to another meaning … or reverse a direction".
- ADR-116 limitation and `PHASE_15_IMPLEMENTATION.md`: prose "cannot carry a figure, a period or a cardinality", and the rule "covers every form the audits and briefs name".
- `UX_ARCHITECTURE.md:389`: "the analyst's own words carry no quantity".

Reproductions 1–8 and the F-4 table contradict each of these. Only the typed-fact half of the design is sound. Prose is still model-authored quantitative meaning, filtered by a vocabulary. The owner's brief explicitly rejects a word list as the sole proof, and ADR-116 itself describes the rule as a vocabulary.

### 4.4 The owner brief's specific cases

| § | Case | Result |
|---|---|---|
| §4 | Digest 12 open actions; prose "12 clients need attention." | `degraded` (numeral). The facts + "They need attention." combination is `passed`. |
| §5 | "Health rose from 38 to 61" | `degraded` |
| §5 | "Health fell from 61 to 38" | Stated only as the `health_score_change` fact → `passed` |
| §5 | Prose with August / this month / last month / Q3 / year to date | `degraded` |
| §5 | "That is its latest score" after the Jul fact | `passed` (FAIL) |
| §6 | Swap attempt: 8 critical / 3 open with reversed ids | Never renders 3 critical / 8 open. PASS. This safety does not rest on clause splitting. |
| §7 | twenty percent, one and a half months, doubled, halved, a dozen, a couple, a single, both, none, Roman III, Arabic-Indic digits | All `degraded` |
| §8 | Titles "Issue 8" / "3" | Never facts. "Issue 8 is open.", `“3”`, "“8” critical alerts" and "Issue eight" in prose are all `degraded`. PASS. |
| §9 | "Revenue declined 3%" and "Runway is 8 months" | `degraded`. The valid fact does not rescue the invalid prose (`degraded`, only the valid fact kept). PASS. |
| §10 | "Cash pressure is increasing" | kept |
| §10 | "…by one third", "doubled", "by a third", "by half", "trebled", "threefold" | `degraded`. PASS. |
| §11 | Badge | See §5 below |
| §12 | Forged, foreign, other-organisation fact | `degraded` |
| §12 | Wrong period or wrong metric fact | Can only render its own period and metric |
| §13 | Full end-to-end turn | authorised scope → digest → recording fake model → fact refs → server resolution → render → grounding → stored turn → `/portfolio/analyst`. Done for 4 turns, rendered badges: `passed` → Grounded, `degraded` → Partly grounded, `not_applicable` → No figures. |

### 4.5 Honest prose (L-C re-measured)

- 38 realistic honest adviser sentences.
- 33 were kept, including "Several actions are overdue.", "Cash pressure is increasing.", "Client Y requires attention.", "Beta Ltd is steady." and "Health at Alpha Ltd has deteriorated.".
- 5 were removed:
  - "A few clients need a call this week."
  - "Nothing else stands out."
  - "All other clients look stable."
  - "Both Alpha Ltd and Beta Ltd have overdue actions." (true)
  - "Beta Ltd has a single overdue action to chase." (false: 2)
- So 4 of 37 honest sentences were removed, about 11%. The analyst stays useful. **Honest prose: PASS, with the 11% false-positive rate noted.**

## 5. Grounding badge

- `analyst/page.tsx:10-15,45,52` maps the stored `grounding_status`: `passed` → Grounded, `degraded` → Partly grounded, `not_applicable` → No figures, `failed`/null → Not answered.
- The status is written only by `api_server.portfolio_ai_finish_turn` (service role; `proacl` excludes `authenticated` and `anon`).
- My direct attempts as the employee failed with `42501`: insert, update and delete on `portfolio_ai_turns`, and calls to `api_server.begin` / `finish`. The stored status did not change.
- `passed` is stored only when nothing was dropped (`briefing.ts:387`). Every probe with a drop was `degraded`, and the UI showed Partly grounded for the forged-fact turn.
- **Mechanism: PASS.** What the badge promises is overstated (§4.2–4.3).

## 6. AI boundary and stored-turn revocation (HIGH-C)

**Model context** (`probe-db-boundary.log`). An employee assigned A and B; C unassigned.
- System and digest: no "Gamma" name, no C id, no C alert id.
- The user's own question contained the name, which is user-supplied.
- `tools=["submit_briefing"]`, `toolChoice={"type":"tool","name":"submit_briefing"}`.
- The model named `client:3` and cited `alert:99` / `action:77`. Both were dropped, the turn was `degraded`, and the stored answer contains no Gamma name or C id.

**Forged scope** through `beginPortfolioTurn`:

| Attempt | Result |
|---|---|
| [A,C] | PERMISSION_DENIED |
| [C] | PERMISSION_DENIED |
| random id | PERMISSION_DENIED |
| [] | VALIDATION |
| stranger, [A] | PERMISSION_DENIED |
| client, [A] | PERMISSION_DENIED |

**Employee reads of C** through every portfolio RPC, with `[C]` or NULL:
- 0 rows of C each time.
- `portfolio_summary([A,C])` returns A only.
- Direct table reads of C (`alerts`, `actions`, `health_scores`, `organizations`) returned 0 rows.

**Revocation** (`probe-db-boundary2.log`). The turn's scope was {A,B}. Each step was read three ways: a fresh context, a stale in-memory context, and a direct PostgREST read by id.

| Step | fresh | stale | direct | stale-context view |
|---|---|---|---|---|
| baseline | 1 | 1 | 1 | B high alerts 1 |
| B revoked | 0 | 0 | 0 | B counts 0, B alert rows 0 |
| B reassigned | 1 | 1 | 1 | — |
| A `ends_at` in the past | 0 | 0 | 0 | — |

- Revocation takes effect without re-login, because the database derives scope on every read.

**Other readers of the turn:**
- 0 rows for: the owner (not the author), a client of A, a stranger, a super admin at aal1, the employee at aal1, and a forged random uid.
- 1 row for a super admin at aal2 (the governance read, by design).

**Result: PASS.**

## 7. Zero-assignment, client, stranger, aal1, mixed membership

| Caller | Result |
|---|---|
| Employee with 0 assignments, aal2 | empty context; clients=0, alerts 0/0, actions 0/0 |
| Same employee, aal1 | NOT_FOUND |
| Client of A | NOT_FOUND |
| Stranger | NOT_FOUND |
| Super admin, aal1 | NOT_FOUND (also at 1,053 organisations) |
| Client in A and owner of M2 | resolver gives `[M2:owner]` only; direct `portfolio_summary([A,M2])` → `["M2"]`; `standing_alerts([A])` → 0 rows |
| Client-only, NULL-scope detail reads | 0 rows |

- **UI.** The client of A got 404 on `/portfolio`, `/alerts`, `/actions`, `/analyst`, `/clients/A` (their own organisation) and `/clients/B`, with no B name in the body. Anonymous requests are redirected to `/sign-in?next=…`.
- **Empty state.** `page.tsx:16-25` shows it; `analyst/page.tsx:35-37` hides the form.
- The zero-assignment state was not driven in a browser: an employee session needs TOTP.

**Result: PASS.**

## 8. HIGH-A and HIGH-B through the new transport (`probe-db-scale.log`)

**HIGH-A setup:**
- P: 700 critical alerts (140 of them acknowledged) and 1,100 high-priority overdue actions.
- Q: 4 critical alerts, 1 high alert, 3 overdue actions and 2 in progress.
- R: unauthorised, with 300 critical alerts and 400 actions.

**HIGH-A results:**
- Portfolio: critical 704, standing 705, open 1,105, overdue 1,103. These match SQL truth.
- R is not in the view.
- Q's attention reasons: "4 critical alerts; 3 overdue actions; 1 high alert".
- Alert list 500/705 with `truncated=true`; the note reads "Showing the first 500 of …". Action lists 500/1,105 and 500/1,103.
- Q's client page: 5/5 alerts.
- The digest carries Q's fact ("has 4 standing critical alerts") but 0 of Q's alert detail rows (L-D persists).
- 3 POSTs, 153 ms.
- **PASS.**

**HIGH-B:**
- 45 organisations × 24 complete scored months, each with a distinct latest score (20+i) and previous score (95−i).
- 0 "not yet scored", 0 wrong latest values, 0 wrong previous values.
- 3 requests.
- **PASS.**

## 9. F-5 / L-6: large portfolios

**Super admin, 1,053 organisations on the platform:**
- Resolver: 2 POSTs to `my_organizations`, all 1,053 returned, 41 ms.
- `loadPortfolio`: 4 POSTs (summary ×2, recent feeds ×2), 407 ms.
- Counts: bulk open 325 = truth 325; overdue 143 = 143; portfolio open 1,830 = SQL 1,830.
- Every action lens: 1 POST each, capped 500, correct totals.
- Alerts: 500/1,005 in 1 POST.
- A client page for organisation #995: 6 POSTs.
- `askAdviser`: status `passed`, a digest of 1,053 clients and 5,409 facts, 8 requests, 626 ms.
- aal1: NotFound.

**Employee at k assignments.** Every count matched SQL truth. No GET was issued, and there was no per-organisation request.

| k | open (= truth) | overdue (= truth) | `loadPortfolio` | `askAdviser` |
|---|---|---|---|---|
| 1 | 0 | 0 | 3 POSTs | 7 requests |
| 10 | 3 | 1 | 3 POSTs | 7 requests |
| 201 | 65 | 29 | 3 POSTs | 7 requests |
| 250 | 82 | 36 | 3 POSTs | 7 requests |
| 1,005 | 325 | 143 | 4 POSTs | 8 requests |

**The request body cannot widen scope:**
- An employee with 1 assignment sent 1,005 ids: summary 1 row; 0 action rows from other organisations.
- Employee at aal1, NULL scope: 0 rows.
- Owner, client, random id and anon cases are also covered by the green `portfolio-transport` suite.

**Definer hygiene and grants** (`probe-catalog.log`):
- `app.portfolio_scope`, `app.adviser_org_ids`, `api.portfolio_summary` and the four detail reads are all SECURITY DEFINER with `search_path=""`, owned by `motion_definer`.
- `motion_definer` has `rolbypassrls = f`.
- Execute is granted to `authenticated` only; `anon` and `public` have none.
- Each function reads only rows `where organization_id in (select app.portfolio_scope(p_orgs))` (migration lines 67, 82, 95, 125, 143, 163, 187).
- The lens predicates match `src/modules/actions`:
  - `OPEN_STATUSES = open, in_progress`;
  - overdue: `due < today`;
  - due soon: `today..today+DUE_SOON_DAYS(7)`, with the window passed in;
  - high: `critical`/`high`;
  - mine: `owner = uid`.
  - The SQL lists are hard-coded duplicates, so any future drift would need a code change in both places. There is no drift today.

**Result: F-5 PASS, L-6 closed.**

## 10. Financial truth, evidence, Phase 13/14

- Phase 15 computes nothing monetary. The counts are integer projections; health comes from `health_scores`.
- The sweep checked 100 with 0 mismatches. Every Phase 14 and evidence suite was green (§3).
- **Phase 13:**
  - `banking` 20/20 and journey-13 passed.
  - Transactions page overflow: **233 px at 320, 178 px at 375, 0 at 768**. This is identical to the previous audit's measurement, so not worsened. `/money/banking` and `/home` are 0.
- **Evidence:** Phase 15 adds no evidence store. Citations resolve to the organisation's own alert and action pages (`hrefs`), and foreign citations are dropped (§6).
- **PASS.**

## 11. Security / RLS

- `portfolio_ai_turns` has RLS enabled and forced. Its select policy is `app.is_super_admin() OR (user_id = app.uid() AND scope_organization_ids <@ ARRAY(SELECT app.adviser_org_ids()))`.
- Writes go only through the `api_server` functions, which are granted to `service_role` only.
- No public table lacks forced RLS (`NOFORCE|0`).
- **LOW (hygiene, pre-existing).** `anon` holds `xtm` (REFERENCES, TRIGGER, MAINTAIN) on `portfolio_ai_turns`, as on 10 Phase 11–14 tables. It holds no data privilege and none of these is reachable through PostgREST. It dates from `20260924000001`, not this commit.
- **PASS.**

## 12. Mobile and accessibility (`probe-ui.log`, production build)

**Setup:** an owner of 2 organisations (A with a ~90-character name, 620 alerts, 3 actions; B with 30 overdue actions) and 4 turns stored through `askAdviser`.

**Overflow:** 0 px on every route at every width (320, 375, 768, 1440), except `/portfolio/clients/A`: **408 px at 320 and 353 px at 375** (L-E, unchanged cause). The cause is the "Open {name}" button in `PageHeader`'s `shrink-0` action slot (`src/components/ui/surfaces.tsx:28`). The larger numbers than last audit come from a longer name.

**Accessibility:**
- axe (tags wcag2a/aa, 21a/aa, 22aa, best-practice) found 0 violations, except `empty-table-header` (minor, best-practice) on `/portfolio` `th:nth-child(7)` at 768 and 1440 (L-F).
- 1 h1 per page; no skipped heading levels.
- Keyboard order on the analyst: navigation → labelled textarea → Ask → answer links. Every stop has a visible focus indicator, except the `BODY` wrap-around.

**Mobile: FAIL (LOW, L-E). Accessibility: PASS.**

## 13. Performance architecture

- There is no N+1. The request count grows with pages of 1,000, not with organisations (§9).
- Local timings are single measurements, not a benchmark. No latency benchmark was performed. The 83 ms quoted in the docs is treated only as one local run; I measured 153–407 ms here.
- **Finding (LOW, L-H: digest size).** The analyst digest grows linearly with clients (`probe-digest-size.txt`, character count ÷ 4):

| Clients | Characters | Rough tokens |
|---|---|---|
| 10 | 24.6 k | about 6 k |
| 201 | 464 k | about 116 k |
| 1,005 | 2.32 M | about 580 k |

  - This is not bounded or documented.
  - For a large portfolio a real model call would be very costly or exceed the context window. A failure would end as `failed`, so the behaviour is fail-closed; it is unmeasured without a key.
- **L-G persists.** There is no daily quota. The throttle is 10 per minute (I hit `QuotaExceeded` on the 11th turn in a minute).
- **Performance: FINDINGS.**

## 14. Previous LOWs

| Item | Status |
|---|---|
| L-A (quoted title that is a figure) | Closed: numerals in prose are always removed. |
| L-B | Closed ("20%-plus", "3 per-cent" are removed). |
| L-C | About 11% of honest sentences removed (§4.5). |
| L-D | Persists (Q had 0 detail rows in the digest). |
| L-E | Persists (§12). |
| L-F | Persists. |
| L-G | Persists. |
| L-4, L-7 | Unchanged by this commit (no attention or tenancy-status code changed besides paging). |
| TOTP employee journey | Still not driven in a browser. |
| No client-list pagination | Still true; the page renders all rows. |
| No last-data-date | Still true. |
| Previous-scored-month trend semantics | Now surfaces through F-2 prose combinations. |
| Acknowledged alerts in attention | Counted consistently (140 acknowledged included). |

None is worse than documented, except that the digest size is unbounded (L-H).

## 15. Documentation

- `docs/PHASE_15_FINAL_RELEASE_AUDIT.md` is byte-identical to the original record (`diff` against the prior scratchpad copy). The only difference is the appended archival note. **Faithful.**
- ADR-115 is marked "Superseded by ADR-116" and kept; not deleted.
- ADR-117, DATABASE_ARCHITECTURE §14.3, and the transport, paging, caps and scope text are accurate.
- The "no live Claude validation" and "no latency benchmark" statements are present.
- **Inaccurate:**
  - ADR-116 §2 and Consequences, `PHASE_15_IMPLEMENTATION.md §8` and its limitations, `UX_ARCHITECTURE.md:389`, and `ROUTE_ARCHITECTURE.md:174` make the claims listed in §4.3; each is false.
  - The eval claims to cover "each of the final audit's F-1…F-4 sentences" but uses a modified F-4 sentence (`portfolio-eval.test.ts:228`).
  - `supabase/tests/14_portfolio.test.sql` comments that the reads run "under the caller's own RLS (SECURITY INVOKER)"; they are SECURITY DEFINER.
  - `ROUTE_ARCHITECTURE.md:157` gives the empty-state copy as "No client organizations assigned yet"; the page says "You haven't been assigned to any organisations yet." (minor).
- **Documentation: FINDINGS.**

## 16. Scope control

- The only matches for funding readiness, funding score, funding report or "phase 16" in `src`, `supabase`, `e2e`, `test` and `scripts` are a pre-existing comment in `health/domain/config.ts:31`.
- There is no Phase 16 table, route, workflow or AI.
- **NOT STARTED.**

## 17. What could not be verified

- **Live Claude behaviour.** How often a real model would write the §4.2–4.3 shapes is unmeasured. The findings rest on the server storing them as `passed` and the UI showing Grounded.
- **The employee browser session** (it needs TOTP).
- **The hosted gateway's limits.** POST bodies at 1,005 ids work locally; this was not measured on the hosted gateway.

## 18. Findings

### MEDIUM — blocking

- **F-1 (reopened).** A text statement placed after a facts statement re-qualifies the server's figure, and the result is stored `passed` and shown under Grounded.
  - Where: `briefing.ts:318-341` (parts joined into one paragraph), `analyst/page.tsx:61,75,96`.
  - Reproduction: "…has 3 open actions. They are overdue." (1 overdue); "The portfolio has 12 clients. They need attention." (3).
- **F-2 (reopened).** The same mechanism re-dates or reverses a health fact.
  - Reproduction: "…for Jul 2026 was 61. That is its latest score." (latest is 38); "…fell 23 points… Its health has improved."
- **F-4 (reopened).** The prose rule misses many quantity forms, including the previous audit's verbatim sentence "Alpha Ltd does not have any critical alerts.". It also misses "Only one of…", "Not one of…", negated counts, misspellings, joined and obfuscated number words (soft hyphen, zero-width characters), lowercase Roman numerals, Latin-script foreign numerals, comparatives and superlatives.
  - Where: `free-text.ts:29-85,66,75`; `claims.ts:74-82`.
  - Each passed end to end or in the pure probe.

### LOW

- L-C: about 11% of honest sentences are removed.
- L-D: the digest's per-client detail can be empty for a client (counts correct).
- L-E: `/portfolio/clients/[orgId]` overflows with a long name: 408 px at 320, 353 px at 375.
- L-F: axe `empty-table-header` (minor, best-practice).
- L-G: no daily quota; the only limit is 10 per minute.
- L-H: the digest size is unbounded (about 116 k tokens at 201 clients).
- Name laundering: a client literally named like a number word ("Twelve", "Both", "None").
- `anon` holds xtm privileges on `portfolio_ai_turns` (pre-existing pattern, no data access).
- The documentation inaccuracies in §15.

## Closed

- M-1 (digits and number words of the previous forms), L-2, L-A, L-B, L-6.
- F-3 and F-5.
- HIGH-A, HIGH-B, HIGH-C.

## Final verdict: **NOT READY FOR PHASE 16**

---

> **Archival note — added with ADR-118, not part of the audit.** This record was copied verbatim on 2026-09-29 from the auditor's session scratchpad, where it would not have survived the session; nothing above was edited. The probe files and logs it names lived in that scratchpad and are not in the repository. Its findings F-1, F-2 and F-4, the altered test sentence, and the documentation findings are addressed by ADR-118; whether they are closed is for the next independent audit to decide.
