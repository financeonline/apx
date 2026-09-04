# MOTION — Financial Engine (Calculation, Health Score, Alerts)

Depends on: `ARCHITECTURAL_DECISIONS.md` (ADR-004..008, ADR-016..018, CD-03..CD-08, CD-18, CD-19, CD-28, CD-30), `DATABASE_ARCHITECTURE.md`, `MVP_SCOPE.md §2.5–2.9`
Consumed by: `EVIDENCE_MODEL.md`, `AI_ARCHITECTURE.md`, `SERVICE_ARCHITECTURE.md`, `TEST_STRATEGY.md`, `UX_ARCHITECTURE.md`
Module homes: `src/modules/financial-engine` (metrics), `src/modules/banking` (bank rules), `src/modules/health` (score), `src/modules/alerts` (rules)

---

## 1. Principles

1. **Deterministic.** Same accepted records + same engine version + same organization settings ⇒ byte-identical `metric_snapshots`. No clocks, no randomness, no network inside `domain/`. "Today" is an explicit input (`asOf`) used only for aging and runway.
2. **Pure domain functions.** `src/modules/financial-engine/domain/*` are functions of typed inputs to typed outputs. They never import Supabase, Next.js or the Anthropic SDK. `services/` load records through `data/` repositories and hand plain arrays to `domain/`.
3. **Only accepted records count.** Every loader filters `record_status = 'accepted'` and `superseded_by IS NULL` (ADR-016). `pending`, `needs_review`, `duplicate`, `rejected`, `incomplete` rows are invisible to the engine.
4. **Decimal arithmetic.** `decimal.js`, 20 significant digits, `ROUND_HALF_UP`, rounding applied once at snapshot write (ADR-006). Money 2 dp; ratios 6 dp stored, 1 dp displayed; days integer; counts integer; HHI 0–1 at 6 dp.
5. **Never zero-fill.** A metric that cannot be computed is written with `value = NULL` and `data_quality.missing[]` explaining why. Zero means "we know it is zero".
6. **Versioned and materialised.** Every value is produced by a `calculation_run` and stored in `metric_snapshots` with `engine_version`, `basis`, `assurance_level`, `components`, `data_quality`, `evidence_query` (ADR-008). UI and AI read snapshots only.
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
| `invoices` | `invoices` | Sales/purchase headers and credit notes | `revenue` (sales), `cost_of_sales`/`operating_expense` (purchase, via `counterparties` default or user mapping), `receivables`, `payables` |
| `bank_transactions` | `bank` | Signed cash movements | via `category_account_id → accounts.standard_category` |

### 2.2 Coverage tests (does a source "cover" a period?)

A source covers `fiscal_period P` for an organization when:

| Source | Coverage test |
|---|---|
| `period_balances` | ≥1 accepted, non-superseded row for `P` whose `balance_kind` is `trial_balance`, or (`pnl_report` for P&L families / `balance_sheet` for balance families), **and** the originating `import_batches.period_start ≤ P.period_start AND period_end ≥ P.period_end` |
| `ledger` | ≥1 accepted `ledger_entries` row with `period_id = P` **and** the organization's ledger has ≥1 accepted entry in the *following* period or `P` ends before the latest ledger batch `period_end` (guards against a partially loaded current month; a partial month is flagged, not excluded) |
| `invoices` | ≥1 accepted invoice with `period_id = P` (revenue family) or `issue_date ≤ P.period_end` and not fully paid before `P.period_start` (AR/AP families) |
| `bank` | For **every** active `bank_accounts` row (`is_active`, not `credit_card`/`loan` for cash families): ≥1 accepted transaction with `transaction_date` within `P`, **or** the account's statements have `period_start ≤ P.period_start` and `period_end ≥ P.period_end` in a committed batch (an account with a covered but empty month is fine). If any active current/savings account is uncovered, bank coverage is `partial`. |

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
- Bank-basis P&L figures carry `data_quality.warnings = ['cash_basis_proxy']` and the UI shows a "cash-basis estimate" tag (CD-03c).
- The dashboard header shows the basis of the P&L family for the selected period ("Accrual — from trial balance", "Accrual — from ledger", "Cash-basis estimate — from bank").

### 2.4 Calculation run algorithm

```
runCalculation(orgId, trigger, triggerRefId):
  1. acquire pg_advisory_xact_lock(hash(orgId))          -- one run per org at a time
     if a run for orgId is 'running' and younger than 15 min → enqueue follow-up, return
  2. affected = affectedPeriods(trigger)                   -- see below
     period_from = min(affected); period_to = latest fiscal_period with any accepted record
     (any change ripples forward: opening_cash, trailing averages, YoY comparisons)
     always extend period_from back 12 months for comparison inputs (read-only, not rewritten)
  3. insert calculation_runs {status:'running', engine_version, period_from, period_to}
  4. load accepted records for [period_from − 12m, period_to] via data/ repositories (RLS-scoped or withOrgScope)
     load accounts, counterparties, bank_accounts, organization settings (fiscal year, base currency)
  5. coverage = computeCoverage(records, periods)
  6. for P in periods ascending:
       basisByFamily = choosePrecedence(coverage[P])
       compute in dependency order:
         L0 category aggregates (per standard_category, per account, per counterparty)
         L1 revenue, cost_of_sales, expense buckets, other/interest/tax
         L2 gross_profit, operating_expenses, operating_profit, net_profit, margins, contribution
         L3 cash_inflows, cash_outflows, net_cash_movement, opening_cash (from P−1 closing_cash), closing_cash
         L4 receivables, payables, overdue, days, working_capital
         L5 customer/supplier dimension metrics, concentrations, HHI
         L6 growth and variance metrics (need P−1, P−12, trailing 3)
         L7 cash_runway_months
       each metric → MetricResult {value|null, unit, basis, assurance, components, data_quality, evidence_query}
  7. write snapshots in one transaction:
       insert metric_snapshots (is_current = true) for the run
       update previous snapshots for same (org, period, metric_key, dimension) set is_current = false
  8. health score: computeHealthScore(P) for each P in range → health_scores (same transaction)
  9. input_fingerprint = sha256(sorted (table, id, updated_at) of every record loaded ∪ accounts.standard_category map ∪ settings)
     update calculation_runs {status:'succeeded', input_fingerprint, stats, finished_at}
 10. enqueue jobs 'alerts.evaluate' {orgId, calculation_run_id, period_from, period_to}
 11. on any error: transaction rolls back, run marked 'failed' with error, previous snapshots remain current
```

**Affected periods by trigger**

| Trigger | `affected` |
|---|---|
| `import_commit` / `import_rollback` | periods of committed/rolled-back rows (from `import_batches.period_start/period_end`) |
| `account_remapped` | every period with data (a category change moves history) |
| `settings_changed` (fiscal year, opening balances) | every period with data |
| `recalc_manual`, `scheduled` | every period with data |

**Idempotency.** Re-running with an unchanged `input_fingerprint` and engine version is a no-op unless `trigger = 'recalc_manual'`; the run is recorded with `stats.skipped = true`. Two identical runs produce identical snapshot rows apart from ids and timestamps; `TEST_STRATEGY.md` asserts this.

**Concurrency.** The advisory lock serialises runs per organization; runs for different organizations proceed in parallel workers. Snapshot writes are one transaction so readers never see a half-written period.

---

## 3. Metric registry

Sign conventions used throughout:

- Ledger: for `income`/`liability`/`equity`-type accounts, amount = Σcredit − Σdebit; for `expense`/`asset`-type accounts, amount = Σdebit − Σcredit. Revenue is therefore positive when normal, negative when refunds exceed sales.
- Period balances: `closing_balance − opening_balance` is the period movement; for P&L categories the movement *is* the period amount (P&L reports supply movement only, so `opening_balance = 0`).
- Bank: `amount > 0` inflow, `< 0` outflow; `is_transfer` rows excluded from inflow/outflow (CD-28).
- Invoices: `sales` adds, `sales_credit_note` subtracts; `purchase` adds, `purchase_credit_note` subtracts. `void` excluded.

Category sets:

- `OPEX_SET = {operating_expense, payroll, marketing, depreciation}`
- `BELOW_LINE = {other_income, other_expense, interest_expense, tax_expense}`
- `CASH_SET = {cash}`; cash-like bank account types `{current, savings}`
- `NON_PNL = {transfer, drawings, equity, loan, credit_card, tax_liability, …asset/liability categories}` — never counted in P&L

Evidence descriptor shorthand `EQ(table, filters)` expands to the JSON in `EVIDENCE_MODEL.md §3`; every snapshot's `evidence_query` is exactly that descriptor with `as_of = calculation_run_id`.

Common missing-data reasons (`data_quality.missing[]`): `no_source_covers_period`, `no_opening_cash`, `no_cost_of_sales_accounts`, `uncategorised_amounts_exceed_threshold`, `comparison_period_missing`, `comparison_is_zero`, `bank_coverage_partial`, `no_counterparty_data`, `no_due_dates`, `insufficient_history`.

### 3.1 Profit & loss metrics

| Key | Unit | Inputs | Formula | Edge cases / missing behaviour | Evidence |
|---|---|---|---|---|---|
| `revenue` | money | P&L basis source, categories `{revenue}` | Σ amount over revenue accounts in P (sign per convention) | Negative allowed (refund-heavy month) with warning `negative_revenue`. Uncategorised debit/credit amounts > 5% of |revenue| → `completeness` reduced and warning `uncategorised_amounts`; > 25% → `value` still written, `assurance = estimated`, missing `uncategorised_amounts_exceed_threshold`. | `EQ(basis_table, {period:P, standard_categories:[revenue]})` |
| `other_income` | money | `{other_income}` | Σ as revenue | — | same shape |
| `cost_of_sales` | money | `{cost_of_sales, inventory movement if TB}` | Σ debit − credit | If the org has **no** account with `standard_category = cost_of_sales` (system account only, never used): `value = NULL`, missing `no_cost_of_sales_accounts` (CD-05). | `EQ(…,{standard_categories:[cost_of_sales]})` |
| `gross_profit` | money | `revenue`, `cost_of_sales` | `revenue − cost_of_sales`; if `cost_of_sales` NULL for `no_cost_of_sales_accounts` → `gross_profit = revenue` with warning `no_cost_of_sales` | If `revenue` NULL → NULL | components `{revenue, cost_of_sales}`; evidence = union of both descriptors |
| `gross_margin` | ratio | `gross_profit`, `revenue` | `gross_profit / revenue` | `revenue = 0` or NULL → NULL (`comparison_is_zero`); `cost_of_sales` NULL for `no_cost_of_sales_accounts` → NULL with missing `no_cost_of_sales_accounts` (shown "n/a", never 100%). Negative revenue → NULL with warning. | components |
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
- Mixed basis across the two periods (e.g. TB last month, bank this month) → warning `basis_differs` and `assurance = estimated`.
- Dimension variances (`expense_by_category.variance.*`, `expense_by_account.variance.*`) are written per dimension id present in *either* period; a category present only now has `comparison = 0`, `pct_change = NULL`, warning `new_in_period`.

`revenue_growth_mom` = `revenue.variance.prev_period.pct_change` and `revenue_growth_yoy` = `revenue.variance.same_period_last_year.pct_change`, written as their own ratio metrics for convenience (same NULL rules).

Property test: `B.variance.prev_period.value(P) = B(P) − B(P−1)` for every P with both present.

### 3.3 Cash metrics

| Key | Unit | Inputs | Formula | Edge cases / missing | Evidence |
|---|---|---|---|---|---|
| `cash_inflows` | money | bank basis: accepted `bank_transactions` in P on cash-like accounts, `is_transfer = false`, `amount > 0`; ledger basis: debits to `cash` accounts excluding contra `transfer` | Σ amount | Partial bank coverage → value written, warning `bank_coverage_partial`, completeness = covered accounts / active accounts. Credit-card and loan accounts are excluded from cash but their *payments from* cash accounts count as outflows. | `EQ(bank_transactions,{period:P, bank_account_ids:[cash-like], direction:'inflow', is_transfer:false})` |
| `cash_outflows` | money | as above, `amount < 0` | Σ |amount| (stored positive) | | direction `'outflow'` |
| `net_cash_movement` | money | | `cash_inflows − cash_outflows` | Transfers cancel by construction; if a transfer has no detected pair (one leg only) it stays in the sums and warning `unpaired_transfer_candidate` is set | components |
| `opening_cash` | money | previous `closing_cash`; else per CD-06 | First period with data: statement opening balance (`import_batches.statement_opening_balance` for the earliest batch per account) → `bank_accounts.opening_balance` where `opening_balance_date ≤ P.period_start` → balance-sheet `period_balances` for `cash` in `P−1`. Sum across cash-like accounts. | None available → NULL, missing `no_opening_cash`; every later `closing_cash` also NULL with the same reason (movement metrics still written). New account mid-history: its opening balance joins at its first covered period. | components per account `{account_id, source, value}` |
| `closing_cash` | money | | `opening_cash + net_cash_movement` | When a statement supplies `balance_after` on the last transaction of P for every account, the engine cross-checks Σ`balance_after` vs computed; difference > £0.01 → warning `statement_balance_mismatch` with the delta in components (computed value still stored; statement value kept in components for display). | components |
| `cash_runway_months` | count (1 dp) | `closing_cash`, `net_cash_movement` for P, P−1, P−2 | `avg_burn = −mean(net_cash_movement over 3 periods)`; if `avg_burn > 0`: `closing_cash / avg_burn`; else NULL with warning `cash_positive` | Requires three non-null periods else `insufficient_history`; `closing_cash ≤ 0` → `0`; cap displayed at 36 ("36+") | components |

Property tests: `closing_cash(P) = opening_cash(P+1)` for consecutive covered periods; `net_cash_movement = cash_inflows − cash_outflows`; transfer pairs sum to zero and appear in neither inflow nor outflow.

### 3.4 Receivables, payables, working capital

`asOf` for aging = `P.period_end` (historical periods) or the run's `asOf` date for the current period (stored in `components.as_of`).

| Key | Unit | Inputs | Formula | Edge cases / missing | Evidence |
|---|---|---|---|---|---|
| `receivables` | money | invoice basis: accepted `sales`/`sales_credit_note` invoices with `issue_date ≤ asOf` and not `void` | Σ `balance_due` as at `asOf` (uses `amount_paid` and `paid_date`: if `paid_date > asOf` the invoice is treated as unpaid at `asOf`) | Invoice basis unavailable → `period_balances`/`ledger` closing balance of `receivables` category (aging metrics NULL, `assurance = calculated`). Credit notes with negative balance reduce the total. | `EQ(invoices,{invoice_type:[sales,sales_credit_note], open_as_of:asOf})` |
| `receivables_overdue` | money | as above | Σ `balance_due` where `due_date < asOf` | Invoices without `due_date` are excluded and counted in `data_quality.warnings: no_due_dates (n)` | descriptor with `overdue_as_of` |
| `receivables_days` | days (int) | `receivables`, `revenue` for P, P−1, P−2 | `receivables / Σrevenue(3 periods) × 91.25` | Any of the three revenue values NULL → `insufficient_history`; Σrevenue ≤ 0 → NULL | components |
| `payables` | money | `purchase`/`purchase_credit_note` invoices | Σ `balance_due` at `asOf` | fallback to `payables` category balance | analogous |
| `payables_overdue` | money | | as receivables_overdue | | |
| `payables_days` | days | `payables`, `cost_of_sales + operating_expenses` over 3 periods | `payables / Σ(cost_of_sales + operating_expenses)(3) × 91.25` | denominator ≤ 0 or NULL → NULL | |
| `working_capital` | money | `closing_cash`, `receivables`, `payables`, and where TB/BS covers P: `inventory`, `other_current_asset`, `other_current_liability`, `credit_card`, `tax_liability` | `closing_cash + receivables + inventory + other_current_asset − payables − credit_card − tax_liability − other_current_liability` | Balance-sheet-only categories absent (no TB/BS) → treated as unknown: metric written with `completeness` reduced and warning `partial_working_capital` listing missing categories; if `closing_cash` NULL → NULL. `basis = 'mixed'` whenever inputs differ. | components with each term and its basis |

### 3.5 Customer and supplier metrics

Customer set = `counterparties` with `kind ∈ {customer, both}`; supplier set = `{supplier, both}`. Merged counterparties (`merged_into_id` set) roll up to the survivor.

| Key | Dim | Formula | Edge cases | Evidence |
|---|---|---|---|---|
| `customer_revenue` | counterparty | Σ revenue attributable to the counterparty in P (invoice basis: invoice totals net of tax and credit notes; ledger basis: revenue-account entries with `counterparty_id`; bank basis: inflows with `counterparty_id`, `estimated`) | Revenue rows without a counterparty are aggregated into a synthetic snapshot `dimension_id = NULL` labelled "Unattributed" so Σ customer_revenue + unattributed = `revenue`. | `EQ(basis_table,{period:P, counterparty_ids:[c], standard_categories:[revenue]})` |
| `customer_contribution` | counterparty | CD-08: `customer_revenue − Σ directly attributable costs` where a cost is attributable when a `cost_of_sales`/`OPEX_SET` ledger entry or purchase invoice carries this `counterparty_id` **as a customer cost** (`counterparties.kind = both` rows need explicit flag; MVP treats purchase invoices from a `both` counterparty as supplier spend, not customer cost). In practice equals `customer_revenue` for most orgs; labelled "revenue contribution" in the UI whenever attributable costs are 0. | `assurance = calculated`, warning `no_cost_allocation` when costs are 0 | |
| `customer_revenue_share` | counterparty | `customer_revenue / revenue` | `revenue ≤ 0` → NULL | |
| `customer_concentration_top1` | none | max `customer_revenue_share` (excluding Unattributed) | Fewer than 1 attributed customer → NULL `no_counterparty_data`; if Unattributed share > 50% → `assurance = estimated`, warning `high_unattributed_share` | components `{top_counterparty_id, share, unattributed_share}` |
| `customer_concentration_top5` | none | Σ of five largest shares | < 5 customers → sum of all with warning `fewer_than_5` | |
| `revenue_concentration_hhi` | none | Σ (share_i)² over attributed customers, 0–1 | as top1; single customer → 1.0 | |
| `supplier_spend` | counterparty | Σ `cost_of_sales ∪ OPEX_SET` amounts attributable to the supplier (purchase invoices; ledger expense entries with `counterparty_id`; bank outflows with `counterparty_id`) | Unattributed synthetic snapshot as for customers | |
| `supplier_concentration_top1`, `supplier_concentration_top5` | none | shares of `Σ supplier_spend + unattributed` | as customer equivalents | |

Property tests: Σ `customer_revenue` (incl. unattributed) = `revenue` (same basis); shares sum to 1 ± 1e−6; HHI ∈ [top1², 1].

### 3.6 Registry summary

Every key above is declared once in `src/modules/financial-engine/domain/registry.ts` with `{key, unit, family, level (L0–L7), dimension_type, dependencies[], formulaId}`. The registry is the source for the AI's `get_metric` catalogue and for the UI's metric labels and definitions ("What is this?" copy). Unknown metric keys are type errors.

---

## 4. Banking rules used by the engine (`src/modules/banking/domain`)

### 4.1 Categorisation precedence
1. **User override** (`category_source = 'user'`): never changed by rules.
2. **Saved organization rule**: `(normalised description signature | counterparty_id) → category_account_id`, created automatically when a user categorises and confirms "apply to similar".
3. **Keyword rule set** (platform, versioned): regex/keyword → standard category (e.g. `/payroll|salary|hmrc paye/` → `payroll`; `/stripe|shopify payout|invoice/` inflow → `revenue`; `/hmrc vat/` → `tax_liability`; `/loan repayment/` → `loan`). Sets `category_source = 'rule'` and `assurance_level = 'inferred'`... no: categorisation does not alter record assurance; it sets `bank_transactions.category_source` only.
4. **AI suggestion** (`ai_suggested`): post-MVP; when present it is still a suggestion until confirmed.
5. **None**: `category_account_id = NULL` → counted as `uncategorised`.

Uncategorised share drives `completeness` for bank-basis metrics (§5).

### 4.2 Transfer detection (CD-28)
For each accepted outflow `t` on cash-like/credit-card/loan accounts of the org: find an inflow `u` on a *different* `bank_accounts` row of the same org with `|u.amount| = |t.amount|`, `|u.transaction_date − t.transaction_date| ≤ 3 days`, both unpaired. Prefer the closest date, then description similarity. Pair → set `is_transfer = true`, `transfer_pair_id` both ways, `category_account_id` = system `transfer` account. Users may unpair or pair manually (`category_source = 'user'` protects the decision). Unpaired transfer-looking rows (description matches `/transfer|tfr|to savings|from current/`) get warning flag `unpaired_transfer_candidate` surfaced in the coverage panel.

### 4.3 Recurring payment detection
1. Signature = lower-cased description with digits, dates, reference codes and whitespace runs removed, truncated to 40 chars; plus `counterparty_id` when set.
2. Group accepted transactions per `(bank_account_id, signature, direction)` with ≥ 3 occurrences in the trailing 18 months.
3. Cadence from median gap in days: 6–8 weekly, 13–15 fortnightly, 27–32 monthly, 85–95 quarterly, 355–375 annual, else irregular. Require ≥ 70% of gaps within ±20% of the median.
4. `expected_amount` = median amount; `amount_tolerance_ratio` = max(0.10, MAD/median).
5. `next_expected = last_seen + cadence`; `status = 'stopped'` if `asOf > next_expected + 1.5 × cadence`; `'changed'` if the last amount deviates > tolerance.
6. Upsert `recurring_payment_groups` (`detector_version`), set `recurring_group_id` on member transactions. Groups are recomputed each run; ids are stable via the unique key.

### 4.4 Bank data → cash metrics
Only accounts with `account_type ∈ {current, savings}` feed `opening_cash`/`closing_cash`. Credit-card and loan accounts are tracked for balances and appear in `working_capital` via categories, not cash. Bank-basis P&L proxy (when chosen by precedence) maps inflows in `revenue` category to `revenue`, outflows by category to expenses, ignoring `transfer`, `loan`, `drawings`, `equity`, `tax_liability` principal movements.

---

## 5. Data quality model

`metric_snapshots.data_quality`:

```json
{ "completeness": 0.0–1.0,
  "warnings": ["cash_basis_proxy", "uncategorised_amounts", "bank_coverage_partial", "statement_balance_mismatch", "basis_differs", "sign_change", "new_in_period", "partial_working_capital", "no_due_dates", "fewer_than_5", "high_unattributed_share", "negative_revenue", "unpaired_transfer_candidate", "partial_month"],
  "missing": ["no_source_covers_period", "no_opening_cash", "no_cost_of_sales_accounts", "comparison_period_missing", "comparison_is_zero", "insufficient_history", "no_counterparty_data", "uncategorised_amounts_exceed_threshold"] }
```

Completeness per family:

| Family | Completeness |
|---|---|
| P&L (ledger/TB) | 1 − (uncategorised |amount| / total |amount| in period) |
| P&L (bank proxy) | 0.6 × (1 − uncategorised share) — capped because it is a proxy |
| Cash | (covered active cash-like accounts / active cash-like accounts) × (1 if opening cash known else 0.5) |
| AR/AP (invoices) | 1 − (invoices without due_date / invoices) |
| AR/AP (balances) | 0.7 |
| Customer/supplier | 1 − unattributed share |
| Derived metrics | min of inputs' completeness |
| Variance | min(current, comparison) |

Propagation: the Health Score excludes a dimension when its required metrics are NULL or completeness < 0.6 (§7); the AI tools return `data_quality` verbatim and the response contract requires the Confidence section to repeat any warning affecting a cited number (`AI_ARCHITECTURE.md`). The Home page shows a single "Data quality" indicator = min completeness of the headline metrics for the selected period, with a link to the coverage panel.

---

## 6. Engine versioning and recalculation

- `engine_version` is semver in `src/modules/financial-engine/domain/version.ts`. **Patch** = bug fix that changes no golden output; **minor** = new metric or new warning (existing values unchanged); **major** = any change to an existing formula, precedence, or category set.
- A **major** bump enqueues `calculation.run` (`trigger = 'scheduled'`, full range) for every active organization at deploy time; until it completes the organization sees a "Figures updating" banner and reads old snapshots (still `is_current` until replaced atomically per period).
- Snapshots are never migrated in place. Old runs remain readable (`is_current = false`) so an AI answer or report generated last month resolves to the numbers it saw.
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

- Dimension **excluded** when any required metric is NULL or the min completeness of its required metrics < 0.6. Excluded dimensions are listed with reason.
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
| K3 spike count | number of `expense.spike` alerts open for P: 0 +10; 1–2 −5; ≥ 3 −15 | |
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
| B3 anomalies | open `bank.unusual_transaction` / `recurring.*` / `duplicate.transaction` alerts for P: 0 +10; 1–2 −5; ≥ 3 −15 | |
| B4 coverage | bank coverage full +10; partial −5 | |

### 7.4 Stored breakdown (`health_scores.breakdown`)

```json
[{ "key": "profitability", "score": 62, "weight_config": 25, "weight_applied": 27.8,
   "included": true, "exclusion_reason": null,
   "metrics": [{"metric_key":"net_margin","value":"0.083","snapshot_id":"…"}, …],
   "rules": [{"rule":"P1","result":"0.05–0.15","points":15}, …],
   "positives": ["Net margin of 8.3% is healthy"],
   "negatives": ["Gross margin fell 3.1 pts over the last 3 months"],
   "data_quality": {"completeness":0.94,"warnings":[]} }, …]
```

`config_version = 'health.config.v1'`. The AI tool `get_health_score` returns this object unchanged.

---

## 8. Alert Engine (`src/modules/alerts`)

### 8.1 Global rules
- Evaluated by job `alerts.evaluate` after every successful calculation run, for every period in the run range, oldest first.
- `dedupe_key = '{rule_key}|{period_id}|{subject_type}|{subject_id or "-"}'` (ADR-018).
- **Suppression (all rules):** skip when the metric's completeness < 0.5; skip the earliest period with data for variance-based rules (`first-period gate`); skip when |amount| < `MIN_ABS = max(£100, 0.5% of revenue)`; for `medium`/`low` severities, do not re-open an alert dismissed within the last 90 days for the same dedupe_key (`cooldown`); an alert whose subject record was superseded/rejected is auto-resolved (`status_reason = 'record_removed'`).
- **Lifecycle:** condition true → upsert in place (severity, explanation, threshold_summary, evidence bundle regenerated, `last_evaluated_at`), status preserved. Condition false → if `open`/`acknowledged` set `resolved` with `status_reason = 'condition_cleared'`; if `dismissed` leave untouched; if `resolved` leave untouched. Never delete.
- Severity is computed from the rule table; `critical` only for cash and duplicate-money rules.
- Every alert gets `recommended_next_step` from the template and an `evidence_bundles` row of kind `alert` (see `EVIDENCE_MODEL.md §5`).

### 8.2 Rule catalogue (`rule_version = 'alerts.rules.v1'`; thresholds are defaults, CD-18)

| rule_key | Family | Trigger (defaults) | Severity | metric_key / subject | Explanation template | Evidence pinned | Next step template |
|---|---|---|---|---|---|---|---|
| `expense.spike_category` | Expense spike | `expense_by_category.variance.prev_period` per category: `pct_change ≥ 0.25` AND `value ≥ 0.02 × revenue` (or ≥ £500 if revenue NULL) | high if `pct_change ≥ 0.50` or `value ≥ 0.05 × revenue`, else medium | `expense_by_category` / `standard_category` | "{category} spending was {current} in {period}, up {value} ({pct}) on {prev_period}." | top 5 records by |amount| in category this period + descriptor for category/period | "Review the largest {category} transactions and confirm they are expected." |
| `expense.spike_account` | Expense spike | as above on `expense_by_account` (ledger/TB basis only); suppressed if the category alert already fired for the same account's category with the same top record | medium | `expense_by_account` / `account` | "{account} rose {pct} to {current}." | top 5 records | as above |
| `revenue.decline` | Revenue decline | `revenue.variance.prev_period.pct_change ≤ −0.15` OR `revenue.variance.same_period_last_year.pct_change ≤ −0.20` | high if ≤ −0.30, else medium | `revenue` / none | "Revenue fell {pct} to {current} in {period} compared with {comparison_period}." | `customer_revenue.variance.prev_period` top 5 negative + revenue descriptor | "Check whether the drop is timing (late invoicing) or lost customers; see the customers that fell most." |
| `margin.deterioration` | Margin deterioration | `gross_margin.variance.trailing_3m_avg ≤ −0.03` OR `net_margin.variance.prev_period ≤ −0.05` | high if net margin now < 0, else medium | `gross_margin` or `net_margin` / none | "Gross margin is {current}, down {value} pts from the 3-month average." | metric snapshots for margin, revenue, cost_of_sales; cost_of_sales top records | "Compare pricing and supplier costs; margin usually moves because one of them did." |
| `cash.decline` | Cash deterioration | `closing_cash.variance.prev_period ≤ −0.20 × opening_cash` OR net_cash_movement < 0 for 3 consecutive periods | high | `closing_cash` / none | "Cash fell from {comparison} to {current} in {period}." | cash_outflows top 10, cash metric snapshots | "Look at the largest outflows this month and confirm they were planned." |
| `cash.runway_low` | Cash deterioration | `cash_runway_months < 3` | critical if < 1.5, else high | `cash_runway_months` / none | "At the current rate of spending, cash would last about {runway} months." | runway components, last 3 net movements | "Prioritise collecting {receivables_overdue} of overdue invoices and defer non-essential spending." |
| `receivables.deterioration` | Receivables deterioration | `receivables_days.variance.prev_period ≥ 10` OR `receivables_overdue / receivables ≥ 0.30` | high if overdue share ≥ 0.50, else medium | `receivables_overdue` / none | "{overdue} of {receivables} owed to you is overdue ({share})." | top 10 overdue invoices by balance | "Chase the {n} largest overdue invoices; the top 3 account for {top3_share}." |
| `payables.deterioration` | Payables deterioration | `payables_days.variance.prev_period ≥ 10` OR `payables_overdue / payables ≥ 0.30` | medium (high if overdue ≥ 0.50) | `payables_overdue` / none | "You owe {overdue} that is past due." | top 10 overdue purchase invoices | "Agree payment plans with the largest overdue suppliers before they affect supply." |
| `concentration.customer` | Customer concentration | `customer_concentration_top1 ≥ 0.35` (medium) or `≥ 0.50` (high); only re-fires when share changes ≥ 0.05 or crosses a band | medium/high | `customer_concentration_top1` / `counterparty` (the top customer) | "{customer} makes up {share} of revenue this period." | customer_revenue snapshot, invoice descriptor for that customer | "Reduce reliance on {customer}: protect the account and grow the next tier." |
| `concentration.supplier` | Supplier concentration | `supplier_concentration_top1 ≥ 0.40` | low (medium if ≥ 0.60) | `supplier_concentration_top1` / `counterparty` | "{supplier} received {share} of spend." | supplier_spend snapshot, descriptor | "Check contract terms and alternatives for {supplier}." |
| `recurring.amount_changed` | Recurring-payment anomaly | group `status = 'changed'`: last amount deviates > max(tolerance, 10%) from expected | medium if deviation ≥ 25% or ≥ £250, else low | none / `recurring_group` | "{signature} was {actual}, usually about {expected}." | the deviating transaction + group's last 6 transactions | "Confirm the new amount is correct with the provider." |
| `recurring.missed` | Recurring-payment anomaly | group `status = 'stopped'` in P for outflow groups with ≥ 6 occurrences (a missed inflow is `recurring.inflow_missed`, medium) | low | none / `recurring_group` | "{signature} did not occur in {period}; it usually does every {cadence}." | group + last 3 transactions | "Check whether the payment was cancelled or is overdue." |
| `recurring.new` | Recurring-payment anomaly | a new outflow group reaches 3 occurrences with expected_amount ≥ £50 | info | none / `recurring_group` | "A new regular payment of about {expected} to {signature} has started." | first 3 transactions | "Confirm this subscription or standing order is intended." |
| `duplicate.transaction` | Duplicate transaction | two accepted records in the same table with equal `dedupe_hash` (both kept via reviewer override) or fuzzy match (same |amount|, same signature, ≤ 1 day apart, different ids) in P, amount ≥ £50 | critical if amount ≥ 5% of monthly outflows or ≥ £5,000, else high | none / `bank_transaction` (or `ledger_entry`) | "Two payments of {amount} to {signature} on {d1} and {d2} look like duplicates." | both records | "Confirm with the supplier or bank; request a refund if paid twice." |
| `bank.unusual_transaction` | Unusual bank transaction | single outflow ≥ max(£1,000, 3 × MAD of outflows over trailing 6 months + median) AND not part of a recurring group AND not a transfer; or any outflow to a new counterparty ≥ 10% of monthly outflows | high if ≥ 25% of monthly outflows, else medium | none / `bank_transaction` | "A payment of {amount} to {signature} on {date} is much larger than usual." | the transaction, descriptor of outflows in P | "Verify this payment was authorised." |
| `deviation.large_transaction` | Large transaction deviation | ledger/invoice record ≥ 3 × the account's median |amount| over trailing 6 months and ≥ £1,000 (ledger/TB basis; bank rule above covers bank basis) | medium | `expense_by_account` / `ledger_entry` or `invoice` | "{description} of {amount} is far above the usual size for {account}." | the record + account descriptor | "Check the invoice or entry is correct and coded to the right account." |
| `variance.significant` | Significant period variance | any of `operating_profit`, `net_profit`, `net_cash_movement` `.variance.prev_period` with |pct_change| ≥ 0.30 and |value| ≥ 0.05 × revenue, where no more specific alert (`revenue.decline`, `expense.spike_*`, `cash.*`) already explains it in the same period | medium (favourable variances are `info`) | that metric / none | "{metric} changed by {value} ({pct}) versus {comparison_period}." | metric snapshot + its top component variances | "Open the analysis to see which categories moved." |

Currency symbols in templates follow `organizations.base_currency`. Templates are rendered by the engine (no AI) into `explanation`; placeholders come only from `threshold_summary`.

### 8.3 Evaluation algorithm

```
evaluateAlerts(orgId, runId, periods):
  lock org (advisory)
  load current snapshots for periods ∪ trailing 12, recurring groups, open alerts for org
  for P in periods ascending:
    ctx = {snapshots(P), snapshots(P−1..P−12), asOf}
    for rule in RULES (ordered: cash.* → duplicate.* → revenue → expense → margin → receivables → payables → concentration → recurring → bank/deviation → variance.significant):
      if suppressed(rule, ctx) continue
      outcomes = rule.evaluate(ctx)          -- zero or more {subject, severity, threshold_summary, pins, descriptor}
      for o in outcomes: upsert alert by dedupe_key; rebuild evidence bundle
      for existing open/acknowledged alert of rule in P not in outcomes: resolve('condition_cleared')
  variance.significant runs last so it can check "already explained" against alerts written this pass
  write audit event alerts.evaluated {run_id, counts}
```

Rules are pure functions `(ctx) → outcomes[]` in `src/modules/alerts/domain/rules/*.ts`, each with a fixture-based test that asserts the exact `threshold_summary`.

---

## 9. Test plan summary (details in `TEST_STRATEGY.md §5–7`)

- **Golden organizations (CD-30):** (A) *Service Co* — 24 months GL export, no cost of sales, one bank account; (B) *Retail Co* — bank statements for two accounts with transfers, sales and purchase invoice lists, credit notes, a duplicate direct debit; (C) *Mixed Co* — trial balances for 12 months, partial ledger for the last 3, opening balance missing for one account. Expected values for every metric in §3 are hand-computed in spreadsheets committed alongside as CSV; tests assert equality to the cent / 6 dp.
- **Property tests** listed under each §3 subsection, run over randomly generated ledgers (fast-check).
- **Precedence tests:** each family × each coverage combination asserts `basis` and `assurance`.
- **Snapshot/replay tests:** run twice ⇒ identical values and `input_fingerprint`; replay from stored run ⇒ identical.
- **Health tests:** each rule boundary (exactly at threshold), exclusion and renormalisation, `score = NULL` with < 3 dimensions.
- **Alert tests:** each rule fires at threshold and not one unit below; dedupe upsert preserves status; `condition_cleared` resolution; dismissed cooldown; first-period gate; evidence bundle non-empty for every fired alert.
