# Phase 15 — Final Independent Release Audit 3 (Adviser / CFO Command Centre)

- **Audited commit:** `74050d1c3374083d470f5f3ab9cf3e32a1c9f938`, "Phase 15 final structured briefing closure (ADR-118)".
- **Baseline:** `48f2c4f` (audited NOT READY in `docs/PHASE_15_FINAL_RELEASE_AUDIT_2.md`: F-1, F-2, F-4).
- **Date:** 2026-09-29.
- **Method.** Memory notes, ADRs, commit messages and implementation docs were treated as claims. Every result below comes from the repository at `74050d1`, a local database reset with `supabase db reset`, and probes I wrote myself. The model was always a fake or recording transport; no live Claude model was called (there is no `ANTHROPIC_API_KEY`).
- **Repository.** Read-only. I modified no file and made no commit or push. Phase 16 was not started. `git status --porcelain` was empty before and after the audit. The repository's own gate commands (`next build`, Playwright) wrote their usual git-ignored output (`.next/`, `test-results/`).
- **Artefacts** (all in this folder):
  - Probes: `probes/pure-contract.test.ts`, `probes/db-boundary.test.ts`, `probes/db-scale.test.ts`, `uiprobe/ui-turns.test.ts`, `pw/audit.pw.ts`.
  - Configs: `vitest.pure.config.ts`, `vitest.db.config.ts`, `vitest.ui.config.ts`, `vitest.scenarios.config.ts`, `pw.config.ts`.
  - Outputs: `probe-contract-results.txt`, `probe-db-boundary.log`, `probe-db-scale.log`, `probe-ui.log`.
  - Gate logs: `gates.sh`, `gates-summary.log`, `g-*.log`, `integration.json`, `e2e.json`. The journey-15 trace is extracted in `j15trace/`.
  - `node_modules` is a symlink to the repository's, so the configs resolve.

## Verdict: **READY FOR PHASE 16**

ADR-118 removes the channel through which F-1, F-2 and F-4 were reproduced:
- The model's only output is the forced `submit_briefing` tool, and each block is a **reference**.
- The server writes every sentence from its own facts, attention reasons, source records and a fixed phrase library.
- There is no text field the server renders.

I tested this at three levels:

| Level | What I ran | Result |
|---|---|---|
| Pure | 2,880 adversarial payload × channel × location combinations | 0 leaks. Every output was composed only of server pieces (an independent oracle). |
| End to end | 20 turns through `askAdviser` with a fake model, into `portfolio_ai_turns` | Every stored text composed only of server pieces |
| Production UI | 5 turns rendered by the production build | `passed` → **Grounded**; `degraded` → **Partly grounded**; `not_applicable` → **No figures**; `failed` → **Not answered** |

**Other results:**
- The F-5 transport, HIGH-A/B/C, scope, revocation, isolation, financial truth and Phase 13/14 regressions all reproduce as passing.
- No CRITICAL, HIGH or MEDIUM finding remains.
- The remaining findings are LOW (§17). The most important is **N-1**: four of the nine library phrases carry no data condition. So `not_in_portfolio` ("The organisation asked about is not in this portfolio.") can be stored `passed` beside facts about a client that *is* in the portfolio. It is non-quantitative, server-worded and contradicted on the same card, so I classify it LOW. The documents overstate what the phrase conditions check.

---

## 1. Repository state

| Check | Result |
|---|---|
| HEAD | `74050d1c3374083d470f5f3ab9cf3e32a1c9f938` |
| `main` / `origin/main` after `git fetch` | both `74050d1…` |
| Working tree | clean before and after |
| Commits `48f2c4f..HEAD` | exactly one: `74050d1` |

`git diff --stat 48f2c4f HEAD`: 17 files, +1196/−529. Source changes:
- `portfolio/domain/briefing.ts` (+275/−…)
- `portfolio/domain/free-text.ts` (deleted)
- `portfolio/services/adviser.ts`
- `portfolio/index.ts`

**No migration changed.** The rest is tests, pgTAP (a comment only), e2e (a prompt version string only) and documentation.

Across Phase 15 (`f5334be..74050d1`), no file changed under `src/modules/{ai,alerts,financial-engine,banking,commercial,health,actions,evidence}` or `src/components/ui`.

**`docs/PHASE_15_FINAL_RELEASE_AUDIT_2.md`** is a faithful copy of the original record:
- `diff` against `final-audit-2/PHASE_15_FINAL_RELEASE_AUDIT_2.md` shows only an appended "Archival note" (lines 515–518).
- `docs/PHASE_15_FINAL_RELEASE_AUDIT.md` gains only a one-paragraph "Later note".
- ADR-116 is marked superseded, and it says its claims were false. It is kept, not deleted.

## 2. Environment

- macOS, under heavy memory pressure (about 4,000 free 16 KB pages throughout).
- Only the `supabase_*_MOTION` containers were running; no other project's stack was running.
- Port 3100 was free before the runs.
- The local stack had **transient infrastructure failures** under load:
  - GoTrue returned `504 Gateway Timeout` to one password sign-in (journey-15, §3).
  - One `fetch failed` occurred in a scenarios fixture (§3).
  - Containers stayed healthy. Retries passed.

## 3. Clean-database gates (sequential, `gates.sh`)

| Gate | Result |
|---|---|
| db:reset #1 | rc 0 |
| typecheck | rc 0 |
| lint | rc 0, no output |
| unit | **74 files, 2,042 / 2,042 passed** |
| AI eval | **2 files, 253 / 253 passed** (`portfolio-eval` 80, `ai-eval` 173) |
| integration (full run) | 51 files, 757 tests: **707 passed, 1 failed, 49 skipped**; 1,720 s; rc 1 (details below) |
| pgTAP | **17 files, 1,068 tests, "All tests successful"** |
| schema drift | "55 tables, 125 api functions, RLS forced everywhere, no write grants, no reachable server functions" |
| build | rc 0 |
| db:reset #2 | rc 0 |
| Playwright | **68 passed, 1 failed, 1 skipped** (13.6 min); rc 1 (details below) |

**Integration: the full-run failure and skips, and their independent runs:**
- **`scenarios.test.ts`: 49 skipped.** The `beforeAll` exceeded the integration project's 60 s `hookTimeout` ("Hook timed out in 60000ms", `scenarios.test.ts:130`). This is the resource limit the brief predicts.
  - I ran it on its own through `vitest.scenarios.config.ts`. That config mirrors the integration project: same aliases, same setup file, `testTimeout` 30 s. Only `hookTimeout` differs: 600 s.
  - Attempt 1: `beforeAll` failed with `fixture org NoCat failed: TypeError: fetch failed` (a transient gateway failure; the containers were healthy immediately afterwards).
  - Attempt 2: **49 / 49 passed** (129.7 s).
- **`ai-eval-record.test.ts`: 1 failed**, with the known nondeterministic signature: `get_alerts #16 output shape: expected [ Array(26) ] to deeply equal [ Array(25) ]`.
  - Re-run alone (`--project integration`, no `RECORD_AI_EVAL`, so nothing is written): **1 / 1 passed**.
  - The test was not modified. The failure is the array-length signature only, from shared database state. It is not a Phase 15 regression.
- **Every other file passed.**
  - `portfolio` 17/17, `portfolio-scale` 7/7, `portfolio-ai` 17/17, `portfolio-transport` 8/8.
  - The transport suite logged "[F-5] super admin: 1005 organisations, 6 requests, 568 ms (local, not a benchmark)".
  - The sweep printed **"SWEEP checked 100, mismatches 0"**.

| Suite | Passed |
|---|---|
| evidence-invoice-basis | 5/5 |
| evidence-provenance | 14/14 |
| evidence-drawer | 33/33 |
| evidence-void-invoice | 5/5 |
| evidence-merged-counterparty | 4/4 |
| evidence-documents | 6/6 |
| evidence-reconciliation-sweep | 1/1 |
| banking | 20/20 |
| bank-commercial-population | 12/12 |
| ledger-commercial-population | 10/10 |
| commercial | 11/11 |
| engine-invoice-golden | 17/17 |
| engine-run | 16/16 |
| engine-end-to-end | 11/11 |
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

- **Every integration test actually ran: 757 of 757.**
  - 708 ran in the full run.
  - The 49 scenarios tests ran separately and passed.
  - On their latest run, 757 / 757 pass.

**Playwright:**
- **`journey-15-command-centre.spec.ts` failed** at its last step, `signIn(client)` (`fixtures.ts:84`, `waitForURL` 30 s).
  - The trace (`j15trace/`) shows `POST :54421/auth/v1/token?grant_type=password → 504 Gateway Timeout`. That is local GoTrue under load.
  - Every Phase 15 assertion in the journey before that step had passed. These include the *Grounded* and *Partly grounded* badges (line 110) and 0 px overflow at 375 and 768 px.
  - Re-run alone (`--project=journeys`): **1 / 1 passed** (1.0 min).
- **The skip** is the conditional one at `evidence-provenance.spec.ts:54`.
- Passing specs include journey-13 (banking), journey-14 (commercial), the axe sweep on all four Command Centre pages, and the 320/375/768/1440 no-sideways-scroll sweep.

## 4. The structured contract, as built (brief §3)

**Model output.** One forced tool, `submit_briefing` (`adviser.ts:82-110`, `toolChoice {type:'tool'}`). Its input is validated by `SubmissionSchema` (`briefing.ts:256-271`):
- `mode` is `answer` or `refusal`.
- `headline` holds up to 4 blocks; `clients` up to 25 `{ref, blocks ≤10, because ≤12}`; `notes` up to 6 `{blocks ≤6}`; `limitations` up to 6 strings.
- A block is `{kind:string}` with any other keys, so that the grounder, not the schema, judges each block.

**Rendering and validation.** `groundBriefing` (`briefing.ts:359-485`) reads each block strictly by kind (`BLOCK_FIELDS`, `:275-280`):

| Block | What the server does |
|---|---|
| `facts` | Resolves ids against a `Map` of digest facts. Renders `renderFacts` (`:318-324`): each fact's own `statement`, or one shared sentence of `phrase`s for counts about one client. |
| `attention` | Resolves ids against a `Map` of MOTION's reasons. Renders "Name: label; label." |
| `source` | Resolves `alert:N` / `action:N`. Renders `Name: alert “title” (severity, status).` |
| `phrase` | Looks the id up in `PHRASES` and checks `holds(...)`. |

- Any other kind or extra field is recorded and marks the turn `degraded`.
- Every rendered word comes from the digest (built server-side from the caller's authorised view) or from server string templates.
- Text blocks in the model response are never read (`adviser.ts:154`).
- The model's `tool_use` input is never stored raw. `persistable` stores the rendered briefing, the client names, and the cited refs' titles.

**What the model is shown** (`probe-db-boundary.log`, test 2):
- `system[0]`: rules, 2,381 characters.
- `system[1]`: the digest inside `untrustedJson` (every value wrapped in `<data>`).
- Each fact appears as `{id, type, period, says}`.
- The phrases appear with a `{client}` placeholder.
- Each client carries its ref, id, name, status, health (band, month, trend, previous month), `attention[{id, kind, says}]`, `attentionRank`, and up to 10 alerts and 10 actions (ref, id, severity/priority, status, title, standing_since or due).
- The user question is wrapped in `<user_question>`.
- `tools = ["submit_briefing"]`.

### 4.1 The adversarial matrix (`probes/pure-contract.test.ts`, `probe-contract-results.txt`)

Every submission was parsed exactly as `askAdviser` parses it (`SubmissionSchema.safeParse`, then `groundBriefing`). An independent oracle checked that every output string is a concatenation of pieces built from the digest:
- fact statements;
- per-client shared count sentences;
- attention sentences;
- source sentences;
- phrase sentences.

**The matrix:**
- **45 payloads.** These include:
  - all of audit 2's attachment and prose sentences, verbatim;
  - "12 clients need attention.";
  - "Health rose from 38 to 61." and August / this month / last month / Q3 / year to date;
  - "Revenue declined 3%." and "Runway is 8 months.";
  - twenty percent, one and a half months, doubled, halved, a dozen, a couple, a single, both, none;
  - III and iii;
  - ٥ (Arabic-Indic);
  - "does not have any", "Only one of", twentyfive, soft hyphen, zero-width space, vingt, zwei, quartet, comparatives and superlatives;
  - "Cash pressure is increasing" (and "…by one third", "doubled");
  - "Issue 8 is open.", "“3” actions are overdue.".
- **28 channels.** Each payload was sent as:
  - a text block;
  - an extra `text`, `says`, `statement`, `value` or `metric` on a facts block;
  - a fact id, attention id, source ref, phrase id or phrase ref;
  - a nested object inside `facts`;
  - a string where an array is expected;
  - the block kind itself (as a string, or inside an array);
  - a bare string or array as a block;
  - a limitation;
  - a refusal headline, or a refusal carrying facts;
  - a client-level `summary`, a note-level `text`, or a top-level `answer`/`commentary`;
  - the client ref, or a `because` ref;
  - the headline as a string.
- **Locations:** headline, client summary, note.

**Result: 2,880 submissions, 0 payload leaks, 0 outputs that are not server pieces.** Outcomes by channel:
- Most channels were `degraded`.
- Malformed shapes were `failed(schema)`, so nothing was rendered.
- Refusals were `not_applicable`.
- **Container-level extra fields** (client `summary`, note `text`, top-level `answer`) are silently stripped by zod and the turn stays **`passed`**. Nothing of them is rendered (see N-3).

**Odd shapes and ids** (54 cases):

| Input | Outcome |
|---|---|
| Duplicate ids; 10,000 duplicates | Rendered once, `passed` |
| Every fact id in one block | Server sentences only; `degraded` for the ids from other clients |
| Whitespace, upper-case, NBSP, zero-width and numeric id variants | Dropped, `degraded` |
| Another client's fact, attention reason or source in a summary | Dropped, `degraded` |
| `client:99`, forged attention kind, `alert:99` | Dropped, `degraded` |
| Nonexistent reason (`organisation_suspended` for an active client) | Dropped, `degraded` |
| Phrase conditions against contradicting data: `look_first` on a non-first client, `client_clear` on a flagged client, `needs_attention` on a clear client, `health_unavailable` on a scored client, `portfolio_clear` when a client needs attention | Each dropped, `degraded` |
| Phrase with another client's ref; client phrase with no ref in the headline | Dropped |
| Refusal carrying facts, a client phrase, or a failing portfolio phrase | Headline = `outside_scope` sentence, `not_applicable` |
| Limitation that is a client phrase, a failing phrase or free text | Dropped, `degraded` |
| Limitation that is a number | `failed(schema)` |
| More than 4 headline blocks or more than 25 clients | `failed(schema)` |
| Valid id plus a non-string element (number, object or null) in `facts` | Non-string silently ignored, `passed` (N-3) |
| Phrase with a numeric or object `ref` inside a summary | Falls back to the summary's own client, `passed` (N-3) |
| Duplicate client entries | Both rendered, `passed` |
| **Block `kind` = `constructor`, `__proto__`, `toString`, `hasOwnProperty`** | `TypeError: fields.includes is not a function` (N-2) |
| **Phrase id = `constructor`, `toString`, `__proto__`, `valueOf`** (with a client) | `TypeError: phrase.holds is not a function` (N-2) |

### 4.2 Tenant- and model-controlled strings in the rendered briefing

No model-controlled string reaches the briefing. Tenant-controlled strings do, always in their own slot:

| String | Where it appears | Who can write it |
|---|---|---|
| Organisation names | In every sentence | Owners/admins (`settings.manage`) and super admins |
| Alert titles | Quoted, as sources | Written by the alert templates (`alerts/domain/templates.ts`). Some interpolate imported names: category, account, customer, supplier, payment signature. |
| Action titles | Quoted, as sources | Employee, owner and admin roles (`actions.create`); not clients |
| Attention labels | As reasons | Server-computed from counts (`attention.ts:61-90`) |

Reproductions:
- A client named "Twelve clients need attention Ltd" gives "Nothing at Twelve clients need attention Ltd needs attention. Twelve clients need attention Ltd has 0 open actions.", `passed`.
- Alert "Revenue fell 40%" and action "Runway is 8 months" give `Alpha Ltd: alert “Revenue fell 40%” (critical, open).` and `Alpha Ltd: action “Runway is 8 months” (high priority).`, `passed`.

**Severity: LOW** (N-4):
- A title is always quoted and labelled as an alert or action title, and it is the same text the organisation's own alert and action pages show.
- A name is always in the subject position.
- Neither ever becomes a fact, a count or a phrase condition.
- ADR-118 §1 documents that "a title is tenant text shown as a title; it is never a fact".
- A reader could still misread a quoted title as MOTION's statement.

## 5. F-1 — count versus meaning (brief §4): **PASS**

The digest's `portfolio/open_actions` = 12. The only sentence the server can write with that 12 is "12 actions are open across the portfolio."
- **Pure probe:** `{facts:['portfolio/open_actions'], metric:'needing_attention', value:'12', text:'12 clients need attention'}` plus `portfolio/needing_attention` rendered "12 actions are open across the portfolio. 1 client needs attention.". Status `degraded`; removed: "metric, value, text are not part of a facts block".
- **End to end** (owner of 3 clients, 12 open actions): stored headline "12 actions are open across the portfolio.", `degraded`.
- **Audit 2's F-1 attachments:**
  - "…has 3 open actions." then "They are overdue." stored "AU3 Alpha … has 3 open actions.", `degraded`.
  - "They have been resolved." and "They are not critical." are never rendered (pure matrix).

## 6. F-2 — period and direction (brief §5): **PASS**

- **Every ordering and combination** of Alpha's three health facts, in one block or in separate blocks, gives 15 distinct renderings. None contains "rose", "improv", "latest" or "recover", and none re-dates a value (listed in `probe-contract-results.txt`).
- **"Health rose from 38 to 61."** plus the August / this month / last month / Q3 / year-to-date sentences: stored only as the server's attention sentence, `degraded`.
- **"Health fell from 61 to 38"** is only ever the `health_score_change` fact: "…'s health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026.", stored `passed`.
- **Audit 2's sentences, verbatim, end to end:**

| Submission | Stored | Status |
|---|---|---|
| Jul fact + "That is its latest score." | "…'s health score for Jul 2026 was 61." | `degraded` |
| change fact + "Its health has improved." | the fall sentence only | `degraded` |
| open-actions fact + "They are overdue." | "…has 3 open actions." | `degraded` |

- **Direction and period** come from `buildDigest` (`briefing.ts:174-181`): the direction from the sign of the delta, and the periods from the health row's own labels.

## 7. F-3 — multiple figures (brief §6): **PASS**

- All 325 orderings of Alpha's five count facts in one block were rendered and checked. Every value stays on its own noun (8 critical, 3 open, 1 overdue, 8 standing, 0 high), and 3 critical / 8 open never appears.
- **End to end:** reversed ids plus `{facts:[critical], value:'3'}` plus the swap sentence as text stored "…has 3 open actions and 8 standing critical alerts. …has 8 standing critical alerts.", `degraded`.
- **The mechanism is not clause splitting.** Each fact carries its own `phrase`, and `renderFacts` joins phrases (`briefing.ts:321-322`).

## 8. F-4 — number words (brief §7): **PASS**

The architecture, not a vocabulary, prevents a model-authored quantity:
- `free-text.ts` is deleted (`git diff` shows it removed).
- `grep` finds no parser, dictionary or Unicode normalisation in the briefing path.
- A text block is never rendered.

Every form the brief lists, and every form audit 2 found passing, was submitted through every channel. None reached the briefing (§4.1). End to end, 22 number-word sentences in four notes were all discarded, `degraded`.

**The exact sentence "Alpha Ltd does not have any critical alerts." is tested verbatim** in `test/eval/portfolio-eval.test.ts`:
- line 94 (in `AUDIT_1`, alone and after a fact);
- line 107 (attached after `open_actions`);
- lines 127–131 (a dedicated test);
- it is no longer the altered '...none.' form.

## 9. Titles and claim-level cases (brief §8, §9): **PASS**

- **Titles "Issue 8" and "3":**
  - No fact statement contains a title (pure probe §0).
  - As sources they render `…: alert “Issue 8” (critical, open).` and `…: action “3” (high priority, overdue by 45 days).`. The "45 days" is computed by the server from the due date and today.
  - "Issue 8 is open." and "“3” actions are overdue." in any channel are never rendered.
- **Claim level:** with the facts "revenue fell 8% in Sep 2026" and "cash runway … was 3 months":
  - "Revenue declined 3%." and "Runway is 8 months." are not rendered.
  - A `{facts:[runway], value:'8'}` block renders "…was 3 months".
  - The valid facts render and do not rescue the invalid claims (`degraded`).

## 10. Honest prose and usability (brief §10)

- "Cash pressure is increasing.", "…by one third" and "Cash pressure doubled." are not rendered (end to end: notes emptied, `degraded`). Under ADR-118 no model prose is rendered at all.
- **Usability.** A well-behaved answer stored `passed`, verbatim:
  - Headline: "3 clients need attention. Look at AU3 Alpha … first."
  - Client summary: "AU3 Alpha … has 8 standing critical alerts and 3 open actions. AU3 Alpha …'s health score fell 23 points, from 61 in Jul 2026 to 38 in Aug 2026. AU3 Alpha …: 8 critical alerts. AU3 Alpha …: alert “Issue 8” (critical, open). Look at AU3 Alpha … first."
  - Note: "12 actions are open across the portfolio. 2 open actions are overdue across the portfolio."
  - Limitation: the `figures_elsewhere` phrase.
- **What it can answer:**
  - "which clients need attention and why" (attention reasons);
  - "whose health fell" (`health_score_change` facts; health-band reasons);
  - "what to look at first" (`look_first`, true only for MOTION's first-ranked client).
- **What it cannot answer:**
  - "what changed this week": the recent-changes feed is not in the digest, and no recency fact exists;
  - anything financial beyond counts and health.
- The text is repetitive: the client name is in every sentence. It is less fluent than prose but useful. Not a blocker.

## 11. Grounding badge (brief §11): **PASS**

- `analyst/page.tsx:10-15,45,52` maps the stored `grounding_status` to *Grounded*, *Partly grounded*, *No figures* or *Not answered*.
- `'Grounded'` appears nowhere else in `src`. The only client component, `ask-form.tsx`, shows the action message ("Answered." or the failure text) and never a badge.
- `passed` is written only when `removed` is empty (`briefing.ts:482`), through `api_server.portfolio_ai_finish_turn` (service role only).
- The employee's direct attempts (insert, update and delete on `portfolio_ai_turns`; `api_server` begin and finish, including a forged `passed` answer) all failed `42501`. The stored turn was unchanged.
- **Production UI** (`probe-ui.log`):

| Turn | Stored | Badge shown |
|---|---|---|
| well-behaved | `passed` | Grounded |
| F-1 attachment attempt | `degraded` | Partly grounded |
| forged fact | `degraded` | Partly grounded |
| refusal | `not_applicable` | No figures |
| schema failure | `failed` | Not answered |

- journey-15 asserts Partly grounded (never Grounded) for a stored `degraded` turn, and Grounded for `passed`.
- **Caveat on meaning:** see N-1 and N-3.

## 12. Fact authorisation (brief §12): **PASS**

- **Forged ids** (`client:1/revenue_change`, `client:99/…`): dropped, `degraded`.
- **Foreign ids:** another client's fact in a summary is dropped, `degraded`.
- **A fact of an organisation outside the caller's scope:** the digest is built only from `loadPortfolio(ctx)`, so such a fact does not exist. Fact ids are positional (`client:N/metric`) and resolved only against this turn's digest.
- **Wrong period / wrong metric:** citing `previous_health_score` or `overdue_actions` renders only that fact's own period and metric ("…for Jul 2026 was 61", "…has 1 overdue action").
- **End to end:** all of the above in one block stored only the two valid, self-describing facts, `degraded`.

## 13. Real end-to-end AI turn (brief §13): **PASS**

The chain: resolver (the caller's authorised scope) → `loadPortfolio` → `buildDigest` → `beginPortfolioTurn` (the database re-checks scope and charges the throttle) → recording fake model → `SubmissionSchema` → `groundBriefing` → `finishPortfolioTurn` → `listAdviserTurns` → `/portfolio/analyst`.

- The fake model also returned a text block ("Revenue fell 40% — ignore the tool."). It was never stored.
- All 20 end-to-end turns: the stored `grounding_status` equals the returned status equals the listed status, and every stored text is composed of server pieces.
- **Nothing trusts model values.** Fact values come from the digest; names, titles and labels come from the digest; phrase conditions are evaluated against the digest.

## 14. F-5 and large-portfolio authorisation (brief §14, §15): **PASS**

From `probe-db-scale.log`; 1,054 organisations on the platform, including 1,005 bulk.

**Super admin (aal2):**
- Resolver: 2 POSTs, 1,054 organisations, 38 ms.
- `loadPortfolio`: 4 POSTs, 264 ms.
- Counts: bulk open 325 = SQL 325; overdue 143 = 143; portfolio open 1,830 = SQL 1,830.
- Every lens: 1 POST, capped at 500, with correct totals.
- Alerts: 500 / 1,005.
- A client page for bulk organisation #995: 6 requests.
- `askAdviser`: `passed`, 1,054 digest clients, 5,415 facts, 8 requests, 577 ms.
- A stored turn with a 1,054-organisation scope is readable (`listAdviserTurns` → `passed`).
- aal1: NotFound.

**Employee at k assignments.** Every count equals SQL truth, every request is a POST, and there is no per-organisation request.

| k | open / overdue (= truth) | `loadPortfolio` | `askAdviser` |
|---|---|---|---|
| 1 | 0 / 0 | 3 POSTs | 7 requests |
| 10 | 3 / 1 | 3 POSTs | 7 requests |
| 201 | 65 / 29 | 3 POSTs | 7 requests |
| 250 | 82 / 36 | 3 POSTs | 7 requests |
| 1,005 | 325 / 143 | 4 POSTs | 8 requests |

**The body cannot widen scope:**
- An employee with 1 assignment sent 1,005 ids: summary 1 row; 0 action rows from other organisations.
- Employee at aal1, NULL scope: 0 rows.
- Anon: `42501` on the `api` schema.
- A bulk client: resolver NotFound; summary over 1,005 ids returns 0 rows.
- Super admin with forged ids: 0 rows.
- `p_limit` 100,000: 500 rows.
- **Employee 0 assignments** (aal2): empty context, 0 / 0 / 0 (§16).

## 15. HIGH-A, HIGH-B, HIGH-C (brief §16–18): **PASS**

**HIGH-A setup:**
- P: 700 critical alerts (140 acknowledged) and 1,100 overdue high-priority actions.
- Q: 4 critical, 1 high, 3 overdue, 5 open.
- R: unauthorised, 300 alerts and 400 actions.

**HIGH-A results:**
- Portfolio: critical 704, standing 705, open 1,105, overdue 1,103. These match SQL.
- R is not in the view.
- Q's reasons: "4 critical alerts", "3 overdue actions", "1 high alert", although Q has 0 rows in the 500-row alert list.
- Lists: 500 / 705 (`truncated`); actions 500 / 1,105; overdue 500 / 1,103.
- Q's client page: 5 / 5 alerts.
- 3 POSTs, 76 ms.
- The digest carries Q's fact but no Q alert detail (L-D, persists).

**HIGH-B:** 45 organisations × 24 scored months, each with a distinct latest (20+i) and previous (95−i) score. 0 "not yet scored", 0 wrong latest, 0 wrong previous, 3 requests.
- The query (`portfolio_summary`, h CTE) windows `health_current ⋈ health_scores ⋈ fiscal_periods (is_complete)` per organisation and returns the latest two (`rn = 1, 2`).
- It scans each organisation's complete months in SQL but returns at most 2 rows per organisation. There is no app-side all-history load.

**HIGH-C** (`probe-db-boundary.log` test 3; turn scope {A, B}). Each step was read three ways: a fresh context, a stale context, and a direct PostgREST read as the user.

| Step | fresh / stale / direct |
|---|---|
| baseline | 1 / 1 / 1 |
| B revoked | 0 / 0 / 0 (stale context's view of B: counts 0, alert rows 0) |
| B reassigned | 1 / 1 / 1 |
| A `ends_at` in the past | 0 / 0 / 0 |
| A restored | 1 / 1 / 1 |

- **Other readers:** owner (not author) 0, client of A 0, stranger 0, super admin aal1 0, employee aal1 0, zero-assignment employee 0, forged random uid 0, anon `42501`.
- **Super admin aal2: 1** (the documented governance read).
- **Policy:** `app.is_super_admin() OR (user_id = app.uid() AND scope_organization_ids <@ ARRAY(SELECT app.adviser_org_ids()))`.

## 16. Employee, client and zero-assignment access (brief §19–21): **PASS**

**Employee assigned A and B; C unassigned:**
- The model context contains no C name, C id or C alert id.
- The model's `client:3`, `alert:99` and `action:77` were dropped, `degraded`.
- `beginPortfolioTurn` for [A,C], [C] or a random id: PERMISSION_DENIED; [] → VALIDATION.
- Stranger [A] and client [A]: PERMISSION_DENIED.
- Every portfolio RPC with [C] or NULL returned 0 rows of C.
- `portfolio_summary([A,C])` returned A only.
- Direct reads of C's `alerts`, `actions`, `health_scores` and `organizations`: 0 rows.
- The client page check (`ctx.organisations.find`) for C: notFound.
- **Revoke B, with the context unchanged** (no re-login):
  - B's counts become 0, with 0 alert rows and 0 action rows.
  - `askAdviser` with the stale context → PERMISSION_DENIED; the model was never called.
  - A fresh resolver returns [Alpha].

**Client of A:**
- Resolver NotFound. All five portfolio RPCs → 0 rows.
- **UI (production build):** 404 on `/portfolio`, `/portfolio/alerts`, `/portfolio/actions`, `/portfolio/analyst`, `/portfolio/clients/A` (their own organisation) and `/portfolio/clients/B`. No B name appears in the body.
- **Anonymous:** redirected to `/sign-in?next=…`.
- **Mixed** (client in A, owner of M2): resolver `[M2:owner]`; `portfolio_summary([A, M2])` → M2 only.

**Zero-assignment employee:**
- aal2: empty context (not NotFound); 0 clients, 0 / 0 alerts, 0 / 0 actions.
- `askAdviser` with an empty scope → VALIDATION; the model was not called.
- The page shows "You haven't been assigned to any organisations yet." (`page.tsx:16-20`), and the analyst hides the form (`analyst/page.tsx:35-37`).
- aal1: NotFound.
- The employee browser session was not driven (it needs TOTP).

## 17. Findings

### No CRITICAL, HIGH or MEDIUM findings.

### LOW

- **N-1 (new): unconditional phrases can be false under *Grounded*.**
  - `not_in_portfolio`, `outside_scope`, `figures_elsewhere` and `review_evidence` have `holds: () => true` (`briefing.ts:231-235`).
  - Reproduction (pure and end to end): an answer whose headline is `not_in_portfolio` and whose client block is Alpha's `open_actions` fact is stored **`passed`**. The card reads "The organisation asked about is not in this portfolio." above "AU3 Alpha … has 3 open actions.", and it is badged *Grounded*.
  - The server cannot check this phrase, because its truth depends on the free-text question.
  - **Severity LOW:** the phrase is non-quantitative and non-financial, names no organisation, and is contradicted on the same card and by the Command Centre list. Nothing is leaked.
  - **The documents overstate it:**
    - `PHASE_15_IMPLEMENTATION.md §8`: "Each phrase has a condition the server checks against the data";
    - `briefing.ts:221`: "choosing a phrase is choosing a statement the data already supports";
    - ADR-118 §4 and ROUTE/UX: "library phrases whose conditions hold" as the meaning of *Grounded*.
- **N-2 (new): prototype-key ids crash the turn.**
  - A block `kind` or a phrase id equal to an `Object.prototype` key reaches `BLOCK_FIELDS[kind]` / `PHRASES[id]` (plain-object lookups, `briefing.ts:371, 412`) and throws `TypeError`. The keys tested were `constructor`, `__proto__`, `toString`, `hasOwnProperty` and `valueOf`.
  - End to end, the turn is stored `failed` (*Not answered*) and `askAdviser` throws `InternalError`. The UI shows the action's error message.
  - This is fail-closed: nothing is rendered or leaked. But it contradicts "one bad block cannot fail the whole turn" (`briefing.ts:251-254`, `portfolio-briefing-contract.test.ts`).
  - Model-triggered availability only.
- **N-3 (new, precision): some unknown input is ignored without degrading.**
  - Extra fields on a client, a note or the top level (`summary`, `text`, `answer`) are stripped by zod, and the turn stays **`passed`**.
  - The same happens for non-string members of `facts`/`reasons` arrays, and a non-string phrase `ref` inside a summary (which falls back to the summary's own client).
  - None of it is rendered, so "every sentence is the server's" holds.
  - But "Grounded … nothing the model sent was discarded" (ADR-118 §4, `PHASE_15_IMPLEMENTATION.md §8`, `ROUTE_ARCHITECTURE.md` §5.1) is not literally true.
- **N-4: tenant strings appear in the briefing.**
  - Organisation names, and quoted alert and action titles, can carry numeric-looking text (e.g. `alert “Revenue fell 40%”`, or a client named "Twelve clients need attention Ltd"), shown under *Grounded* as a title or name (§4.2).
  - They are never facts. The authors are owners, admins and employees, or imported names.
  - This is audit 2's name-laundering item, now also covering titles.
- **N-5 (new observation): React hydration error.**
  - React error #418 (hydration mismatch, `args[]=HTML`) is thrown in the production build on `/portfolio`, `/portfolio/alerts`, `/portfolio/actions` and `/portfolio/clients/[id]`; it did not occur on `/portfolio/analyst` (journey-15 trace, 13 `pageError` events).
  - No `src/app` or `src/components` file changed since `48f2c4f`, so it predates this commit.
  - No assertion or visible behaviour failed. I did not determine the cause.
- **L-C (superseded):** there is no prose, so no honest prose is filtered. Fluency is reduced (§10).
- **L-D (persists):** a client beyond the 500-row detail lists has correct counts and reasons but no digest detail, so the model cannot cite its alerts (Q: 0 detail rows).
- **L-E (persists): `/portfolio/clients/[orgId]` overflows with a ~90-character name** — 402 px at 320 and 347 px at 375. It is 0 at 768 and 1440, and 0 on every other route and width. The cause is unchanged: the "Open {name}" button in `PageHeader`'s `shrink-0` slot.
  - `PHASE_15_IMPLEMENTATION.md:123` claims 0 overflow "on every Command Centre page".
- **L-F (persists):** axe `empty-table-header` (minor, best-practice) on `/portfolio` `th:nth-child(7)` at 768 and 1440.
- **L-G (persists):** there is no daily quota. The throttle is 10 per minute (the 11th turn → `QUOTA: too many portfolio_ai requests`).
- **L-H (persists, documented): the digest size is unbounded.** Digest JSON size by client count:

| Clients | Characters |
|---|---|
| 1 | 4,081 |
| 10 | 20,836 |
| 201 | 379,906 |
| 250 | 472,382 |
| 1,005 | 1,895,370 |
| 1,054 (super admin) | 2,010,181 |

  - A real model call at that size would exceed any context window. Any error would end `failed` (fail-closed); this is unmeasured without a key.
- **`anon` privileges (pre-existing):** `anon` holds `xtm` (REFERENCES, TRIGGER, MAINTAIN) on `portfolio_ai_turns`; `authenticated` holds `rxtm`. There is no data privilege, and none of these is reachable through PostgREST.
- **Documentation findings:** §20.

None of these is a tenant-isolation, authorisation, AI-data-boundary, material grounding, financial-truth or evidence-integrity defect. I reclassified nothing upward: no reproduction showed material harm.

## 18. Other areas

| Area | Result | Evidence |
|---|---|---|
| Portfolio scope / aggregation (§22) | PASS | Scope is derived in the database (`app.portfolio_scope` over `app.adviser_org_ids`). Counts are one grouped statement. Detail lists are capped at 500 in SQL. Requests at 1, 10, 201 and 1,005 organisations are 3, 3, 3 and 4; no N+1. |
| Health / alerts / actions reuse (§23) | PASS | No change to those modules in Phase 15. The SQL lens predicates match `actions/domain` (`OPEN_STATUSES = open, in_progress`; overdue `due < today`; due soon `today..today+7`; high `critical`/`high`; mine `owner = uid`; `byUrgency` priority, due nulls last, created). The enum order is critical first. |
| Financial truth (§24) | PASS | The portfolio module sums no money (`grep`). Sweep 100 / 0 mismatches. Every Phase 14 suite is green (§3). |
| Phase 13 (§25) | PASS | banking 20/20; journey-13 passed. Transactions overflow 233 px at 320, 178 px at 375, 0 at 768: identical to both previous audits, so not worsened. `/money/banking` and `/home` are 0. |
| Evidence (§26) | PASS | The Phase 15 migrations create only `portfolio_ai_turns`, so there is no evidence store. Citations link to the organisation's own alert and action pages (`hrefs`). Foreign or unissued citations are dropped. |
| Security / RLS (§27) | PASS | `portfolio_ai_turns` has RLS forced. There is no public table without forced RLS, and no `authenticated`/`anon` write grants. All portfolio functions are `SECURITY DEFINER`, `search_path=""`, owned by `motion_definer` (`bypassrls = false`). `api.*` reads are granted to `authenticated` only; `api_server` begin/finish to `service_role` only. `org_role_of` is re-checked per scope organisation at begin. |
| Accessibility (§28) | PASS | axe (wcag2a/aa, 21a/aa, 22aa, best-practice) on 7 routes × 4 widths: 0 violations except L-F (minor). The Playwright axe sweep of the 4 Command Centre pages passed. One h1 per page. Keyboard order on the analyst: navigation → labelled textarea → Ask → answer links, each with visible focus, except the wrap to `BODY`. |
| Mobile (§29) | FAIL (LOW, L-E) | 0 px overflow on every route at 320, 375, 768 and 1440, except the long-name client page at 320 and 375. |
| Performance (§30) | FINDINGS (L-H, L-G) | Request counts are independent of organisation count. Timings are single local measurements, not a benchmark: 76–264 ms for `loadPortfolio`; 577 ms for super admin `askAdviser`; 568 ms in the transport suite. Documents claim no benchmark (83 ms is described as a single local run). |

## 19. Known nondeterministic issue (brief §32)

- **`ai-eval-record`:** failed in the full integration run with `get_alerts #16 output shape: expected [ Array(26) ] to deeply equal [ Array(25) ]`. It passed 1 / 1 when re-run alone.
- It was not modified. This is the documented array-length signature, not a regression.

## 20. Documentation (brief §34): FINDINGS (LOW)

**Accurate:**
- The model writes no text; the server renders every sentence.
- The block kinds and fact authorisation.
- Limitations and refusals as phrase ids.
- `free-text.ts` removed.
- ADR-117 transport, paging and caps; `DATABASE_ARCHITECTURE §14.3`.
- Roles and zero-assignment (the `ROUTE_ARCHITECTURE` empty-state copy is now correct).
- Current-access turns.
- The "no latency benchmark" and "single local measurement" wording.
- "No live Claude model has been run".
- Audit 2's documentation findings are fixed: the pgTAP comment now says SECURITY DEFINER; the eval uses the verbatim F-4 sentence; ADR-116 is marked superseded, with its false claims named.

**Inaccurate or overstated (all LOW):**
1. **N-1:** "Each phrase has a condition the server checks against the data" (`PHASE_15_IMPLEMENTATION.md §8`; `briefing.ts:218-221`). Four phrases are unconditional, so *Grounded* does not certify them.
2. **N-3:** "Grounded … nothing the model sent was discarded" (ADR-118 §4, `PHASE_15_IMPLEMENTATION.md §8`, `ROUTE_ARCHITECTURE.md §5.1`). Container-level extras and non-string array members are silently ignored while the turn stays `passed`.
3. **L-E:** `PHASE_15_IMPLEMENTATION.md:123` says page overflow is 0 "on every Command Centre page" at 375, 768 and 1440 px. Reproduced 347 px at 375 for a long client name.
4. **Wording:** `UX_ARCHITECTURE.md` describes *Partly grounded* as "one or more sentences stated something the data does not". Under ADR-118 it means a reference or block was discarded, for example a forged id. Minor. The same section still says "Command Centre (Phase 15, ADR-112–115)". Minor.
5. **N-2:** the contract comment "one bad block cannot fail the whole turn" (`briefing.ts:251-254`) is false for prototype-key kinds and phrase ids.

## 21. Scope control

- The only matches for funding readiness, funding score or "phase 16" in `src`, `supabase`, `e2e`, `test` and `scripts` are the pre-existing comment at `health/domain/config.ts:31`.
- There is no Phase 16 table, route or workflow.
- **NOT STARTED.**

## 22. What I could not verify

- **Live Claude behaviour:** how a real model uses the references; whether it misuses `not_in_portfolio`; the real-model failure at L-H digest sizes.
- **The platform employee's browser session** (it needs TOTP). The employee boundary was proven at the database and service level.
- **The hosted gateway's limits** for 1,005-id POST bodies.
- **The cause of React error #418** (N-5).

## Final verdict: **READY FOR PHASE 16**

- F-1…F-5 are closed.
- HIGH-A, HIGH-B and HIGH-C are closed.
- There is no CRITICAL, HIGH or MEDIUM finding.
- There is no tenant-isolation, authorisation, AI-boundary, material-grounding, financial-truth or evidence-integrity defect.
- Phase 13 and 14 regressions pass.
- Every test ran:
  - scenarios passed separately after the known hook timeout;
  - `ai-eval-record` failed only with its known signature and passed alone;
  - journey-15 failed only on a local auth-gateway 504 after its Phase 15 assertions, and passed when re-run.
- The remaining items are LOW, and several need documentation corrections (§20).

---

> **Archival note — added when preserved, not part of the audit.** This record was copied verbatim on 2026-09-29 from the auditor's session scratchpad, where it would not have survived the session; nothing above was edited. The probe files and logs it names lived in that scratchpad and are not in the repository. Its verdict, READY FOR PHASE 16, applies to commit `74050d1`. Its LOW findings (N-1…N-5, L-D…L-H) are deliberately left for a later hardening pass.
