# ADR-120 — Independent Audit (Receivables, payables, working capital; cash chain) — engine 2.0.0

Auditor: independent (did not write the code). Date: 2026-09-30. Repository: `/Users/shuakinsv/Desktop/MOTION`.

**VERDICT: NOT READY** — four HIGH and seven MEDIUM findings are inside ADR-120's own scope (§7).

---

## 1. Scope, commits, method

**Under audit:** `364bf17` (ADR-120 implementation), `a6b6545` (lockfile only), `7a139b8` (pre-audit hardening). Baseline `1443e76` (with `e801eb7`, docs only). Change set: `git diff 1443e76..7a139b8 -- src supabase test scripts` (36 files, +3,071/−372).

**Read:** ADR-119, ADR-120 (with its implementation record and hardening disposition), ADR-121 and ADR-122; FINANCIAL_ENGINE §2.2–§2.4, §3.2–§3.4, §5–§8; EVIDENCE_MODEL §3; AGENTS.md/CLAUDE.md.

**Method:**
1. **Line-by-line review of the change set.** Files: `receivables-input.ts`, `receivables.ts`, `coverage.ts`, `cash.ts`, `compose.ts`, `services/run.ts`, `data/repository.ts`, `server-rpc.ts`, the evidence compiler and resolver, the alert rule, the health repository, migration `20260930000001`, the nightly route and `scripts/engine-upgrade.ts`.
2. **Two git worktrees on the one local database** (`supabase_db_MOTION`). The old worktree was at `1443e76` and the new one at `7a139b8`, each with `node_modules` symlinked and `.env.local` copied.
3. **Fixtures.**
   - The implementer's 7 fixture organisations (`test/fixtures/adr120-orgs.ts`).
   - 11 adversarial organisations of my own design (`audit-probe-seed.ts`), seeded as raw committed batches and accepted records. No snapshot was ever inserted by hand.
   - The adversarial set: GAP, MIDSTART, LEDGER2, TBBS, MOVTB, CURRENT, CREDITHEAVY, PARTIALPD, LONG (15 months, crossing a 12-period chunk), BIGINV (1,050 invoices and customers) and BSREV.
4. **Set A.** Computed by the **old engine**: a real `calculation.run` job plus `alerts.evaluate` through the queue. Then upgraded through the **real production path**: `api_server.enqueue_engine_upgrade('2.0.0')` → worker. `as_of` was pinned to 2026-09-15 for comparability.
5. **Set C.** The same 18 organisations seeded fresh and computed by the new engine.
6. **Diffs:**
   - Set A before vs set C, health rule by rule and alert by alert.
   - Set A after the upgrade vs set C (is the upgrade path equivalent to a fresh computation?).
7. **Evidence sweep.** Every leaf descriptor of `receivables`, `receivables_overdue`, `payables` and `payables_overdue` in set C (153) was resolved through `resolveDescriptor` and totalled against the figure.
8. **Mid-history run (LONG).** A late July statement was added and an `import_commit` run triggered from July; the result was compared with a full recompute.
9. **Other probes:**
   - revoked employee assignment;
   - wall-clock sensitivity of the current-period test;
   - isolated flake-rate measurement.
10. Worktrees removed afterwards (`git worktree remove --force` + `prune`). The main checkout's `git status` is clean. All scratch material is in `…/scratchpad/adr120-audit/`: probe sources `audit-probe-seed.ts`, `audit-dump.ts`, `zz-audit-*.test.ts`, `diff.py`, and raw outputs in `out/`.

---

## 2. Gate results (run by me, clean DB via `npx supabase db reset`, sequential)

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | pass |
| `npx eslint .` | pass |
| unit | **2,073 / 2,073** (75 files) |
| integration (full, clean DB) | **751 passed, 49 skipped; 1 file failed** (53/54 files). The failing file is `scenarios.test.ts`: its `beforeAll` hook times out at 60 s, so all 49 tests are skipped. It **reproduces identically on the `1443e76` worktree** against the same DB and date, and that file does not touch the engine. Pre-existing and environmental, not ADR-120. `receivables-recovery` 32/32, `engine-upgrade` 6/6, `engine-row-cap` 5/5 and `ai-eval-record` 1/1 all passed in this run. |
| `ai-eval-record` isolated rate | **7/10 pass**. All 3 failures carry the known signature `get_alerts #16 output shape`; the signature is unchanged. |
| eval | **253 / 253** |
| pgTAP (`supabase test db`) | **1,068 / 1,068** |
| `npm run check:schema` | pass. **55 tables, 126 api functions.** The implementation record's "125, unchanged" was superseded by the hardening migration. |
| `npx next build` | pass |
| Playwright | **69 passed, 1 skipped** |

The gates are green apart from the pre-existing `scenarios` timeout. **They are not sufficient:** every blocking finding below was reproduced on a real database through the real queue, and no existing test detects any of them.

---

## 3. Verification by area

### 1. Root-cause claims — CONFIRMED
- At `1443e76`, `compose.ts` does not import or call `computeReceivables`. It only passes `input.cashOptions ?? {}` to `computeCash` (line 419).
- At `1443e76`, `services/run.ts` and `jobs/handlers/calculation-run.ts` never set `cashOptions`, `openingCarry` or `priorNetMovements`.
- No SQL writes the receivables keys.
- Old-engine dumps (set A before) contain no receivables-family snapshot. Cash runway is `insufficient_history` everywhere, and every month opens at the typed balance (for example LONG: flat 50,000 − movements).

### 2. Receivables/payables source precedence — PARTLY CORRECT, FOUR DEFECTS

**Correct (verified on real runs):**
- Credit notes subtract and void invoices are excluded (INVBANK Aug 4,400).
- An invoice paid after the date counts at its total (Jun 1,200).
- An invoice paid **exactly on** the as-of date is excluded (PARTIALPD PD-2).
- A partial payment with no date raises `payment_date_unknown`.
- A sales-only organisation has payables unknown (INVONLY).
- A trial balance with no row states zero (TB Jul payables 0.00).
- Working capital is NULL when cash, receivables or payables is unknown.
- The ledger branch handles one opening journal correctly (LEDGER).

**Defects:**
- **F-1 / F-2 (cash):** see area 5.
- **F-3 — ledger double count (LEDGER2).** Two opening-balance journals (IMP-GL-011 flags one at every fiscal-year start or export start). `ledgerFallback` (`receivables-input.ts:135–157`) starts at the **earliest** journal and sums **every** ledger cell from it, including the second journal's lines.
  - receivables Jul **13,000** (truth 7,000) and Aug **11,000** (truth 5,000);
  - `receivables_days` Aug **502**, so Health Q3 scores `> 90 days` **−20**;
  - the evidence reconciles to the wrong figure, because it sums the same rows.
- **F-4 — verified zero from a batch whose range is after P.** `invoiceSideCoverage` (`coverage.ts:141–150`) accepts any batch of the side committed 0–45 days after P, whatever its declared range.
  - BSREV: a sales list declared **March only**, committed 5 April, "covers" **February**. February receivables = **0.00, basis `invoices`, assurance `verified`, completeness 1**, although no source states anything about February.
  - The same happens in production for the month before any customer's first uploaded monthly list (for example, a June list committed 5 July makes May's receivables a verified 0.00).
- **F-9 — current-period aging unreachable.** For the current period P, a batch committed before `P.period_end` is never "0–45 days after", and a declared range ending at the upload date never spans P.
  - Probe CURRENT (list committed 2026-09-10, `as_of` 2026-09-15): September receivables = NULL `stale_invoice_data`.
  - The implementer's test `receivables-recovery.test.ts:66` ("the current period is aged as at the run's as-of date") passes only because the fixture stamps `committed_at = now()` (`adr120-orgs.ts:49`), which is after the run's `as_of` and within 45 days of 30 September. That cannot happen in production.
  - Re-running INVBANK with `committed_at` = 2026-11-20 (what `now()` will be after 14 November 2026) gives September `receivables_overdue` = NULL `stale_invoice_data`. **The test will fail from 2026-11-15.**
- **L-3 (MOVTB):** a movement-basis trial balance hides a cumulative balance sheet for the same month. Receivables are NULL, with the misleading reason `no_source_covers_period`. This is conservative, never wrong.

### 3. `receivables_days` / `payables_days`

**Correct:**
- Invoice-basis denominator: gross = `amount (net) + debit (tax)` from `full` lists spanning each month (INVBANK Aug 61 = 4,400/6,600 × 91.25).
- Three consecutive months are required.
- The prior-period carry works across chunk boundaries: LONG June 2025–August 2026 is continuous (31–32 days, no break at the May→June 2026 boundary).
- The prior-period carry works across run boundaries: the LONG mid-history run equals the full recompute, 0 of 324 figures differ.
- `receivables_days` / `payables_days` variances are written.

**Defects:**
- **F-5 — days computed from fabricated revenue zeros.** When receivables come from a balance statement, the denominator is P&L `revenue`. That revenue can be the pre-existing FU-1 fabricated 0.00 (basis `invoices`, warning `open_items_only`).
  - BSREV April and May: `receivables_days` = **91** (3,000 / (3,000 + 0 + 0) × 91.25), where April and May revenue is simply unknown.
  - This disproves H-7's statement that ADR-120's "only reach is `receivables_days` … becoming unavailable, never wrong".
- **L-1:** `payables_days` divides gross (VAT-inclusive) payables by a net expense base, with no netting and no `vat_inclusive` warning. LONG: 37 days where the VAT-consistent value is about 30. ADR-027.4's gross-consistency principle is applied to receivables only.
- **L-8:** the derived evidence of `receivables_days` names only P's `revenue` snapshot, while the denominator is three months of gross invoice totals. `payables_days` names `operating_expenses`, while its denominator is cost of sales + operating expense + marketing.

### 4. Working capital — CORRECT
- NULL when any of cash, receivables or payables is unknown (INVONLY, TBBS without bank, CREDITHEAVY).
- Otherwise the balance-sheet-only terms carry `partial_working_capital`.

### 5. Cash carry and runway — TWO HIGH DEFECTS

**Correct:**
- Chain start and carry through consecutive covered months (BANK, LONG: 15 months, `closing(P) = opening(P+1)` everywhere, including across the chunk boundary).
- Runway only over fully covered months.
- A mid-history run carries from stored figures exactly as a full run does (0/324 differ).
- The version gate forces a full-history recompute: set A's 2.0.0 runs span the whole history, for example LONG from 2025-06.

**F-1 (HIGH) — the carry crosses a statement gap and relabels the result as complete.**
- Probe GAP: June and August statements; the July statement is missing. The August statement **prints its own opening of 4,000.00**.
- Engine: July carries 9,000 at completeness 0. August then opens at 9,000 and closes at **8,500.00 with completeness 1, no warning, no missing reason**. Truth: 3,500.
- Causes:
  - `run.ts:504` carries P−1's close whenever an earlier period had a statement.
  - `cash.ts:578/583` propagates only P−1's *missing* reasons, not its completeness or coverage warning.
  - Only the *earliest* statement's opening is ever consulted (`run.ts:363–373`), so the later statement's printed opening is ignored.
  - The statement closing cross-check is not wired (FU-4 / H-11).
- Health consequences: August C1 `> 0` +10, C4 `>= 2x` +5 and the `cash_flow` dimension included at 45, all scored on the wrong balance.
- The same mechanism applies to any partly covered month (a statement ending mid-month).

**F-2 (HIGH) — the CD-06 statement opening is taken from the wrong statement.**
- Probe MIDSTART:
  - statement S1: 1–20 June, printed opening 10,000, with −4,000 on 06-10;
  - statement S2: 21 June – 31 July;
  - statement S3: August.
- No statement spans June, so the chain starts in July. `statementOpenings` offers S1's opening, dated 06-01 (a period start), and `pickCandidate` accepts it because 06-01 ≤ 07-01.
- July opens at **10,000 (verified, completeness 1)** and closes at **10,500**; August closes at **10,600**. Truth: 5,500 / 5,600.
- Before ADR-120 these were NULL `no_opening_cash`. ADR-120 turned "unknown" into a **wrong, verified** figure.
- Health: July C1 +10; August B1 `rising for 3 months` +15.

**Also noted:**
- Future periods (Oct 2026–Aug 2027 in LONG) are written with the carried close (35,000) at completeness 0. This is H-15, recorded as INTENTIONAL. An `attention.overflow` alert lands on 2027-08.
- An uncovered month still reports `net_cash_movement` 0.00 (now at completeness 0).

### 6. The 1,000-row caps

**Correct:**
- `serverRpcAll` orders on the full `aggregate_periods` grouping key (unique per row). I checked the SQL: every GROUP BY column is in `AGGREGATE_ORDER`.
- `batch_coverage` is ordered by `batch_id`.
- The `metric_current` readers are ordered on `metric_current_cell_unique`.
- BIGINV: receivables 10,500.00 over 1,050 invoices and 1,050 counterparties; alert overdue 10,500.00.
- In the old engine, LONG (15 months) had most Health dimensions `required_metric_missing` because of truncation. The new engine restores them (see area 10).

**Remaining risks:**
- **L-7:** each page re-evaluates the full aggregate. BIGINV's first 2.0.0 upgrade run failed with Postgres **statement timeout (57014)** under worker concurrency; the retry succeeded.
- **L-6:** the H-9 fingerprint source `accountCategories` is unpaged. Past 1,000 accounts, a remap of an account beyond the cap would not change the fingerprint, the run would be `no_change`, and a trial-balance or ledger receivables figure would stay stale. Pre-existing, so H-9's answer "No" to "Affected by ADR-120?" is not strictly true.
- The claim that the remaining unpaged readers (H-8) do not feed C2, Q3, B1 or the deterioration alerts is **correct** by code inspection.

### 7. Deterioration alerts — ONE MEDIUM DEFECT

**Correct:** the open-invoice population is paged, excludes void invoices and is aged at the figure's `as_of`.

**F-10 (MEDIUM) — the alert facts are wrong whenever credit notes are present.** The top-three list excludes credit notes, but `overdue` is net of them, and total/overdue are shown as absolute values:

| Organisation | Receivables | Overdue | Alert as stored |
|---|---|---|---|
| INVBANK | 4,400 | 1,800 | **`top3_share` 1.333333**. Template (`templates.ts:171`): "the top three account for 133%" |
| INVONLY | 4,400 | 1,800 | same as INVBANK |
| CREDITHEAVY | −700 (a net credit) | −700 | **HIGH** alert fires with `total 700.00`, `overdue 700.00`, share 1.0 and **`top3_share` 2.571429**. The alert tells the owner customers owe 700 overdue when the business owes its customers 700. |

H-4 records `top3_share` as FIXED.

### 8. Evidence — THREE DEFECTS (sweep: 153 descriptors, 14 failures)

**Correct:**
- `invoice_open_at` totals match the engine (INVBANK, INVONLY, CURRENT, CREDITHEAVY including negatives, LONG × 15 months).
- `balance_reporting` gives liabilities a positive sign (TB).
- Ledger descriptors name every period summed (LEDGER).
- Cross-tenant resolution returns nothing, and a revoked employee assignment drops evidence rows from 3 to 0.

**Defects:**
- **F-6 (MEDIUM) — balance drill-down counts two statements.** A `period_balances` descriptor filters only `period_ids` and `account_ids` (`descriptor-compiler.ts:178`). It pins neither `balance_kind`, basis nor batch. In TBBS (trial balance and balance sheet for the same month):
  - receivables figure 9,000 → drill-down **18,000**;
  - payables figure 4,000 → drill-down **8,000**.
- **F-7 (MEDIUM) — drill-down drops a part-paid invoice.** The resolver's `open_at` post-filter (`resolve.ts:216`) drops any invoice with `paid_date ≤ as_of`, even when a balance is still due. In PARTIALPD (400 of 1,000 paid on 07-15):
  - receivables figure **600** → drill-down **0.00**, 0 rows, for July, August and September;
  - the same for `receivables_overdue`.
- **F-8 (MEDIUM) — a large drill-down cannot be opened.** Any selection above about 250 records fails. `fetchRecordStatusEvents` sends 300 ids per request (`rows.ts:121`), and the gateway answers **414 "URI too long"** (measured: 200 ids pass, 300 fail).
  - All 6 non-zero BIGINV receivables descriptors throw `InternalError`.
  - The mechanism is pre-existing, but ADR-120's evidence claim depends on it.
  - ADR-120's cumulative ledger descriptors (every period since the opening journal) reach this size quickly.

### 9. Deployment recalculation — CORRECT, WITH LOW NOTES

**Verified on real old-engine figures:**
- 18/18 eligible organisations queued.
- A second call before any run returned 18 but created **no duplicate jobs** (18 queued, not 36).
- The payload is `recalc_manual`.
- Every organisation got a full-history 2.0.0 run.
- A third call after the runs returned 1: BIGINV, whose run had failed on a statement timeout. Its job retried automatically and succeeded. Failure isolation and re-queue work.
- Post-upgrade figures and Health are **identical to a fresh 2.0.0 computation** for all 18 organisations (BIGINV after its retry).

**Security:**
- `SECURITY DEFINER`, `search_path=''`, owner `motion_definer`, EXECUTE revoked from public, anon and authenticated, granted to service_role, plus the `role_claim` check.
- These are covered generically by pgTAP `00_structure` (every api_server function).

**Notes:**
- **L-5:** every call writes a `job.enqueued` audit row per organisation, even when it only re-finds the queued job: 36 rows for 18 jobs, and the nightly cron repeats this for any organisation that keeps failing.
- An organisation that fails every night stays on old figures, visible only in `/platform/jobs`; there is no alert.

### 10. Health and alerts regression — see §4
No threshold, rule or `health.config.v1` change (`git diff` of `health/domain` and `alerts/domain/rules` shows only the working-capital invoice selection). Phase 15 code (`portfolio`, `ai`) is untouched. Phase 16 has not started (no funding code, tables or routes).

### 11. Tests
- The amended assertions are legitimate:
  - working capital 5,900 → NULL;
  - the variance list;
  - the compiler's `invoice_open_at`;
  - the version literal;
  - the repository mocks.
- No test was weakened.
- `recorded-tools.json`: the normalised diff matches the stated changes (NULL receivables and payables rows with `no_source_covers_period`, extra snapshot ids).
- However:
  - (a) the current-period test is wall-clock dependent and proves an impossible fixture (F-9);
  - (b) all ADR-120 fixtures are 3 months long, single-chunk, one opening journal, one statement per month, trial balance only, credit notes smaller than invoices, and no partial payment with a date. None of F-1…F-8 or F-10 is caught by any test;
  - (c) ADR-120 decision 1.4 required pgTAP coverage, but no pgTAP test was added (L-10; RLS is unchanged).

### 12. Classification review — see §6

---

## 4. Independent Health and alert before/after diff

**Set A before (old engine) vs set C (new engine), rule by rule, every period.**

**The implementer's six fixtures reproduce the ADR-120 §7/§8 table exactly:**
- C2, Q3 and B1 as stated.
- Scores: INVBANK 71→75, INVONLY 72→70, LEDGER 69→76, TB 70→80.
- Alerts:
  - `receivables.deterioration` fires for INVBANK and INVONLY;
  - `payables.deterioration` fires for INVBANK;
  - `revenue.decline` fires for LEDGER (paging);
  - `concentration.supplier` fires for INVBANK;
  - `cash.decline` is removed for INVBANK;
  - `recurring.*` moves 2027-08 → 2026-08.

**Changes NOT in the ADR's regression record:**

| Organisation | Change | Explained by |
|---|---|---|
| HISTORY (the implementer's 7th fixture) | C1 now scores (+10) in Jun, Jul, Aug; `cash_flow` dimension newly included; scores Jun 75→71, Aug 78→84; B1 +15 in August | the H-5 statement opening. The ADR says C1 and June/July are "unchanged in every organisation". |
| GAP | C1 +10, C4 +5, `cash_flow` included (45) in August on the **wrong** carried balance | **F-1** — not a legitimate change |
| MIDSTART | C1 +10 in July; B1 `rising` +15 in August on wrong verified balances | **F-2** — not legitimate |
| LEDGER2 | Q3 `> 90 days` −20 in August (days 502 from a double-counted balance) | **F-3** — not legitimate |
| LONG (15 months) | 101 differences: K1, G2, G3, Q1, P4, B2, C3, C1, C4, C2, B1, Q3 and dimension inclusion across 13 months. August score 73→67 (Q1 −25, G3 −10, K1 +20, C3 −20, C2 +20, B1 −15). Alerts: 10 new `cash.decline`, concentration and unusual-transaction alerts re-dated. | the old health/alert reads were truncated at 1,000 `metric_current` rows (restored by the paging fix, ADR-120 (b)), plus the carry. Legitimate, but **absent from the ADR's Health record**, which says every other rule is unchanged. |
| BIGINV | 36 Health differences; `cash.decline`, `revenue.decline` and `receivables.deterioration` now fire | cap fixes plus restored figures (legitimate) |
| CURRENT, PARTIALPD | `revenue.decline` fires instead of `variance.significant`; Q3 scores | paging fix plus restored days (legitimate) |
| CREDITHEAVY | `receivables.deterioration` HIGH on a net credit | **F-10** — not legitimate |
| TBBS, MOVTB, BSREV, EMPTY | no Health change | — |

**Conclusion.** Every change is attributable to an ADR-120 code change. However:
- the changes from F-1, F-2, F-3 and F-10 are driven by **wrong figures**, not by newly available data;
- the recorded regression set (C2/Q3/B1 only) is materially incomplete for any organisation with more than about 10 months of history (**F-11**). Phase 15's `bandFell` / `scoreFell` will see these changes on the first 2.0.0 run.

---

## 5. Findings

| ID | Sev | Area | Evidence | Reproduction | Recommended fix | Blocks |
|---|---|---|---|---|---|---|
| F-1 | **HIGH** | Cash carry | GAP: Aug `closing_cash` 8,500.00 at completeness 1, no warning; truth 3,500 (Aug statement prints 4,000). Health C1/C4 scored on it. Cause: `run.ts:504`, `cash.ts:578–583` | statements Jun + Aug only, printed openings 10,000 and 4,000 | After a month that was not fully covered, restart each account from the covering statement's printed opening when its range starts at P's start. Otherwise make the opening unknown or partial (propagate completeness or a missing reason). Wire the statement closing cross-check (FU-4). | **Yes** |
| F-2 | **HIGH** | CD-06 opening | MIDSTART: Jul opening 10,000 verified (c=1) from a 1–20 June statement; truth 5,000. Aug 10,600 vs 5,600. Before: NULL. `run.ts:363–373` | S1 1–20 Jun (opening 10,000, −4,000), S2 21 Jun–31 Jul, S3 Aug | A statement opening is eligible only if the statement starts on the first day of the period where that account's chain starts. Otherwise use the typed balance or NULL. | **Yes** |
| F-3 | **HIGH** | Ledger fallback | LEDGER2: Jul 13,000 (7,000), Aug 11,000 (5,000); `receivables_days` 502; Q3 −20. `receivables-input.ts:135–157` | two GL batches, each with an opening-balance journal (Jun 1, Jul 1) | Base the balance on the latest opening journal at or before P, and add only non-opening movements after it. Or refuse (NULL) when journals overlap. Add a test. | **Yes** |
| F-4 | **HIGH** | AR/AP coverage | BSREV: Feb receivables **0.00, invoices, verified, c=1** from a March-only list committed 5 April. `coverage.ts:141–150` | full sales list declared 1–31 Mar, committed 5 Apr; read February | A fresh batch covers P only if it is an as-at (`open_items`) list or its declared range starts on or before P's end. Otherwise NULL `stale_invoice_data`. | **Yes** |
| F-5 | MEDIUM | Days denominator | BSREV Apr/May `receivables_days` = 91 from revenue 0.00 (`open_items_only`) that no source states; disproves H-7's "never wrong" | as BSREV | Refuse a revenue input whose basis does not properly cover P (fix FU-1 first, or treat `open_items_only` revenue as unknown in `denominatorInputsFor`) | **Yes** |
| F-6 | MEDIUM | Evidence | TBBS: receivables 9,000 → drill-down 18,000; payables 4,000 → 8,000. `descriptor-compiler.ts:178` | cumulative TB and BS for the same month | Pin `balance_kind`/basis (or batch) in the `period_balances` descriptor, matching `chooseBalanceKind` | **Yes** |
| F-7 | MEDIUM | Evidence | PARTIALPD: receivables and overdue 600 → drill-down 0.00 (Jul–Sep). `resolve.ts:216` | invoice 1,000, 400 paid, `paid_date` 07-15 | Replace the `open_at` post-filter with "contributes non-zero under `invoiceOutstandingAt`", or keep every issued, non-void row | **Yes** |
| F-8 | MEDIUM | Evidence (pre-existing mechanism ADR-120 depends on) | BIGINV: 6/6 non-zero receivables drill-downs throw `InternalError`; 414 URI too long at 300 ids (`rows.ts:121`) | 1,050 open invoices; resolve the Aug receivables descriptor | Batch ≤ 150 ids or use an RPC / POST filter; add a >300-row evidence test | **Yes** |
| F-9 | MEDIUM | Current-period aging / test integrity | CURRENT: Sep receivables NULL `stale_invoice_data` for a list committed 5 days before `as_of`. `receivables-recovery.test.ts:66` passes only because `committed_at = now()`, and fails after 2026-11-14 (demonstrated) | list committed 2026-09-10, `as_of` 2026-09-15 | Define current-period coverage: a list committed on or before `as_of` and after P's start, as at its commit date. Pin `committed_at` in fixtures. | **Yes** |
| F-10 | MEDIUM | Alerts | `top3_share` 1.333333 (INVBANK and INVONLY: "top three account for 133%"); CREDITHEAVY: HIGH alert on a −700 net credit, total/overdue shown as 700, `top3_share` 2.57. `working-capital.ts:111,162` | fixtures above | Do not raise on total ≤ 0. Compute the share and `top3_share` on gross overdue sales (or clamp and state credits). Keep the sign. | **Yes** |
| F-11 | MEDIUM | Regression record | The ADR says only C2/Q3/B1 change. Independently: C1, C4, dimension inclusion (H-5), and K1/G2/G3/Q1/P4/B2/C3 for any organisation whose window exceeds 1,000 snapshots (LONG) | §4 | Restate the Health/alert change set, including the truncation-fix effect on Phase 15 attention, and obtain product-owner sign-off | **Yes** (decision 2 deliverable) |
| L-1 | LOW | `payables_days` | gross payables ÷ net expense base, no warning (LONG 37 vs about 30) | LONG | Net by VAT rate, or warn `vat_inclusive` (needs a spec decision) | No |
| L-3 | LOW | Precedence | MOVTB: a movement TB hides a cumulative BS → NULL `no_source_covers_period` | MOVTB | Fall through to the BS when the TB is movement-basis; give a precise reason | No |
| L-4 | LOW | CD-06 | Two statements with the same start: the tie is broken by batch uuid, not the latest committed | code, `run.ts:363–370` | Prefer the latest committed, as ADR-029.2 does | No |
| L-5 | LOW | Upgrade audit | 36 `job.enqueued` audit rows for 18 jobs; a nightly repeat for failing organisations | set A | Audit only when a new job row is inserted | No |
| L-6 | LOW | Caps (pre-existing) | Fingerprint `accountCategories` unpaged: a remap beyond 1,000 accounts → `no_change` → stale AR/AP | code | Page it, as FU-3 | No |
| L-7 | LOW | Performance | BIGINV 2.0.0 run: statement timeout 57014 on the first attempt (retry succeeded) | set A upgrade | Measure; materialise the aggregate once per chunk | No |
| L-8 | LOW | Evidence (derived) | `*_days` descriptors name P's `revenue`/`operating_expenses`, not the three-month denominator actually used | code | Name the three periods' inputs | No |
| L-9 | LOW | Future periods | Periods after `as_of` computed with the carried close (LONG to Aug 2027); `attention.overflow` lands on 2027-08 | LONG | Do not compute or offer periods after `as_of` | No |
| L-10 | LOW | Process | ADR-120 decision 1.4 asked for pgTAP coverage; none was added | `git diff -- supabase/tests` | Add pgTAP for `enqueue_engine_upgrade` behaviour | No |
| P-1 | — | Pre-existing | `scenarios.test.ts` `beforeAll` 60 s timeout, also on `1443e76` | full and isolated runs | Separate investigation | No |

---

## 6. Assessment of the ADR-120 / ADR-122 classifications

| # | ADR says | Audit |
|---|---|---|
| H-1 | FIXED | **Accurate.** Verified end to end on real 1.0.0 figures. |
| H-2 | FIXED | **Accurate** for correctness. Adds load (L-7). |
| H-3 | FIXED | **Accurate.** |
| H-4 | FIXED | **Partly.** The population and paging are fixed; `top3_share` and the sign are still wrong (F-10). |
| H-5 | FIXED | **Inaccurate.** Wiring the statement opening introduced F-2, and gaps are unhandled (F-1). |
| H-6 | FIXED | **Partly.** The mid-export journal case is fixed; multiple journals double-count (F-3). |
| H-7 | PRE-EXISTING / FOLLOW-UP | **Mis-scoped.** It does reach ADR-120 figures with wrong values (F-5), and ADR-120's own AR/AP freshness test has the analogous "committed near P ⇒ covers P" defect (F-4). |
| H-8 | PRE-EXISTING | Accurate. |
| H-9 | PRE-EXISTING, "No" | Mostly accurate; edge case L-6. |
| H-10 | INTENTIONAL | Accurate. |
| H-11 | PRE-EXISTING, "No" | **Inaccurate.** The missing statement cross-check is exactly what would expose F-1; it should be in scope. |
| H-12 | INTENTIONAL | Accurate (conservative). |
| H-13 | INTENTIONAL | Accurate. |
| H-14 | PRE-EXISTING | Accurate. |
| H-15 | INTENTIONAL | Acceptable, but see L-9. |
| H-16 | INTENTIONAL | Accurate. |
| H-17 | PRE-EXISTING | Accurate, but F-6 is a separate ADR-120 descriptor defect. |
| H-18 | FIXED | Accurate (not re-audited). |
| H-19 | PRE-EXISTING | Accurate. Measured 3/10 failures, all with the known signature. |
| H-20 | INTENTIONAL | Accurate. |

**Unlisted issues:** F-1, F-2, F-3, F-4, F-6, F-7, F-8 (dependency), F-9, F-10, F-11, and L-1, L-3, L-4, L-5, L-8, L-9, L-10.

---

## 7. VERDICT

**NOT READY.** The ADR-120 dependency is **not** cleared for Phase 16.

**Blocking findings:**
- HIGH: F-1, F-2, F-3, F-4.
- MEDIUM: F-5, F-6, F-7, F-8, F-9, F-10, F-11.

The core wiring is sound: receivables through the invoice basis, the per-side split, the working-capital NULL rule, carry and runway over consecutive covered months, chunk and mid-run determinism, and the upgrade mechanism are all verified. But the new code turns several realistic data shapes into wrong verified figures, and Health scores them:
- a missing statement month;
- a statement starting mid-month;
- yearly GL exports;
- the first uploaded monthly sales list.

In addition:
- evidence fails to reconcile for three realistic shapes;
- the restored alerts state impossible facts;
- the current-period aging test is a wall-clock time bomb.

Phase 16's F5 must not consume these figures until the blocking findings are fixed and re-audited.
