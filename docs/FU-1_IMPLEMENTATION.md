# ADR-125 (FU-1) — Implementation record

**Status: IMPLEMENTED (engine 4.0.0, migration `20260930000004`). Not independently audited.**
- FU-1 is fixed, together with the two defects that adversarial review found in the first cut: FU-13 (blocker) and FU-14 (major).
- The owner has deferred the comprehensive independent audit until the remaining approved phases are built.
- **Nothing here is an audit approval, and nothing here declares the system production-ready.**
- Phase 16 (Funding Readiness) has not been started.

The decisions are in `ARCHITECTURAL_DECISIONS.md` ADR-125, the rule is in `FINANCIAL_ENGINE.md` §2.2, and the generated record is `docs/FU-1_ENGINE_REGRESSION_RECORD.md`.

---

## 1. Root cause (exact)

The defect was in `src/modules/financial-engine/domain/coverage.ts`, in the invoices block of `computeCoverage`.

`arApBatch` was set for any invoice batch that either spanned P or had `daysBetween(P.end, committedAt) <= 45`. The second test was meant as the AR/AP freshness gate, and it is true in two cases it should not be:
- for **every** batch committed BEFORE P, because the gap is negative;
- therefore for months far in the future.

On that flag, the invoices source covered P for the P&L with warning `open_items_only`. The rest followed:
- §2.3's P&L precedence (`period_balances` > `ledger` > `invoices` > `bank`) chose invoices.
- `composePeriod` summed zero invoice cells, giving revenue **0.00**, assurance `calculated`, completeness 1 and no missing reason.
- The same coverage fed the counterparty (customer) family, and `isPeriodComplete` made the month complete.
- A complete month is scored by Health, so Health scored a manufactured zero-revenue month.

## 2. Trace

1. **Coverage** (`computeCoverage`): the invoices source covers P for the P&L and customer families and sets the invoices `latestDataDate`.
2. **Precedence** (§2.3): with no `period_balances` or `ledger` coverage, invoices wins over `bank`.
3. **Compose** (`composePeriod`): P&L cells from the invoice aggregate, which is empty for an uncovered month, so 0.00. The figure is stated rather than NULL, because coverage said the month was covered.
4. **Persistence**:
   - `metric_snapshots` / `metric_current` store the 0.00.
   - `set_period_completeness` stores `is_complete = true`.
   - The Health step scores the month and repoints `health_current`.
5. **Readers**: Home, Insights, Reports, the Health history and the AI tool layer all read the stored 0.00 as a fact.

## 3. The fix (engine 4.0.0)

`coverage.ts` has three new pieces: `invoiceRevenueCoverage`, `revenueRuns` and `revenueDataDate`.

- **Only full sales lists.** Target `invoices`, `invoice_list_kind = 'full'`, import type `sales_invoices` or `sales_report`. `open_items` lists and purchase-only lists never cover revenue.
- **Effective range.** A list covers from its declared start to the EARLIER of its declared end and its **commit date**. A list knows nothing after the day it was committed: the upload form allows any end date, and a new batch defaults to the whole current month.
- **Combining.** Effective ranges that meet or overlap combine into runs, as statements do (ADR-124 D-1).
- **Completed P.** Covered if and only if the combined runs contain every day of P.
- **P not yet begun** (after the as-of): never covered.
- **Current P.** Revenue TO DATE, through the earlier of the run's end and the as-of:
  - warning `partial_month`;
  - completeness = days reached ÷ days in P;
  - complete only when the run reaches P's end.
- **`latestDataDate.invoices`** = the latest effective end, capped at the as-of, so a current month stated to date is not `is_complete`.
- **`arApBatch` deleted.** The 45-day freshness gate belongs only to `invoiceSideCoverage` (AR/AP, ADR-124 D-3), which is unchanged.
- **Fallthrough unchanged.** An uncovered month falls through §2.3: the bank cash proxy, else NULL `no_source_covers_period`. A covered month with no sales is a genuine, stated 0.00.
- **`receivables-input.ts` `denominatorInputsFor`.** For the current month's invoice revenue to date (`partial_month`), `revenue`, `invoiceSalesTotal` and `payablesExpenseBase` are all NULL. Days figures are not computed from a few days of flow.
- **`ENGINE_VERSION` 4.0.0.** This is a major change because existing values change.
  - The golden hash was re-recorded.
  - The golden corpus includes the FU-1 cases: spanned, genuine zero, before/after the range, stops short, committed before, purchase only, open items, current to date / unreached / spanned, committed mid-month, contiguous halves, halves with a gap.
  - It was mutation-checked.

## 4. FU-13 · The list kind was never written (blocker, found by adversarial review)

**The defect.** The import pipeline never wrote `invoice_list_kind = 'full'`:
- The only writer is `api.record_batch_confirmation`. It copies `p_value ->> 'invoice_list_kind'`.
- The review page never sends that key: it confirms IMP-INV-012 with `{answer: 'yes'}`.
- The column has no default.

So every list committed through the app had a NULL kind, and under 4.0.0 it would have stated no revenue.

**The fix: migration `20260930000004_fu1_list_kind_and_stale_health.sql`.**
- **Trigger `import_batches_invoice_list_kind`** → `app.invoice_list_kind_at_commit()`, `BEFORE INSERT OR UPDATE OF status, invoice_list_kind` on `import_batches`.
  - When an invoice batch reaches `committed` with a NULL kind, it sets `open_items` if `confirmations ? 'IMP-INV-012'`, else `full`.
  - An explicit kind is untouched.
- **`app.backfill_invoice_list_kind()`** applies the same rule to batches already committed. The migration calls it once. It is a function, so the rule the backfill applies is the one pgTAP tests.

**Consequence (recorded, not hidden).** Existing imported lists now read as `full` (or `open_items`) on the AR/AP side too:
- For real organisations, `receivables_days` can now be computed from them. `fullListSpans` was always false with a NULL kind.
- A list confirmed under IMP-INV-012 states a completed month only when its as-at date is that month's end (ADR-124 D-3).

This is the import specification finally being true of the data, not a rule change: IMPORT_ENGINE says every invoice batch has a kind ∈ {`full`, `open_items`}. The regression fixtures always set the kind, so the 27-organisation record cannot show this change.

## 5. FU-14 · A month that stops being complete kept its Health score (major, review)

**The defect.** A period that stopped being complete kept the Health pointer an earlier run had left in `health_current`. Home and the Health history kept showing a score built on figures the engine no longer states.

**The fix.** `api_server.set_period_completeness` now deletes the `health_current` row of any period it marks incomplete.
- The `health_scores` rows (history) are kept.
- No Health rule, weight or threshold changed (ADR-030.4).

**Known limit.** A run that FAILS after withdrawing a pointer does not restore it. The failed-run restore only restores that run's own pointers, and `is_complete` was never restored on failure either.

## 6. Tests

**New**
- `test/unit/fu1-revenue-coverage.test.ts` (25): the rule, case by case.
- `test/fixtures/fu1-orgs.ts`: 16 permanent organisations. Their shapes are in the fixture header.
  - COVERED, ZERO, NOTCOVER, LATERONLY, EARLIERONLY, DURING, PRECEDENCE, CURRENT;
  - BANKINV, EMPTY, GAPS, HISTORYFIRST, STALE, CUSTOMER, PURCHONLY, OPENITEMS.
- `test/integration/fu1-remediation.test.ts` (27), through the real queue:
  - **The 15 required cases.** These include the AI tool layer returning no value for uncovered months.
  - **Evidence and tenancy.** Evidence reconciliation, and a tenancy case.
  - **STALE.** A 3.0.0 July 0.00 plus a planted complete and scored July. The test checks, in order:
    - Home shows the figures as "updating";
    - `enqueueEngineUpgrade` queues the organisation;
    - July is recomputed to NULL and is no longer complete;
    - its Health pointer is withdrawn and its history row is kept.
  - **FU-13 through the REAL commit path** (`api.commit_import_batch`, `api.record_batch_confirmation`):
    - a plain list commits as `full` and states May 4,200;
    - a confirmed list commits as `open_items` and states no revenue.
  - **FU-14**, via PRECEDENCE.
- `supabase/tests/16_fu1_list_kind.test.sql` (14):
  - the trigger;
  - an explicit kind is kept;
  - a non-invoice batch is untouched;
  - the backfill touches exactly the committed NULL-kind invoice batches;
  - grants.

**Updated**
- `test/unit/engine-coverage.test.ts`: two tests now use genuine full sales lists.
- `test/unit/engine-invoice-basis.test.ts`.
- `test/unit/engine-version-golden.test.ts`: the FU-1 corpus, and a test that the FU-1 cases state revenue exactly where it is established.
- `test/integration/adr124-remediation.test.ts`: the literal `'3.0.0'` pin is replaced by "major ≥ 3". FU-1's STALE test pins major ≥ 4.
- **EARLIERONLY now expects June NULL too.** The list was committed on 5 June and declared to 30 June, so it saw 1–5 June only (decision 2).

## 7. Gates

All run on the final code, database gates on a clean database, one at a time.

| Gate | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | pass |
| Lint (`eslint .`) | pass |
| Unit (`vitest --project unit`) | **2,161 / 2,161** (79 files) |
| Unit with the coverage gate | pass — `coverage.ts` 100 % lines / 97.4 % branches |
| AI eval (`vitest --project eval`) | **253 / 253** |
| Production build (`next build`) | pass |
| Integration (`vitest --project integration`) | **867 / 868** in one run — the one failure is the pre-existing `ai-eval-record` flake `get_alerts #16 output shape` (26 vs 27) |
| `ai-eval-record` isolated × 10 | 7 / 10 — all 3 failures `get_alerts #16 output shape` (26 vs 27), the baseline rate measured on `8493362` and on ADR-124 (pre-existing; not suppressed) |
| pgTAP (`supabase test db`) | **1,102 / 1,102** (19 files) |
| Schema drift (`check:schema`) | pass — 55 tables, 127 api functions, RLS forced everywhere |
| Playwright | **69 passed, 1 skipped** (pre-existing conditional skip) |
| FU-1 (`fu1-remediation` + `fu1-revenue-coverage`) | 27 / 27 integration; 25 unit |
| Evidence reconciliation sweep | **54 → 42 checked, 0 mismatches** (§9) |
| 27-organisation comparison | done; every change explained (§8) |

## 8. Meaningfulness

`fu1-remediation` was run on the 3.0.0 engine (a worktree at `df9db4a`, against the current database). **15 of the 27 tests fail** — every FU-1 case:
- COVERED Sep/Oct, NOTCOVER, LATERONLY, EARLIERONLY, DURING, GAPS;
- PURCHONLY, OPENITEMS, BANKINV;
- CURRENT ×2, CUSTOMER Aug;
- AI NOTCOVER, STALE, and FU-13 open items.

The 12 that pass on both engines are regression guards:
- COVERED Jun–Aug, ZERO, HISTORYFIRST, EMPTY, PRECEDENCE, CUSTOMER Jul;
- AI June, evidence, tenancy, version;
- FU-13 full list, FU-14.

The last two live in the migration, which that database already had. Without the migration, the FU-13 test's `full` assertion fails by construction.

## 9. 27-organisation regression record (3.0.0 → 4.0.0)

Full generated record: `docs/FU-1_ENGINE_REGRESSION_RECORD.md`. It was produced by `scripts/engine-compare.ts`, which now also follows `revenue`, `cost_of_sales`, gross/operating/net profit, `operating_expenses`, the margins and `customer_concentration_top1`.

| Organisation | Figures | Health | Alerts |
|---|---|---|---|
| BANK, LEDGER, TB, EMPTY, HISTORY, GAP, MIDSTART, LEDGER2, TBBS, MOVTB, GAPGL, PARTJUL, NEWACCT, LEDGER3, UNRECON, MIDTYPED, CYCLE (17) | unchanged | — | — |
| INVBANK, INVONLY, CREDITHEAVY, PARTIALPD, LONG, BIGINV, CNFUTURE | P&L 2026-09 → 2027-08: 0.00 → NULL `no_source_covers_period` | — | — |
| CURRENT | P&L 2026-10 → 2027-08: 0.00 → NULL. September stays revenue to date; the warning is now `partial_month` instead of `open_items_only`, and warnings are not compared | — | — |
| BSREV | P&L 2026-02 and 2026-04 → 2027-08 (every month except March): 0.00 → NULL. The lists were committed before those months | February's score withdrawn | — |
| BSLIST | P&L 2026-08 → 2027-08: 0.00 → NULL | — | — |

**How to read the changes.** Every change is P&L 0.00 → NULL `no_source_covers_period`, in months no full sales list establishes. The margins' reason changes from `comparison_is_zero` / `no_cost_of_sales_accounts` to `no_source_covers_period`.

**Unchanged:** every cash, receivables, payables and working-capital figure.

## 10. Evidence sweep 54 → 42

This was instrumented on both engines. The 12 descriptors that dropped out are the sweep invoice organisation's revenue for 2026-09 to 2027-08. Each was a figure of 0.00 on the invoice basis: a manufactured zero behind a month its August-only list does not cover. Under 4.0.0 those months are NULL, so they have no descriptor. None was added, and all 42 reconcile (0 mismatches).

## 11. Health and alert effects

- **Health.** Only BSREV February's score is withdrawn. It rested on manufactured revenue and opex (`banking_health` 60, `cost_control` 60 on K3), and February is no longer complete.
  - On an upgraded database, FU-14 now also withdraws its `health_current` pointer.
  - The freshly reset comparison database cannot show that step. STALE asserts it.
- **Alerts.** No alert added or removed.
- **Unchanged:** no Health rule, weight or threshold, and no alert rule or threshold.

## 12. Security and tenancy

- **RLS and grants unchanged**, except for the two new functions.
  - `app.invoice_list_kind_at_commit` and `app.backfill_invoice_list_kind` are `SECURITY DEFINER`, `search_path = ''`, owned by `motion_definer`, and revoked from public, anon and authenticated (pgTAP).
  - The trigger runs as definer.
- **`api_server.set_period_completeness`** keeps its guards:
  - service-role claim, else 42501;
  - `app.require_scope(p_org)`;
  - executable only by `service_role`.

  Its new delete is filtered by the job's organisation and the period id.
- **Recalculation cannot cross organisations.** Coverage reads only the job's organisation's batches. The upgrade sweep queues one job per organisation through `app.enqueue_recalculation`.
- **Evidence and tenancy** are proven in `fu1-remediation`: another organisation's owner resolves nothing from COVERED's July revenue.

## 13. Remaining findings

- **FU-12 · Cost side (OPEN).**
  - A sales-only full list states `cost_of_sales` / `operating_expenses` 0.00 and profit = revenue.
  - The mirror: a purchase-only list's costs are now NULL.
- **FU-15 · New (OPEN).** `invoiceSideCoverage` (AR/AP) does not yet limit a list to its commit date. It is out of FU-1's scope by the owner's instruction (AR/AP unchanged).
- **Month rollover.** A current month's stored revenue to date stays until the next recalculation. There is no daily scheduled run (FU-6).
- **FU-14's failed-run restore limit** (§5).
- **P&L snapshot completeness** reflects categorisation, not coverage. This is pre-existing and applies to all bases.
- **FU-2, FU-3 and FU-5 to FU-11:** unchanged.

**Owner sign-off (2026-09-30).** ADR-124's 27-organisation Health/alert change set is APPROVED. This sign-off does not cover ADR-123's F-11 table.

**Not done by design:** Phase 16 (Funding Readiness) has not been started. There has been no independent audit of this work.
