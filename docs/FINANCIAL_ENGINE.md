# MOTION — Financial Engine (Calculation, Health Score, Alerts)

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-004..008, ADR-016..018, CD-03..CD-08, CD-18, CD-19, CD-28, CD-30), `DATABASE_ARCHITECTURE.md`, `MVP_SCOPE.md §2.5–2.9`
Consumed by: `EVIDENCE_MODEL.md`, `AI_ARCHITECTURE.md`, `SERVICE_ARCHITECTURE.md`, `TEST_STRATEGY.md`, `UX_ARCHITECTURE.md`
Module homes: `src/modules/financial-engine` (metrics), `src/modules/banking` (bank rules), `src/modules/health` (score), `src/modules/alerts` (rules)

> **Revision 1.2 (red-team round 2, 2026-09-05).** Applies ADR-041 (chunked runs) and ADR-047 (R2-B-01..12): rollback resets `superseded_by`; state alerts re-open; reporting-sign balances; pinned cumulative differencing; credit-note negation and per-row VAT; declared export ranges and the `is_complete` cash exception; safe chunk chaining; narrow scheduled runs with the fingerprint computed before writes; rollback promotes dependants; receivables use the current row; two-pass alert capping with a data/user suppression split; one `transfer_kind` enum with a description gate. See `RED_TEAM_REVIEW.md §6`.

> **Revision 1.1 (red-team round 1, 2026-09-04).** Applies ADR-027, ADR-028, ADR-029, ADR-030, ADR-031, ADR-032 (§7), ADR-034, ADR-035, ADR-036. Findings addressed: F-B-01, F-B-02, F-B-05, F-B-06, F-B-07, F-B-08, F-B-09, F-B-13, F-B-14, F-B-15, F-B-16, F-B-17, F-C-07, F-C-09, F-C-12, F-C-15, F-C-16, F-D-01, F-D-02, F-D-03, F-D-04, F-D-06, F-D-09, F-D-12, F-D-18 and the below-the-cut notes on `cash.decline`, `payables_days` and coverage of stale invoices. See `RED_TEAM_REVIEW.md`.

---

## 1. Principles

1. **Deterministic.** Same accepted records + same engine version + same organization settings ⇒ byte-identical `metric_snapshots`. No clocks, no randomness, no network inside `domain/`. "Today" is an explicit input (`asOf`) used only for aging and runway.
2. **Pure domain functions.** `src/modules/financial-engine/domain/*` are functions of typed inputs to typed outputs. They never import Supabase, Next.js or the Anthropic SDK. `services/` load records through `data/` repositories and hand plain arrays to `domain/`.
3. **Only accepted records count.** Every loader filters `record_status = 'accepted'` and `superseded_by IS NULL` (ADR-016). The `superseded_by` column is the *current* state: `api.rollback_import_batch` resets it (and `superseded_at`) to NULL on every restored row and re-points chains, so restored data is visible to the engine, to `app.aggregate_periods` and to the partial unique indexes without any event lookup; `record_status_events` is history and is used only by evidence as-of resolution (ADR-047.1, R2-B-01). `pending`, `needs_review`, `duplicate`, `rejected`, `incomplete` rows are invisible to the engine.
4. **Decimal arithmetic.** `decimal.js`, 20 significant digits, `ROUND_HALF_UP`, rounding applied once at snapshot write (ADR-006). Money 2 dp; ratios 6 dp stored, 1 dp displayed; days integer; counts integer; HHI 0–1 at 6 dp.
5. **Never zero-fill.** A metric that cannot be computed is written with `value = NULL` and `data_quality.missing[]` explaining why. Zero means "we know it is zero".
6. **Versioned and materialised.** Every value is produced by a `calculation_run` and stored append-only in `metric_snapshots` with `engine_version`, `basis`, `assurance_level`, `components`, `data_quality`, `evidence_query` (ADR-008). The pointer table `metric_current` names the current snapshot per (period, key, dimension) (ADR-031.5). UI and AI read current snapshots through that pointer only.
7. **Explainable by construction.** `components` holds every named input so a reader can redo the arithmetic by hand; `evidence_query` re-selects the rows (ADR-009).

### 1.1 Where the engine stops and AI begins

The engine produces **numbers, comparisons, rule outcomes and factor lists**. The AI produces **narrative, causal hypotheses, prioritisation and recommendations** over those outputs. The boundary is a type boundary: the AI receives `MetricSnapshot`, `HealthScore`, `Alert` and `EvidenceBundle` objects through tools; it never receives raw records to sum, and no AI output is ever written into a metric, score or alert value.

| Engine (deterministic) | AI (interpretive) |
|---|---|
| `operating_expenses.variance.prev_period` = +£8,420 (+18.3%) | "Costs rose mainly because of the new warehouse lease that started in March" |
| `expense_by_category[marketing]` +£5,100 vs prior month | "Marketing spend is the largest driver of the increase" *(ranking is engine; "driver" wording and causal link to campaign is AI)* |
| `customer_concentration_top1` = 0.41 | "Losing Acme would remove 41% of revenue; consider diversifying" |
| Alert `cash.runway_low` fired: runway 2.4 months | "Priority this week: chase the three overdue invoices totalling £14,200 before paying the supplier bill due on the 28th" |
| Health Profitability dimension = 58, negative factor "gross margin fell 4.2 pts" | "Margin pressure looks like pricing rather than volume, because revenue is flat while cost of sales rose" *(labelled inference)* |

Rule of thumb: if it can be unit-tested against a golden number, it belongs in the engine. If it is a sentence with a "because", it belongs to the AI and must cite engine outputs.

---

## 2. Inputs and source precedence

### 2.1 Record sources

| Source table | Basis label | Nature | Standard-category link |
|---|---|---|---|
| `period_balances` | `period_balances` | Summary per account per month (TB/P&L/BS) | via `accounts.standard_category` |
| `ledger_entries` | `ledger` | Transaction-level debit/credit lines | via `accounts.standard_category` |
| `invoices` | `invoices` | Sales/purchase headers and credit notes | `revenue` (sales, **net of tax** per ADR-027.4), purchase invoices → `counterparties.default_expense_category` (set at first mapping, editable; unset → `uncategorised`), `receivables`, `payables` |
| `bank_transactions` | `bank` | Signed cash movements | via `category_account_id → accounts.standard_category` |

### 2.2 Coverage tests (does a source "cover" a period?)

Every batch carries a **declared export range** (`import_batches.period_start/period_end`), captured at mapping from the file (min/max dates, statement period, report header) and confirmed by the reviewer (`IMPORT_ENGINE.md §6.1`, ADR-047.6). Coverage uses the declared range, never the last posting date, so a month whose last working day is the 28th is still covered by an export declared to the 31st.
A source covers `fiscal_period P` for an organization when:

| Source | Coverage test |
|---|---|
| `period_balances` | One *winning batch* per `(P, balance_kind)`: the latest committed, non-rolled-back batch of that kind whose declared `period_start ≤ P.period_start AND period_end ≥ P.period_end` (ADR-029.2). **Kind precedence per family (ADR-047.4):** P&L families take `trial_balance` over `pnl_report`; balance families take `trial_balance` over `balance_sheet`. Cumulative-basis P&L also needs the pinned previous balance (§3), else the family is covered but values are NULL with `no_prior_trial_balance`. |
| `ledger` | ≥1 accepted `ledger_entries` row with `period_id = P` **and** a committed GL batch whose declared range spans P (`period_start ≤ P.period_start AND period_end ≥ P.period_end`). A month inside the declared range with few entries is complete; a month beyond it is `partial_month`. |
| `invoices` (revenue family) | A committed invoice batch with `invoice_list_kind = full` whose declared range spans P (ADR-047.10). An `open_items` list never defines revenue. |
| `invoices` (AR/AP families) | An invoice batch (any kind) whose declared range covers P, or a batch committed within 45 days after `P.period_end` (**freshness gate**). Otherwise the family falls through to `period_balances`/`ledger`, and if neither covers P the value is NULL with `stale_invoice_data`. |
| `bank` | For **every** active `bank_accounts` row (`is_active`, `account_type ∈ {current, savings}` for cash families): a committed statement batch for that account whose declared range spans P (a covered month with no transactions is fine). Any uncovered active cash-like account → bank coverage `partial`, expressed as `data_quality.bank_coverage_partial`. |

**Latest data date** per source = max declared `period_end` over committed batches of that source.

**`fiscal_periods.is_complete` (ADR-030.1, ADR-047.6)** = the chosen P&L source's latest data date `≥ P.period_end` **AND** (bank coverage for P is full **OR** the organization has no active cash-like bank account). Partial bank coverage is a data-quality warning, not incompleteness, so a GL organization with quarterly statements still gets complete months. `core/periods.latestCompletePeriod()` returns the latest complete period; when none exists it returns the latest period with accepted data flagged `partial`, and Home, Insights, Reports and the AI all show the "{Month} so far" treatment for it.

Coverage is computed once per run per period and stored in `calculation_runs.stats.coverage[period_id]` for the UI's "data coverage" strip.

### 2.3 Precedence by metric family (CD-03, ADR-005)

The first covering source wins for the whole family in that period. Sources are **never summed across** for one metric-period.

| Family | Metric keys | Ordered sources | Assurance when chosen |
|---|---|---|---|
| P&L | `revenue`, `cost_of_sales`, `gross_profit`, `gross_margin`, `operating_expenses`, `operating_profit`, `operating_margin`, `other_income`, `other_expense`, `interest_expense`, `tax_expense`, `net_profit`, `net_margin`, `contribution_margin*`, `expense_by_*`, `customer_revenue*`, `supplier_spend*`, concentrations | `period_balances` → `ledger` → `invoices` → `bank` | `verified` for period_balances/ledger rows carrying `verified`; `calculated` for ledger/invoice aggregates; **`estimated`** when `bank` is the basis (cash proxy for accrual figures) |
| Cash | `cash_inflows`, `cash_outflows`, `net_cash_movement`, `opening_cash`, `closing_cash`, `cash_runway_months` | `bank` → `ledger` (cash-category accounts) → `period_balances` (cash accounts, movement only) | `verified` (bank), `calculated` (ledger), `estimated` (period_balances without opening balance) |
| Receivables / Payables | `receivables`, `receivables_days`, `receivables_overdue`, `payables`, `payables_days`, `payables_overdue`, `working_capital` | `invoices` → `period_balances` (`receivables`/`payables` categories) → `ledger` (same categories) | `verified` (invoices, aging available), `calculated` (balances; aging `NULL`) |
| Customer / supplier dimension | `customer_*`, `supplier_*` | `invoices` → `ledger` (entries with `counterparty_id`) → `bank` (transactions with `counterparty_id`) | as P&L family |

**Rules**

- `basis` on the snapshot is the chosen source. If a metric is derived from metrics of different bases (e.g. `working_capital` from invoice-based receivables and balance-based cash), `basis = 'mixed'` and `components.bases` lists each input's basis.
- A period with no covering source for a family writes every metric of that family with `value = NULL`, `basis = 'none'`, `data_quality.missing = ['no_source_covers_period']`.
- Bank-basis P&L figures carry `data_quality.warnings = ['cash_basis_proxy', 'vat_inclusive']`, `data_quality.proxy = true`, and the UI shows a "cash-basis estimate" tag (CD-03c, ADR-035). When `organizations.settings.vat_registered = true` and `default_vat_rate` is set, proxy revenue and expense categories flagged as taxable are netted down by the rate (still `estimated`; `components.vat_rate_applied` recorded) (ADR-027.4, CD-33).
- The dashboard header shows the basis of the P&L family for the selected period ("Accrual — from trial balance", "Accrual — from ledger", "Cash-basis estimate — from bank").

### 2.4 Calculation run algorithm (ADR-031, ADR-041, ADR-047)

The run is a chain of **chunks** of at most `CHUNK_PERIODS` (12) consecutive months, oldest first. One run row persists across chunks with `progress` and `chunks[]`; the per-organization advisory lock is taken per chunk and released between chunks. Every `calculation.run` job — first chunk or continuation — carries the single idempotency key `orgId` (ADR-047.7), so at most one calculation job per organization is ever queued and two runs can never interleave.

```
runCalculation(orgId, job):                                   -- job.payload: {trigger, triggerRefId, periodFrom,
                                                              --   periodTo, cursor?, runId?, restart_from?}
  0. sweep (every worker tick, not only here): any calculation_runs row 'running' whose latest chunk
     started longer than budget × 3 ago → if a continuation job for it is missing, re-enqueue it from
     progress.cursor (attempts + 1); after max attempts → run 'failed' {worker_lost} and pointers restored
     (step 12). Any import_batches in 'committing' whose job is dead → 'awaiting_review' (stage 'commit').
  1. acquire pg_advisory_xact_lock(hash(orgId))               -- one chunk per org at a time
  2. if job.runId is null (first chunk):
       change_set = every import_batches row committed or rolled back, every accounts.standard_category
         change, every bank categorisation/transfer edit, every record_status_events row (supersede,
         unsupersede, reject, restore, promote), every counterparties.merged_into_id change and every
         settings change with a timestamp later than the last *succeeded* run's started_at
       affected  = min period over change_set (full range for account_remapped / settings_changed /
                   recalc_manual / engine major bump)
       scheduled trigger (ADR-047.8): affected = the current period only, and only registry keys with
         as_of_dependent = true (receivables_overdue, payables_overdue, *_days, cash_runway_months,
         recurring status); the pointer rewrite in step 8 is limited to that key set
       period_from = min(affected) − 12 months (comparison inputs, read-only)
       period_to   = min(latest fiscal_period with accepted P&L or bank records,
                         current month in organizations.timezone)         -- ADR-030.5
       as_of       = today in organizations.timezone (core/periods/clock.ts)
       fingerprint = sha256(aggregate metadata: max record_status_events.at, row counts per source,
         accounts.standard_category map, category_history heads, counterparties.merged_into_id map,
         settings, detector_version, as_of::date when period_to is the current period)
       if fingerprint = last succeeded run's fingerprint and trigger ∉ {recalc_manual}:
         insert calculation_runs {status:'succeeded', stats.no_change = true}; return   -- ADR-047.8
       insert calculation_runs {status:'running', engine_version, period_from, period_to, as_of, job_id,
         input_fingerprint, progress:{periods_done:0, periods_total}}
     else (continuation):
       run = calculation_runs[job.runId]
       if job.payload.restart_from is set: finish this chunk (steps 3–9), then mark run 'superseded' and
         enqueue a fresh first chunk with periodFrom = restart_from (ADR-047.7); return
       assert metric_current for the chunk's boundary period (cursor − 1 month) points at this run,
         else mark run 'superseded' and return (another run overtook it)
  3. chunk = periods [cursor, cursor + CHUNK_PERIODS)
     delete from metric_snapshots where calculation_run_id = run.id and period_id in chunk   -- idempotent retry
  4. aggregated_at = transaction_timestamp()
     aggregates = app.aggregate_periods(orgId, chunk_from − 12 months, chunk_to, aggregated_at)  -- SQL
       returns per period × source × standard_category × account_id × counterparty_id × bank_account_id:
       Σ debit, Σ credit, Σ amount, row_count, min/max date over accepted, non-superseded records
       (superseded_by IS NULL — the column, ADR-047.1), excluding is_transfer of every kind for P&L
       families and cash_transfer legs for cash families; the TypeScript engine never iterates raw rows
     load accounts, counterparties, bank_accounts, opening balances, invoice headers for AR/AP aging
     (bounded set), organization settings (fiscal year per batch, currency, timezone, VAT)
  5. banking.detectRecurring(chunk) → recurring_payment_groups (detector_version in the fingerprint), so
     recurring status is a run input, not a separately timed job (ADR-047.11)
     coverage = computeCoverage(aggregates, periods); maintain fiscal_periods.is_complete
  6. for P in chunk ascending (only P ≥ affected are written; earlier periods are inputs):
       basisByFamily = choosePrecedence(coverage[P])
       compute in dependency order L0..L7 (L0 = the SQL aggregates); cross-period inputs (opening cash,
       trailing averages, YoY) read metric_current of the previous period, which this run wrote in the
       previous chunk (never parallel within a run)
       conditions(P) = dataSuppressed-filtered outcomes of the pure alert rule functions (§8.3): the
       same functions and the same data-only suppression feed health K3/B3 and the alert job, so the
       score never depends on who dismissed what (ADR-047.11)
       each metric → MetricResult {value|null, unit, basis, assurance, components, data_quality,
         evidence_query{ …, as_of: {calculation_run_id, aggregated_at} }}
  7. health for complete periods of the chunk (ADR-030.4)
  8. write in one transaction:
       insert metric_snapshots (append-only)
       for each period in chunk: for each pointer to be replaced, record previous_snapshot_id;
         delete from metric_current where organization_id = orgId and period_id = P
           [and metric_key in as_of_dependent set, for scheduled runs];
         insert pointers for every snapshot written                       -- retires vacated dimensions
       health_scores rows + health_current pointers
       calculation_runs.chunks += {cursor, aggregated_at, finished_at}; progress.periods_done += |chunk|
  9. if more periods: enqueue continuation {runId, cursor: chunk_to + 1 month} (key orgId); return
 10. final chunk: update calculation_runs {status:'succeeded', finished_at}
     set import_batches.calculation_run_id = run.id for every batch in change_set
     enqueue 'alerts.evaluate' {orgId, runId, period_from: affected, period_to}
 11. stale check: if any change_set-qualifying event has a timestamp > run.started_at → run.stale = true
     and enqueue a fresh first chunk from the earliest affected period (the loop terminates because each
     new run only covers changes newer than the previous run's start)
 12. on failure of the final attempt: run 'failed' with error; restore metric_current for every period
     the run rewrote from previous_snapshot_id (pointers are never left mixed between runs)
```

**Affected periods by trigger** — the table below is the *minimum*; step 2 always unions every change since the last succeeded run, so a second batch committed while a job was queued or running is never lost (F-D-01, F-B-13).

| Trigger | `affected` |
|---|---|
| `import_commit` / `import_rollback` / `import_replace` | periods of committed/rolled-back rows (declared `import_batches.period_start/period_end`) |
| `account_remapped`, `settings_changed` | every period with data; these triggers **debounce for 5 minutes** and the UI offers an explicit "Apply changes" action so a bookkeeper remapping 15 accounts causes one run |
| `banking_edit` (category override, transfer pair/unpair, opening balance), `record_superseded`, `counterparty_merged` | periods of the edited rows onward |
| `recalc_manual`, engine major bump | every period with data |
| `scheduled` (daily) | the current period only, `as_of_dependent` keys only (ADR-047.8) |

**Idempotency and no-change runs.** The fingerprint is computed *before* any write from aggregate metadata (step 2) and compared with the last succeeded run; an equal fingerprint finishes immediately as `succeeded (no_change)` unless the trigger is `recalc_manual`. Because `as_of::date` enters the fingerprint only when the current period is in range, a daily scheduled run recomputes aging, overdue, runway and recurring status for the current period and nothing else (F-B-14, R2-B-08). Two identical runs produce identical snapshot rows apart from ids and timestamps; `TEST_STRATEGY.md` asserts this.

**Coalescing and restart (ADR-047.7).** All `calculation.run` jobs share the key `orgId`. A fresh enqueue while a first chunk is `queued` merges `periodFrom = LEAST(...)`. A fresh enqueue while a continuation is `queued` merges `payload.restart_from = LEAST(existing, new)`: the continuation finishes its chunk, marks the run `superseded`, and starts a new run from `restart_from`. A chunk that finds `metric_current` for its boundary period pointing at another run exits `superseded`. A run therefore either completes every chunk under its own pointers or is replaced wholesale; readers never see 2023 from one run and 2024 from another.

**Evidence instant.** Each chunk records `aggregated_at`; the descriptors of that chunk's snapshots carry it in `as_of`, and the resolver reproduces the chunk's selection as of that instant using `record_status_events` and the history tables (`EVIDENCE_MODEL.md §3`, ADR-046.2/ADR-047.7).

**Retention.** Snapshots referenced by `metric_current`, `evidence_items`, `health_scores.breakdown`, `alerts` or `alert_revisions` are never compacted; unreferenced non-current snapshots are compacted after **90 days** (`snapshots.compact`, stated identically in ADR-031.5, `DATABASE_ARCHITECTURE.md §6` and `SERVICE_ARCHITECTURE.md §5`).

**Concurrency and runtime.** The advisory lock serialises chunks per organization; different organizations proceed in parallel workers. Because L0 is a single SQL aggregation, chunk CPU is proportional to periods × dimensions, not rows: the budget is **≤ 1,500 CPU-ms and ≤ 60 s wall-clock per chunk** in the Supabase Edge Function background task (NFR-04); route handlers never run chunks. Spike S5 (`IMPLEMENTATION_PLAN.md §3`) verifies one 12-period chunk of `golden-mixed` against that budget in CPU-ms; the fallback is `CHUNK_PERIODS` 6, then CD-34. Snapshot and pointer writes are one transaction so readers never see a half-written period. The Home "Updating your numbers… {done} of {total} months" banner is driven by the existence of a queued/running job for the organization and the run's `progress`, never by `calculation_runs.status` alone (F-D-03).

## 3. Metric registry

Sign conventions used throughout:

- Ledger: for `income`/`liability`/`equity`-type accounts, amount = Σcredit − Σdebit; for `expense`/`asset`-type accounts, amount = Σdebit − Σcredit. Revenue is therefore positive when normal, negative when refunds exceed sales.
- Period balances (ADR-027, ADR-047.3–4): stored in natural sign (`closing_balance = debit − credit`; the account-type rule above converts to the reporting sign). Files that present income and liabilities as positive numbers (every P&L report and balance sheet from Xero, QuickBooks or Sage) are declared `transforms.balanceSign = reporting` at mapping (`IMP-TB-013`) and negated to natural sign at commit, so the engine never sees reporting sign. Each batch carries `balance_basis ∈ {cumulative, movement}` (default: trial balance and balance sheet → `cumulative`, P&L report → `movement`; the reviewer confirms, `IMP-TB-012`) and freezes `fiscal_year_start_month_at_commit`, which is the fiscal year used for differencing; the organization-level fiscal year cannot change while cumulative balances exist unless each affected batch is re-confirmed. For P&L categories: `movement` → the period amount is `closing_balance`; `cumulative` → the period amount is `closing(P) − closing(P_prev)` where **`P_prev` is the row for the same account, same `balance_kind`, same `balance_basis`, in the immediately preceding fiscal month** — never a movement-basis month and never an earlier month; in the first fiscal month the amount is `closing(P)`; if the preceding month's winning batch of that kind exists but lacks the account, `P_prev = 0` with note `account_absent_prior`; if no such batch exists and P is not the first fiscal month the value is NULL with `no_prior_trial_balance`. Balance-sheet categories under `cumulative` use `closing(P)`; under `movement` they are prior balance-sheet closing + Σ movements, else NULL with `no_opening_balance`.
- Ledger balance-sheet balances (ADR-027.3): balance(P) = opening balance + Σ movements to `P.period_end`, where the opening balance comes from, in order, a `balance_sheet` `period_balances` row for the period before the earliest ledger period; an opening-balance journal (`IMP-GL-011`, ADR-047.4: entries whose `journal_ref`/description matches `/opening balance|brought forward|b\/f\b|b\/d\b|conversion balance|opening balance equity/i`, dated within ± 1 day of the fiscal-year start or the export's first day, flagged per `journal_ref`, promoted to a reviewer confirmation when Σ|amount| > 10% of the batch, togglable with `api.set_opening_balance_flag`; excluded from every P&L metric); `bank_accounts.opening_balance` for cash. None → NULL with `no_opening_balance` (the ledger family never reports movements-since-import as a balance).
- Bank: `amount > 0` inflow, `< 0` outflow. `is_transfer` rows are excluded from inflow/outflow **only when both legs are on cash-like accounts** (`{current, savings}`); a leg on a cash-like account paired with a `credit_card`/`loan` account is a debt repayment or drawdown and counts in cash metrics under that category (ADR-028). For liability-type bank accounts the statement gate is `−Σ amount = closing − opening`.
- Invoices: `sales` adds, `sales_credit_note` subtracts; `purchase` adds, `purchase_credit_note` subtracts. `void` excluded. Credit notes are stored with all four money fields positive (`subtotal`, `tax_amount`, `total_amount`, `amount_paid` are negated together at conversion, ADR-047.5) and subtracted by type. Amounts for P&L are **net of tax per row**: `subtotal`, else `total_amount − tax_amount`, else `total_amount` (a `subtotal` of 0 with `total_amount > 0` counts as absent); the metric carries `vat_inclusive` when ≥ 1 contributing row fell back to `total_amount` and `assurance = estimated` when the fallback share > 10% (the rule itself is `app.invoice_net`, called by the aggregate and by every other SQL reader and mirrored in `sign.ts#invoiceNetOfTax`; the aggregate carries `fallback_rows` per cell so the share can be taken, ADR-103). Invoice cells carry no account — a header has none — so the composition derives the category from the type and the counterparty's `default_expense_category` and reports it under the organisation's system account for that category (§2.1, ADR-103). The bank proxy nets down only the categories in `platform_settings.taxable_categories` (default `{revenue, cost_of_sales, operating_expense, marketing}`, CD-33). Every invoice metric uses the **current** row (ADR-047.10); there is no "row current at a historical asOf".

Category sets:

- `OPEX_SET = {operating_expense, payroll, marketing, depreciation}`
- `BELOW_LINE = {other_income, other_expense, interest_expense, tax_expense}`
- `CASH_SET = {cash}`; cash-like bank account types `{current, savings}`
- `NON_PNL = {transfer, drawings, equity, loan, credit_card, tax_liability, …asset/liability categories}` — never counted in P&L

Evidence descriptor shorthand `EQ(table, filters)` expands to the JSON in `EVIDENCE_MODEL.md §3`. A `standard_categories:[c]` filter in the shorthand is **resolved at run time** to the concrete `account_ids` (ledger, period balances) or `category_account_ids` (bank) that carried that category when the run executed; the stored descriptor never contains a category name (ADR-034). Leaf snapshots store `evidence_query = {kind:'leaf', descriptor}` with `as_of = calculation_run_id`; derived snapshots (gross profit, margins, variances, working capital, runway, concentrations) store `{kind:'derived', components:[{name, snapshot_id}]}` so the drawer and the AI can descend to each input's records.

Common missing-data reasons (`data_quality.missing[]`): `no_source_covers_period`, `no_opening_cash`, `no_opening_balance`, `no_prior_trial_balance`, `account_absent_prior` (note, value 0), `stale_invoice_data`, `no_cost_of_sales_accounts`, `uncategorised_amounts_exceed_threshold`, `comparison_period_missing`, `comparison_is_zero`, `bank_coverage_partial`, `no_counterparty_data`, `no_due_dates`, `insufficient_history`, `no_bank_accounts` (no cash-like bank account exists, so nothing can establish cash — the whole cash family is NULL, ADR-104), `cost_of_sales_in_other_source` (purchase invoices carry cost of sales but the chosen P&L basis does not, ADR-104).

### 3.1 Profit & loss metrics

| Key | Unit | Inputs | Formula | Edge cases / missing behaviour | Evidence |
|---|---|---|---|---|---|
| `revenue` | money | P&L basis source, categories `{revenue}` | Σ amount over revenue accounts in P (sign per convention) | Negative allowed (refund-heavy month) with warning `negative_revenue`. Uncategorised debit/credit amounts > 5% of |revenue| → `completeness` reduced and warning `uncategorised_amounts`; > 25% → `value` still written, `assurance = estimated`, missing `uncategorised_amounts_exceed_threshold`. | `EQ(basis_table, {period:P, standard_categories:[revenue]})` |
| `other_income` | money | `{other_income}` | Σ as revenue | — | same shape |
| `cost_of_sales` | money | `{cost_of_sales, inventory movement if TB}` | Σ debit − credit | If the org has **no** account with `standard_category = cost_of_sales` (system account only, never used): `value = NULL`, missing `no_cost_of_sales_accounts` (CD-05). "Ever used" counts purchase invoices from a `cost_of_sales` supplier **only on the invoice basis**; on a ledger or balance basis that evidence yields `value = NULL`, missing `cost_of_sales_in_other_source` — never a zero the source did not state (ADR-104). On the invoice basis the descriptor names the suppliers whose default category is `cost_of_sales` (`counterparty_ids`), so it re-selects exactly the figure's rows (ADR-104). | `EQ(…,{standard_categories:[cost_of_sales]})` |
| `gross_profit` | money | `revenue`, `cost_of_sales` | `revenue − cost_of_sales`; if `cost_of_sales` NULL for `no_cost_of_sales_accounts` or `cost_of_sales_in_other_source` → `gross_profit = revenue` with warning `no_cost_of_sales` | If `revenue` NULL → NULL | components `{revenue, cost_of_sales}`; evidence = union of both descriptors |
| `gross_margin` | ratio | `gross_profit`, `revenue` | `gross_profit / revenue` | `revenue = 0` or NULL → NULL (`comparison_is_zero`); `cost_of_sales` NULL for `no_cost_of_sales_accounts` or `cost_of_sales_in_other_source` → NULL with that reason (shown "n/a", never 100%). Negative revenue → NULL with warning. | components |
| `expense_by_category` (dim `standard_category`) | money | `OPEX_SET ∪ BELOW_LINE ∪ {cost_of_sales}` | one snapshot per category present: Σ debit − credit | Categories with zero rows are not written (absence ≠ zero) | `EQ(…,{standard_categories:[c]})` |
| `expense_by_account` (dim `account`) | money | expense-type accounts | Σ per `account_id` | Only written when basis ∈ {ledger, period_balances}; bank basis writes per category only | `EQ(…,{account_ids:[a]})` |
| `operating_expenses` | money | `OPEX_SET` | Σ expense_by_category over `OPEX_SET` | — | descriptor with the four categories |
| `operating_profit` | money | `gross_profit`, `operating_expenses` | `gross_profit − operating_expenses` | NULL if either NULL | components |
| `operating_margin` | ratio | | `operating_profit / revenue` | as gross_margin | |
| `other_expense`, `interest_expense`, `tax_expense` | money | respective category | Σ debit − credit | zero rows → `0` only if the family source covers the period (a covered TB with no interest line means zero interest) | |
| `net_profit` | money | | `operating_profit + other_income − other_expense − interest_expense − tax_expense` | If basis = bank: `tax_expense` frequently absent → warning `cash_basis_proxy` | components list all five |
| `net_margin` | ratio | | `net_profit / revenue` | as margins | |
| `contribution_margin` | money | `revenue`, `cost_of_sales`, variable opex | MVP definition: `revenue − cost_of_sales − marketing` (marketing treated as the only variable operating cost; documented simplification pending product sign-off) | NULL if revenue NULL | components |
| `contribution_margin_ratio` | ratio | | `contribution_margin / revenue` | as margins | |

Precision: money metrics rounded to 2 dp at write; ratios stored 6 dp.

Property tests: `gross_profit = revenue − cost_of_sales` whenever both non-null; `operating_profit = gross_profit − operating_expenses`; `net_profit` identity; `Σ expense_by_category over OPEX_SET = operating_expenses`; `Σ expense_by_account for accounts in category c = expense_by_category[c]` (ledger basis).

### 3.2 Growth and variance conventions

Comparison set for period `P`:

| Suffix | Comparison period | Definition |
|---|---|---|
| `prev_period` | `P − 1 month` | previous fiscal period |
| `same_period_last_year` | `P − 12 months` | |
| `trailing_3m_avg` | mean of `P−1, P−2, P−3` | requires all three non-null; otherwise NULL with `insufficient_history` |

For each base metric `B` in `{revenue, gross_profit, gross_margin, operating_expenses, operating_profit, net_profit, net_margin, closing_cash, net_cash_movement, receivables, payables, expense_by_category, expense_by_account}` and each suffix, write `B.variance.{suffix}`:

- `value = current − comparison` (absolute; for ratio bases the value is in ratio points, unit `ratio`)
- `components = {current, comparison, pct_change, comparison_period_id, comparison_basis}`
- `pct_change = (current − comparison) / |comparison|` when `comparison ≠ 0`; **NULL** when `comparison = 0` (`comparison_is_zero`) or when signs differ (`sign_change` warning) because a percentage across zero is meaningless; the absolute value is still written.
- Mixed basis across the two periods (e.g. TB last month, bank this month) → warning `basis_differs` and `assurance = estimated`. **Consumers treat a `basis_differs` variance as NULL**: every variance-based alert rule is suppressed (§8.1) and health rules P4, G1, K2 skip it (ADR-030.3); the MetricCard shows "compared on a different basis" with no percentage.
- Dimension variances (`expense_by_category.variance.*`, `expense_by_account.variance.*`) are written per dimension id present in *either* period; a category present only now has `comparison = 0`, `pct_change = NULL`, warning `new_in_period`.

`revenue_growth_mom` = `revenue.variance.prev_period.pct_change` and `revenue_growth_yoy` = `revenue.variance.same_period_last_year.pct_change`, written as their own ratio metrics for convenience (same NULL rules).

Property test: `B.variance.prev_period.value(P) = B(P) − B(P−1)` for every P with both present.

### 3.3 Cash metrics

| Key | Unit | Inputs | Formula | Edge cases / missing | Evidence |
|---|---|---|---|---|---|
| `cash_inflows` | money | bank basis: accepted `bank_transactions` in P on cash-like accounts, `amount > 0`, excluding rows whose `is_transfer = true` **and** whose pair is also on a cash-like account (ADR-028); ledger basis: debits to `cash` accounts excluding contra `transfer` | Σ amount | Partial bank coverage → value written, warning `bank_coverage_partial`, completeness = covered accounts / active accounts. Credit-card and loan accounts are excluded from cash; the cash-like leg of a payment to (or drawdown from) such an account **is** an outflow (inflow) and is reported under category `credit_card`/`loan` in `expense_by_category`-style cash breakdowns. | `EQ(bank_transactions,{period:P, bank_account_ids:[cash-like], direction:'inflow', exclude_cash_transfers:true})` |
| `cash_outflows` | money | as above, `amount < 0` | Σ |amount| (stored positive) | | direction `'outflow'` |
| `net_cash_movement` | money | | `cash_inflows − cash_outflows` | Cash-like↔cash-like transfer pairs cancel by construction; a transfer-looking row with no detected pair stays in the sums with warning `unpaired_transfer_candidate` | components |
| `opening_cash` | money | previous `closing_cash`; else per CD-06 / ADR-027.3 | First period with data, per cash-like account: statement opening balance captured deterministically (`import_batches.statement_opening_balance`, never the AI-read value alone) → `bank_accounts.opening_balance` where `opening_balance_date ≤ P.period_start` → `balance_sheet` `period_balances` for `cash` in `P−1` → opening-balance journal (`IMP-GL-011`). Sum across cash-like accounts. | None available → NULL, missing `no_opening_cash`; every later `closing_cash` also NULL with the same reason (movement metrics still written). **No cash-like account at all** (none active, none covered this period): the sum over zero accounts is not a known zero — `opening_cash`, `closing_cash`, `cash_inflows`, `cash_outflows` and `net_cash_movement` are all NULL with `no_bank_accounts`, basis `none`, completeness 0 (§1.5, ADR-104). New account mid-history: its opening balance joins at its first covered period. | components per account `{account_id, source, value}` |
| `closing_cash` | money | | `opening_cash + net_cash_movement` | When a statement supplies `balance_after` on the last transaction of P for every account, the engine cross-checks Σ`balance_after` vs computed; difference > £0.01 → warning `statement_balance_mismatch` with the delta in components (computed value still stored; statement value kept in components for display). A statement batch that could not be reconciled at import (`IMP-BAL-007`) propagates warning `unreconciled_statement`. | components |
| `cash_runway_months` | count (1 dp) | `closing_cash`, `net_cash_movement` for P, P−1, P−2 | `avg_burn = −mean(net_cash_movement over 3 periods)`; if `avg_burn > 0`: `closing_cash / avg_burn`; else NULL with warning `cash_positive` | Requires three non-null periods else `insufficient_history`; `closing_cash ≤ 0` → `0`; cap displayed at 36 ("36+") | components |

Property tests: `closing_cash(P) = opening_cash(P+1)` for consecutive covered periods; `net_cash_movement = cash_inflows − cash_outflows`; cash-like↔cash-like transfer pairs sum to zero and appear in neither inflow nor outflow; a current-account payment to a credit-card account appears in `cash_outflows`; on the retail golden org `closing_cash(P)` equals Σ statement closing balances of cash-like accounts for every P (ADR-028).

### 3.4 Receivables, payables, working capital

`asOf` for aging = `P.period_end` (historical periods) or the run's `asOf` date for the current period (stored in `components.as_of`).

| Key | Unit | Inputs | Formula | Edge cases / missing | Evidence |
|---|---|---|---|---|---|
| `receivables` | money | invoice basis (fresh per §2.2): accepted, non-superseded `sales`/`sales_credit_note` invoices with `issue_date ≤ asOf` and not `void` — always the **current** row (ADR-047.10; a corrected total therefore flows to every period, matching revenue) | `Σ balance_due(sales) − Σ balance_due(sales_credit_note)` as at `asOf` (uses `amount_paid` and `paid_date`: if `paid_date > asOf` the invoice is treated as unpaid at `asOf`; partial payments without `paid_date` are treated as paid at `asOf` with warning `payment_date_unknown`) | Invoice basis unavailable → `period_balances` closing balance of `receivables` (cumulative), else ledger balance **only when an opening balance exists** (ADR-027.3), else NULL with `no_opening_balance`; aging metrics NULL, `assurance = calculated`. Credit notes with negative balance reduce the total. | `EQ(invoices,{invoice_type:[sales,sales_credit_note], open_as_of:asOf})` |
| `receivables_overdue` | money | as above | Σ `balance_due` where `due_date < asOf` | Invoices without `due_date` are excluded and counted in `data_quality.warnings: no_due_dates (n)` | descriptor with `overdue_as_of` |
| `receivables_days` | days (int) | `receivables`, revenue for P, P−1, P−2 | `receivables / Σ sales(3 periods) × 91.25`, where the denominator is **gross-consistent**: Σ invoice `total_amount` (net of credit notes) from `full` invoice lists when receivables are invoice-basis, else net `revenue` with receivables netted down by `default_vat_rate` when known (ADR-027.4); `components.denominator_basis` records the choice | Any of the three values NULL → `insufficient_history`; Σ ≤ 0 → NULL; an `open_items` list in the window → NULL with `open_items_only` (ADR-047.10) | components |
| `payables` | money | `purchase`/`purchase_credit_note` invoices (fresh per §2.2), current row | `Σ balance_due(purchase) − Σ balance_due(purchase_credit_note)` at `asOf` | fallback as `receivables` (cumulative balance, else ledger with opening balance, else NULL `no_opening_balance`) | analogous |
| `payables_overdue` | money | | as receivables_overdue | | |
| `payables_days` | days | `payables`, `cost_of_sales + operating_expenses − payroll − depreciation` over 3 periods | `payables / Σ(cost_of_sales + operating_expense + marketing)(3) × 91.25` (payroll and depreciation never pass through accounts payable, so they are excluded from the denominator) | denominator ≤ 0 or NULL → NULL | |
| `working_capital` | money | `closing_cash`, `receivables`, `payables`, and where a cumulative TB/BS covers P: `inventory`, `other_current_asset`, `other_current_liability`, `credit_card`, `tax_liability` (all taken as `closing(P)` in reporting sign) | `closing_cash + receivables + inventory + other_current_asset − payables − credit_card − tax_liability − other_current_liability` | Balance-sheet-only categories absent (no TB/BS) → treated as unknown: metric written with `completeness` reduced and warning `partial_working_capital` listing missing categories; if `closing_cash` NULL → NULL. `basis = 'mixed'` whenever inputs differ. | components with each term, its basis and its snapshot id (ADR-034) |

### 3.5 Customer and supplier metrics

Customer set = `counterparties` with `kind ∈ {customer, both}`; supplier set = `{supplier, both}`. Merged counterparties (`merged_into_id` set) roll up to the survivor.

| Key | Dim | Formula | Edge cases | Evidence |
|---|---|---|---|---|
| `customer_revenue` | counterparty | Σ revenue attributable to the counterparty in P (invoice basis: invoice totals net of tax and credit notes; ledger basis: revenue-account entries with `counterparty_id`; bank basis: non-transfer inflows categorised `revenue` with `counterparty_id`, `estimated` — uncategorised rows, transfers of every kind and refunds are in no customer's figure, ADR-110) | Revenue rows without a counterparty are aggregated into a synthetic snapshot `dimension_id = NULL` labelled "Unattributed" so Σ customer_revenue + unattributed = `revenue`. | `EQ(basis_table,{period:P, counterparty_ids:[c], standard_categories:[revenue]})` |
| `customer_contribution` | counterparty | CD-08: `customer_revenue − Σ directly attributable costs` where a cost is attributable when a `cost_of_sales`/`OPEX_SET` ledger entry or purchase invoice carries this `counterparty_id` **as a customer cost** (`counterparties.kind = both` rows need explicit flag; MVP treats purchase invoices from a `both` counterparty as supplier spend, not customer cost). In practice equals `customer_revenue` for most orgs; labelled "revenue contribution" in the UI whenever attributable costs are 0. | `assurance = calculated`, warning `no_cost_allocation` when costs are 0 | |
| `customer_revenue_share` | counterparty | `customer_revenue / revenue` | `revenue ≤ 0` → NULL | |
| `customer_concentration_top1` | none | max `customer_revenue_share` (excluding Unattributed) | Fewer than 1 attributed customer → NULL `no_counterparty_data`; if Unattributed share > 50% → `assurance = estimated`, warning `high_unattributed_share` | components `{top_counterparty_id, share, unattributed_share}` |
| `customer_concentration_top5` | none | Σ of five largest shares | < 5 customers → sum of all with warning `fewer_than_5` | |
| `revenue_concentration_hhi` | none | Σ (share_i)² over attributed customers, 0–1 | as top1; single customer → 1.0 | |
| `supplier_spend` | counterparty | Σ `cost_of_sales ∪ OPEX_SET` amounts attributable to the supplier (purchase invoices; ledger expense entries with `counterparty_id`; bank: non-transfer outflows in an expense category with `counterparty_id`, never uncategorised rows, transfers or inflows, ADR-110) | Unattributed synthetic snapshot as for customers | |
| `supplier_concentration_top1`, `supplier_concentration_top5` | none | shares of `Σ supplier_spend + unattributed` | as customer equivalents | |

Property tests: Σ `customer_revenue` (incl. unattributed) = `revenue` (same basis); shares sum to 1 ± 1e−6; HHI ∈ [top1², 1].

### 3.6 Registry summary

Every key above is declared once in `src/modules/financial-engine/domain/registry.ts` with `{key, label, unit, family, level (L0–L7), dimension_type, dependencies[], formulaId, aggregation, as_of_dependent}`. `label` is the display label the AI grounding check requires near a quoted number (`AI_ARCHITECTURE.md §7`, ADR-045.1). `as_of_dependent = true` marks keys a daily scheduled run recomputes for the current period (`receivables_overdue`, `payables_overdue`, `receivables_days`, `payables_days`, `cash_runway_months`; recurring status lives on `recurring_payment_groups`), ADR-047.8. `aggregation ∈ {sum, last, recompute}` states how a monthly key rolls up to a quarter or year (flows sum, stocks take the last month, ratios and days recompute from summed components). **MVP exposes months only** (ADR-030.6): the period picker has no quarter/year granularity; when quarter/year views ship they are materialised as snapshots with `period_kind` by the engine, never aggregated in the UI or in React. The registry is the source for the AI's `get_metric` catalogue and for the UI's metric labels and definitions ("What is this?" copy). Unknown metric keys are type errors.

---

## 4. Banking rules used by the engine (`src/modules/banking/domain`)

### 4.1 Categorisation precedence
1. **User override** (`category_source = 'user'`): never changed by rules.
2. **Saved organization rule**: `(normalised description signature | counterparty_id) → category_account_id`, created automatically when a user categorises and confirms "apply to similar".
3. **Keyword rule set** (platform, versioned): regex/keyword → standard category (e.g. `/payroll|salary|hmrc paye/` → `payroll`; `/stripe|shopify payout|invoice/` inflow → `revenue`; `/hmrc vat/` → `tax_liability`; `/loan repayment/` → `loan`). Sets `category_source = 'rule'` and `assurance_level = 'inferred'`... no: categorisation does not alter record assurance; it sets `bank_transactions.category_source` only.
4. **AI suggestion** (`ai_suggested`): post-MVP; when present it is still a suggestion until confirmed.
5. **None**: `category_account_id = NULL` → counted as `uncategorised`.

Uncategorised share drives `completeness` for bank-basis metrics (§5).

### 4.2 Transfer detection (CD-28, ADR-028)
For each accepted outflow `t` on any bank account of the org: find an inflow `u` on a *different* `bank_accounts` row of the same org with `|u.amount| = |t.amount|`, `|u.transaction_date − t.transaction_date| ≤ 3 days`, both unpaired, **and** (ADR-047.12) at least one leg's `description_normalized` matches `/transfer|tfr|to savings|from current|own account/` or contains the other account's name. A candidate that meets amount, date and account but fails the description gate is not paired; it is flagged `unpaired_transfer_candidate` for reviewer confirmation, so a customer receipt and a same-amount supplier payment two days apart are never silently cancelled. Prefer the closest date, then description similarity. Pair → set `is_transfer = true` and `transfer_pair_id` both ways, and classify the pair with the single enum `transfer_kind {none, cash_transfer, card_repayment, loan_repayment, loan_drawdown, other_transfer}`:

| Legs | `transfer_kind` | Cash metrics | P&L |
|---|---|---|---|
| cash-like ↔ cash-like | `cash_transfer` | both legs excluded from inflow/outflow | excluded |
| cash-like ↔ `credit_card` | `card_repayment` | cash-like leg counted as outflow under category `credit_card` | excluded (the card purchases themselves are the expenses) |
| cash-like ↔ `loan` | `loan_repayment` / `loan_drawdown` | cash-like leg counted as outflow / inflow under category `loan` | excluded |
| `credit_card` ↔ `loan`, or same account type non-cash | `other_transfer` | not cash | excluded |

`category_account_id` is set to the system `transfer`, `credit_card` or `loan` account accordingly. Users may unpair or pair manually (`category_source = 'user'` protects the decision). Unpaired transfer-looking rows (description matches `/transfer|tfr|to savings|from current/`) get warning flag `unpaired_transfer_candidate` surfaced in the coverage panel. Every pairing change writes `category_history` (ADR-034) and enqueues a `banking_edit` calculation trigger.

### 4.3 Recurring payment detection
1. Signature = lower-cased `description_normalized` (already masked of account numbers and sort codes, ADR-038.4) with digits, dates, reference codes and whitespace runs removed, truncated to 40 chars; plus `counterparty_id` when set.
2. Group accepted transactions per `(bank_account_id, signature, direction)` with ≥ 3 occurrences in the trailing 18 months.
3. Cadence from median gap in days: 6–8 weekly, 13–15 fortnightly, 27–32 monthly, 85–95 quarterly, 355–375 annual, else irregular. Require ≥ 70% of gaps within ±20% of the median.
4. `expected_amount` = median amount; `amount_tolerance_ratio` = max(0.10, MAD/median).
5. `next_expected = last_seen + cadence`; `status = 'stopped'` if `asOf > next_expected + 1.5 × cadence`; `'changed'` if the last amount deviates > tolerance.
6. Upsert `recurring_payment_groups` (`detector_version`), set `recurring_group_id` on member transactions. Groups are recomputed each run; ids are stable via the unique key.

### 4.4 Bank data → cash metrics and the bank-basis P&L proxy
Only accounts with `account_type ∈ {current, savings}` feed `opening_cash`/`closing_cash`. Credit-card and loan accounts are tracked for balances and appear in `working_capital` via categories, not cash. The bank-basis P&L proxy (when chosen by precedence) reads **all active accounts including liability accounts** (card purchases are expenses; the repayment leg is not), maps inflows in `revenue` category to `revenue` and outflows by category to expenses, and excludes `is_transfer` rows of every `transfer_kind` and every `NON_PNL` category (ADR-047.12). Its descriptors carry `bank_account_ids: [all active]` and `exclude_transfers: 'all'` so the drawer reconciles to the same set. When a cash-like account shows outflows categorised `credit_card` and no card statement covers P, the proxy expenses are understated by the unseen card spend: warning `card_spend_unclassified` is set on every proxy P&L metric for P.

---

## 5. Data quality model

`metric_snapshots.data_quality`:

```json
{ "completeness": 0.0–1.0,
  "proxy": false,
  "warnings": ["cash_basis_proxy", "vat_inclusive", "card_spend_unclassified", "account_absent_prior", "open_items_only", "uncategorised_amounts", "bank_coverage_partial", "statement_balance_mismatch", "unreconciled_statement", "basis_differs", "sign_change", "new_in_period", "partial_working_capital", "no_due_dates", "payment_date_unknown", "fewer_than_5", "high_unattributed_share", "negative_revenue", "unpaired_transfer_candidate", "partial_month"],
  "missing": ["no_source_covers_period", "no_opening_cash", "no_bank_accounts", "no_opening_balance", "no_prior_trial_balance", "stale_invoice_data", "no_cost_of_sales_accounts", "cost_of_sales_in_other_source", "comparison_period_missing", "comparison_is_zero", "insufficient_history", "no_counterparty_data", "uncategorised_amounts_exceed_threshold"] }
```

Completeness per family:

| Family | Completeness |
|---|---|
| P&L (ledger/TB) | 1 − (uncategorised |amount| / total |amount| in period) |
| P&L (bank proxy) | 1 − uncategorised share, with `proxy = true` and `assurance = estimated` (ADR-035; the proxy penalty is expressed by the flag and the score cap, not by a completeness haircut) |
| Cash | (covered active cash-like accounts / active cash-like accounts) × (1 if opening cash known else 0.5) |
| AR/AP (invoices) | 1 − (invoices without due_date / invoices) |
| AR/AP (balances) | 0.7 |
| Customer/supplier | 1 − unattributed share |
| Derived metrics | min of inputs' completeness |
| Variance | min(current, comparison); NULL to consumers when `basis_differs` |
| Partial month (`is_complete = false`) | multiplied by `days_covered / days_in_month` for flow metrics (ADR-030.4); a period returned by `latestCompletePeriod()` as the `partial` fallback carries `partial_month` and the UI's "so far" treatment |

Propagation: the Health Score excludes a dimension when its required metrics are NULL or completeness < 0.6, caps a dimension at 70 when its required metrics are `estimated`/`proxy` (§7.2), and is not computed at all for incomplete periods (ADR-030.4); the AI tools return `data_quality` verbatim and the response contract requires the Confidence section to repeat any warning affecting a cited number (`AI_ARCHITECTURE.md`). The Home page shows a single "Data quality" indicator = min completeness of the headline metrics for the selected period, with a link to the coverage panel.

---

## 6. Engine versioning and recalculation

- `engine_version` is semver in `src/modules/financial-engine/domain/version.ts`. **Patch** = bug fix that changes no golden output; **minor** = new metric or new warning (existing values unchanged); **major** = any change to an existing formula, precedence, or category set.
- A **major** bump enqueues `calculation.run` (`trigger = 'scheduled'`, full range) for every active organization at deploy time; until it completes the organization sees a "Figures updating" banner and reads old snapshots (their `metric_current` pointers stand until replaced atomically per period).
- Snapshots are never migrated in place and never updated. Old runs remain readable (their snapshots simply have no `metric_current` pointer) so an AI answer or report generated last month resolves to the numbers it saw. **Retention equals the organization's lifetime**: a snapshot referenced by `evidence_items`, `health_scores.breakdown`, `alerts` or `alert_revisions` is never archived; unreferenced non-current snapshots are compacted by the `snapshots.compact` job after 90 days (ADR-031.5, ADR-047.8 — the single retention figure across all documents).
- Reproducibility guarantee: given `calculation_run_id`, `input_fingerprint` and the tagged engine version from git, the run can be replayed in a test harness and must reproduce every snapshot value (`TEST_STRATEGY.md` "replay" suite on the golden orgs).
**Plain-language summary sentence.** The one-sentence Home summary (`UX_ARCHITECTURE.md §4`) is generated deterministically from current snapshots and the health breakdown by templates in `modules/health/domain/summary-templates.ts`; it is never produced by the AI and is covered by the same golden-dataset tests as the score.

- Health config (`§7`) and alert rules (`§8`) carry their own versions (`config_version`, `rule_version`) and are bumped independently.

---

## 7. Business Health Score (`src/modules/health`)

Analytical indicator only; every screen carries the SOW §9 disclaimer text ("indicative, not a lending decision"). Config `health.config.v1`.

**All thresholds below require product-owner sign-off before Phase 6 (CD-19).**

### 7.1 Dimensions and weights

| Dimension key | Weight | Required metrics (NULL ⇒ excluded) | Supporting metrics |
|---|---|---|---|
| `profitability` | 25 | `net_margin`, `gross_margin` (or `no_cost_of_sales_accounts` → use `operating_margin`) | `net_profit.variance.prev_period`, `gross_margin.variance.trailing_3m_avg`, `contribution_margin_ratio` |
| `cash_flow` | 25 | `closing_cash`, `net_cash_movement` | `cash_runway_months`, `net_cash_movement` last 3 |
| `revenue_growth` | 15 | `revenue`, `revenue_growth_mom` or `revenue_growth_yoy` | `revenue` trailing 6 (volatility), `customer_concentration_top1` |
| `cost_control` | 15 | `operating_expenses`, `revenue` | `operating_expenses.variance.prev_period`, `expense_by_category.variance.prev_period` |
| `customer_quality` | 10 | `customer_concentration_top1` | `customer_concentration_top5`, `revenue_concentration_hhi`, `receivables_days` |
| `banking_health` | 10 | any bank coverage for P | `closing_cash` trend 3, `cash_outflows` vs `cash_inflows`, open alerts of families `bank.*`, `recurring.*`, `duplicate.*` |
| `marketing_efficiency` | (10, reserved) | post-MVP (CAC, contribution per acquisition) | — |
| `funding_readiness` | (10, reserved) | post-MVP | — |

When post-MVP dimensions arrive, MVP weights are scaled so the eight sum to 100; the config version bumps.

### 7.2 Gate, renormalisation, bands

- No score is computed for a period with `is_complete = false` (ADR-030.4); Home shows the latest complete month's score and "{Month} so far" without a score.
- Dimension **excluded** when any required metric is NULL or the min completeness of its required metrics < 0.6. Excluded dimensions are listed with reason.
- Dimension **capped at 70** with note "based on bank data only" when any required metric has `assurance = estimated` or `data_quality.proxy = true` (ADR-035); a bank-only organization therefore receives a score on its first import.
- Rules that read a variance carrying `basis_differs` treat it as NULL (skip the rule).
- `score = round(Σ dimension_score × weight / Σ weights of included dimensions)`; `dimensions_used`/`dimensions_total` stored; UI shows "based on 4 of 6 dimensions". Fewer than 3 included → `score = NULL`, state "Not enough data yet".
- Bands: 0–39 **At risk**, 40–59 **Needs attention**, 60–79 **Stable**, 80–100 **Strong**.

### 7.3 Dimension rules (each dimension starts at 50; rules add/subtract; clamp 0–100)

**profitability**
| Rule | Condition | Points |
|---|---|---|
| P1 net margin level | `net_margin ≥ 0.15` +30; `0.05–0.15` +15; `0–0.05` 0; `< 0` −30 | |
| P2 gross margin level (skip if n/a) | `≥ 0.50` +10; `0.30–0.50` +5; `< 0.20` −10 | |
| P3 margin trend | `gross_margin.variance.trailing_3m_avg ≥ +0.02` +10; `≤ −0.02` −15 | |
| P4 profit momentum | `net_profit.variance.prev_period.pct_change ≥ +0.10` +5; `≤ −0.20` −10 | |
Positive templates: "Net margin of {net_margin} is healthy", "Gross margin improved {delta} pts over the last 3 months". Negative: "The business made a loss of {net_profit} this month", "Gross margin fell {delta} pts".

**cash_flow**
| Rule | Condition | Points |
|---|---|---|
| C1 closing cash sign | `closing_cash > 0` +10; `≤ 0` −40 | |
| C2 runway | `cash_runway_months ≥ 6` +20; `3–6` +5; `1–3` −15; `< 1` −30; NULL because cash-positive +20 | |
| C3 movement trend | `net_cash_movement > 0` in ≥ 2 of last 3 periods +15; ≤ 0 in all 3 −20 | |
| C4 cash vs monthly outflows | `closing_cash / cash_outflows ≥ 2` +5; `< 0.5` −10 | |
Templates: "Cash would last about {runway} months at the current rate", "Cash fell for {n} months in a row".

**revenue_growth**
| Rule | Condition | Points |
|---|---|---|
| G1 YoY (or MoM if YoY missing) | `≥ +0.20` +30; `+0.05–0.20` +15; `−0.05–+0.05` 0; `−0.20–−0.05` −15; `< −0.20` −30 | |
| G2 volatility | coefficient of variation of `revenue` over trailing 6 `≤ 0.15` +10; `≥ 0.40` −10 (needs 6 periods) | |
| G3 concentration drag | `customer_concentration_top1 ≥ 0.50` −10 | |
Templates: "Revenue is up {pct} on the same month last year", "Revenue swings a lot month to month".

**cost_control**
| Rule | Condition | Points |
|---|---|---|
| K1 opex ratio | `operating_expenses / revenue ≤ 0.60` +20; `0.60–0.85` +5; `0.85–1.0` −10; `> 1.0` −25 | |
| K2 opex growth vs revenue growth | `opex pct_change − revenue pct_change ≤ 0` +15; `> +0.10` −15 | |
| K3 spike conditions | number of categories in P for which the `expense.spike_category` **condition** holds, evaluated by the same pure rule function over this run's snapshots (never `alerts` rows or their statuses, ADR-035): 0 +10; 1–2 −5; ≥ 3 −15 | |
Templates: "Costs grew slower than revenue", "{category} spending jumped {pct} this month".

**customer_quality**
| Rule | Condition | Points |
|---|---|---|
| Q1 top-1 share | `≤ 0.20` +25; `0.20–0.35` +10; `0.35–0.50` −10; `> 0.50` −25 | |
| Q2 top-5 share | `≤ 0.60` +10; `> 0.85` −10 | |
| Q3 collection | `receivables_days ≤ 30` +15; `30–60` 0; `60–90` −10; `> 90` −20 (skip if NULL) | |
Templates: "No single customer is more than {share} of revenue", "{customer} is {share} of revenue — a concentration risk".

**banking_health**
| Rule | Condition | Points |
|---|---|---|
| B1 balance trend | `closing_cash` rising over last 3 +15; falling all 3 −15 | |
| B2 inflow/outflow ratio | `cash_inflows / cash_outflows ≥ 1.1` +15; `0.9–1.1` 0; `< 0.9` −15 | |
| B3 anomaly conditions | count of `bank.unusual_transaction`, `recurring.amount_changed`/`missed`/`inflow_missed` and `duplicate.transaction` **conditions** for P from the pure rule functions over this run's snapshots and accepted records: 0 +10; 1–2 −5; ≥ 3 −15 (contributing record ids stored in `breakdown[].conditions`) | |
| B4 coverage | bank coverage full +10; partial −5 | |

### 7.4 Stored breakdown (`health_scores.breakdown`)

```json
[{ "key": "profitability", "score": 62, "weight_config": 25, "weight_applied": 27.8,
   "included": true, "exclusion_reason": null,
   "metrics": [{"metric_key":"net_margin","value":"0.083","snapshot_id":"…"}, …],
   "rules": [{"rule":"P1","result":"0.05–0.15","points":15}, …],
   "conditions": [{"rule_key":"expense.spike_category","subject_id":"…","snapshot_ids":["…"]}],
   "capped": false, "cap_reason": null,
   "positives": ["Net margin of 8.3% is healthy"],
   "negatives": ["Gross margin fell 3.1 pts over the last 3 months"],
   "data_quality": {"completeness":0.94,"warnings":[]} }, …]
```

`config_version = 'health.config.v1'`. Factor sentences carry their numbers as structured fields (`positives_structured: [{template_id, values:{net_margin:'0.083'}, snapshot_ids:[…]}]`) so the AI allowed set can be built from typed fields, never from prose (ADR-032.1). The AI tool `get_health_score` returns this object unchanged.

---

## 8. Alert Engine (`src/modules/alerts`)

### 8.1 Global rules
- Evaluated by job `alerts.evaluate` after every successful calculation run, for every period in the run range, oldest first.
- **Two rule classes (ADR-036).** *Event* rules describe something that happened in a period and are keyed per period: `dedupe_key = '{rule_key}|{period_id}|{subject_type}|{subject_id or "-"}'`. *State* rules describe a condition that persists and are keyed per subject only: `dedupe_key = '{rule_key}|state|{subject_type}|{subject_id or "-"}'`; `period_id` is updated to the latest evaluated period on each re-evaluation and `first_seen_at` is retained. Class per rule is in §8.2.
- **Suppression is split in two (ADR-047.11).** `dataSuppressed(rule, ctx)` depends on data only and is shared by the alert job and the health engine (K3/B3): completeness < 0.5; the variance carries `basis_differs` (ADR-030.3); the earliest period with data for variance-based rules (`first-period gate`); on a period with `is_complete = false` only `duplicate.*`, `bank.unusual_transaction` and `recurring.*` are evaluated (ADR-030.4); |amount| < `MIN_ABS = max(£100, 0.5% of revenue)`; record pairs where either record has `duplicate_reviewed = true` (ADR-029.6). `userSuppressed(existing)` depends on user state and applies only when *persisting* alerts: the dismissal cooldown below. Thresholds that reference "monthly outflows" or medians (`bank.unusual_transaction`, `duplicate.transaction`, `deviation.large_transaction`) use the trailing **three complete** months, never the partial current month (ADR-047.6). An alert whose subject record was superseded/rejected is auto-resolved (`status_reason_code = 'record_removed'`).
- **Per-run cap (two-pass, ADR-047.11).** All outcomes for all periods are collected first, then sorted by (severity desc, period desc); the cap of 25 applies to *new* rows, `critical` outcomes are exempt from it, and the remainder is summarised in one `info` alert "N further items need attention" linking to Insights. A first import of 24 months can therefore never bury the current month's cash alert under old `info` rows.
- **Lifecycle and revisions (ADR-034).** Condition true → if the alert exists and nothing material changed (same severity, same pinned ids, same rounded threshold values) only `last_evaluated_at` moves; otherwise a new `alert_revisions` row is written (severity, explanation, threshold_summary, evidence bundle, run), `alerts.current_revision_id` is repointed, audit `alert.reevaluated {before, after}` is written, and an `acknowledged` alert whose severity increased returns to `open`. **Re-opening (ADR-047.2, R2-B-02).** A `resolved` state-class alert whose condition returns gets a new revision and `status ← open`, `status_reason_code = condition_returned`, `reopened_at = now()`, keeping `first_seen_at`. A `dismissed` alert re-opens when its severity increases **or** when `dismissed_at < now() − 90 days` (the cooldown); otherwise a dismissal holds and only `last_evaluated_at` moves. Condition false → if `open`/`acknowledged` set `resolved` with `status_reason_code = 'condition_cleared'`; if `dismissed` or `resolved` leave untouched. Never delete. The evidence bundle is regenerated only when a new revision is written.
- Severity is computed from the rule table; `critical` only for cash and duplicate-money rules.
- Every alert gets `recommended_next_step` from the template and an `evidence_bundles` row of kind `alert` (see `EVIDENCE_MODEL.md §5`). `threshold_summary` holds every number used in the explanation as typed fields (`{current:'…', previous:'…', pct_change:'…', period_label:'…'}`); templates render from it and AI tools return it structurally (ADR-032.7).

### 8.2 Rule catalogue (`rule_version = 'alerts.rules.v1'`; thresholds are defaults, CD-18)

| rule_key | Family · class | Trigger (defaults) | Severity | metric_key / subject | Explanation template | Evidence pinned | Next step template |
|---|---|---|---|---|---|---|---|
| `expense.spike_category` | Expense spike · **event** | `expense_by_category.variance.prev_period` per category: `pct_change ≥ 0.25` AND `value ≥ 0.02 × revenue` (or ≥ £500 if revenue NULL) | high if `pct_change ≥ 0.50` or `value ≥ 0.05 × revenue`, else medium | `expense_by_category` / `standard_category` | "{category} spending was {current} in {period}, up {value} ({pct}) on {prev_period}." | top 5 records by |amount| in category this period + descriptor for category/period | "Review the largest {category} transactions and confirm they are expected." |
| `expense.spike_account` | Expense spike · **event** | as above on `expense_by_account` (ledger/TB basis only); suppressed if the category alert already fired for the same account's category with the same top record | medium | `expense_by_account` / `account` | "{account} rose {pct} to {current}." | top 5 records | as above |
| `revenue.decline` | Revenue decline · **event** | `revenue.variance.prev_period.pct_change ≤ −0.15` OR `revenue.variance.same_period_last_year.pct_change ≤ −0.20` | high if ≤ −0.30, else medium | `revenue` / none | "Revenue fell {pct} to {current} in {period} compared with {comparison_period}." | `customer_revenue.variance.prev_period` top 5 negative + revenue descriptor | "Check whether the drop is timing (late invoicing) or lost customers; see the customers that fell most." |
| `margin.deterioration` | Margin deterioration · **event** | `gross_margin.variance.trailing_3m_avg ≤ −0.03` OR `net_margin.variance.prev_period ≤ −0.05` | high if net margin now < 0, else medium | `gross_margin` or `net_margin` / none | "Gross margin is {current}, down {value} pts from the 3-month average." | metric snapshots for margin, revenue, cost_of_sales; cost_of_sales top records | "Compare pricing and supplier costs; margin usually moves because one of them did." |
| `cash.decline` | Cash deterioration · **event** | `closing_cash.variance.prev_period.value ≤ −0.20 × |opening_cash|` AND `≤ −max(£1,000, 1 month of average outflows / 4)` (absolute floor so the rule is meaningful when `opening_cash ≤ 0`), OR `net_cash_movement < 0` for 3 consecutive complete periods | high | `closing_cash` / none | "Cash fell from {comparison} to {current} in {period}." | cash_outflows top 10, cash metric snapshots | "Look at the largest outflows this month and confirm they were planned." |
| `cash.runway_low` | Cash deterioration · **state** | `cash_runway_months < 3` | critical if < 1.5, else high | `cash_runway_months` / none | "At the current rate of spending, cash would last about {runway} months." | runway components, last 3 net movements | "Prioritise collecting {receivables_overdue} of overdue invoices and defer non-essential spending." |
| `receivables.deterioration` | Receivables deterioration · **state** | `receivables_days.variance.prev_period ≥ 10` OR `receivables_overdue / receivables ≥ 0.30` | high if overdue share ≥ 0.50, else medium | `receivables_overdue` / none | "{overdue} of {receivables} owed to you is overdue ({share})." | top 10 overdue invoices by balance | "Chase the {n} largest overdue invoices; the top 3 account for {top3_share}." |
| `payables.deterioration` | Payables deterioration · **state** | `payables_days.variance.prev_period ≥ 10` OR `payables_overdue / payables ≥ 0.30` | medium (high if overdue ≥ 0.50) | `payables_overdue` / none | "You owe {overdue} that is past due." | top 10 overdue purchase invoices | "Agree payment plans with the largest overdue suppliers before they affect supply." |
| `concentration.customer` | Customer concentration · **state** | `customer_concentration_top1 ≥ 0.35` (medium) or `≥ 0.50` (high); only re-fires when share changes ≥ 0.05 or crosses a band | medium/high | `customer_concentration_top1` / `counterparty` (the top customer) | "{customer} makes up {share} of revenue this period." | customer_revenue snapshot, invoice descriptor for that customer | "Reduce reliance on {customer}: protect the account and grow the next tier." |
| `concentration.supplier` | Supplier concentration · **state** | `supplier_concentration_top1 ≥ 0.40` | low (medium if ≥ 0.60) | `supplier_concentration_top1` / `counterparty` | "{supplier} received {share} of spend." | supplier_spend snapshot, descriptor | "Check contract terms and alternatives for {supplier}." |
| `recurring.amount_changed` | Recurring-payment anomaly · **state** | group `status = 'changed'`: last amount deviates > max(tolerance, 10%) from expected | medium if deviation ≥ 25% or ≥ £250, else low | none / `recurring_group` | "{signature} was {actual}, usually about {expected}." | the deviating transaction + group's last 6 transactions | "Confirm the new amount is correct with the provider." |
| `recurring.missed` | Recurring-payment anomaly · **state** | group `status = 'stopped'` in P for outflow groups with ≥ 6 occurrences (a missed inflow is `recurring.inflow_missed`, medium) | low | none / `recurring_group` | "{signature} did not occur in {period}; it usually does every {cadence}." | group + last 3 transactions | "Check whether the payment was cancelled or is overdue." |
| `recurring.new` | Recurring-payment anomaly · **state** | a new outflow group reaches 3 occurrences with expected_amount ≥ £50 | info | none / `recurring_group` | "A new regular payment of about {expected} to {signature} has started." | first 3 transactions | "Confirm this subscription or standing order is intended." |
| `duplicate.transaction` | Duplicate transaction · **event** | two accepted records in the same table with equal `dedupe_hash`, neither carrying `duplicate_reviewed = true`, or fuzzy match (same |amount|, same signature, ≤ 1 day apart, different ids) in P, amount ≥ £50 | critical if amount ≥ 5% of monthly outflows or ≥ £5,000, else high | none / `bank_transaction` (or `ledger_entry`) | "Two payments of {amount} to {signature} on {d1} and {d2} look like duplicates." | both records | "Confirm with the supplier or bank; request a refund if paid twice." |
| `bank.unusual_transaction` | Unusual bank transaction · **event** | single outflow ≥ max(£1,000, 3 × MAD of outflows over trailing 6 months + median) AND not part of a recurring group AND not a transfer; or any outflow to a new counterparty ≥ 10% of monthly outflows | high if ≥ 25% of monthly outflows, else medium | none / `bank_transaction` | "A payment of {amount} to {signature} on {date} is much larger than usual." | the transaction, descriptor of outflows in P | "Verify this payment was authorised." |
| `deviation.large_transaction` | Large transaction deviation · **event** | ledger/invoice record ≥ 3 × the account's median |amount| over trailing 6 months and ≥ £1,000 (ledger/TB basis; bank rule above covers bank basis) | medium | `expense_by_account` / `ledger_entry` or `invoice` | "{description} of {amount} is far above the usual size for {account}." | the record + account descriptor | "Check the invoice or entry is correct and coded to the right account." |
| `variance.significant` | Significant period variance · **event** | any of `operating_profit`, `net_profit`, `net_cash_movement` `.variance.prev_period` with |pct_change| ≥ 0.30 and |value| ≥ 0.05 × revenue, where no more specific alert (`revenue.decline`, `expense.spike_*`, `cash.*`) already explains it in the same period | medium (favourable variances are `info`) | that metric / none | "{metric} changed by {value} ({pct}) versus {comparison_period}." | metric snapshot + its top component variances | "Open the analysis to see which categories moved." |

Currency symbols in templates follow `organizations.base_currency`. Templates are rendered by the engine (no AI) into `explanation`; placeholders come only from `threshold_summary`, which is also what AI tools and the UI use for numbers (ADR-032.7). `{signature}` and `{customer}` placeholders are rendered from `description_normalized`/counterparty names and are treated as untrusted text by the AI layer.

### 8.3 Evaluation algorithm (two-pass, ADR-047.11)

```
evaluateAlerts(orgId, runId, periods):
  lock org (advisory)
  load current snapshots (via metric_current) for periods ∪ trailing 12, recurring groups (already
       recomputed inside the run, ADR-047.11), accepted records needed by record-level rules,
       all non-resolved alerts and their current revisions
  -- pass 1: collect
  outcomes = []
  for P in periods ascending:
    ctx = {snapshots(P), snapshots(P−1..P−12), asOf, is_complete(P), trailing_complete_3(P)}
    for rule in RULES:
      if dataSuppressed(rule, ctx) continue                 -- §8.1, data only; identical to health K3/B3
      for o in rule.evaluate(ctx):                          -- pure; {subject, severity, threshold_summary, pins, descriptor}
        outcomes.push({P, rule, o, key: dedupeKey(rule.class, rule.key, P, o.subject)})
    variance.significant is evaluated after the other rules of P so it can see what already explains P
  -- pass 2: persist, most important first
  sort outcomes by (severity desc, P desc, rule order)
  created = 0
  for x in outcomes:
    existing = alerts[x.key]
    if existing:
      if userSuppressed(existing, x): touch last_evaluated_at; continue          -- dismissed within 90 d and no severity increase
      if unchanged(existing.current_revision, x.o): touch last_evaluated_at; continue
      write alert_revisions row; repoint current_revision_id; rebuild evidence bundle
      if existing.status = 'acknowledged' and x.o.severity > previous: status ← 'open'
      if existing.status = 'resolved':  status ← 'open', status_reason_code 'condition_returned', reopened_at
      if existing.status = 'dismissed' and (severity increased or dismissed_at < now − 90 d):
                                          status ← 'open', status_reason_code 'condition_returned', reopened_at
      audit alert.reevaluated
    else:
      if x.o.severity ≠ 'critical' and created ≥ 25: overflow += 1; continue      -- critical is exempt
      insert alert (state or event key); write revision; build bundle; created += 1; audit alert.created
  -- resolve what did not recur
  for existing open/acknowledged event-class alert of any rule in periods with no outcome for its key: resolve('condition_cleared')
  for existing open/acknowledged state-class alert whose subject has no outcome for the latest period: resolve('condition_cleared')
  if overflow > 0: upsert the info alert 'attention.overflow' for the latest period with count
  write audit event alerts.evaluated {run_id, counts, overflow}
```

Rules are pure functions `(ctx) → outcomes[]` in `src/modules/alerts/domain/rules/*.ts`, each with a fixture-based test that asserts the exact `threshold_summary`. The same functions, behind the same `dataSuppressed()` filter, are called by the health engine (§7.3 K3/B3) inside the calculation chunk, so score and alerts can never disagree about whether a condition holds, and neither depends on dismissals.

## 9. Test plan summary (details in `TEST_STRATEGY.md §5–7`)

- **Golden organizations (CD-30):** (A) *Service Co* — 24 months GL export, no cost of sales, one bank account; (B) *Retail Co* — bank statements for two accounts with transfers, sales and purchase invoice lists, credit notes, a duplicate direct debit; (C) *Mixed Co* — trial balances for 12 months, partial ledger for the last 3, opening balance missing for one account. Expected values for every metric in §3 are hand-computed in spreadsheets committed alongside as CSV; tests assert equality to the cent / 6 dp.
- **Property tests** listed under each §3 subsection, run over randomly generated ledgers (fast-check).
- **Precedence tests:** each family × each coverage combination asserts `basis` and `assurance`.
- **Snapshot/replay tests:** run twice ⇒ identical values and `input_fingerprint`; replay from stored run ⇒ identical.
- **Health tests:** each rule boundary (exactly at threshold), exclusion and renormalisation, `score = NULL` with < 3 dimensions.
- **Alert tests:** each rule fires at threshold and not one unit below; dedupe upsert preserves status; `condition_cleared` resolution; dismissed cooldown (all severities for duplicates); first-period gate; evidence bundle non-empty for every fired alert; state-class rules produce one alert per subject across six imported months; per-run cap and overflow alert; a revision is written only on material change; severity increase re-opens an acknowledged alert; `duplicate_reviewed` pairs never fire.
- **Revision 1.2 cases (ADR-047, R2-B):** rolling back a correcting batch B restores A's rows to `app.aggregate_periods` and the partial unique index accepts a third batch (R2-B-01); a resolved `cash.runway_low` re-opens with `condition_returned` when runway falls again, and a dismissed high alert re-opens after 90 days or on severity increase (R2-B-02); `pnl-reporting-sign.xlsx` yields positive revenue and negative-signed liabilities in natural storage (R2-B-03); cumulative differencing across a movement month, an absent account (`account_absent_prior` = 0), a fiscal-year boundary and a frozen `fiscal_year_start_month_at_commit` (R2-B-04); `credit-note-with-tax.csv` nets revenue and receivables to zero and `IMP-INV-011` trips on an inconsistent row (R2-B-05); a GL declared to 31 Aug whose last posting is 28 Aug covers August; a GL organization with quarterly statements has complete months; `latestCompletePeriod()` falls back to a `partial` period (R2-B-06); a fresh enqueue during a chain supersedes the run and restarts from `restart_from`, a chunk retry is idempotent, a dead continuation is re-enqueued by the sweep, and a failed run restores pointers (R2-B-07); a daily scheduled run rewrites only `as_of_dependent` pointers for the current period and an unchanged fingerprint finishes `no_change` before any write (R2-B-08); three overlapping statements: replacing the first promotes the dependants and leaves the accepted row count unchanged (R2-B-09); a corrected invoice total flows to revenue and receivables alike; `invoices-open-items-only.csv` requires the `IMP-INV-012` confirmation and never defines revenue or DSO (R2-B-10); a first import of 24 months keeps the current month's critical alert and K3/B3 are unchanged by dismissals (R2-B-11); a same-amount receipt and payment two days apart are not auto-paired; `card_spend_unclassified` appears when a card is repaid but no card statement is imported (R2-B-12).
- **Revision 1.1 cases (each mapped to a finding):** cumulative TB Q1 (`tb_cumulative_q1.xlsx`) gives March revenue = Mar − Feb and NULL with `no_prior_trial_balance` when Feb is absent (F-B-02); card repayment appears in `cash_outflows` and closing cash equals statement closing balances (F-B-01); VAT-inclusive invoice list gives `vat_inclusive` warning and net revenue when `subtotal` present (F-B-05); opening-balance journal `IMP-GL-011` sets ledger receivables/cash and is excluded from P&L; ledger receivables without any opening balance are NULL, never a movement (F-B-06); TB→GL→bank basis switch produces `basis_differs` and fires no variance alert and moves no health rule (F-B-07); incomplete current month gets no score and only record-level alerts, and Home/AI default to the same complete period (F-B-08, F-D-09); two commits 1 s apart both appear in the final snapshots, and a commit during a running run triggers the stale loop (F-D-01, F-B-13); a scheduled run on unchanged records advances overdue and recurring status (F-B-14); remapping an account leaves no `metric_current` pointer for the vacated category (F-B-16); bank-only organization with 30% uncategorised receives a score with three dimensions capped at 70 (F-B-09, F-D-04); K3/B3 are identical between two runs on identical data regardless of alert statuses (F-C-12); `cash.decline` with `opening_cash ≤ 0` uses the absolute floor; `payables_days` excludes payroll.
