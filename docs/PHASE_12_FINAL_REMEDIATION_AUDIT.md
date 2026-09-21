# Phase 12 — Final Remediation Audit (What-If Scenarios)

**Audited commit:** `a9c66ad` — "Phase 12 — Remediation before Phase 13" (branch `main`, in sync with `origin/main`, working tree clean).
**Previous audit:** `docs/PHASE_12_FINAL_AUDIT.md` (HIGH 1, MEDIUM 3, LOW 7 → NOT READY).
**Remediation record:** `docs/PHASE_12_REMEDIATION.md`.
**Rule:** READY requires CRITICAL = 0 and HIGH = 0. This audit modified no code.

## 1. Method

Three independent lines of evidence per finding, none of them a test count on its own:

1. **Cold read of the committed diff** — `git show a9c66ad -- <file>` for each of the six production files, hunk by hunk, against the claim in `PHASE_12_REMEDIATION.md`.
2. **Independent probes written for this audit, outside the repository** (scratch harness, not committed): `reaudit.probe.ts` (13 vitest cases against a fresh database, per-organisation owners, INR/AED/GBP organisations) and `reaudit.pw.ts` (one Playwright journey on an AED organisation with `bank_coverage_partial` warnings and no category breakdown, screenshots taken before and after a save).
3. **The repository's own suites re-run against the commit** — unit `scenario-apply`/`scenario-presentation`/`scenario-assumptions`/`forecast-compose` (121), integration `scenarios`/`forecast`/`ai-tools`/`evidence-provenance`/`rls-isolation` (146), Playwright `journey-12-what-if`/`journey-11-forecast`/`authorization` (9). The full 11-gate regression on a clean database was also run once immediately before the commit (see §5).

## 2. Verification of the four remediated findings

### HIGH-1 — refusal never reached the page; success tone shown with no reasons; stale scenario read as the failed result

**Diff (actions.ts):** the `done('This could not be worked out. The reasons are below.')` branch is gone. The refusal path now builds a `ValidationError` whose message is `${UNAVAILABLE_HEADLINE} Nothing was saved.` and whose items are `{ path: ASSUMPTION_LABEL[kind], message: unavailableText(reason) }`, returned as `{ ok: false, error: refusal.toJSON() }`. `revalidatePath` only runs on the success branch, so a refusal cannot re-render the saved list as if something changed.
**Diff (page.tsx):** `ScenarioUnavailableView` import and the dead `latest.unavailable.length > 0` branch removed; a "Last saved scenario · {date}" eyebrow now sits above the saved scenario's name; empty copy reads "No scenario has been saved yet."
**Diff (comparison.tsx):** `ScenarioUnavailableView` deleted.

**Browser evidence (independent probe, AED org):**
- Refusal with nothing saved: alert text = "This cannot be worked out, because something it needs is missing. Nothing was saved. Wages: MOTION does not know what this has been running at, so it cannot work out a percentage of it. Give an amount instead." Tone class `border-danger/40 bg-danger-soft`. `role="status"` count 0. "reasons are below" count 0. "Last saved scenario" count 0. `scenario_runs` rows = 0.
- Refusal with a saved scenario on the page: same alert text; "Worked out and saved" count 0; headings = `["What if things change?", "What would you like to change?", "Sales up 10%", "What this assumes"]` — the refused name "Wages pct" is nowhere; rows = 1. Screenshot `reaudit-refusal-after-save.png` shows the red refusal beside the form and "LAST SAVED SCENARIO · 21 SEPT 2026 / Sales up 10%" clearly labelled as a prior save.
- Repository journey 12 asserts the same (refusal before save, refusal after save with old heading retained and no new heading) and passes.

**Verdict: resolved.** The user sees why, in the error tone, beside the form; nothing is stored; the saved scenario is labelled as saved, not presented as the result of the failed attempt.

### MEDIUM-1 — `startsInMonth` beyond the horizon silently no-oped

**Diff (apply.ts):** `sufficiency(assumptions, basis, horizonMonths)` now refuses with `need(kind, 'starts_after_horizon', null)` when `assumption.startsInMonth > horizonMonths`; `applyScenario` passes `input.horizon.length`. `config.ts` adds the reason code; `presentation.ts` adds the sentence ("…would start after the last month MOTION can see… Choose an earlier month.").
**Probe evidence:** month = horizon length → accepted and applied; month = horizon + 1 → whole scenario refused with `starts_after_horizon`, zero `scenario_runs` rows; mixed (one inside, one after) → refused as a whole, nothing partial saved. Repository unit describe "a change has to land inside the months…" (inside/boundary/after/mixed) passes; integration refusal case passes.
**Verdict: resolved.** The whole-scenario refusal rule of the phase is preserved (no partial application).

### MEDIUM-2 — forecast basis and data-quality warnings did not propagate to scenario results/UI

**Diff (services/index.ts):** `forecastWarningsOf(forecast.breakdown)` extracted at save time and written to `scenario_runs.data_quality.forecast_warnings`; `viewOf` flattens and de-duplicates them into `dataQuality.warnings`. **Diff (comparison.tsx):** a `data-testid="scenario-basis"` block renders `BASIS_LABEL[scenario.basis]` + `BASIS_TEXT` and "The figures this rests on carry a note: …" via the shared `DATA_QUALITY_NOTE_TEXT` map (same copy as the dashboard and forecast pages).
**Probe evidence:** limited-basis organisation → view basis `limited`, page says "Limited basis"; warned organisation → `warnings` carried into the view and stored `data_quality`; AED browser run shows "Strong basis — six or more complete months, all of them settled figures." followed by "The figures this rests on carry a note: bank statements do not cover the whole period." Repository integration describes for basis and warnings pass; journey 12 asserts the note text.
**Verdict: resolved.** Basis is the Phase 11 basis, unchanged; nothing is recomputed, only carried.

### MEDIUM-3 — AI tool 19 rendered assumption amounts without currency / not the organisation's currency

**Diff (repository.ts):** `loadBaseCurrency` reads `organizations.base_currency` (schema: `char(3) not null default 'GBP'`, so never null for a real organisation). **Diff (services/index.ts):** `ScenarioView.currency` = `baseCurrency ?? cell currency ?? 'GBP'`; at save time cells are stored with `baseCurrency ?? currencyOf(forecast)`. **Diff (intelligence.ts):** every `money(..., null)` in tool 19 became `money(..., state.currency)`; figures use `metric.currency ?? state.currency`.
**Probe evidence (three organisations, same tool, same user):** INR → `assumption=₹50,000 figure=₹10,000`; AED → `AED 50,000 / AED 10,000`; GBP → `£50,000 / £10,000`. Repository integration currency describe passes; `ai-tools` role × tool matrix passes.
**Verdict: resolved.** Note the remaining `?? 'GBP'` literals in `comparison.tsx` (lines 28 and 116) are unreachable: stored cell currency is always the organisation's, and `base_currency` is NOT NULL. Observation only.

## 3. Regression checks (areas 6–7 of the brief)

| Area | What was checked | Result |
|---|---|---|
| Deterministic calculation | Probe: same assumptions run twice → identical `scenario_values`; SQL: every `baseline_value` equals the Phase 11 forecast value for the same period/metric; `revenue_change` with `directCostsFollow` cascades into cost of sales and operating profit exactly as before | unchanged |
| `composeFromLevels` | Forecast unit suite and `forecast.test.ts` (19) pass; Phase 11 journey passes; no diff to `compose.ts` in `a9c66ad` | no regression |
| Tenant isolation | Probe: org B owner cannot read org A scenario by id (not found), `rls-isolation.test.ts` 42/42 | no regression |
| RBAC | Viewer/analyst refused `scenario.run` and archive; owner/admin/accountant allowed; `authorization` journey passes; permission matrix "in sync" | no regression |
| RLS / grants | pgTAP PASS; drift gate 48 tables / 109 functions, RLS forced everywhere, no write grants; migration file untouched by the remediation | no regression |
| Evidence | `evidence-provenance.test.ts` 14/14; scenario bundle still clones the forecast bundle items | no regression |
| AI | `ai-tools.test.ts` 22/22 incl. the role × tool matrix; eval 158/158 at PROMPT_VERSION `analyst-v3.2`; refusal templates unchanged by the remediation | no regression |

## 4. Findings

### CRITICAL — none.
### HIGH — none.
### MEDIUM — none.

### LOW

Carried from the first audit, deliberately out of remediation scope by instruction:

- **LOW-1** zero-interest drawdown refused rather than accepted.
- **LOW-2** malformed scenario id in the route → 500 not 404 (pre-existing `/actions`, `/evidence` pattern; excluded by instruction).
- **LOW-3** `anon` SELECT grant on `scenario_runs` with no `anon` policy (non-exploitable under forced RLS; excluded by instruction).
- **LOW-4** partly closed: the mis-titled percentage-refusal test now targets the right organisation. The remaining part (no test that the tool 19 *text* mentions the basis word) stands.
- **LOW-5** negative-baseline percentage wording.
- **LOW-6** silent zero-item bundle clone when the forecast bundle is empty.
- **LOW-7** archive is organisation-wide rather than per-author.

New in this audit:

- **LOW-8** After a refused submit the form resets entirely (React 19 default behaviour for `useActionState` forms): ticks are cleared and typed amounts return to placeholders, so the user re-enters the scenario after reading the reason. Visible in `reaudit-refusal-after-save.png`. `scenario-form.tsx` was not touched by the remediation; this is original Phase 12 behaviour that the first audit did not flag. Not misleading, no data effect; the refusal text tells the user what to change.

**Totals:** CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 8 (7 carried, 1 new).

## 5. Gates at the audited commit

Run on a clean database immediately before `a9c66ad` was created; `a9c66ad` contains exactly that tree.

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint (incl. `no-money-parsefloat`, `no-deep-module-import`, `no-direct-table-write`) | PASS |
| Permission matrix | in sync |
| Unit + coverage | 66 files, 1,953 passed |
| AI eval | 158 passed |
| Build (both `/what-if` routes emitted) | PASS |
| DB reset | ok |
| pgTAP | PASS |
| Schema drift | 48 tables, 109 functions, RLS forced everywhere, no write grants |
| Integration | 37 files, 614 passed (incl. `ai-eval-record` on that run) |
| Playwright | 62 passed, 1 skipped |

Re-runs for this audit (§1, item 3): 121 unit, 146 integration, 9 Playwright, all passed.

**Known flake, unchanged status:** `test/integration/ai-eval-record.test.ts` is intermittently nondeterministic because the Phase 7 alert set varies between runs. It reproduces on the pre-Phase-12 commit `434a457`, is not touched by Phase 12 or its remediation, and passed on the gate run above. Excluded from remediation by instruction; it does not bear on Phase 12 readiness.

## 6. Verdict

CRITICAL 0, HIGH 0 → the READY rule is met. All four remediated findings are genuinely fixed in the shipped code, confirmed by reading the diff, by probes written independently of the repository's tests, and by the repository's own suites. No regression was found in calculation, isolation, RBAC, RLS, Evidence, Forecasting or AI.

**READY FOR PHASE 13**
