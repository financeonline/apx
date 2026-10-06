# MOTION — Phase 16 Implementation Design
## Funding Readiness (REQ-FR-01…11)

**Status: DESIGN FINALISED — IMPLEMENTATION NOT STARTED — BLOCKED BY DEPENDENCY.**

- **Decisions:** the product owner decided U-1…U-6 on 2026-09-30 (§16). The thresholds in §5 are approved, subject to the five drafting amendments A-1…A-5 (§5.8), which need a one-line confirmation.
- **Dependency:** Phase 16 implementation cannot begin until the separate **Receivables/Payables Engine Recovery** (ADR-120) and its **Health Score regression audit** are complete (§15).
- **Inspection record and source mapping:** `docs/PHASE_16_DESIGN_GATE.md`.
- **Baseline:** Phase 15 released at `74050d1`; audit preserved in `1443e76`. Phase 15 is frozen.

### Legend

| Tag | Meaning |
|---|---|
| **SOW** | Requirement from `SOW_v2_extracted.md` / `PRODUCT_REQUIREMENTS.md`. |
| **EXISTING** | Architecture, code or a threshold present at `74050d1`, reused unchanged. A threshold tagged EXISTING is copied from `health.config.v1` or `alerts.rules.v1` exactly. |
| **APPROVED** | Decided by the product owner (2026-09-30). |
| **REJECTED** | Considered and refused by the product owner; must not be built. |
| **DEFERRED** | Out of Phase 16. |
| **BLOCKED BY DEPENDENCY** | Approved, but may not be implemented until a named prerequisite is complete and audited. |
| **CONFIRM** | A drafting amendment made to satisfy an approved rule; needs a one-line confirmation (§5.8). |

---

## 1. Scope

| Item | Tag | Source |
|---|---|---|
| An indicative Funding Readiness Assessment based on the financial, banking and business information MOTION holds | SOW | §19, REQ-FR-01 |
| Not a lending decision, approval or guarantee | SOW | §19, §26, REQ-FR-02 |
| Seven factors (REQ-FR-03…09), including **receivables and payables (REQ-FR-07), which remains a requirement** | SOW | §19 |
| Output: readiness score, positive factors, negative factors, missing information, improvement actions, evidence | SOW | §19, REQ-FR-10 |
| A standalone assessment and one interactive tenant page | APPROVED | ADR-119 |
| F5 receivables & payables | BLOCKED BY DEPENDENCY | ADR-120 |
| Funding Readiness as a Health Score dimension | DEFERRED | ADR-119 (REQ-BH-10 stays open) |
| Printable/exportable Funding Readiness Report (PDF, report job) | DEFERRED to Phase 17 | SOW §20, REQ-RP-05 |
| Lender marketplace, matching, provider directory, application submission, credit-decision simulation | DEFERRED | SOW §22, REQ-FR-11 |
| AI-generated scores, figures, reasons or recommendations | REJECTED | §12 |
| User-entered financial assumptions that change the score | DEFERRED | — |
| Automatic Action Centre records | DEFERRED | §7 |
| Calculating assessments while the feature flag is off | REJECTED | U-4, ADR-121 |

---

## 2. Decision register

| # | Decision | Tag |
|---|---|---|
| D-1 | Health Score integration deferred; `health.config.v1` and every stored score unchanged **by Phase 16** | APPROVED (ADR-119) |
| D-2 | Phase 16 = assessment + interactive page; no PDF or report generation | APPROVED |
| D-3 | One tenant route `/app/[orgSlug]/funding`; no `/funding`, no `/portfolio/clients/[orgId]/funding` | APPROVED |
| D-4 | Gate the page with the existing `reports.view`; no new permission, role or scope system | APPROVED |
| D-5 | `features.funding_readiness`, default off, super admin toggles | APPROVED |
| D-6 | Every assessment persisted per calculation run, with its rules version | APPROVED |
| D-7 | Weights 20 / 20 / 15 / 15 / 10 / 10 / 10 | APPROVED |
| D-8 | Missing data is not zero; NULL stays NULL | APPROVED (EXISTING engine rule, ADR-104) |
| D-9 | F7 is scored but diagnostic; the gate counts only F1–F6 | APPROVED |
| D-10 | Overall = renormalised weighted mean of the scored factors, 0–100 | APPROVED |
| D-11 | Five presentation bands (§6.4) | APPROVED |
| D-12 | Debt from `loan` + `long_term_liability`; accounting data authoritative; no interest cover; debt ÷ T12M operating profit | APPROVED |
| D-13 | Consistency over six months, reusing the G2 method | APPROVED |
| D-14 | Improvement actions report-only and deterministic | APPROVED (U-6) |
| D-15 | No AI anywhere in the assessment | APPROVED |
| D-16 | Rules version `funding_readiness.v1` | APPROVED |
| D-17 | Factor calculation contract (§4): baseline 50, all applicable rules summed, clamp once, 0.6 completeness exclusion, proxy cap 70, Health rounding | APPROVED (U-2) |
| D-18 | Every threshold in §5 | APPROVED (U-2), with A-1…A-5 CONFIRM |
| D-19 | New engine metric `debt_balance` | APPROVED (U-2, D-12) |
| D-20 | Receivables/payables engine recovery is a separate remediation **before** Phase 16 implementation | APPROVED (U-1, ADR-120) |
| D-21 | Loan-type bank account without balance-sheet debt → debt unavailable; name shown only as a data-quality hint | APPROVED (U-3) |
| D-22 | Calculate only while enabled, with eligible historical backfill on enablement | APPROVED (U-4, ADR-121); the earlier "always calculate" proposal is REJECTED |
| D-23 | Flag off → not-found, no navigation item, enforced server-side and in RLS | APPROVED (U-5) |
| D-24 | Disclaimer wording (§6.5) | APPROVED (U-6) |

---

## 3. Architecture

- **Module:** `src/modules/funding` (domain / data / services).
  - `domain/` is pure: config, rules, score, sentences, action templates.
  - Engine outputs come only through public module indexes (`@/modules/financial-engine`, `@/modules/alerts`, and `@/modules/health` for the shared banded-rule helpers).
- **Inputs:**
  - the organisation's `metric_snapshots` written **by calculation runs** (never test-only or hand-inserted figures);
  - `fiscal_periods`;
  - bank coverage per period;
  - the banking anomaly condition inputs (as health B3);
  - the statement facts behind Phase 13's reconciliation status.

  It reads no ledger, invoice or bank row directly for a figure.
- **When it runs:** only while `features.funding_readiness = true` (ADR-121). Two paths:
  1. **Enablement backfill.** Setting the flag to true enqueues `funding.assess` on the EXISTING job queue, in the same transaction as the flag change. The job assesses every **eligible period**: each complete fiscal period that has current metric snapshots (the periods `metric_current` / `health_current` point to). Each assessment pins the calculation run whose snapshots it read. It establishes `funding_current`.
  2. **Normal schedule.** Every later `calculation.run` gains a funding step immediately after the health step, for the complete periods in its range. It is skipped when the flag is off.

  **Backstop:** the EXISTING nightly job enqueues `funding.assess` for any enabled organisation whose latest eligible period has no current assessment. This covers a flag set by any other path.
- **Flag off:** no calculation, no new rows, no current assessment shown. Rows written while the flag was on stay as the audit record but are unreadable while it is off (§10). Re-enabling runs the backfill again for periods whose current assessment does not cite the period's current run.
- **Chain:** calculation-run snapshots → deterministic factor scoring → deterministic overall score → saved assessment → evidence → UI. No model call anywhere.

---

## 4. Factor calculation contract (APPROVED, U-2)

1. **Assessment period.** P is a complete fiscal period (ADR-030.4). "P−n…P" means the organisation's fiscal periods in calendar order ending at P. A month before the organisation's first period does not exist and has no data.
2. **One sum, one clamp.**
   - Each factor starts at **50**.
   - **Every** applicable rule is evaluated and its points added.
   - The total is clamped to **[0, 100] once, after all rules**; never after an individual rule.
   - Example: 50 + 10 + 20 + 15 + 5 + 20 = 120 → factor score **100**.
   - Integer. (EXISTING `scoreFromRules`.)
3. **Banded rules are data** (`BandedRule` / `ScoreBand`, EXISTING). Semantics (EXISTING `bandOf`):
   - bands are tried top-down;
   - `higher_is_better` matches `value ≥ bound`, or `>` when `exclusive`;
   - `lower_is_better` matches `value ≤ bound`, or `<` when `exclusive`;
   - the last band catches all;
   - values are compared as exact decimals.
4. **Unavailable is not a value.** A rule whose input is NULL (absent, uncomputable, `basis_differs`) is **unavailable**. It is recorded as `skipped` with a reason and adds nothing. It is never read as zero, as poor performance, or as healthy performance (D-8).
5. **Genuine zero and genuine negative are values.** A figure of exactly 0 or below 0 from a valid source is scored as that value, by the bands.
6. **Factor unavailable** (status `missing`, score NULL, never 0) when any of the following holds:
   - (a) a required input has no usable value → `required_input_missing`, carrying the engine's `data_quality.missing` codes;
   - (b) the minimum completeness of the required inputs is < **0.6** → `insufficient_completeness` (EXISTING);
   - (c) every rule was unavailable → `no_applicable_rule`;
   - (d) a factor-specific condition in §5.
7. **Proxy cap.** When a required input is `estimated` or `proxy`, the factor score becomes `min(score, 70)` with "based on bank data only" (EXISTING ADR-035). Not applied to F3 or F7.
8. **Sentences.** A rule with points > 0 → a positive; < 0 → a negative; 0 → neither. They come from fixed templates whose numbers are typed fields with snapshot ids (ADR-032.1 pattern).
9. **Missing information.** Every unavailable factor and unavailable rule yields a fixed missing-information line keyed by its reason.
10. **P&L-complete period (CONFIRM, A-3).** A period p is P&L-complete when:
    - `revenue`(p) and `operating_profit`(p) are usable;
    - their `basis ≠ none`;
    - neither carries `partial_month`.

    This is a property of the financial data alone. A missing bank statement does not make a month P&L-incomplete (bank gaps are scored once, in F3).
11. **No double penalty (APPROVED principle, U-2).** One missing piece of data may lower **at most one rule** across the whole assessment. A factor being unavailable is not a penalty: it is excluded, and only the gate (§6.1) reacts to it. See the matrix in §5.9.

---

## 5. Factor threshold tables (APPROVED, U-2)

Notation: `[a, b)` includes a and excludes b. Money is in the organisation's base currency; ratios are decimals. "Step" for boundary tests: 0.0001 for ratios, 1 for counts and days, 0.01 for money.

### 5.1 F1 · Revenue & profitability — weight 20

| Item | Definition |
|---|---|
| Required | `revenue`(P) **and** `net_profit`(P) usable |
| Source | snapshots, P&L family (`period_balances` → `ledger` → `invoices` → `bank`). Revenue net of tax, credit notes and voids per ADR-027.4/105/107. EXISTING |
| Thin data | completeness < 0.6 → unavailable; bank basis → cap 70 |
| Evidence | snapshots of `revenue`, `net_profit`, `net_margin`, the growth key, `gross_margin`, with their descriptors |

**Zero or negative revenue (APPROVED; A-4 CONFIRM):**
- When `revenue`(P) is usable and **≤ 0**, F1.1 scores **−30** (`no_revenue`), and F1.2 and F1.3 are **unavailable** (`no_revenue`).
- No margin or growth percentage is calculated or shown for that period. The engine already writes the margins as NULL (`comparison_is_zero`, `negative_revenue`).

| Rule | Input | Bands | Zero / negative / unavailable |
|---|---|---|---|
| **F1.1** Net margin | `net_margin`(P) | `[0.15, ∞)` +30 · `[0.05, 0.15)` +15 · `[0, 0.05)` 0 · `(−∞, 0)` −30 — EXISTING P1 | margin exactly 0 → 0; revenue ≤ 0 → −30 `no_revenue` |
| **F1.2** Revenue growth | `revenue_growth_yoy`(P), else `revenue_growth_mom`(P) | `[0.20, ∞)` +30 · `[0.05, 0.20)` +15 · `[−0.05, 0.05)` 0 · `[−0.20, −0.05)` −15 · `(−∞, −0.20)` −30 — EXISTING G1 | revenue(P) ≤ 0 → unavailable; both NULL (e.g. prior revenue 0) → unavailable `no_comparable_period` |
| **F1.3** Gross margin | `gross_margin`(P) | `[0.50, ∞)` +10 · `[0.30, 0.50)` +5 · `[0.20, 0.30)` 0 · `(−∞, 0.20)` −10 — EXISTING P2 | revenue ≤ 0 or `no_cost_of_sales_accounts` → unavailable |

- **Range:** 0–100.
- **Positives / negatives:** "Net margin of {net_margin}", "Revenue up/down {pct} on {comparison}", "Gross margin of {gross_margin}", "A loss of {net_profit}", "No revenue in {period}".

### 5.2 F2 · Cash flow — weight 20 (health C1–C4, EXISTING)

| Item | Definition |
|---|---|
| Required | `closing_cash`(P) **and** `net_cash_movement`(P) usable |
| Source | cash family (`bank` → `ledger` cash accounts → `period_balances`) |
| Evidence | cash snapshots; directional bank descriptors (ADR-028/109) |

**NULL is not zero (APPROVED):**
- **Unavailable cash is not zero cash.** A NULL cash metric (`no_bank_accounts`, `no_opening_cash`, uncovered period) makes the rule unavailable, and the factor too when it is a required input. It is never converted to 0.
- **Genuine zero.** Cash of exactly 0 from a valid source is an actual zero and is scored as 0.
- **Genuine negative.** Negative cash (overdrawn) from a valid source is an actual negative and is scored as such.

| Rule | Input | Bands | Zero / negative / unavailable |
|---|---|---|---|
| **F2.1** Closing cash sign | `closing_cash`(P) | `(0, ∞)` +10 · `(−∞, 0]` −40 — EXISTING C1 | genuine 0 → −40; genuine negative → −40 |
| **F2.2** Runway | `cash_runway_months`(P) | `[6, ∞)` +20 · `[3, 6)` +5 · `[1, 3)` −15 · `(−∞, 1)` −30 — EXISTING C2 | engine gives 0 when cash ≤ 0 → −30. NULL with `cash_positive` → +20 "cash generative". Other NULL → unavailable. |
| **F2.3** Movement trend (A-5 CONFIRM) | `net_cash_movement`, P−2…P | > 0 in ≥ 2 of 3 → +15 · ≤ 0 in all 3 → −20 · else 0 — EXISTING C3 | genuine 0 counts as ≤ 0; a period whose `bankEvidenceRatio` is < 1 or NULL (its movement is a partial figure, or there is no bank evidence) or whose value is NULL counts as unavailable; fewer than 3 available → rule unavailable (a missing statement is never read as a fall) |
| **F2.4** Cash cover | `closing_cash / cash_outflows`(P) | `[2, ∞)` +5 · `[0.5, 2)` 0 · `(−∞, 0.5)` −10 — EXISTING C4 | outflows NULL or 0 → unavailable; negative cash → −10 |

- **Range:** 0–100.

### 5.3 F3 · Banking behaviour — weight 15

| Item | Definition |
|---|---|
| Required | bank **evidence** ratio for P > 0 (EXISTING `bankEvidenceRatio`; NULL — no cash-like account in scope — is **unavailable**, never "full"). **Not** `bankCoverageRatio`: that is the cash family's *completeness* and is `1` for a business with no bank account at all (Step 0E, H-1; Step 0F, N-4) |
| Source | cash snapshots; the B3 anomaly functions (EXISTING); Phase 13 statement facts through the EXISTING `reconciliationFor`, reused unchanged. No new classification or reconciliation logic. |
| Thin data | coverage 0 or no active cash-like account → unavailable `no_bank_coverage`; no proxy cap |
| Evidence | inflow/outflow snapshots; condition `bank_transaction` ids; a `source_document` per statement (`import_batches.source_document_id`); the `closing_cash` snapshot carrying `unreconciled_statement`; `calculation_run` and `fiscal_period` items for F3.5 |

| Rule | Input | Bands | Zero / unavailable |
|---|---|---|---|
| **F3.1** Money in vs out | `cash_inflows / cash_outflows`(P) | `[1.1, ∞)` +15 · `[0.9, 1.1)` 0 · `(−∞, 0.9)` −15 — EXISTING B2 | outflows NULL/0 → unavailable; genuine inflows 0 → −15 |
| **F3.2** Anomalies | count of anomaly conditions for P | `0` +10 · `1–2` −5 · `≥ 3` −15 — EXISTING B3 | scored only when all five anomaly rules could run; otherwise unavailable with the suppression reason |
| **F3.3** Coverage of P | `bankEvidenceRatio` for P | `= 1` +10 · `(0, 1)` −5 — EXISTING B4 | NULL (no cash-like account) → unavailable; `0` → F3's requirement fails. Never `bankCoverageRatio` (H-1) |
| **F3.4** Reconciliation | status per active cash-like account **that has a statement for P** | any `unreconciled` → −10 · else all `reconciled` → +10 · else 0 | accounts with `no_statement` are excluded (F3.3 scores them) → none left → unavailable |
| **F3.5** Statement history (A-1 CONFIRM) | number of periods **P−5…P−1** (the five before P) with `bankEvidenceRatio` = 1 (NULL counts as not covered) | `5` +10 · `3–4` 0 · `0–2` −10 | P is excluded (F3.3 scores it); a period before the first fiscal period counts as not covered |

- **Range:** 0–100.
- **Double-penalty design:**
  - a missing statement **in P** lowers F3.3 only (F3.4 excludes it; F3.5 excludes P; F7 excludes it, §5.7);
  - a missing statement **in an earlier month** lowers F3.5 only (it does not make that month P&L-incomplete for F6, by §4.10).

### 5.4 F4 · Existing debt — weight 15

#### 5.4.1 Engine metric `debt_balance` (APPROVED)

| Item | Definition |
|---|---|
| Key / unit | `debt_balance`, money, reporting sign (owed = positive) |
| Population | accounts with `standard_category ∈ {loan, long_term_liability}` at the run's as-of. `credit_card` and other liabilities are excluded. A card facility counts only when its account is categorised `loan`. |
| Source | the winning balance-family batch for P (EXISTING precedence `trial_balance` → `balance_sheet`), `balance_basis = cumulative`; Σ `closing_balance` of the population |
| Genuine zero | a covering cumulative TB/BS with no loan / LTL balance → **0**, a known zero |
| Unavailable | no covering cumulative TB/BS (ledger-only, invoice-only, bank-only, P&L report only, movement-basis TB) → **NULL**, missing code `no_balance_sheet` (new) |
| Loan-type bank accounts (U-3) | Never establish a debt amount, whatever the account is called or typed: "Business Loan" establishes nothing. Never added to `debt_balance`. When `debt_balance` is NULL and an active `bank_accounts.account_type = 'loan'` exists, its name is shown **only** as a data-quality hint. |
| Evidence | `period_balances` descriptor with `account_ids` (EXISTING v1 filters); for a zero, the batch's `source_document` + `calculation_run` |
| Engine version | minor bump; every existing metric unchanged; not read by health, alerts, the analyst or Phase 15 |

#### 5.4.2 Factor rules

| Item | Definition |
|---|---|
| Required | `debt_balance`(P) usable. **If it is unavailable, the whole factor is unavailable:** no ratio is calculated, the no-debt score is **not** awarded, and the missing line reads **"Debt could not be established from the available balance-sheet data."** (U-3) |
| Derived | **T12M operating profit** = Σ `operating_profit` over P−11…P, defined only when all 12 periods are P&L-complete (§4.10); otherwise NULL (`insufficient_history`) |
| Thin data | completeness < 0.6 → unavailable; estimated inputs → cap 70 |

| Rule | Condition (evaluated top-down) | Points |
|---|---|---|
| **F4.1** Debt pressure | `debt_balance ≤ 0` (debt genuinely absent) → `no_debt`, **whatever the operating profit** | **+25** |
| | `debt_balance > 0` and T12M operating profit NULL → unavailable `capacity_unavailable` | — |
| | `debt_balance > 0` and T12M operating profit **≤ 0** → `no_operating_profit`. No division is performed. | **−30** |
| | `debt_balance > 0` and T12M > 0: ratio = debt ÷ T12M, lower is better: `(0, 1.0]` +25 · `(1.0, 2.0]` +10 · `(2.0, 3.0]` 0 · `(3.0, 4.0]` −15 · `(4.0, ∞)` −30 | as banded |
| **F4.2** Debt trend | `debt_balance`(P−3) NULL → unavailable | — |
| | prior ≤ 0 and current ≤ 0 | 0 |
| | prior ≤ 0 and current > 0 → `new_debt` | −10 |
| | prior > 0: change = (current − prior) ÷ prior, lower is better: `(−∞, −0.10]` +10 · `(−0.10, 0.10)` 0 · `[0.10, ∞)` −10 | as banded |

- A negative `debt_balance` (a debit balance on debt accounts) is treated as "no debt" (+25), with warning `debit_balance_on_debt_accounts`.
- **Range:** 10–85.
- **Presentation:** the capacity bands are product rules, never lender criteria (§6.4).

### 5.5 F5 · Receivables & payables — weight 10 — **BLOCKED BY DEPENDENCY (ADR-120)**

REQ-FR-07 remains a requirement. F5 may not be implemented until the Receivables/Payables Engine Recovery (ADR-120) is complete and its Health Score regression audit has passed. Rules:

- F5 reads only `receivables*` / `payables*` snapshots written by a **calculation run**. It never reads manually inserted, test-only or synthetic figures. F5 tests must produce their inputs through a real calculation run, not by inserting snapshots.
- Missing receivables or payables data is **unavailable, never zero, and never a healthy score.** When both `receivables` and `payables` are unavailable the factor is unavailable, and it can never score "nothing outstanding".
- The funding module never computes these figures itself (that would be a second engine).

Thresholds (APPROVED, applied once the dependency is met):

| Item | Definition |
|---|---|
| Required | `receivables`(P) **or** `payables`(P) usable (EXISTING OR-group shape) |
| Source | receivables/payables family: `invoices` (ageing available) → `period_balances` / `ledger` (balances, ageing NULL); invoices older than the 45-day freshness gate → NULL `stale_invoice_data`; voids excluded, credit notes negative |
| Evidence | invoice descriptors `open_as_of` / `overdue_as_of`, or balance descriptors |

| Rule | Input | Bands | Zero / negative / unavailable |
|---|---|---|---|
| **F5.1** Days to get paid | `receivables_days`(P) | `(−∞, 30]` +15 · `(30, 60]` 0 · `(60, 90]` −10 · `(90, ∞)` −20 — EXISTING Q3 | NULL → unavailable |
| **F5.2** Receivables overdue share | **gross** share (owner decision, ADR-140): overdue open invoices ÷ GROSS open invoices for P — credits stated separately, never netted into the denominator — exactly the EXISTING `receivables.deterioration` share (ADR-124 D-5, `open_credits`); never above 100% | `[0, 0.30)` +10 · `[0.30, 0.50)` −10 · `[0.50, 1]` −20 (0.30 / 0.50 EXISTING `receivables.deterioration`) | no gross open invoices → +10 `nothing_outstanding` (net credits alone never score "nothing outstanding" while invoices are overdue); receivables NULL → unavailable (incl. `opening_invoices_unconfirmed`, R-2); overdue NULL (no ageing) → unavailable `aging_unavailable`; an `estimated` receivables (R-3, undated payments) takes the cap of §4 |
| **F5.3** Payables overdue share | the same gross share for payables (ADR-140) | `[0, 0.30)` +10 · `[0.30, 0.50)` −10 · `[0.50, ∞)` −20 (EXISTING `payables.deterioration`) | as F5.2 for payables |

- **Range:** 0–85.

### 5.6 F6 · Financial consistency — weight 10

Window **W** = P−5…P (six periods; EXISTING `G2_PERIODS`).

| Item | Definition |
|---|---|
| Required | `revenue`(P) and `operating_profit`(P) usable (P is P&L-complete) |
| Source | `revenue` and `operating_profit` snapshots over W, with their `basis` and `partial_month` flags |
| Evidence | pinned snapshots for W; `fiscal_period` items |

**Missing is not a loss (APPROVED):**
- A **missing month** is one that is not P&L-complete: no data, partial data, or a period that does not exist yet. It is only ever counted by F6.1, as a continuity gap.
- A month with **zero or negative operating profit** is a P&L-complete month whose profit is ≤ 0. Only such a month counts as not profitable in F6.3.
- A missing month is **never** counted as loss-making.

| Rule | Input | Bands | Unavailable |
|---|---|---|---|
| **F6.1** Continuity (A-3 CONFIRM) | number of P&L-complete periods in W | `6` +10 · `4–5` 0 · `1–3` −10 | always available when the factor is (P itself counts) |
| **F6.2** Revenue volatility | population CV of `revenue` over W (EXISTING `coefficientOfVariation`) | `≤ 0.15` +10 · `(0.15, 0.40)` 0 · `≥ 0.40` −10 — EXISTING G2 | unavailable unless **all six** periods are P&L-complete (`insufficient_history`); mean ≤ 0 → unavailable `revenue_not_positive` |
| **F6.3** Profitable months | number of periods in W with `operating_profit > 0` | `6` +15 · `4–5` +5 · `2–3` −5 · `0–1` −15 | unavailable unless **all six** periods are P&L-complete. Operating profit exactly 0 is a genuine value and counts as not positive. |

- **Range:** 15–85.
- **Double-penalty note:** a month missing from W lowers F6.1 only. F6.2 and F6.3 become unavailable rather than scoring the gap.

### 5.7 F7 · Data completeness — weight 10 (diagnostic)

F7 is diagnostic. It scores the quality of the data behind the factors that were scored. It never scores which factors are unavailable, and it never substitutes for the gate (§6.1): it is not counted there (D-9).

| Item | Definition |
|---|---|
| Required | at least one of F1–F6 scored; otherwise unavailable |
| Inputs | the required-input snapshots of the scored substantive factors |
| Thin data | no proxy cap |
| Evidence | the scored inputs' snapshot ids and `data_quality`; `calculation_run` |

| Rule | Input | Bands | Unavailable |
|---|---|---|---|
| **F7.1** Completeness (A-2 CONFIRM) | min `completeness` over the scored inputs **excluding cash-family metrics** (`opening_cash`, `closing_cash`, `net_cash_movement`, `cash_inflows`, `cash_outflows`, `cash_runway_months`). Their completeness is the bank coverage ratio, already scored by F3.3. | `[0.95, 1]` +20 · `[0.80, 0.95)` +5 · `[0.60, 0.80)` −10 | no non-cash scored input → unavailable |
| **F7.2** P&L basis | `basis` of `revenue`(P) | `period_balances` / `ledger` +15 · `invoices` +5 · `bank` −15 | basis `none` → unavailable |
| **F7.3** Warnings | distinct codes from **W7** on the scored inputs | `0` +10 · `1–2` 0 · `≥ 3` −10 | — |

**W7** = `statement_balance_mismatch`, `unpaired_transfer_candidate`, `no_due_dates`,
`payment_date_unknown`, `high_unattributed_share`, `vat_inclusive`. These exclude:
- `bank_coverage_partial` and `unreconciled_statement` (scored by F3.3 / F3.4);
- `cash_basis_proxy` (scored by F7.2).

- **Range:** 15–95.

### 5.8 Drafting amendments needing confirmation

Each is the smallest change that makes the approved thresholds obey an approved rule. No approved number changed except A-1's window. Existing Health rules are not touched; the amendments apply to the funding rules only.

| # | Amendment | Why |
|---|---|---|
| **A-1** | F3.5 counts **P−5…P−1** (five periods): 5 → +10, 3–4 → 0, 0–2 → −10 (was P−5…P: 6 / 3–5 / 0–2) | A missing statement in P was penalised by both F3.3 and F3.5 (the U-2 double-penalty rule) |
| **A-2** | F7.1 excludes cash-family completeness | cash completeness *is* bank coverage, already scored by F3.3 |
| **A-3** | "P&L-complete period" (§4.10) replaces `is_complete` in F6.1 and the T12M sum. F6.2 and F6.3 require all six periods P&L-complete. The F6 requirement no longer needs F6.2/F6.3 to apply. | `is_complete` also requires full bank coverage, so one missing statement lowered F3.5 and F6.1. A partial month could otherwise count as loss-making. |
| **A-4** | revenue ≤ 0 → F1.1 −30 and F1.2 / F1.3 unavailable | "do not calculate misleading margin/growth percentages when revenue is zero"; also avoids −30 and −30 for one fact |
| **A-5** | F2.3 treats a period with bank coverage < 1 as unavailable (Health C3 itself is unchanged) | a missing statement in an earlier month makes that month's net movement a partial figure, which could read as a fall and double-count with F3.5 |

### 5.9 Double-penalty matrix (APPROVED principle, U-2)

| One missing / weak piece of data | Rule that scores it | Rules that must not |
|---|---|---|
| No bank account at all | none: F2 and F3 are unavailable, and only the gate reacts | F7 (cash excluded) |
| Statement missing for one account in P | F3.3 (−5) | F3.4 (excluded), F3.5 (P excluded), F6 (bank-independent), F7.1 (cash excluded), F7.3 (not in W7) |
| Statement missing in an earlier month | F3.5 | F6.1 (bank-independent), F2.3 (that month is unavailable, A-5) |
| Statement does not reconcile | F3.4 | F7.3 (`unreconciled_statement` not in W7) |
| No balance sheet | none: F4 is unavailable, only the gate reacts | F7 |
| P&L data missing for an earlier month | F6.1 | F6.2 / F6.3 (unavailable), F4 (T12M unavailable, not −30) |
| Bank-proxy P&L | F7.2 | F1 / F6 carry the proxy **cap** (a ceiling, not a deduction) |
| Receivables/payables unavailable | none: F5 is unavailable | F7 |

---

## 6. Overall score

### 6.1 Availability gate (APPROVED)

A numeric score requires **F1 and F2, plus at least 3 of F3–F6**. An equivalent statement:
- at least **5 of F1–F6** are scored; and
- their combined weight is **≥ 72 / 90**.

Check of the equivalence: F1 + F2 = 40, and the smallest three of F3–F6 add 10 + 10 + 15 = 35, giving 75 ≥ 72. Conversely, missing F1 or F2 leaves at most 70 < 72.

- F7 does **not** count.
- When the gate is not met: `overall_status = insufficient_data`, `overall_score = NULL`, and the page says **"Insufficient data"**. No partial numeric score is shown or stored. The factor cards, missing information and actions still show.
- `data_coverage_percent = round_half_up(100 × scored weight in F1–F6 ÷ 90)`.

### 6.2 Formula (APPROVED; rounding EXISTING `health/domain/score.ts`)

Let V = the scored factors among F1–F7.

```
applied_weight(f) = round_half_up( weight(f) / Σ_{g∈V} weight(g) × 100 , 1 dp )
overall_score     = round_half_up( Σ_{f∈V} score(f) × applied_weight(f) / Σ_{f∈V} applied_weight(f) , 0 dp )
```

An unavailable factor is never in V and never contributes 0. The result is an integer 0–100. The stored breakdown carries `applied_weight`, so the score can be re-derived exactly from the stored row.

### 6.3 Statuses

| Status | When |
|---|---|
| no row | flag off (never calculated), P incomplete, or no calculation run yet |
| `insufficient_data` | gate not met |
| `scored` | gate met |

### 6.4 Bands (APPROVED)

| Score | Label |
|---|---|
| 90–100 | High indicative readiness |
| 75–89 | Strong indicative readiness |
| 60–74 | Moderate indicative readiness |
| 40–59 | Developing indicative readiness |
| 0–39 | Low indicative readiness |

These are product presentation bands only. They are never a lender classification, credit grade,
approval likelihood or predicted outcome, and never merged with the Health Score bands.

### 6.5 Disclaimer (APPROVED, U-6)

> "Funding Readiness is an indicative financial-readiness assessment based on the data available in
> this organisation. It is not a lender, credit, investment or funding approval rating. Missing or
> incomplete information can reduce the assessment's coverage and reliability."

Shown first on the page and beside every rendering of the score; stored on each assessment row.

---

## 7. Improvement actions (APPROVED, U-6)

- **Triggers.** One action per negative rule result, and one per unavailable factor, from fixed templates keyed by `(rule, result)` or `(factor, reason)`. Every action names the factor and the rule or reason that triggered it. **AI never determines the score or writes the reason.**
- **Fields:** `factor`, `rule` or reason, `reason` sentence, `evidence` (snapshot ids / bundle, or the missing-data code), `priority`.
- **Priority** uses the EXISTING `action_priority_enum` vocabulary, never `critical`:
  - points ≤ −30 → `high`;
  - −29…−10 → `medium`;
  - −9…−1 → `low`;
  - unavailable F1–F6 → `medium`;
  - unavailable F7 → `low`.
- **Order:** priority, then factor weight, then factor order, then rule order.
- **Templates** (APPROVED examples):

| Trigger | Action |
|---|---|
| F2.2 runway below 3 months | "Review near-term cash commitments: cash would last about {runway} months." |
| F5.1 days to get paid above 60 | "Review overdue customer balances: customers take about {days} days to pay." |
| F4.1 ratio above 3.0, or `no_operating_profit` | "Review debt exposure against operating profit." |
| F3.3 partial coverage, or F3.5 below 5 | "Upload the missing bank statements." |
| F4 unavailable `no_balance_sheet` | "Import a trial balance or balance sheet so debt can be established." |

- No Action Centre rows are created; the Action Centre lifecycle is unchanged.

---

## 8. Evidence (APPROVED: reuse)

- **Store:** the one evidence store (`evidence_bundles` / `evidence_items`).
- **Bundle:** one bundle per assessment row, kind `funding_assessment` (a new value on the EXISTING `evidence_kind_enum`, following `forecast` and `scenario`). It is written in `api_server.finish_funding` in the same transaction as the row, pinned to the assessment's calculation run.
- **Items:** existing item types only: `metric_snapshot`, `query` (`debt_balance`), `bank_transaction`, `source_document`, `fiscal_period`, `calculation_run`.
- **Descriptors** carry `as_of.calculation_run_id`. Signs, net-of-tax, voids and merges are the engine's (ADR-105/107/108/109/111), and nothing is restated.
- **Drawer:** the EXISTING `/app/[orgSlug]/evidence/[bundleId]`. For a `funding_assessment` bundle, the server also enforces the flag (§10).

---

## 9. Persistence (APPROVED; mirrors `health_scores`)

**`public.funding_assessments`** — append-only; unique `(organization_id, period_id, calculation_run_id)`.

| Column | Type / rule |
|---|---|
| `id` | uuid pk (assessment_id) |
| `organization_id`, `calculation_run_id`, `period_id` | org-composite FKs to `calculation_runs` and `fiscal_periods` |
| `overall_score` | smallint NULL, check 0–100; NULL iff `insufficient_data` |
| `overall_status` | `scored` \| `insufficient_data` |
| `band` | text NULL iff score NULL |
| `factors_used`, `factors_total` (= 7) | smallint |
| `substantive_weight_scored` (0–90), `data_coverage_percent` (0–100) | smallint |
| `breakdown` | jsonb. Per factor: key, weights, status, score, reason, capped, completeness, rules (value, band, points, unavailable reason), metrics (key, value, snapshot_id), conditions, positives / negatives (template + typed values + snapshot ids), missing, actions |
| `rules_version` | `funding_readiness.v1` |
| `engine_version` | text |
| `trigger` | `enablement_backfill` \| `calculation_run` \| `nightly_backstop` |
| `disclaimer` | text |
| `created_at` | generated_at |

- **`public.funding_current`** — pointer per `(organization_id, period_id)`, like `health_current`.
- **Writes** go only through `api_server.finish_funding`: service role, SECURITY DEFINER, owner `motion_definer`, complete periods only. Its guard allows two cases:
  - the same run's retry while that run is `running`;
  - the backfill writing against a `succeeded` run whose snapshots it read.
- **No write grants; forced RLS.**
- **Read RLS:** the EXISTING five-role allow-list over the accessible set (ADR-065) **AND** `organizations.features->>'funding_readiness' = 'true'` for the row's organisation. `suspended_member` is excluded.
- **Purge:** covered by `api_server.purge_organization`.
- **Not a ledger:** the breakdown stores copies of snapshot values with their snapshot ids, as `health_scores.breakdown` does. It is an audit record, never read back as financial truth.
- **History:** a future `funding_readiness.v2` writes new rows and never rewrites v1.

---

## 10. Access and feature flag (APPROVED)

| Role | `/app/[orgSlug]/funding` (flag on) |
|---|---|
| Owner | own organisation(s) |
| Admin | organisations where admin |
| Client | own organisation |
| Employee | assigned organisations only, at aal2; revocation effective on the next request |
| Super admin | all organisations, at aal2 |
| Suspended member / organisation | denied (`suspended_member` lacks `reports.view`) |
| Stranger | uniform not-found |

Every role gets not-found when the flag is off.

- **Server guard:** `getAccessContext(orgSlug)` → `requirePermission(ctx, 'reports.view')` → flag check → not-found when off. The flag is re-read on every request; the client never supplies an organisation id.
- **Flag off (U-5), enforced at three layers, never by UI hiding alone:**
  1. the page returns not-found and the navigation item is absent (server-rendered from the same check);
  2. the funding read services and the evidence route refuse `funding_assessment` bundles;
  3. RLS on `funding_assessments` / `funding_current` returns no rows.
- **Toggle:** the super admin uses the EXISTING `OrgFeatureToggle` on `/platform/organizations/[orgId]`. Enabling goes through a server path that sets the key, writes the audit event and enqueues `funding.assess` in one transaction (ADR-121).

---

## 11. Routes and UI

| Route | Change | Tag |
|---|---|---|
| `/app/[orgSlug]/funding` | new; the only Funding Readiness page | APPROVED |
| `/app/[orgSlug]/evidence/[bundleId]` | unchanged route; flag enforced for funding bundles | APPROVED |
| `/portfolio/clients/[orgId]` | one link to `/app/[slug]/funding` when the flag is on (UI only) | APPROVED |
| `/platform/organizations/[orgId]` | one `OrgFeatureToggle` for `funding_readiness` | APPROVED |
| `/funding`, `/portfolio/clients/[orgId]/funding`, report/PDF routes | not created | APPROVED |

**Page order:**
1. Disclaimer.
2. Score and band, or "Insufficient data".
3. Data coverage.
4. Seven factor cards.
5. Positive factors.
6. Negative factors.
7. Missing information (including debt/loan-account hints).
8. Improvement actions.
9. Evidence drill-down.
10. Rules version, assessment timestamp, run.

**States:** preparing (enabled, backfill running), no eligible period yet, insufficient data, scored, loading, error.

The page has no horizontal scroll at 375 px, and long names wrap.

---

## 12. AI boundary (APPROVED)

- No AI in scores, factor states, sentences, reasons, actions, evidence or the page. No model call in `funding.assess` or the calculation step.
- The analyst, its tools, prompts and eval corpus, and the adviser briefing are unchanged. No new tool. `get_health_score` is unchanged.
- An analyst that explains a saved assessment is DEFERRED; it would need its own design and audit.

---

## 13. Protection boundary (APPROVED)

**Phase 16 must not alter:**
- Phase 15 authorisation and portfolio scope (`getAccessContext`, `app.portfolio_scope`, `app.adviser_org_ids`; ADR-112/114/117);
- Phase 15 AI grounding / structured briefing (ADR-118), digest, attention;
- Health Score behaviour, past or future (ADR-119);
- Phase 13 banking logic (`reconciliationFor` may be exported, not edited);
- Phase 14 commercial logic;
- engine sign, net-of-tax, void and merge conventions, and existing metric values;
- the evidence architecture;
- the Action Centre lifecycle.

**Phase 16's only edits outside its own module, tables and page:**
1. the funding step in `calculation.run`, plus the `funding.assess` job handler;
2. the `debt_balance` metric and the `no_balance_sheet` code;
3. the `funding_assessment` bundle kind;
4. purge coverage;
5. the enable path that enqueues the backfill, plus the nightly backstop;
6. one flagged navigation item;
7. one flagged portfolio link;
8. one platform toggle.

Each edit needs a regression test proving the old behaviour unchanged.

**The receivables/payables recovery is not a Phase 16 edit.** It is ADR-120's separate remediation, and any Health Score or alert change it causes is audited there, not here.

---

## 14. Test design (document only)

**Unit:**
- every band at bound − step, bound and bound + step (inclusive and exclusive), generated from the config;
- genuine zero, genuine negative and NULL, for every input;
- the one-clamp contract (the 120 → 100 example; a sum below 0 → 0; no per-rule clamp);
- revenue ≤ 0 (F1.1 −30, F1.2 / F1.3 unavailable);
- `cash_positive`;
- debt ≤ 0 → +25 regardless of T12M;
- debt > 0 with T12M ≤ 0 → −30 and no division;
- T12M NULL → unavailable;
- debt unavailable → factor unavailable, no +25;
- P&L-complete period definition (partial month, basis none, bank gap does not matter);
- F6: a missing month is never loss-making;
- the §5.9 matrix, one test per row, asserting each piece of data lowers exactly one rule;
- F7 excluded from the gate;
- the gate at 4 / 5 / 6 of 6, each single-missing case (F1 or F2 missing fails);
- F1 + F2 + 3 of F3–F6 ≡ 5 of 6 ∧ ≥ 72;
- no partial score when the gate fails;
- rounding at .5;
- bands at 39/40, 59/60, 74/75, 89/90;
- byte-identical repeatability;
- action priority and order;
- templates contain no untyped numbers.

**Engine (`debt_balance`):**
- TB with loan / LTL / both / neither (→ 0);
- balance sheet without TB;
- TB beats balance sheet;
- movement-basis TB → NULL;
- ledger-only → NULL;
- a loan-type bank account (including one named "Business Loan") never contributes;
- `credit_card` excluded;
- recategorisation as-of;
- descriptor reconciles (the EXISTING sweep);
- existing golden outputs unchanged.

**Integration:**
- empty organisation;
- no bank accounts (F2 / F3 unavailable, never cash 0);
- genuine zero cash;
- negative cash;
- incomplete history;
- refunds and credits;
- voided invoices;
- invoice-basis;
- ledger-basis;
- bank-only (cap 70);
- debt via `loan`;
- debt via `long_term_liability`;
- zero debt vs unavailable debt;
- partial current month (no row);
- boundary fixtures per factor.

**F5** (after ADR-120 only): inputs produced by a real calculation run (no `writeMetric`); unavailable receivables/payables → F5 unavailable, never "nothing outstanding".

**Flag lifecycle:**
- off → a calculation run writes no funding rows;
- enable → `funding.assess` enqueued atomically → every eligible period assessed → `funding_current` set, `trigger = enablement_backfill`;
- the next calculation run assesses its periods;
- the nightly backstop fills a gap;
- disable → no new rows, page not-found, RLS returns nothing, existing rows retained;
- re-enable → stale periods re-assessed.

**Evidence:**
- displayed figure = snapshot = descriptor total;
- correct basis and sign;
- voids excluded;
- the bundle resolves only in its own organisation;
- a funding bundle is refused while the flag is off.

**Security (integration + pgTAP):**
- cross-organisation denial for client / owner / admin;
- unassigned employee denied;
- revocation effective on the next request;
- a crafted slug or id does not bypass scope;
- RLS = page for all five roles, suspended, and flag off;
- no write grants;
- `finish_funding` refuses non-service callers, incomplete periods and foreign runs;
- append-only guard;
- purge.

**Browser:**
- the journey: enable → preparing → scored page → factor → evidence → back;
- the portfolio link;
- desktop and 375 px;
- empty, insufficient-data, loading and error states;
- a long name;
- many evidence rows;
- axe.

**Regression:** the full gate set on a clean database, run sequentially, including every Phase 13, 14 and 15 suite and the Health golden tests. `ai-eval-record` is reported with its measured flake rate, never as a pass.

---

## 15. Dependency chain and build sequence (APPROVED)

```
Receivables/Payables Engine Recovery        (separate remediation, ADR-120)
        ↓
Health Score regression audit               (independent; intentional Q3 / alert changes reviewed)
        ↓
Phase 16 implementation, including F5 implementation
        ↓
Phase 16 full regression + independent audit
```

Phase 16 implementation order, once both prerequisites pass:
1. Confirm A-1…A-5.
2. The `debt_balance` engine metric and its tests.
3. The funding domain and unit tests.
4. Persistence:
   - migration: tables, guard, RLS with flag, `finish_funding`, enum value, purge;
   - pgTAP;
   - the `funding.assess` job, the calculation step, the enable path and the nightly backstop;
   - integration tests.
5. Page, navigation, portfolio link, platform toggle; security and e2e tests.
6. Full regression, then an independent audit of the final commit. Phase 17 does not start until it is READY.

---

## 16. Decisions U-1…U-6 (final)

| # | Decision | Status |
|---|---|---|
| **U-1** | The receivables/payables/working-capital gap is fixed as a **separate engine remediation before Phase 16 implementation** (ADR-120), which requires:<br>1. calculation invocation;<br>2. deterministic persistence;<br>3. empty and missing-data handling;<br>4. unit, integration and pgTAP coverage;<br>5. tenant/RLS verification;<br>6. Health Score regression testing.<br>F5 never reads manual or synthetic figures; missing stays unavailable. Health Score rules and alerts beginning to fire is intentional and independently audited there. Phase 16 does not silently alter Health behaviour. | APPROVED; F5 BLOCKED BY DEPENDENCY |
| **U-2** | All proposed v1 thresholds, with these amendments:<br>• F1: zero or negative revenue −30, no misleading percentages;<br>• F2: NULL is not zero;<br>• F3: no double penalty;<br>• F4: debt > 0 with T12M ≤ 0 → −30 and no division; no-debt score regardless of operating profit;<br>• F5: blocked;<br>• F6: missing month ≠ loss;<br>• F7: diagnostic, not the gate.<br>Drafting amendments A-1…A-5 need confirmation. | APPROVED (A-1…A-5 CONFIRM) |
| **U-3** | No debt inferred from a bank account's name or type. Without trustworthy TB/BS debt: debt unavailable, no ratio, no no-debt score; the loan-account name is shown only as a hint; "Debt could not be established from the available balance-sheet data." | APPROVED |
| **U-4** | "Always calculate, flag gates visibility" is REJECTED. Instead: **calculate after enablement with eligible historical backfill** (ADR-121). | APPROVED (old proposal REJECTED) |
| **U-5** | Flag off: not-found, no navigation link, enforced server-side, and RLS matches | APPROVED |
| **U-6** | Disclaimer wording (§6.5); deterministic, factor-grounded actions (§7); AI never determines the score or reason | APPROVED |
