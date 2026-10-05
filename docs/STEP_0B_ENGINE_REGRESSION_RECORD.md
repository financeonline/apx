# Step 0B engine regression record — 5.0.0 → 6.0.0

> **Superseded in part by Step 0C:** 6.0.0 was never released; the branch is at **7.0.0** (`receivables_days` VAT footing, bank-proxy netting — ADR-133) and `health.config.v2` (ADR-134). The 27-organisation comparison must be run 5.0.0 → 7.0.0 (`scripts/validate-step0.sh compare`); this record covers only the pure-engine 5.0.0 → 6.0.0 corpus diff.

**Status: PARTIAL.** The pure-engine comparison below is complete and fresh. The 27-organisation database comparison (`npm run engine:compare`, the FU-12 record's method) has **not** been run: it needs the local Supabase stack, and the authoring environment had no Docker. It must be produced, with `scripts/engine-compare.ts` (now reporting assurance-only changes and the two days figures), before 6.0.0 is released.

## Method (fresh, 2026-10-05)

`test/unit/engine-version-golden.test.ts`'s corpus was dumped as JSON from the 5.0.0 and the 6.0.0 engines in isolated copies of the repository and diffed field by field. The corpus is the pure engine over a fixed set of organisations' cells, batches, statements and invoices (P&L on a ledger, per-account cash, receivables and payables from invoices, a balance sheet, opening journals, the AR/AP freshness matrix, FU-1 and FU-12's invoice coverage).

Recorded hash: 5.0.0 `f73cd20f…` → 6.0.0 `edb0d10f…` (`test/fixtures/engine-golden.json`).

## What changed in the existing corpus

FU-15 only. Every other existing output is byte-identical.

| Corpus case | Figure | 5.0.0 | 6.0.0 |
|---|---|---|---|
| FU-1 "committed mid-month" (a sales list declared to August, committed 20 July) | July `receivables` | 0.00, `verified`, basis invoices | NULL `stale_invoice_data`, basis none |
| same | July `receivables_overdue` | 0.00, `verified` | NULL `stale_invoice_data` |
| same | July `receivables_days` | NULL `insufficient_history` | NULL `stale_invoice_data` |
| same | July `working_capital` | receivables term from invoices | receivables term missing (`stale_invoice_data`) |
| FU-12 "purchases committed mid-month" | July `payables`, `payables_overdue`, `payables_days`, `working_capital` | 0.00 `verified` / from invoices | NULL `stale_invoice_data` / term missing |

The 5.0.0 figures were the defect: a list committed on 20 July cannot state 31 July's position, and stated it as a verified zero.

FU-9 and ADR-130 moved nothing in the existing corpus. Its `payables_days` were already NULL (`insufficient_history`), and every corpus statement is CSV (`verified`). New corpus cases were added so the hash now covers them:

| New case | Result (6.0.0) |
|---|---|
| FU-15 boundaries: declared past commit · late month-end (committed 4 months later) · aged-debtors list as at the end but committed before it · committed before the month | not covered · covered · not covered · not covered |
| FU-9 purchase gross (20% + zero-rated − credit note) | 1,580.00 a month |
| FU-9 `payables_days` from invoices | 50 (2,600 ÷ 4,740 × 91.25) |
| FU-9 from a balance, not VAT-registered / bank proxy | 13 (2,600 ÷ 18,000 × 91.25) |
| FU-9 from a balance, VAT-registered / status unknown | NULL `vat_basis_unknown` |
| ADR-130 June (an unreconciled PDF statement overlaps it) | cash `calculated`; bank-proxy revenue stays `estimated` (already weaker) |
| ADR-130 July and August (an AI-read statement overlaps them) | cash and bank-basis P&L `inferred`; values unchanged |

## Expected effect on real organisations (not measured — needs the database run)

- **Organisations whose invoice lists were committed mid-month with a range reaching past the commit date** (the upload form's default whole-month range makes this common): that month's receivables and payables move from a verified figure to the balance sheet, the ledger, or NULL `stale_invoice_data`. So do overdue amounts, the days figures, working capital, Health Q3, and the receivables/payables deterioration alerts.
- **Every ledger- or trial-balance-based organisation:** `payables_days` becomes NULL `vat_basis_unknown`, because `vat_registered` is set nowhere in the product (see ADR-129).
  - The payables deterioration alert can then fire only on the overdue share, never on a days increase.
  - Invoice-basis organisations' `payables_days` change value (gross over gross); bank-proxy organisations' are unchanged.
- **Organisations with an AI-read or unreconciled PDF statement:** that month's cash and bank-basis figures are re-badged (`inferred` → "Please check"; `calculated`). Values are unchanged.
- **Health:** Q3 can be skipped where receivables or payables become NULL. *Superseded by Step 0C:* under `health.config.v2` (ADR-134) an `inferred` input caps a dimension at 70, so AI-read months' Health can fall.
