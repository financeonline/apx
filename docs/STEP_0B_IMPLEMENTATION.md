# Step 0B — import review, FU-15, FU-9, FU-6, assurance propagation

> **Superseded in part by Step 0C (`docs/STEP_0C_IMPLEMENTATION.md`):** the engine is now 7.0.0 (6.0.0 never released); the daily recalculation is enqueued HOURLY from `/api/jobs/scheduled` (ADR-135), not from `/api/jobs/nightly`; `receivables_days` follows the same VAT rule as `payables_days` (ADR-133).

Branch `fix/step0-import-type-mapping` (uncommitted), on `2783240`. Engine 5.0.0 → **6.0.0**.
Records: ADR-128 (FU-15), ADR-129 (FU-9), ADR-130 (assurance), ADR-131 (FU-6); `docs/STEP_0B_ENGINE_REGRESSION_RECORD.md`.

## 1. Import review (Step 0 changes, revised)

| Item | Outcome |
|---|---|
| Names with digits | The established rule (ADR-045.3, `findFigureInName`, tested in `import-mapping.test.ts`) refuses currency marks, ISO currency codes, money-grouped numbers and percentages, and allows digits alone. The SQL guard in `api.create_import_counterparties` was narrowed to never refuse what TypeScript allows ("10 Percentage Points Ltd"). 25 numbered business names were checked in TS and SQL: 3M, 7-Eleven, Forever 21, A1 Plumbing, 1-800-Flowers, No. 10 Bistro, 24/7 Logistics, Hotel 1000, and others. Consequence of the established rule: "1,000 Islands Ltd" is refused (grouped digits). |
| Non-bank PDFs | Step 0 refused them before storage, which **removed** document storage. Reverted. Every PDF is now **stored** as a source document under its kind (listed, access-controlled, traceable). Only a `bank_statement` PDF is **read**. Other PDFs start no batch and import no rows, and the uploader is told to export CSV/Excel. `document.extract` refuses non-statement batches. No OCR. |
| Balance sheet / PDF in the upload form | Balance sheet offered (commits to `period_balances` as `balance_sheet`; IMP-TB-012/013 confirmations as for a trial balance). The file picker accepts `.pdf`; the hint says whether the chosen type's PDF is read or only stored. |
| `/api/imports/upload` | `documentKind` validated against `document_kind_enum` (it was cast raw, same defect class as D1). |
| Counterparty function vs RLS/permissions | Runs as `motion_definer` (`definer_all` policy); `imports.review`; batch open and target `invoices`; kind from the batch; audited; `on conflict do nothing` (concurrent creation); merged counterparties untouched. Covered by pgTAP 17 (not run) and PGlite (38/38). |
| Scope changes kept and flagged | A GL row naming a merged-away counterparty now resolves to the survivor (was NULL); the counterparty read pages past 1,000 rows. |

## 2. FU-15 (ADR-128)

`coverage.ts invoiceSideCoverage`: a list knows through `min(declared end, commit date)` for the spanning test, the DSO history (`fullListSpans`) and an aged-debtors list's as-at date. Tests: `fu15-ar-ap-coverage.test.ts` (15; 6 fail on 5.0.0); golden boundary cases.

## 3. FU-9 (ADR-129)

Traced footing:
- **Payables numerator:** VAT-inclusive (`balance_due`; the AP control balance).
- **Expense base:**
  - invoice basis: net (`app.invoice_net`);
  - ledger/TB: net if VAT-registered, gross if not;
  - bank proxy: gross.

New rule (recorded data only, no rate):
- **Invoice basis:** divide by the purchase lists' gross (net + recorded tax, minus credit notes).
- **Balance basis:** divide by a gross expense base only; otherwise NULL `vat_basis_unknown`.

Tests: `engine-receivables.test.ts` (payables block rewritten: VAT-inclusive, mixed-rate, zero-tax, no-tax-column, registered, not registered, unknown, bank, zero denominator); `fu9-payables-vat.test.ts`; `alert-rules.test.ts` (the days trigger fires on comparable days and stays silent when unavailable, while the overdue share still works).

## 4. FU-6 (ADR-131)

- **Range** (`chunking.affectedRange`): every run recomputes from the month its predecessor computed as current, if that month has since ended. `scheduled` writes the current period (and that month) with every key.
- **Enqueue:** `api_server.enqueue_scheduled_recalculation()` from `/api/jobs/nightly`, after the upgrade sweep.
- **Queue:** a scheduled payload gives way when another trigger coalesces into it; failed or stale jobs with a queued twin are coalesced, not re-queued.
- **Alerts:** event alerts of unevaluated periods are not resolved.

Evidence:
- `engine-run-control.test.ts` (rollover cases);
- `nightly-route.test.ts`;
- `alert-evaluate.test.ts`;
- PGlite 20/20 on the migration verbatim;
- the 5.0.0 `finish_job` / `reclaim_stale_jobs` reproduced the `23505` jam.

## 5. Assurance (ADR-130)

- Statements carry the assurance commit stamped (`statementRecordAssurance`). Bank figures are weakened to the weakest statement overlapping the period.
- `app.batch_record_assurance` and the rewritten `app.promote_dependants` keep a promoted row's own batch's level, and the columns commit writes.
- Docs aligned: IMPORT_ENGINE §5.3/§5.4/§12.1 "as built" notes.
- `engine-compare.ts` reports assurance-only changes.

## 6. Fresh results (isolated copy, portable Node 24.21, 2026-10-05)

| Check | Result |
|---|---|
| typecheck (cold, `--incremental false`) | PASS |
| lint | PASS |
| unit | PASS, 86 files, 2,274 tests |
| unit coverage gate (per-directory thresholds) | PASS (engine domain 99.8% lines / 96.06% branches) |
| AI eval (recorded) | PASS, 253 |
| production build (cold) | PASS |
| PGlite — `api.create_import_counterparties` verbatim, platform helpers stood in | 38 / 38 |
| PGlite — `20261005000002` verbatim + `app.batch_record_assurance` | 20 / 20 |

**Blocked: no Docker, so no local Supabase.**
- **pgTAP:** all suites, including the new 17, 18 and 19.
- **Integration:** all suites, including the new `import-wizard-types.test.ts`.
- **Schema drift.**
- **Playwright journeys.**
- **The 27-organisation engine regression comparison.**

PGlite with helper stand-ins does not replace these: it does not exercise real RLS, roles, triggers, or the other migrations.

## 7. Remaining engine findings (unchanged, recorded separately)

| ID | Status at 6.0.0 | Effect | Notes |
|---|---|---|---|
| FU-5 | Reproducible | NULL (fails closed): receivables/payables/working capital with no opening journal, even when a prior balance sheet exists | Intentional per ADR-120 H-12; needs an anchor-precedence decision |
| ADR-124 R-1 | Reproducible | NULL (fails closed): July receivables when the GL is split mid-month; the reason says `no_opening_balance`, not `partial_month` | Golden corpus pins it; a §2.2 decision |
| FU-11 | Partly | Evidence only: the days figures' drill-down names only P's inputs | No value changes; still needs a version bump when fixed |
| FU-16 (new) | Pre-existing | Two non-scheduled triggers coalescing keep the queued payload; a later import into an EARLIER month waits for another trigger | Found while fixing FU-6 |
