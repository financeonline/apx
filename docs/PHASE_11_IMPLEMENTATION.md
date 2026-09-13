# MOTION — Phase 11: Forecasting

Date: 2026-09-13 · Branch `main`, on top of `36d3ca4` · Decision recorded: ADR-099
Scope: Forecasting only. No Phase 12 Scenarios, no What-If, no Banking Intelligence, no Commercial
Intelligence, no Adviser/CFO Command Centre, no Funding Readiness, no advanced Reporting.

---

## 0. What already existed

The brief was explicit that documentation and code may disagree, so the first pass was an inventory
rather than a build. What forecasting needed, and whether it was there:

| Piece | State before Phase 11 | Where |
|---|---|---|
| `fiscal_periods` seeded **twelve months forward** | existed | `20260905000004` |
| `metric_snapshots` + `metric_current` per period, with `assurance_level` and `data_quality` | existed | Phase 4 |
| `calculation_runs` — the deterministic run every figure hangs off | existed | ADR-016 |
| Period completeness (`completenessHolds`) | existed, single source | ADR-093 |
| Assurance ladder, `estimated` as a real level | existed, single source | ADR-094, `core/assurance` |
| Evidence bundles + items, `origin_table` allow-list, polymorphic guard | existed | ADR-092, ADR-096 |
| `api_server.finish_health` — the precedent for "server computes, writes whole, in one transaction" | existed | Phase 6 |
| **A forecast table** | **absent** — `DATABASE_ARCHITECTURE.md §395` only reserved the idea | — |
| **A forecast metric, service, page or AI tool** | **absent** | — |
| Analyst behaviour on "what will revenue be next month?" | **refused** — `REFUSAL_TEMPLATES.scenario` covered forecasting and what-if together | `ai/domain/prompt.ts` |

So unlike Phases 8, 9 and 10 — each of which turned out to be largely built — Phase 11 was genuinely
new work. Nothing existing was redesigned. No second evidence path, no second persistence mechanism
and no second completeness or assurance rule were created.

---

## 1. Forecast architecture

```
metric_current ─┐
 (actuals, per   │  loadHistory()          domain/baseline.ts      domain/compose.ts
  period, per    ├─►  ActualPoint[]  ──►   selectWindow()     ──►  leaves → identities
  metric)        │                        buildBaseline()          cash chained
fiscal_periods ──┘  loadHorizon()                                       │
 (12 months fwd)     HorizonPeriod[]                                    ▼
                                                          api_server.finish_forecast()
                                                          ├─ forecast_runs   (one row)
                                                          ├─ forecast_values (one per cell)
                                                          ├─ evidence_bundles + items
                                                          └─ app.audit('forecast.generated')
                                                                        │
                             /app/{org}/forecast  ◄── loadForecast() ◄──┘
                             AI tool 18 get_forecast ◄──┘
```

Eight files, one migration:

| File | Lines | What it is |
|---|---|---|
| `src/modules/forecast/domain/config.ts` | 98 | `forecast.config.v1` — every number, versioned |
| `src/modules/forecast/domain/types.ts` | 96 | shapes; money is a string throughout |
| `src/modules/forecast/domain/baseline.ts` | 190 | sufficiency, continuity, one-offs, weighting |
| `src/modules/forecast/domain/compose.ts` | 177 | leaves → identities → cash chain |
| `src/modules/forecast/domain/presentation.ts` | 83 | plain-English labels and basis sentences |
| `src/modules/forecast/data/repository.ts` | 207 | five reads; money normalised at the boundary |
| `src/modules/forecast/services/index.ts` | 310 | `generateForecast`, `loadForecast`, `storeForecast` |
| `supabase/migrations/20260912000002_forecast.sql` | 254 | two tables, RLS, `api_server.finish_forecast` |

**Why separate tables and not `metric_snapshots`.** A snapshot is what the engine COMPUTED for a
period that happened; it is pinned by `metric_current`, cited by health scores, alerts and evidence,
and append-only per calculation run. A forecast is a different kind of claim about a period that has
not happened. Sharing the table would mean every existing reader of `metric_current` — Home, Money,
the analyst's tools, the evidence drawer — had to learn the difference or risk rendering a forecast
as a figure. Separate tables make that mistake impossible rather than merely discouraged. Recorded
as ADR-099.

**Where the LLM sits.** Nowhere in the calculation. The model reads a stored forecast through tool
18 and can do nothing else with it. See §14.

---

## 2. Forecast methodology

`baseline.v1` — a **recency-weighted average of complete historical periods**, per metric.

1. Take the most recent **consecutive** run of complete periods, at most `MAX_PERIODS = 12`.
2. Drop one-off periods (§below), at most one in four.
3. Weight the kept periods linearly by recency: the newest weighs *n*, the oldest weighs 1.
4. The baseline is the weighted mean, to 2 dp, as a string.
5. Every forecast month for that metric takes the baseline (level, not trend).

**No trend is extrapolated, deliberately.** A straight line through eight noisy monthly points
produces a confident-looking number whose confidence comes from the arithmetic rather than from the
business. Over a three-month horizon, "this is the level it has been running at" is the most a small
business's history can honestly support. Stated as a choice in ADR-099 rather than left implicit.

**One-off exclusion** uses **median and MAD**, not mean and standard deviation — the one-off being
looked for is exactly the thing that drags a mean and inflates a standard deviation. A period is
excluded when it sits more than `OUTLIER_MAD_MULTIPLE = 3.5` MADs from the median (the conventional
modified-Z threshold, deliberately loose: excluding a real month is worse than including an odd one).

> **Defect found and fixed during the build.** Where more than half the window is identical the MAD
> is **zero**, so the comparison `|x − median| > 3.5 × 0` was never true and a genuine outlier
> survived. Five identical months plus one fifty times larger — the textbook case the rule exists
> for — passed straight into the baseline. Fixed with the Iglewicz–Hoaglin fallback: when MAD is
> zero, the scale becomes the **mean absolute deviation**; when that is zero too, nothing is
> excluded because every point is identical. This was a code fix, not a test change.

**Determinism.** The engine is pure: same history in, byte-identical forecast out, with no clock, no
randomness and no ordering dependence. A unit test shuffles the input periods and asserts the result
is unchanged, and another asserts two runs produce identical strings.

---

## 3. Data sufficiency rules

MOTION forecasts a metric only where sufficient data exists (REQ-FC-01). Where it does not, the
metric is **absent with a stated reason** — never zero, never a guess (§20).

| Rule | Value | Why |
|---|---|---|
| Minimum complete periods | `MIN_PERIODS = 3` | Precedent set by the health score's `MIN_DIMENSIONS_FOR_SCORE = 3` — "fewer than three cannot describe a business". Nothing in the approved documents fixes a number, so this one is chosen, stated and versioned rather than assumed. |
| Maximum window | `MAX_PERIODS = 12` | A full year of seasonality when it exists, and no more: a small business two years ago is often a different business. |
| Continuity | the window stops at a gap | A gap means the months before it describe a business that has since stopped reporting the same way; averaging across it would quietly treat them as if it had not. |
| Completeness | incomplete periods excluded entirely | Same rule ADR-030.4 already applies when refusing to score a period; `completenessHolds` is the single predicate (ADR-093). |
| Exclusion cap | `MAX_EXCLUDED_FRACTION = 0.25` | Past one in four, the spread IS the business. |

Refusal reasons, each a real condition the server checked:

`no_history` · `too_few_periods` · `history_not_continuous` · `no_complete_periods` ·
`metric_not_computable`

Each is rendered in words by `presentation.ts` and never shown raw.

**Confidence is three words, not a percentage** — `strong` / `limited` / `weak`. `strong` requires
`STRONG_MIN_PERIODS = 6` complete periods with nothing excluded and nothing estimated. §19 forbids
an invented number, and there is no statistical interval here that could be reported honestly. The
page leads with the **weakest** basis across everything forecast.

---

## 4. Forecast horizon

`HORIZON_MONTHS = 3`.

`MVP_SCOPE.md` and `PRODUCT_REQUIREMENTS.md` fix no horizon, and the standing instruction where none
is specified is the smallest useful implementation. Three months is the shortest horizon a business
can act on — long enough to contain a payroll run and a quarter of supplier payments, short enough
that a recency-weighted level is still a defensible statement about it.

**Every forecast period is a real `fiscal_periods` row.** Organisations are seeded twelve months
forward, so `loadHorizon` selects the next three periods after the last actual; nothing invents a
month, and `forecast_values.period_id` is a foreign key to the composite `(organization_id, id)` so
a forecast cannot attach to another tenant's calendar.

---

## 5. Revenue forecast

Leaf metric. `revenue` is baselined directly from `metric_current`. Derivation `baseline`.
Insufficient history ⇒ `revenue` absent with its reason, and — because the identities below depend
on it — `gross_profit` and `operating_profit` become unavailable too, each with
`metric_not_computable`.

## 6. Expense forecast

Two leaves, kept apart exactly as the engine keeps them apart:

- `cost_of_sales` — leaf, baselined.
- `operating_expenses` — leaf, baselined. Labelled **"Running costs"** on the page.

There is no single "expenses" figure, because the engine does not have one and inventing an
aggregate would be an undocumented business rule.

## 7. Operating profit forecast

**Derived, never averaged.**

```
gross_profit     = revenue − cost_of_sales
operating_profit = gross_profit − operating_expenses
```

Derivation `identity`, with `derived_from` recording the keys it came from, so the drawer shows the
arithmetic rather than asserting the number. Averaging operating profit directly would eventually
disagree with its own components — the one inconsistency a reader would notice and never trust
again. §7's requirement that the relationship be deterministic is met by construction.

**CD-05 is preserved.** An organisation with no cost-of-sales accounts gets no gross profit and
therefore no operating profit — exactly as its actuals already behave. The forecast does not
fabricate a margin the books never had.

## 8. Cash forecast

```
cash_inflows, cash_outflows          ← baseline
net_cash_movement = inflows − outflows
closing_cash      = previous closing + net_cash_movement      (chained)
```

The chain **starts from the last ACTUAL closing balance**, never from an averaged one. A bank
balance is a fact on a date; averaging the last few months' balances to open the forecast would
invent a balance the business never had (§8, "do not invent bank balances"). Where there is no bank
data at all, `closing_cash` is listed as unavailable with `metric_not_computable` — the chain is not
started rather than opened at zero.

> **Defect found and fixed during the build.** The service originally sorted forecast periods by
> their **label**, so "Nov 2026" < "Oct 2026" < "Sep 2026" lexicographically and the cash chain ran
> **backwards** — a rising cash position would have been shown as falling. Fixed to sort by
> `period_start`. A dedicated regression test now asserts the periods come back as
> `['Sep 2026','Oct 2026','Nov 2026']` and closing cash as `['22000.00','24000.00','26000.00']`.

## 9. Receivables forecast

Leaf metric, baselined from `receivables`. A stock figure rather than a flow, so it is the level
that is carried forward, not a movement — which is what a recency-weighted average of a balance
already means. Insufficient or non-continuous history ⇒ absent with its reason.

## 10. Payables forecast

Leaf metric, baselined from `payables`, on the same terms as §9.

---

## 11. Actual vs forecast

The page and the AI tool both carry the **last actual beside the forecast, and the change between
them**, so a forecast is always read against something real:

- `forecast_runs.basis_from_period` / `basis_to_period` record the window the baseline used.
- `loadForecast` returns, per metric, the latest actual value and the delta to the first forecast
  month.
- `forecast_values.value` is `numeric(20,6)`, the same shape as `metric_snapshots.value`, so a
  variance between a forecast and the actual that later lands is **exact** rather than a rounding of
  two differently-typed numbers (ADR-006).

Actuals are never restated by a forecast. `metric_snapshots` and `metric_current` are untouched by
this phase.

---

## 12. Data quality

- The forecast **inherits** the warnings from the snapshots it read: `metric_snapshots.data_quality`
  is carried on each `ActualPoint` and surfaces in `Baseline.warnings`.
- `anyIncomplete` and `anyEstimated` are recorded per baseline and pull the confidence word down.
- Excluded one-offs are stored in `forecast_runs.breakdown` **with the reason**, so a month that was
  left out is visible rather than silently missing.
- Every refusal is stored in `forecast_runs.unavailable` with its reason and the number of periods
  actually found.

> **Fixture defect found during the build.** Two test fixtures wrote `data_quality: '{}'`, which
> produced a 500 (`Cannot read properties of undefined (reading 'length')`) because every reader
> uses `dataQuality.warnings.length`. Fixed in the fixtures to the real shape
> `{"completeness": 1, "proxy": false, "warnings": [], "missing": []}`.

---

## 13. Evidence

`evidence_kind_enum` gains `forecast`; the ADR-092 `origin_table` allow-list gains `forecast_runs`;
the polymorphic guard `same_org_ref_origin` is dropped and **re-registered complete**, so the drift
gate's "every enum value is mapped" assertion stays satisfied.

A forecast bundle's origin is the **run**. Its items are:

1. the `calculation_run` the baselines read, and
2. the `metric_snapshot` rows the baselines were computed from.

**Nothing about the future is cited**, because there is nothing about the future to cite: the
evidence for a forecast is the history it was computed from. Each item keeps the **history's own**
assurance (`verified`, `calculated`, …) while every `forecast_values` row stays `estimated` — a
verified past is not evidence that a future is verified, and the two are deliberately not flattened
into one word.

The bundle is written in the **same transaction** as the run and its values, so a forecast can never
be half-visible or exist without its evidence.

---

## 14. AI integration

**The LLM is not the forecast calculator, and cannot become one.**

- Tool 18 `get_forecast` (`src/modules/ai/domain/tools/intelligence.ts`), permission
  `dashboard.view`, optional `{ metric_key }`. It **reads** `forecast_values` and returns branded
  `money()` envelopes plus `basis`, `stale`, `evidence_bundle_id`, and `not_forecast` reasons. There
  is no tool that computes a forecast, and no path by which the model's own arithmetic can be
  stored.
- Because forecast figures come back as `NumberRef`-grounded envelopes, a number the model invented
  would have no reference and the sentence carrying it is **removed by grounding** (§7.8). The
  guard-rail is mechanical, not a prompt instruction.
- Every forecast figure the analyst quotes carries `assurance: estimated` from the response
  contract, so it is marked as an estimate without the model having to remember to say so.

**The refusal template was split in two**, because it had become wrong in both directions:

| Question | Before | Now |
|---|---|---|
| "What if I raise prices 10%?" | refused | **still refused** — Phase 12 |
| "What is revenue likely to be next month?" | refused (feature did not exist) | **answered** from the stored forecast, or honestly refused with the sufficiency reason |

`REFUSAL_TEMPLATES.scenario` is now what-if only: *"What-if scenarios are not available yet in
MOTION. I can show you what is expected on the current figures, and the numbers that would drive
that decision:"*. `PROMPT_VERSION` bumps `analyst-v3.0` → `analyst-v3.1` and the eval corpus was
re-recorded.

The eval corpus's `scenarioQuestions` split into `whatIfQuestions` (refused) and `forecastQuestions`
(answered). The golden organisation has **two** months of history and `MIN_PERIODS` is 3, so the
expected answer there is that there is not enough history yet, plus the latest actual — the corpus
proves the honest-insufficiency path rather than a happy path. `adv:forecast-anyway` cases assert
the model does not compute one when pushed.

---

## 15. RBAC

| Role | Reach |
|---|---|
| `owner`, `admin`, `employee` (assigned), `super_admin`, `client` | may **read** a forecast |
| `suspended_member` | no reach — frozen to Home (ADR-044.4) |
| Anyone without `dashboard.view` | `NotFound`, never a 403 that would confirm the organisation exists |
| `authenticated` (any role) | **zero write grants** on both tables (ADR-026) |

The gate is `dashboard.view`, held by every role that resolves and by nobody else, so a forecast has
exactly the reach the figures it is made of already have. It is enforced in **three** places, on
purpose:

1. `assertCan(ctx, 'dashboard.view')` in `generateForecast` / `loadForecast`.
2. `requirePermission` on the page (ADR-091), giving HTTP 403 and the §7.4 denied state.
3. `app.has_permission_of(p_actor, p_org, 'dashboard.view')` **re-checked inside**
   `api_server.finish_forecast`, which also refuses any caller whose role claim is not
   `service_role`. A service-role write does not get to skip the check the page made.

An employee's assignment scoping is unchanged and inherited: an unassigned employee cannot read the
organisation's metrics, so cannot read or generate its forecast. Proven by integration test.

---

## 16. Tenant isolation

- Both tables: `enable` **and** `force` row level security, owned by `motion_definer`.
- SELECT policies are ADR-065 set-membership via `app.org_ids_with_role(variadic …)`.
- `revoke insert, update, delete, truncate … from authenticated, anon` — no write path exists for a
  user session at all.
- Every foreign key is **composite** on `(organization_id, …)`: `forecast_values → forecast_runs`,
  `→ fiscal_periods`, and `forecast_runs → calculation_runs` / `fiscal_periods`. A row cannot
  reference another tenant's run, period or calculation even in principle.
- `unique (organization_id, id)` on both tables is what makes those composite keys possible.
- The evidence bundle passes through the ADR-092 polymorphic guard, which raises on an unmapped
  discriminator rather than silently permitting one.
- Cross-tenant reads and writes are asserted directly in `test/integration/forecast.test.ts` against
  two live organisations.

---

## 17. Performance

- **Generation** is five reads and one write RPC: `loadHistory` (one query over
  `metric_current!inner metric_snapshots` joined to `fiscal_periods`), `loadHorizon`,
  `latestCalculationRunId`, and then one `api_server.finish_forecast` call that inserts the run, all
  values, the bundle and its items in a **single transaction**. There is no N+1 over metrics or
  periods.
- **Reading** the page is two queries: the latest run (`forecast_runs_recent` index,
  `(organization_id, generated_at desc)`) and its values (`forecast_values_lookup` index,
  `(organization_id, forecast_run_id, period_id)`).
- **Generated on demand, not on every calculation run.** Most organisations never open the page;
  computing a forecast on every recalculation would be work nobody asked for. This follows the
  evidence-bundle precedent (ADR-066).
- **Staleness is a stated fact, not a cache risk.** Each run stores the `calculation_run_id` it
  read; when a newer calculation exists the page says the figures have changed since this was worked
  out and offers regeneration. Nothing is cached beyond the stored row.
- The domain layer is pure and allocation-light: `MAX_PERIODS = 12` points per metric, ten metrics,
  three horizon months — the arithmetic is negligible next to the round trips.

---

## 18. Database changes

One migration, `supabase/migrations/20260912000002_forecast.sql`:

| Change | Detail |
|---|---|
| `create type public.forecast_basis_enum` | `strong` · `limited` · `weak` |
| `create table public.forecast_runs` | method, config version, `calculation_run_id`, basis window, `periods_used`, `horizon_months`, `basis`, `breakdown` jsonb, `unavailable` jsonb, `generated_at`, `generated_by` |
| `create table public.forecast_values` | `numeric(20,6)` value, currency, `assurance_level` **default `estimated` + CHECK `= 'estimated'`**, `derivation` CHECK `in ('baseline','identity')`, `derived_from text[]` |
| indexes | `forecast_runs_recent`, `forecast_values_lookup` |
| `alter type evidence_kind_enum add value 'forecast'` | — |
| `evidence_bundles_origin_table_known` | recreated including `forecast_runs` |
| `same_org_ref_origin` trigger | dropped and re-registered with the full discriminator map (ADR-092) |
| RLS | enable + force on both, `definer_all`, and the five-role select policies |
| grants | `select` to `authenticated`; all writes revoked; `all` to `service_role` |
| `create function api_server.finish_forecast(uuid, uuid, jsonb, jsonb)` | run + values + bundle + items + `app.audit('forecast.generated')`, one transaction, `security definer`, `search_path = ''`, owner `motion_definer`, execute granted to `service_role` only |

`src/core/db/server-rpc.ts` gains `finishForecast(...)`, exported from `src/core/db/index.ts`.

**Documentation was updated, not the gate.** The schema-drift gate refused the migration until
`docs/DATABASE_ARCHITECTURE.md` carried `### forecast_runs`, `### forecast_values` and the
`finish_forecast` row in the §14 function catalogue. That is the gate working; the documents were
brought up to the schema rather than the check suppressed. Drift now reports **46 tables, 107 api
functions**.

---

## 19. Tests

No existing test was deleted, weakened or edited to match a wrong implementation. Every defect found
below was fixed in the code.

| Suite | File | Count |
|---|---|---|
| Unit — the engine | `test/unit/forecast-baseline.test.ts` | **33** |
| Integration — storage, RLS, roles, tool | `test/integration/forecast.test.ts` | **19** |
| Integration — AI tool registry | `test/integration/ai-tools.test.ts` (17 → 18) | 22 |
| AI evaluation | `test/fixtures/ai/corpus.ts` + `ai-eval-record.test.ts` | **151** |
| Playwright journey | `e2e/journey-11-forecast.spec.ts` | **2** |

What the unit tests actually assert: refusal below `MIN_PERIODS`; a gap truncating the window rather
than being averaged across; incomplete periods excluded; the MAD one-off rule **including the
zero-MAD fallback**; the exclusion cap; linear recency weights; order-independence (shuffled input,
identical output); byte-identical reruns; each identity; the cash chain opening on the last actual;
`closing_cash` absent with no bank data; `gross_profit`/`operating_profit` absent under CD-05.

What the integration tests actually assert: the stored figures read back exactly; the
`forecast_values_estimated` CHECK **refusing** an insert that claims `verified`; the evidence bundle
citing snapshots and the calculation run with the history's own assurance; the tool returning
precisely what was stored; cross-tenant reads returning nothing; a client able to read; an
unassigned employee unable to; `suspended_member` frozen out; regeneration replacing the read
forecast and the staleness flag clearing.

Full gate results are in §21 of the delivery report; every gate is green.

---

## 20. Known limitations

Stated rather than hidden, in the order a reader is likely to hit them:

1. **Level, not trend.** `baseline.v1` carries the recent level forward. A business growing 15% a
   month will see a forecast below where it lands. This is a deliberate choice (§2, ADR-099), not an
   oversight — adding a slope is a `baseline.v2` decision with its own justification to write.
2. **No seasonality model.** A twelve-month window lets a seasonal year sit *inside* the average,
   but December is not treated as December. Most MOTION organisations will not have twelve complete
   months for some time.
3. **Three months only.** Longer horizons are not offered because the method does not support them
   honestly.
4. **Confidence is a word, not an interval.** No prediction interval is produced, because §19
   forbids inventing a number and there is no honest one to compute from three points.
5. **Not recomputed automatically.** A forecast is generated when asked. It reports its own
   staleness but does not refresh itself when new figures land.
6. **Receivables and payables are carried as levels**, with no ageing or collection-pattern
   modelling. That is Commercial/Banking Intelligence work, explicitly out of this phase.
7. **No what-if.** Changing an assumption and seeing the effect is Phase 12, and the analyst still
   refuses it by name.
8. **One method.** There is no per-organisation choice of forecasting method, and no manual
   override of a forecast figure.
9. **Metric coverage is the engine's.** Anything the engine cannot compute for an organisation, the
   forecast cannot forecast — it says so with a reason rather than approximating.

---

## 21. Architectural decisions

**ADR-099 — Forecasting is a statement about the engine's figures, kept in its own tables**
(appended to `docs/ARCHITECTURAL_DECISIONS.md`). It records: separate tables rather than
`metric_snapshots`; leaves forecast and identities derived; `baseline.v1` and the deliberate absence
of trend; the sufficiency rules and where each number came from; median/MAD with the zero-MAD
fallback; confidence as three words; on-demand generation with recorded staleness; evidence as the
history rather than the future; the analyst reading but never computing, with the refusal-template
split and the `PROMPT_VERSION` bump; and reaching `/forecast` from Money so the seven-item primary
navigation (`UX_ARCHITECTURE.md §3.1`, ADR-037) is preserved.

Documents updated in the same commit: `docs/DATABASE_ARCHITECTURE.md` (two table sections, one §14
catalogue row), `docs/AI_ARCHITECTURE.md` (tool 18 row, and the paragraph distinguishing forecast
answerability from what-if refusal), `docs/ARCHITECTURAL_DECISIONS.md` (ADR-099).

No earlier ADR was superseded or reversed.
