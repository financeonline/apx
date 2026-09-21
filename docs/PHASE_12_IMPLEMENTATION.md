# MOTION — Phase 12: What-If Scenarios

Date: 2026-09-21 · Branch `main`, on top of `434a457` · Decision recorded: ADR-100
Scope: Scenarios only. No Phase 13 Banking Intelligence, no Commercial Intelligence, no Adviser/CFO
Command Centre, no Funding Readiness, no advanced Reporting, no knowledge-base or embedding work.

---

## 0. What already existed

The brief was explicit that documentation and code may disagree, so the first pass was an inventory
rather than a build. What a scenario needed, and whether it was there:

| Piece | State before Phase 12 | Where |
|---|---|---|
| A deterministic forecast over the next three months | existed | Phase 11, ADR-099 |
| `composeFromLevels` — leaves → identities → cash chain | existed, but **inline inside `composeForecast`** | `forecast/domain/compose.ts` |
| `buildBaseline` / `selectWindow` — sufficiency, continuity, one-offs, recency | existed and exported | `forecast/domain/baseline.ts` |
| `expense_by_category` per standard category, with `dimension_key` | existed | Phase 6, ADR-055.1 |
| Evidence bundles, the `origin_table` allow-list and the polymorphic guard | existed | ADR-092, ADR-096, ADR-099 |
| Clone-a-bundle-on-decision (an action copies its source's items) | existed | `EVIDENCE_MODEL.md §5` |
| `api_server.finish_forecast` — the "server computes, writes whole, one transaction" precedent | existed | ADR-099 |
| **A scenario table, service, page or AI tool** | **absent** | — |
| Analyst behaviour on "what if I raise prices 10%?" | **refused**, on the grounds that the feature did not exist | `ai/domain/prompt.ts` |

So Phase 12 is genuinely new work sitting on a finished Phase 11. **Nothing in Phases 1–11 was
redesigned.** One behaviour-preserving extraction was made (§1); no second evidence path, no second
persistence mechanism, no second definition of a metric and no new permission were created.

---

## 1. Scenario architecture

```
forecast_values ──► loadForecast()      basisFromForecast()        domain/apply.ts
  (the baseline,     ForecastView   ──►  leaf levels          ──►  sufficiency()  → refuse, or
   per period,                           + last actual cash        deltasFor()    → per-month deltas
   per metric)                                │                           │
metric_current ───► loadCategoryLevels()      │                           ▼
  expense_by_category  payroll / marketing ───┘             composeFromLevels()  ×2
  (only when a percentage needs one)                        baseline │ scenario
                                                                     ▼
                                                  api_server.finish_scenario()
                                                  ├─ scenario_runs   (one row)
                                                  ├─ scenario_values (both figures per cell)
                                                  ├─ evidence_bundles + items (cloned)
                                                  └─ app.audit('scenario.created')
                                                                     │
                            /app/{org}/what-if  ◄── loadScenario() ◄──┘
                            AI tool 19 get_scenario ◄──┘
```

Eight files, one migration, one extraction:

| File | Lines | What it is |
|---|---|---|
| `src/modules/scenarios/domain/config.ts` | 134 | `scenario.config.v1` — the eight kinds, the bounds, the cash defaults |
| `src/modules/scenarios/domain/types.ts` | 144 | shapes; money is a string throughout |
| `src/modules/scenarios/domain/assumptions.ts` | 247 | Zod parse, per-kind bounds, conflict rules |
| `src/modules/scenarios/domain/apply.ts` | 368 | sufficiency, deltas, both sides composed |
| `src/modules/scenarios/domain/presentation.ts` | 143 | every word a reader sees |
| `src/modules/scenarios/data/repository.ts` | 268 | category levels, saved scenarios, bundle ids |
| `src/modules/scenarios/services/index.ts` | 419 | `runScenario`, `loadScenario`, `listScenarios`, `archiveScenario` |
| `supabase/migrations/20260921000001_scenarios.sql` | 290 | two tables, RLS, `api_server.finish_scenario`, `api.archive_scenario` |
| `src/modules/forecast/domain/compose.ts` | +65 −20 | `composeFromLevels` extracted from `composeForecast` |

**The one change to Phase 11, and why it is not a redesign.** `composeForecast` walked the horizon
inline, applying the engine's identities and chaining cash. Phase 12 needs *the same walk* over
*different levels*, and §6's instruction — "Do not duplicate forecast calculations" — forbids a
second copy. The walk was therefore extracted into `composeFromLevels(horizon, levelsAt, openingCash)`
and `composeForecast` became its caller with a constant level per metric, which is exactly what it
did before. The proof that behaviour is unchanged is mechanical: Phase 11's 33 unit cases pass
unedited.

**Where the LLM sits.** Nowhere in the calculation, and nowhere near an assumption. See §10.

---

## 2. Assumption model

Eight kinds, one for each change SOW §14 names (REQ-SC-02…08). Every one carries the month it starts
(1–3) and, where it is a choice, whether it also moves cash.

| Kind | Fields | Moves |
|---|---|---|
| `revenue_change` | `mode` (percent/amount), `value`, `directCostsFollow` | `revenue`, optionally `cost_of_sales` |
| `pricing_change` | `pricePercent`, `volumePercent`, `directCostsFollow` | `revenue` by (1+p)(1+v)−1; `cost_of_sales` by volume alone |
| `payroll_change` | `mode`, `value` | `operating_expenses` |
| `marketing_change` | `mode`, `value` | `operating_expenses` |
| `supplier_cost_change` | `mode`, `value` | `cost_of_sales` |
| `hiring` | `headcount`, `monthlyCostPerPerson` | `operating_expenses` |
| `debt_drawdown` | `amount` | `cash_inflows`, once, in its month |
| `debt_repayment` | `monthlyAmount`, `monthlyInterest \| null` | `cash_outflows`, every month from its month |

"Debt" and "repayment" are separate kinds although the SOW lists them on one line: they are opposite
cash movements with different shapes — borrowing is money arriving once, a repayment is money
leaving every month — and one kind would have had to ask for a signed number, which is the sort of
question §15 exists to prevent.

**Nothing is hidden inside an opaque calculation.** Every assumption is stored as given, rendered as
a sentence beneath the figures, and returned by the AI tool as structured branded fields. The cash
answer is a field with a stated default per kind, never an implication (§7); the defaults are costs
move cash, sales do not, and both are shown beside the figure they apply to.

---

## 3. Supported scenario types, and what each one deliberately does not do

- **Sales (REQ-SC-02).** Moves `revenue`. Direct costs stay still unless `directCostsFollow` is set,
  and when it is, they move at the organisation's **own** rate — the ratio of its forecast
  `cost_of_sales` to its forecast `revenue`. Both answers are assumptions and both are displayed;
  §7's "do not invent margins" is satisfied by reading one rather than choosing one.
- **Prices (REQ-SC-07).** `pricePercent` and `volumePercent` are both required, and `0` volume is a
  real answer meaning "the same number of sales". A 5% price rise with volume held is a 5% revenue
  rise *because the user said the volume holds*, not because MOTION assumed it. Direct costs follow
  **volume**, never price: a price change does not make anything cost more to buy.
- **Wages (REQ-SC-03), marketing (REQ-SC-05).** Move `operating_expenses`. A percentage is taken of
  the engine's own `expense_by_category` level for `payroll` / `marketing`; an amount needs no
  baseline. Marketing adds **no revenue, ever** — no relationship in MOTION's data defines one (§10),
  and the form says so in the row itself.
- **Supplier costs (REQ-SC-04).** Move `cost_of_sales`, so gross profit and operating profit both
  move. Refused outright for an organisation with no cost-of-sales accounts (CD-05).
- **Hiring (REQ-SC-06).** `headcount × monthlyCostPerPerson`, from the chosen month. The cost is
  required; without it the scenario is not worked out (§8). Nothing about a payroll cost is assumed.
- **Debt and repayments (REQ-SC-08).** Principal, repayment and interest are separate amounts and
  each is cash. Interest is never derived from a principal — no rate is held anywhere in MOTION
  (§11) — and because `interest_expense` sits below the operating line in the engine, interest
  changes cash and **not** operating profit, which the page states in words.

---

## 4. Baseline

Every scenario has an explicit baseline and it is **the forecast**, unchanged (§5).
`basisFromForecast` reads the stored forecast the user is looking at and recovers the leaf levels
from it. Two of them are not stored as forecast figures and are recovered by the engine's own
identities, exactly:

```
cost_of_sales   = revenue − gross profit
opening balance = closing cash (month 1) − change in cash (month 1)
```

Both come out of the **same stored run** whose figures the baseline column will show, which is what
keeps the two halves of the comparison about one thing. The baseline column is then re-composed
through `composeFromLevels` from those levels — so it is the forecast by construction, and
`test/integration/scenarios.test.ts` asserts in SQL that every `scenario_values.baseline_value`
equals the `forecast_values.value` for the same run, period and metric.

Six figures are shown, in the order §5 names them: Revenue, Running costs, Operating profit, Cash at
the end, Owed to you, Owed by you. A metric the forecast could not produce is absent with its
reason, never zero.

---

## 5. Scenario calculation

For each of the three months, the deltas of every assumption active that month are summed per leaf,
added to the baseline levels, and the result composed by `composeFromLevels`. The page then shows
BASELINE, SCENARIO, CHANGE and CHANGE % per metric; the percentage is `NULL` when the baseline is
zero, which is the engine's own rule for a variance across zero (`FINANCIAL_ENGINE.md §3.2`) rather
than a second one invented here.

**The cascade is the engine's, not a copy of it.** `gross_profit = revenue − cost_of_sales`,
`operating_profit = gross_profit − operating_expenses`, `net_cash_movement = inflows − outflows`,
and `closing_cash` chains from the last **actual** closing balance. Because both sides go through
the same function, the scenario cannot contradict the forecast and neither can contradict the
engine.

**Determinism.** The domain is pure: no clock, no randomness, no ordering dependence. Assumptions
are sorted into a fixed kind order before application, a unit test shuffles them and asserts a
byte-identical result, and another asserts two runs of the same question agree byte for byte.

---

## 6. Data sufficiency

MOTION applies an assumption only where the figure it moves exists. Where it does not, the **whole**
scenario is unavailable with the reason and **nothing is stored** — a partly applied scenario would
sit in the list looking like a complete answer (§7).

| Reason | The condition the server checked |
|---|---|
| `no_forecast` | There is no forecast to change; the page sends the reader to make one |
| `metric_not_forecast` | The forecast could not produce the leaf this change moves (sales, running costs, money in, money out) |
| `no_category_baseline` | A percentage of wages or marketing, with no `expense_by_category` level to take it of. The amount form is offered instead |
| `no_direct_costs` | CD-05: the books have no cost-of-sales accounts, so there are no direct costs to move and no gross profit to invent |
| `no_revenue_baseline` | An amount of extra sales whose direct costs should follow, against forecast sales of zero — there is no share to compute |

A change assumed to move cash is refused when there is no cash figure to move; the same change with
"does not change cash" is accepted, and the page says which.

Each reason is rendered in words by `presentation.ts` and never shown raw.

---

## 7. Data quality

- A scenario **inherits** the forecast's basis (`strong` / `limited` / `weak`), its config version,
  whether it was already stale when the scenario was made, and the list of metrics the forecast
  refused. All of it is stored on `scenario_runs.data_quality` and shown in "Not included".
- Every `scenario_values` row is `estimated` by DEFAULT and by CHECK. A scenario result is not an
  actual and not a forecast, and there is no way to write one that claims more.
- The three claims are kept apart in words as well as in tables: "Expected now" against "If this
  happens", under a disclaimer that says in one sentence that these are neither results nor a
  forecast.
- The assurance ladder is unchanged and no new level was invented; a scenario simply sits at
  `estimated`, which is the weakest thing the forecast's own figures can be.

---

## 8. Saved scenarios

A scenario is saved the moment it is worked out, under a name the person gave it, and then it never
changes.

**Both figures are stored per cell.** A row holding only the scenario figure would be compared, on
reopening, against whatever the forecast says *then* — so regenerating a forecast would silently
rewrite the history of every saved scenario. Storing the pair makes a saved scenario a fixed
statement about a fixed baseline (§13). An integration test raises the organisation's history, works
the forecast out again, reopens the saved scenario and asserts both figures are what they were.

What *can* change is whether the forecast underneath is still the one it was made from, and that is
reported: the page says the forecast has moved on and offers a new scenario. Nothing is silently
recalculated.

`method` and `config_version` are stamped on every run, so two scenarios made under different rules
are never comparable by accident.

**Archived, never deleted.** `api.archive_scenario` takes one out of the list and can bring it back.
Deleting would leave the scenario's evidence bundle citing a row that no longer exists, which
`EVIDENCE_MODEL.md §8` does not allow.

---

## 9. Evidence integration

`evidence_kind_enum` gains `scenario`; the ADR-092 `origin_table` allow-list gains `scenario_runs`;
the polymorphic guard `same_org_ref_origin` is dropped and re-registered **complete**, so the drift
gate's "every discriminator value is mapped" assertion stays satisfied.

A scenario bundle's origin is the **run**. Its items are **copied from the forecast's bundle** — the
same clone-on-decision pattern an action already uses (`EVIDENCE_MODEL.md §5`). Three consequences,
all deliberate:

1. A scenario rests on exactly the history its baseline rests on: the metric snapshots the forecast's
   baselines read, and their calculation run.
2. Nothing about an assumed future is cited, because there is nothing about an assumed future to
   cite.
3. A regenerated forecast cannot change what a saved scenario says it rests on, because the items
   were copied rather than pointed at.

Each item keeps the **history's** own assurance while every scenario value stays `estimated`. The
bundle is written in the same transaction as the run and its values, so a scenario can never be
half-visible or exist without its evidence. No second evidence system was created.

---

## 10. AI integration

**The LLM is not the scenario calculator, and cannot become one.**

- Tool 19 `get_scenario` (`ai/domain/tools/intelligence.ts`), permission `dashboard.view`, input
  `{ scenario_id? }` and **nothing else**. It reads `scenario_values` and returns branded `money`
  envelopes for **both** halves of every cell, plus the assumptions as structured branded fields,
  the basis, staleness and the evidence bundle id. The scenario's name is text somebody typed and is
  wrapped `untrusted`.
- **There is no tool that takes an assumption.** That is the structural answer to the brief's
  adversarial case, "make the scenario assume revenue is ₹50L without the user providing that
  assumption": there is no surface on which a model-invented assumption could become a figure, so
  the attack has nothing to aim at. An integration test posts exactly that payload at the tool and
  asserts Zod strips it and the stored figures come back unchanged.
- Because both halves cross as branded envelopes, the model cannot quote a scenario figure as though
  it were the expectation it is being compared against; and a figure the model worked out itself
  would have no `NumberRef` and the sentence would be removed by grounding (§7.8).
- Every scenario figure carries `assurance: estimated` from the response contract, so it is marked
  as an estimate without the model having to remember.

**The refusal template changed meaning.** It no longer claims what-ifs are unavailable — they are —
it says *who does the arithmetic and where*:

| Question | Phase 11 | Now |
|---|---|---|
| "What if I raise prices 10%?" | refused: "not available yet" | **still refused**, with: "I can't work a what-if out myself. MOTION works them out on its What-if page, from your own figures, and I can read one back once it is saved:" |
| "What does my saved scenario say?" | refused | **answered** from the stored scenario, or the same honest refusal when nothing is saved |

`PROMPT_VERSION` bumps `analyst-v3.2` and the eval corpus was re-recorded. The corpus gains
`adv:scenario-invent` (four cases where the model is asked to supply the assumption itself, asserting
the planted figure appears nowhere) and `adv:scenario-none-saved` (three cases against an
organisation with nothing saved).

**A tool that RAN a scenario from model-supplied assumptions was considered and rejected.** It would
have satisfied §18 by the letter — the service would still have done the arithmetic — and would in
practice have been a machine for producing confident answers to questions nobody asked, because the
model chooses the assumptions. Recorded in ADR-100.

---

## 11. Action Centre integration point

Nothing is created automatically, and no new action workflow was built (§17). The scenario page ends
with one line — "Decided to do something about this? Record it in your actions" — linking to the
existing Action Centre, where a person types what they have decided and confirms it.

The integration *point* that a later phase would use is the scenario's evidence bundle: it is built,
it is org-composite, and `app.clone_bundle_for_action` already knows how to copy a bundle into an
action. Creating an action **from** a scenario, with that bundle cloned, is deliberately **not**
built in Phase 12 and is listed under known limitations.

---

## 12. RBAC

| Role | Read a scenario | Work one out / archive |
|---|---|---|
| `owner`, `admin`, `employee` (assigned), `super_admin` | ✓ `dashboard.view` | ✓ `intelligence.recompute` |
| `client` | ✓ | ✗ — the form is hidden, not disabled, and the page says who can |
| `suspended_member` | ✗ — frozen to Home (ADR-044.4) | ✗ |
| Anyone without `dashboard.view` | `NotFound`, never a 403 that would confirm the organisation exists | ✗ |
| `authenticated` (any role) | — | **zero write grants** on both tables (ADR-026) |

**No new permission was invented.** §19 and §22 forbid one that could sit outside the matrix, and
ADR-099 set the precedent. Reading is `dashboard.view` because a scenario is a statement about
figures and has exactly the reach those figures already have. Working one out is
`intelligence.recompute` — "trigger a manual calculation run" — because that is what running a
scenario is, and its role set (owner, admin, employee, super admin; not client) is the right one.

Enforced in **three** places, on purpose:

1. `requirePermission(ctx, 'dashboard.view')` on the page (ADR-091) and `can(...)` around the form.
2. `assertCan` in `runScenario` / `archiveScenario`, and again in the server action.
3. `app.has_permission_of(p_actor, p_org, 'intelligence.recompute')` re-checked **inside**
   `api_server.finish_scenario`, which also refuses any caller whose role claim is not
   `service_role`; and `app.require_permission` inside `api.archive_scenario`.

An employee's assignment scoping is unchanged and inherited: an unassigned employee cannot read the
organisation's forecast, so cannot read or work out its scenarios. Proven by integration test, as is
the `aal1` case.

---

## 13. Tenant isolation

- Both tables: `enable` **and** `force` row level security, owned by `motion_definer`.
- SELECT policies are ADR-065 set-membership via `app.org_ids_with_role(variadic …)`.
- `revoke insert, update, delete, truncate … from authenticated, anon` — no write path exists for a
  user session at all.
- Every foreign key is **composite** on `(organization_id, …)`: `scenario_values → scenario_runs`,
  `→ fiscal_periods`, and `scenario_runs → forecast_runs`. A scenario cannot reference another
  tenant's forecast, period or run even in principle — asserted directly by attempting exactly that
  insert **as the service role** and watching the constraint refuse it.
- `unique (organization_id, id)` on both tables is what makes those composite keys possible.
- The evidence bundle passes through the ADR-092 polymorphic guard, which raises on an unmapped
  discriminator rather than silently permitting one.
- Every id the product accepts — a scenario id in a URL, a scenario id in the AI tool — is resolved
  with `(organization_id, id)`, so a foreign id is `NotFound`/`NO_DATA` and never a 403 that would
  confirm the row exists.
- Cross-tenant reads, archives and writes are asserted in both directions in
  `test/integration/scenarios.test.ts`.

---

## 14. Performance

- **Editing is free.** The form is plain HTML — eight `<details>` elements with ordinary inputs — so
  changing an assumption costs no server work and no query. Nothing is recalculated until the
  person presses "Work it out" (§22).
- **Running is three reads and one write.** `loadForecast` (its own two queries), one
  `lastCompletePeriodStart`, and one `loadCategoryLevels` — **only** for the categories the chosen
  assumptions actually need a percentage of, so a scenario with no percentage reads none. Then one
  `api_server.finish_scenario` call that inserts the run, every value, the bundle and its items in a
  single transaction. There is no N+1 over metrics or periods.
- **Reading is four small queries**: the run with its values (`scenario_values_lookup`), its bundle
  id, the id of the newest forecast (for staleness — asking `loadForecast` would have cost five
  queries to learn one id), and the period labels. The list page reads names only, not figures.
- **The engine is not re-run.** A scenario never touches `calculation_runs`,
  `app.aggregate_periods` or `metric_snapshots`: it reads the forecast's stored output. The
  arithmetic is ten metrics over three months.
- Nothing is cached beyond the stored row, and staleness is a stated fact rather than a cache risk.

---

## 15. Database changes

One migration, `supabase/migrations/20260921000001_scenarios.sql`:

| Change | Detail |
|---|---|
| `create table public.scenario_runs` | name, `forecast_run_id` (org-composite FK), method, config version, `assumptions` jsonb, horizon, basis, `data_quality` jsonb, `unavailable` jsonb, `archived_at`, `created_by` |
| `create table public.scenario_values` | `baseline_value` and `scenario_value`, both `numeric(20,6)`; `assurance_level` **default `estimated` + CHECK `= 'estimated'`**; `derivation` CHECK `in ('baseline','identity')`; `derived_from text[]` |
| indexes | `scenario_runs_recent`, `scenario_values_lookup` |
| `alter type evidence_kind_enum add value 'scenario'` | — |
| `evidence_bundles_origin_table_known` | recreated including `scenario_runs` |
| `same_org_ref_origin` trigger | dropped and re-registered with the full discriminator map (ADR-092) |
| RLS | enable + force on both, `definer_all`, and the five-role select policies |
| grants | `select` to `authenticated`; all writes revoked; `all` to `service_role` |
| `create function api_server.finish_scenario(uuid, uuid, jsonb, jsonb)` | run + values + bundle + cloned items + `app.audit('scenario.created')`, one transaction, `security definer`, `search_path = ''`, owner `motion_definer`, execute granted to `service_role` only |
| `create function api.archive_scenario(uuid, boolean)` | throttled, permission-checked, audited; `security definer`, owner `motion_definer`, execute granted to `authenticated` |

`src/core/db/server-rpc.ts` gains `finishScenario(...)`, exported from `src/core/db/index.ts`.

**Documentation was updated, not the gate.** The schema-drift gate refused the migration until
`docs/DATABASE_ARCHITECTURE.md` carried `### scenario_runs`, `### scenario_values` and both §14
catalogue rows. That is the gate working; the documents were brought up to the schema rather than
the check suppressed. Drift now reports **48 tables, 109 api functions**.

---

## 16. Tests

No existing test was deleted, weakened or edited to match a wrong implementation. Every defect found
below was fixed in the code or in a test expectation that was itself wrong, and both are named.

| Suite | File | Count |
|---|---|---|
| Unit — what may be assumed | `test/unit/scenario-assumptions.test.ts` | **28** |
| Unit — the words a reader sees | `test/unit/scenario-presentation.test.ts` | **14** |
| Unit — the engine | `test/unit/scenario-apply.test.ts` | **39** |
| Integration — storage, RBAC, isolation, the tool | `test/integration/scenarios.test.ts` | **39** |
| Integration — AI tool registry | `test/integration/ai-tools.test.ts` (18 → 19 tools) | 22 |
| AI evaluation | `test/fixtures/ai/corpus.ts` + `ai-eval-record.test.ts` | **158** (151 → 158) |
| Playwright journey | `e2e/journey-12-what-if.spec.ts` | **2** (with an axe sweep over the form) |
| Playwright — accessibility, authorization | `accessibility.spec.ts`, `authorization-status.spec.ts` | +1 route, +1 assertion |

What the unit tests actually assert: every one of the eight kinds; the cascade through the engine's
identities; a price rise that is not a sales rise; marketing that buys no revenue; interest that
changes cash and not operating profit; borrowing that arrives once; a change that starts in month
two; order-independence and byte-identical reruns; each of the five refusal reasons; that a refusal
yields **no** cells rather than a partial answer; that a business with no bank data still gets
profit; and — case by case — that `12abc`, `1,500`, an empty box, a lone sign, exponent notation and
`£2500` are all refused rather than read as numbers.

What the integration tests actually assert: that every stored baseline figure equals the
`forecast_values` figure in SQL; that the identities hold in the stored rows; that the `estimated`
CHECK refuses an insert claiming `verified`; that a percentage of wages reads the category and not
the total; that a saved scenario survives a regenerated forecast and reports staleness; that
archiving keeps the row and its evidence; that the bundle carries the forecast's own items with the
history's assurance; that the tool returns exactly what was stored and strips a planted assumption;
that a client may read but not run or archive, proven at the service AND by a direct
`api.archive_scenario` call with the client's own token (SQL refuses 42501) and with a
stranger's (P0002, rather than confirming the row exists); that an unassigned employee and an
`aal1` employee see nothing; that cross-tenant reads, archives and service-role writes all fail; and that
`scenario.created` records who assumed what.

**Three defects found during the build. Two were fixed; the third was measured and attributed.**

> **The money lint rule caught three real ADR-006 violations.** `basisFromForecast` and the view
> builder subtracted money with `Number.parseFloat`, and the assumption bound checks compared with
> `Number()`. All three were rewritten in `Decimal`. They would not have produced a visible error —
> which is exactly why the rule exists.

> **A test expectation was wrong, and the code was right.** The first cash-effect case expected
> `cash_inflows` to rise by a tenth when sales rose 10%. The engine raises it by the £1,000 of extra
> SALES, which is the correct behaviour and a different number; the expectation was corrected and
> the reason written into the test.

### A pre-existing flake found, measured, and deliberately not fixed here

`test/integration/ai-eval-record.test.ts` fails intermittently, and it is **not** Phase 12's. It
compares the live tool outputs with the recorded fixture key for key, and `keyPaths` describes an
array by its FIRST element — so the assertion is sensitive to which alert the golden organisation's
`get_alerts` returns first, and to which alerts fired at all.

Measured rather than assumed, because "it was probably already broken" is not a finding:

| Code | Database | Runs | Failures |
|---|---|---|---|
| This branch | clean (`db reset`) | 6 | 2 |
| **HEAD (`434a457`, untouched Phase 11)** | **clean (`db reset`)** | **6** | **1** |
| HEAD (`434a457`) | accumulated | 6 | 0 |

The same test, on a git worktree of the commit this phase was built on, fails on a clean database
too. Phase 12 neither introduced it nor made it worse; the pre-flight run that passed 565/565 was a
single lucky sample, which is worth saying plainly.

What actually varies is the SET of alerts the golden organisation produces: some runs give
`expense.spike_category` and `concentration.customer`, some give only one of them, and some give
`expense.spike_account` (which is suppressed whenever the category rule fires). Two candidate causes
were eliminated: `drainJobs` runs jobs sequentially, so the two `alerts.evaluate` jobs do not race;
and the flake survives a full `db reset`, so it is not fixture accumulation.

**A tiebreak was tried and reverted.** `loadAlerts` orders by `severity desc, last_evaluated_at
desc` and nothing else, and the golden organisation's two alerts are both `high` and written in one
transaction, so their order is a genuine tie. Adding `rule_key asc, id asc` was written, measured,
and found NOT to fix the failure — the alert SET still varied — so the change was reverted rather
than kept. A behaviour change to a completed phase that does not fix the thing it was written for is
scope creep with no payoff, and `ARCHITECTURE.md` reserves alert evaluation to Phase 7.

Left for whoever owns that pipeline: the alert set the golden organisation produces is not
reproducible run to run, and until it is, this test will fail about one run in three to one in six.
The Phase 12 suites are stable — `test/integration/scenarios.test.ts` was run three times in
succession and passed 37/37 each time.

Full gate results are in the delivery report.

---

## 17. Known limitations

Stated rather than hidden, in the order a reader is likely to hit them:

1. **Three months, because that is the forecast's horizon.** A scenario cannot speak about a period
   the forecast does not.
2. **A scenario needs a forecast**, and therefore three consecutive complete months. A young
   organisation is sent to the forecast page rather than shown a form that would fail.
3. **No revenue effect from marketing, hiring or price changes beyond the stated volume.** MOTION
   holds no figure that would support one. Supplying the effect as an explicit sales assumption is
   the answer, and the form says so.
4. **No payment-timing model.** "Counts as cash in the same month" is a yes/no per assumption, not a
   collection curve. Receivables and payables are carried at their forecast level and do not move
   when a scenario changes sales — modelling how a sale becomes a receivable and then cash is
   Commercial/Banking Intelligence work.
5. **No interest rate, no repayment schedule, no loan balance.** Interest is an amount somebody
   types, for as many months as they say.
6. **Nothing below the operating line.** The forecast does not carry `net_profit`, tax or interest
   as figures, so neither does a scenario. Interest shows in cash only, and the page says why.
7. **One scenario at a time.** There is no side-by-side comparison of two scenarios, and no
   best/worst/expected set.
8. **No sensitivity analysis and no goal-seek.** "What sales would I need to break even?" is the
   inverse question and is not offered.
9. **No action is created from a scenario.** The integration point is a link; cloning the scenario's
   evidence into an action is deliberately not built (§11).
10. **The analyst cannot work one out.** It reads saved scenarios only, by design (§10).
11. **A scenario is not recomputed when the forecast changes.** It reports its own staleness and
    waits to be asked again.
12. **Metric coverage is the forecast's, which is the engine's.** Anything the engine cannot compute
    for an organisation, a scenario cannot move — and it says so with a reason rather than
    approximating.

---

## 18. Architectural decisions

**ADR-100 — A scenario is the forecast with stated changes, composed by the forecast's own
arithmetic** (appended to `docs/ARCHITECTURAL_DECISIONS.md`). It records: one piece of arithmetic for
both sides and the extraction that makes that possible; separate tables and why; both figures stored
so a saved scenario cannot move; every assumption explicit and nothing inferred; a missing input as a
refusal rather than a zero; bad input never becoming a number; `dashboard.view` to read and
`intelligence.recompute` to run, with no new permission; `api_server` for the figures and `api` for
the archive; archived rather than deleted; evidence cloned from the forecast; the analyst reading but
never computing, with the refusal split and the `PROMPT_VERSION` bump, and the rejected alternative
of a compute-from-assumptions tool; no action created; and reaching `/what-if` from the forecast and
from Money so the seven-item primary navigation (`UX_ARCHITECTURE.md §3.1`, ADR-037) is preserved.

Documents updated in the same commit: `docs/DATABASE_ARCHITECTURE.md` (two table sections, two §14
catalogue rows), `docs/AI_ARCHITECTURE.md` (tool 19, the refusal split, §14.3), `docs/PRODUCT_REQUIREMENTS.md`
(REQ-SC-01…10 and REQ-AI-13 delivered), `docs/MVP_SCOPE.md`, `docs/UX_ARCHITECTURE.md`,
`docs/SERVICE_ARCHITECTURE.md`, `docs/ROUTE_ARCHITECTURE.md`, `docs/ARCHITECTURAL_DECISIONS.md`.

No earlier ADR was superseded or reversed.
