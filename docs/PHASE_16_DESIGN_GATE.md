# Phase 16 — Funding Readiness: Design Gate (inspection record)

**Status:** inspection complete; design finalised in `docs/PHASE_16_IMPLEMENTATION.md`. The product
owner decided U-1…U-6 on 2026-09-30, and the thresholds are approved. Drafting amendments A-1…A-5 await a
one-line confirmation. **No application code, migration, test, permission, schema, RLS or AI change has
been made. Phase 16 implementation has not started** and is **BLOCKED BY DEPENDENCY** on the
Receivables/Payables Engine Recovery (ADR-120).

```
Receivables/Payables Engine Recovery (ADR-120)
        ↓
Health Score regression audit
        ↓
Phase 16 implementation, including F5
```

- **Baseline:** `1443e76` (docs) on audited `74050d1`; Phase 15 frozen.
- **Inspected (2026-09-30):**
  - SOW §19–21, `PRODUCT_REQUIREMENTS.md` §18–19, `MVP_SCOPE.md`, `FINANCIAL_ENGINE.md` §2–8, `EVIDENCE_MODEL.md` §3–5, `RBAC_MATRIX.md` §1–2, `ROUTE_ARCHITECTURE.md` §1, `PHASE_13_IMPLEMENTATION.md`, ADR-025 / CD-19;
  - `src/modules/health` (config, apply, dimension, score, rules/*), `financial-engine` (registry, compose, coverage, receivables, cash, types), `dashboard/services/banking.ts`, `portfolio` (attention, services), `app/_lib/authz`, `platform` feature toggles;
  - migrations for `health_scores` / `health_current` / `finish_health` / `evidence_*` enums, `aggregate_periods`, `bank_period_summary`, `import_batches`.

---

## 1. Findings

### G-1 · The engine never produces receivables, payables or working-capital metrics (verified)
- **Registry vs code:** the registry (`financial-engine/domain/registry.ts`) and `FINANCIAL_ENGINE.md §3.4` define `receivables`, `receivables_overdue`, `receivables_days`, `payables`, `payables_overdue`, `payables_days` and `working_capital`. A pure `computeReceivables` exists (`domain/receivables.ts`, introduced in `b2a6861`, Phase 4).
- **Never called:** `composePeriod` (`domain/compose.ts`) runs the P&L, cash and concentration modules only. `computeReceivables` has **no caller** in `src/`, and **no migration** writes those keys.
- **Database:** the local database after the last gate run holds `closing_cash` (16) and `revenue` (16) snapshots, and **zero** snapshots for any of the seven keys (read-only query, 2026-09-30).
- **Tests:** the tests that need them insert them by hand (`writeMetric` in `test/integration/money-pages.test.ts`).
- **Knock-on:** health rule Q3 is always skipped. The alerts `receivables.deterioration` and `payables.deterioration` can never fire. Money › receivables / payables have no figures from the engine.
- **Impact on Phase 16:** factor F5 has no authoritative source.
- **Resolution (U-1, APPROVED):** a separate engine remediation (**ADR-120**), done before Phase 16 implementation and followed by an independent Health Score regression audit. The resulting Health / alert changes are intentional and are audited there. F5 is **BLOCKED BY DEPENDENCY** and must never read hand-inserted or synthetic figures.

### G-2 · There is no debt figure
- **No metric:** no metric key covers debt.
- **But the data is aggregated:** `app.aggregate_periods` already returns `period_balances` cells per `standard_category` with `balance_kind` and `balance_basis`, and `coverage.ts` already has the balance-family kind precedence (`trial_balance` → `balance_sheet`).
- **So:** a `debt_balance` engine metric can be built from existing aggregates with no SQL change. It is designed in `PHASE_16_IMPLEMENTATION.md §5.4.1` (PROPOSED).

### G-3 · Reconciliation status is derived in the dashboard service, not in the banking domain
- **Where it lives:** Phase 13's per-account status (`reconciled` / `unreconciled` / `balances_missing` / `no_statement`) is computed by `reconciliationFor` in `src/modules/dashboard/services/banking.ts`. Its inputs are the statement facts `api.bank_period_summary` reads: statement opening/closing balances, and `IMP-BAL-006/007` issues.
- **Engine already carries it:** `unreconciled_statement` is already propagated onto cash snapshots (`financial-engine/domain/cash.ts`).
- **Design (no new reconciliation engine):** F3.4 reuses `reconciliationFor` unchanged. Its evidence is the statement's `source_document` (`import_batches.source_document_id`, an EXISTING `evidence_item_enum` value) plus the `closing_cash` snapshot carrying the warning.

### G-4 · Feature-flag convention exists and is minimal
- **The convention:** `organizations.features` jsonb, read as `features.<key> === true`. The one precedent is `ai_pdf_extraction` (import page), and the super admin toggles it through `OrgFeatureToggle` → `api.update_organization`.
- **Status of the key:** nothing reads `funding_readiness` yet. Phase 16 follows the same convention, with no new framework.
- **Resolution (U-4 / U-5, ADR-121):**
  - calculate only while enabled, with eligible historical backfill on enablement ("always calculate" is REJECTED);
  - flag off → not-found, no navigation link;
  - enforced server-side and by an RLS flag predicate.

---

## 2. Conflicts between the first brief and the project, and how each is resolved

| # | Conflict | Resolution | Tag |
|---|---|---|---|
| K-1 | Docs make Funding Readiness a Health dimension; activating it changes every score and Phase 15 comparisons | Deferred, **ADR-119**; `MVP_SCOPE` row 100 and `FINANCIAL_ENGINE §7.1` annotated, not deleted | APPROVED |
| K-2 | "Report" vs SOW §20 Phase 17 report | Phase 16 = assessment + page; PDF/report is Phase 17 | APPROVED |
| K-3 | `/funding`, `/portfolio/clients/[orgId]/funding` | `/app/[orgSlug]/funding` only, plus a link from the portfolio client page | APPROVED |
| K-4 | No funding permission | `reports.view` | APPROVED |
| K-5 | ADR-025 flag | `features.funding_readiness`, default off | APPROVED |
| K-6 | Mixed-currency test | Not applicable: one currency per organisation (IMP-CUR-007). Tests assert the base currency instead | EXISTING |
| K-7 | New scoring mechanics vs the Health Score's | Health mechanics reused (baseline 50, all applicable rules summed then clamped once, completeness 0.6, proxy cap 70, rounding) | APPROVED (U-2) |
| K-8 | On-demand read model vs pinned evidence | Persist per run, like `health_scores` | APPROVED |
| K-9 | F5 has no production source (G-1) | Separate engine recovery first (ADR-120); F5 blocked | APPROVED / BLOCKED BY DEPENDENCY |
| K-10 | Calculate while flag off? | Only while enabled, with backfill on enablement (ADR-121) | APPROVED; the earlier proposal REJECTED |
| K-11 | Loan-type bank account without balance sheet | Debt unavailable, no ratio, no no-debt score; the name shown only as a hint | APPROVED (U-3) |
| K-12 | One missing piece of data lowering several rules | One-penalty principle; amendments A-1…A-5 and the matrix in `PHASE_16_IMPLEMENTATION.md §5.8–5.9` | APPROVED principle; A-1…A-5 CONFIRM |

---

## 3. Source mapping: factor → source → calculation → evidence → permission → UI

Permission is the same for every row: `getAccessContext` → `reports.view` → flag → RLS over the
accessible set (`PHASE_16_IMPLEMENTATION.md §10`). The UI for every row is a factor card on
`/app/[orgSlug]/funding`, with sentences, missing lines, actions and an evidence link (§11).

| Factor | Authoritative source (EXISTING unless noted) | Calculation | Evidence |
|---|---|---|---|
| F1 Revenue & profitability (20) | snapshots `revenue`, `net_profit`, `net_margin`, `gross_margin`, `revenue_growth_yoy` / `_mom`; P&L family precedence | rules F1.1–F1.3 (P1 / G1 / P2 bands) | snapshot ids + their descriptors (ADR-105/107/111) |
| F2 Cash flow (20) | `closing_cash`, `net_cash_movement`, `cash_runway_months`, `cash_outflows`; cash family; `no_bank_accounts` = NULL (ADR-104) | F2.1–F2.4 = C1–C4 | cash snapshots, directional bank descriptors (ADR-109) |
| F3 Banking behaviour (15) | bank coverage ratio; `cash_inflows` / `cash_outflows`; B3 condition functions; Phase 13 statement facts via `reconciliationFor` | F3.1–F3.3 = B2–B4; F3.4 reconciliation; F3.5 history over P−5…P−1 (A-1) | snapshots, pinned `bank_transaction`, `source_document` per statement, `calculation_run`, `fiscal_period` |
| F4 Existing debt (15) | **new** `debt_balance` (cumulative TB/BS, `loan` + `long_term_liability`); `operating_profit` ×12 over P&L-complete periods | F4.1 debt pressure: no debt +25; T12M ≤ 0 → −30, no division; ratio bands. F4.2 trend. Debt unavailable → factor unavailable | `period_balances` descriptor (`account_ids`); batch `source_document` for a zero; 12 pinned `operating_profit` snapshots |
| F5 Receivables & payables (10) — **BLOCKED BY DEPENDENCY** | `receivables*`, `payables*` written by a calculation run **after** ADR-120's recovery; never hand-inserted | F5.1 = Q3; F5.2/F5.3 overdue shares with alert thresholds 0.30/0.50 | invoice descriptors `open_as_of` / `overdue_as_of` |
| F6 Financial consistency (10) | `revenue`, `operating_profit` over 6 periods, with basis and `partial_month` (P&L-complete, A-3) | F6.1 continuity; F6.2 = G2 CV and F6.3 profitable months, both only when all six are P&L-complete | `fiscal_period` items, pinned snapshots |
| F7 Data completeness (10), diagnostic, not in the gate | `data_quality` (completeness, warnings) and `basis` of the scored inputs | F7.1 min completeness excluding cash-family metrics (A-2), F7.2 basis, F7.3 warnings | the scored inputs' snapshot ids; `calculation_run` |

---

## 4. Who receives a numeric score in v1

**Gate:** F1 and F2 plus at least 3 of F3–F6. Equivalently, at least 5 of F1–F6 scored with weight ≥ 72/90. F7 does not count.

Because Phase 16 implementation starts only **after** ADR-120's recovery, F5 is expected to be available wherever the organisation holds a receivables/payables source. The column "F5 before recovery" shows why the dependency matters.

| Organisation's data | F1 | F2 | F3 | F4 | F5 before recovery | F5 after recovery | F6 | Result (after recovery) |
|---|---|---|---|---|---|---|---|---|
| Bank statements only | proxy, cap 70 | ✓ | ✓ | ✗ `no_balance_sheet` | ✗ | ✗ no AR/AP source | proxy | **Insufficient data** (F4, F5 missing) |
| Invoices + bank | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ (invoice basis) | ✓ | **Scored** (only F4 missing: 75/90) |
| Ledger (GL) + bank, no TB/BS | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ only with an opening balance, else ✗ | ✓ | Scored or Insufficient data, by opening balance |
| Cumulative TB/BS + bank, ≥ 6 months | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ (balance basis) | ✓ | **Scored** |
| Cumulative TB/BS, no bank account | ✓ | ✗ `no_bank_accounts` (ADR-104) | ✗ | ✓ | ✗ | ✓ | ✓ | **Insufficient data** (F2 mandatory) |
| Loan-type bank account named "Business Loan", no TB/BS | … | … | … | ✗ unavailable; name shown only as a hint (U-3) | … | … | … | per the other factors |

---

## 5. Remaining open items

- **Confirm A-1…A-5** (`PHASE_16_IMPLEMENTATION.md §5.8`). These are drafting amendments made to satisfy the approved double-penalty and missing-≠-loss rules. Four keep every approved number; A-1 changes F3.5's window.
- **Prerequisites:** ADR-120's remediation and its Health Score regression audit must complete before Phase 16 implementation.
- Nothing else is open. U-1…U-6 are decided (`PHASE_16_IMPLEMENTATION.md §16`).
