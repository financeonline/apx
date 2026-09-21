# MOTION — Phase 12 Remediation (before Phase 13)

Date: 2026-09-21 · On top of `fce7818` (Phase 12) · Responds to `docs/PHASE_12_FINAL_AUDIT.md`
Scope: the audit's HIGH-1 and MEDIUM-1…3, and the LOW items those fixes touched directly. Nothing
else. No Phase 13 code; no change to the deterministic calculation, `composeFromLevels`, the Phase 11
forecast, the evidence architecture, the AI security model, RBAC, tenancy or RLS.

---

## 1. Summary

| Finding | Severity | Root cause | Fix | Status |
|---|---|---|---|---|
| HIGH-1 · Refusal reasons never reached the reader; success-toned message; previous scenario shown beneath | HIGH | the server action discarded the refusal payload and reported `done(...)`; the page could only ever read the last *saved* scenario | refusal returned through the existing `ActionResult` error channel, rendered by `ActionMessage` in the error tone; the saved section is labelled "Last saved scenario · date"; the unreachable view was removed | fixed, browser-tested before and after a save |
| MEDIUM-1 · Assumption starting beyond a short horizon silently no-op | MEDIUM | `startsInMonth` was validated against the constant `HORIZON_MONTHS`, not the real horizon | `sufficiency()` takes the horizon length and refuses `startsInMonth > horizonMonths` with a new reason, `starts_after_horizon`; the whole scenario is refused, as for every other missing input | fixed, four unit cases |
| MEDIUM-2 · Forecast basis and warnings dropped | MEDIUM | `basis` was stored and returned but not rendered; `warnings` was hard-coded `[]` and the forecast's per-metric warnings were never copied | warnings lifted from the forecast's stored `breakdown` into `scenario_runs.data_quality.forecast_warnings` at save time; the view exposes them and the basis; the page renders both in words | fixed, integration + browser |
| MEDIUM-3 · Tool 19 showed assumption amounts in GBP for every organisation | MEDIUM | `money(value, null)` falls back to GBP | the organisation's `base_currency` is read once, carried on the view as `currency`, and used by the page and by tool 19 for every amount | fixed, GBP/INR/AED/USD |
| LOW-4 (part) · mis-titled integration case | LOW | title said "refuses", body asserted success | rewritten as a genuine refusal on an organisation without the category breakdown | fixed |

Not changed, deliberately, per the remediation brief: the malformed-id 500 shared with `/actions` and
`/evidence`; the `anon` SELECT grant (non-exploitable); the Phase 7 alert pipeline behind the
intermittent `ai-eval-record.test.ts`; zero-interest validation (LOW-1); negative-baseline wording
(LOW-5); the silent zero-item bundle copy (LOW-6); organisation-wide archive (LOW-7).

---

## 2. HIGH-1 — the refusal state

### Finding
When `runScenario` refused a scenario for a missing figure, the page showed "This could not be
worked out. The reasons are below." in the success tone, showed no reasons, and rendered the
previously saved scenario underneath — a reader could take the old figures for the answer to the
refused request. `ScenarioUnavailableView` was unreachable.

### Root cause
Two halves that did not meet. `runScenario` returns `{ runId: null, unavailable: [...] }` on a
refusal; the server action reduced that to `done(<string>)` and revalidated the path. The page
then re-read `loadScenario(ctx)`, which by design can only return a *saved* scenario or
`{ runId: null, unavailable: [] }` — a refusal is never saved, so the page never had the reasons to
render. The branch that would have rendered them was dead code.

### Fix
- `what-if/actions.ts`: a refusal is returned as `{ ok: false, error }` where `error` is a
  `ValidationError` carrying one issue per refused change — `path` is the change's plain label
  ("Wages"), `message` is `unavailableText(reason)` — under the headline
  "This cannot be worked out, because something it needs is missing. Nothing was saved." Built
  directly rather than through `fail()`, because `fail()` writes an error-level log for what is a
  normal outcome. The path is not revalidated on a refusal: nothing changed.
- `ActionMessage` (unchanged, `components/ui/action-form.tsx`) already renders that shape as a
  `role="alert"` box in the danger tone with the issues listed.
- `what-if/page.tsx`: the section below the form is labelled **"Last saved scenario · {date}"**, so
  it can never be read as the answer to the request just made; the unreachable branch and the
  `ScenarioUnavailableView` component were removed rather than left as dead code.

### Tests
- `e2e/journey-12-what-if.spec.ts` now drives the sufficiency refusal **twice**: before anything is
  saved (asserting the alert, the change name, the reason, "nothing was saved", no success text,
  no "Last saved" section, and `scenario_runs` count 0) and **again after a save** — the exact state
  the audit found — asserting the alert and reason, no success text, that the saved section is still
  the *earlier* scenario labelled as last saved, that no heading reads "Wages pct", and that the
  count is still 1. Each of those assertions fails on the audited build.
- `test/integration/scenarios.test.ts`: the previously mis-titled case is now a genuine refusal on an
  organisation with no `expense_by_category` rows, asserting the exact `unavailable` payload and
  that nothing was stored; a sibling case proves the amount form succeeds for the same organisation.

---

## 3. MEDIUM-1 — assumptions outside the horizon

### Finding
`applyScenario` with a two-month horizon and `startsInMonth: 3` produced a scenario with no
refusal and no changed cell; the assumption was stored as if applied.

### Root cause
`assumptions.ts` bounded `startsInMonth` by the constant `HORIZON_MONTHS = 3`, and nothing compared
it with the horizon actually in hand (`forecast.periods.length`, which is however many future
`fiscal_periods` rows exist).

### Decision
**Reject, not report.** Consistent with the module's rule that a missing input is a refusal and
never a zero (`PHASE_12_IMPLEMENTATION.md §6`): an assumption that cannot touch any month of the
scenario is refused with a new reason, `starts_after_horizon`, and — as with every other refusal —
the whole scenario is refused and nothing is stored. Reporting it as "applied to nothing" was
considered and rejected: it would put a scenario in the saved list that lists an assumption and
shows no effect from it, which is the confusing artefact the finding was about. A start exactly on
the last month of the horizon is inside.

### Fix
- `domain/config.ts`: `UNAVAILABLE_REASONS` gains `starts_after_horizon`.
- `domain/apply.ts`: `sufficiency(assumptions, basis, horizonMonths)` refuses
  `startsInMonth > horizonMonths`; `applyScenario` passes `input.horizon.length`.
- `domain/presentation.ts`: "This change would start after the last month MOTION can see, so it
  would not touch any figure in this scenario. Choose an earlier month."

### Tests
`test/unit/scenario-apply.test.ts`, new block: inside the horizon (applied from month 1 of 2);
**exactly on the boundary** (month 2 of 2: untouched in month 1, applied in month 2); after the
horizon (refused, `starts_after_horizon`, zero cells); **mixed** (an in-range sales change and an
out-of-range hire: refused as a whole, the hire named — never a scenario that quietly lost the
hire); and month 3 of a 3-month horizon, unchanged.

---

## 4. MEDIUM-2 — basis and warnings

### Finding
The basis word (`strong` / `limited` / `weak`) was stored on the run and returned by the service and
tool 19 but never rendered; `dataQuality.warnings` was hard-coded to `[]`, so the forecast's
per-metric warnings never reached the scenario at all.

### Root cause
An incomplete propagation path: the view carried the basis but the component ignored it, and the
save path never copied `forecast_runs.breakdown[].warnings`.

### Fix
- `services/index.ts`: `forecastWarningsOf(breakdown)` lifts each baseline's warning codes out of the
  forecast's stored `breakdown` (`Baseline[]`, ADR-099), defensively (malformed entries contribute
  nothing); `storeScenario` writes them to `scenario_runs.data_quality.forecast_warnings`, so a
  saved scenario keeps disclosing what its baseline carried after the forecast is regenerated;
  `viewOf` flattens and deduplicates them into `dataQuality.warnings`.
- `what-if/comparison.tsx`: directly under the disclaimer, a `data-testid="scenario-basis"` block
  renders `BASIS_LABEL[basis]` with the forecast's own `BASIS_TEXT` (both imported from
  `@/modules/forecast` — no second copy of the words) and, when present, "The figures this rests on
  carry a note: …" using the dashboard's existing `DATA_QUALITY_NOTE_TEXT` table, so a code never
  reaches a reader. No percentage is shown anywhere; the forecast calculation is untouched.

### Tests
- Integration: a four-month organisation yields `basis = 'limited'` on the view and in
  `scenario_runs.basis`; the six-month organisation yields `strong`; an organisation whose
  snapshots carry `cash_basis_proxy` and `bank_coverage_partial` yields both, deduplicated, on the
  view **and** stored under `data_quality.forecast_warnings`; an organisation with none yields `[]`.
- Unit: `forecastWarningsOf` on a well-formed breakdown (deduplicated, empty entries dropped) and on
  malformed input (contributes nothing rather than throwing).
- Browser: journey 12's organisation carries `cash_basis_proxy` on every figure, which also pulls
  the basis from strong to **limited** under Phase 11's rule; the page shows "Limited basis — …
  some of the figures behind them are estimates" and "figures are estimated from bank activity, not
  from your accounts". (The first draft of the assertion expected "strong"; the product was right.)

---

## 5. MEDIUM-3 — currency

### Finding
Tool 19 rendered assumption amounts with `money(value, null)`, which falls back to GBP: an INR
organisation's `50000` hire cost was shown to the model as `£50,000` beside figures in `₹`.

### Root cause
The currency was taken from whichever cell happened to carry one (page) or not at all (tool
assumptions), never from the organisation's setting.

### Fix
- `data/repository.ts`: `loadBaseCurrency` reads `organizations.base_currency` — the setting a
  person can see and change — per the precedent in `dashboard/services/alerts.ts`.
- `services/index.ts`: `ScenarioView.currency` is that setting (the forecast's own cell currency only
  if the setting is absent); `storeScenario` writes it on every `scenario_values` row; the page
  formats every assumption and figure with it; tool 19 formats every assumption amount and every
  figure with it. The numeric values are untouched.

### Tests
Integration, one case each for **GBP, INR, AED, USD**: the view's `currency` equals the setting;
`scenario_values.currency` equals it for every stored cell; tool 19's assumption `display` equals
`formatMoney('50000', { currency })` exactly and its `value` is still `'50000'`; the tool's figure
`display` equals the product formatter applied to the view's own figure. Browser: journey 12's
organisation is INR — `₹11,000`, `₹4,000`, and **no `£` anywhere on the page**.

---

## 6. Verification

Every gate re-run from a clean database after the changes. Results are in §7 of this document as
the final regression table; the Phase 12 suites' new totals are:

| Suite | Before | After |
|---|---|---|
| `test/unit/scenario-apply.test.ts` | 39 | **44** |
| `test/unit/scenario-assumptions.test.ts` | 28 | 28 |
| `test/unit/scenario-presentation.test.ts` | 14 | **16** |
| `test/integration/scenarios.test.ts` | 39 | **49** |
| `e2e/journey-12-what-if.spec.ts` | 2 | 2 (the second now drives the refusal twice) |

No existing test was deleted or weakened. The one Phase 12 test whose body changed is the
mis-titled refusal case, which now tests what its title says.

Two things worth recording from the run, because they were the fixture being wrong and not the
product: the first attempt at the extended integration suite tripped `api.create_organization`'s
per-actor throttle (ADR-044.5) — each remediation organisation now has its own owner; and a GBP
currency assertion hard-coded a baseline that an earlier case in the same file had legitimately
moved — it now asserts formatting against the view's own figure, which is the right invariant for
a currency test anyway.

---

## 7. Final regression

All from a clean `supabase db reset`, on the exact tree committed.

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint (8 custom architecture rules) | PASS |
| Permission-matrix parity | PASS — in sync |
| Unit + coverage gate | PASS — 1,953 tests, 66 files (1,946 before; +7) |
| AI eval | PASS — 158 (unchanged: no prompt or tool-schema change, so no `PROMPT_VERSION` bump) |
| Production build | PASS — both `/what-if` routes emitted |
| pgTAP | PASS |
| Schema drift | PASS — 48 tables, 109 api functions, RLS forced everywhere, no write grants |
| Integration | PASS — 614 tests, 37 files (604 before; +10) |
| Playwright (all projects) | PASS — 62 passed, 1 skipped (the same pre-existing skip) |
| Authorization | PASS — `authorization-status.spec.ts` + the role cases in `scenarios.test.ts` |
| Tenant isolation | PASS — both directions, service + RLS + composite FK, in `scenarios.test.ts` and `rls-isolation.test.ts` |

The single `server action failed … VALIDATION` line the Playwright run logs is journey 12's
*validation* refusal (a blank required field) passing through `fail()` as designed; the
*sufficiency* refusal no longer logs at error level, because it is an outcome, not a failure.

Not re-measured here, by instruction: the pre-existing intermittent `ai-eval-record.test.ts`
(`PHASE_12_FINAL_AUDIT.md §17`). It passed in this run; one green run is not evidence it is fixed,
and nothing in this remediation touches the alert pipeline behind it.
