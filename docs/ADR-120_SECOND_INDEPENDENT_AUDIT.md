# ADR-120 + ADR-123 — Second Independent Audit (receivables, payables, working capital, cash chain — engine 2.0.0)

Auditor: independent (did not write the code). Date: 2026-09-30. Repository: `/Users/shuakinsv/Desktop/MOTION`.

**VERDICT: NOT READY** — two HIGH and five MEDIUM findings inside ADR-120 / ADR-123 scope (§4), three first-audit findings only partly fixed and F-11 not closed (§3).

---

## 1. Scope, commits, method

**Under audit:** `8493362` (ADR-123 remediation) on top of `a6652e6` (audit preserved) and `7a139b8` / `364bf17` (ADR-120). Baseline `1443e76`. Change sets read line by line: `git diff 7a139b8..8493362 -- src supabase test` (remediation, 27 files) and `git diff 1443e76..8493362 -- src supabase test` (ADR-120 + ADR-123, 25 `src` files, +1,385/−107).

**Read:** the first audit, ADR-119…ADR-123 (incl. the owner decision on AR/AP freshness and the F-11 table), FINANCIAL_ENGINE §2.2, §2.3, §3.2–§3.4, §6–§8, EVIDENCE_MODEL §3, RBAC_MATRIX, AGENTS.md/CLAUDE.md.

**Method:**
1. Three git worktrees on the one local database (`supabase_db_MOTION`), `node_modules` symlinked, `.env.local` copied: `old` = `1443e76`, `mid` = `7a139b8`, `new` = `8493362`. Removed afterwards.
2. **Fixtures:** the 7 ADR-120 organisations (`adr120-orgs.ts`, pinned `COMMITTED_AT`), the 11 first-audit organisations (`audit-orgs.ts`), and **9 adversarial organisations of my own** (`audit2-probes.ts`): GAPGL, PARTJUL, NEWACCT, BSLIST, LEDGER3, UNRECON, CNFUTURE, MIDTYPED, CYCLE. All seeded as raw committed batches + accepted records; every figure comes from a real `calculation.run` + `alerts.evaluate` through the queue (as_of 2026-09-15). No snapshot was inserted.
3. The same 27 organisations computed separately by `old`, `mid` and `new`; full dumps (headline metrics with basis/assurance/completeness/missing/warnings, Health breakdown rule by rule, alerts with threshold summaries); diffs old→new (the F-11 change set) and mid→new (what ADR-123 alone changed).
4. **Evidence:** every leaf descriptor of `receivables`, `receivables_overdue`, `payables`, `payables_overdue`, `cash_inflows`, `cash_outflows` of all 27 organisations resolved through `resolveDescriptor` under the owner's RLS and totalled against the figure (mid: 887 descriptors; new: 290).
5. **Pure boundary probes** of `invoiceSideCoverage` (14 cases) and of the restart opening rule (typed balance dated P−1, P.start, months earlier; exact-only on/off).
6. **Version-gate probe:** organisations computed by `7a139b8`'s 2.0.0 then touched by `8493362`'s 2.0.0 (upgrade sweep, `recalc_manual`, and an `import_commit` without a prior recalc).
7. **Test meaningfulness:** ADR-123's new integration and unit tests, and the amended `receivables-recovery` test, run against `7a139b8`.
8. **Sweep:** `evidence-reconciliation-sweep.test.ts` instrumented (scratch copy) to list every descriptor it checks, on `mid` and `new`; set difference taken.
9. Gates on a clean DB (`npx supabase db reset`), sequential.

Scratch material (probe sources, raw dumps, diffs, logs) was kept in the audit session's scratchpad, outside the repository; the probe organisations are to become a permanent fixture under ADR-124. The main checkout was never modified; `git status` was clean.

---

## 2. Gates (run by me; clean DB; sequential)

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | pass |
| `npx eslint .` | pass |
| unit | **2,082 / 2,082** (75 files) |
| `npx supabase db reset` | clean (applies `20260930000002`) |
| integration (full, clean DB) | **819 / 819**, 55 / 55 files (888 s). `scenarios.test.ts` did **not** time out in this run; `adr123-remediation` 18/18, `receivables-recovery` 33/33, `engine-upgrade`, `engine-row-cap`, `evidence-reconciliation-sweep` (56 checked, 0 mismatches) and `ai-eval-record` passed. |
| `ai-eval-record` isolated | **7 / 10** pass; all 3 failures carry the known signature `get_alerts #16 output shape` (26 vs 27 items) — unchanged, not a finding |
| eval | **253 / 253** |
| pgTAP (`supabase test db`) | **1,080 / 1,080** (18 files; +12 from `15_engine_upgrade`) |
| `npm run check:schema` | pass — **55 tables, 126 api functions**, RLS forced everywhere |
| `npx next build` | pass |
| Playwright | **69 passed, 1 skipped** |

All gates are green and match the commit message's figures. **They are not sufficient:** N-1…N-7 were reproduced on a real database through the real queue and no existing test detects any of them.

---

## 3. Verification of the first audit's findings

| # | Sev | Verdict | Evidence (my runs on `8493362`) |
|---|---|---|---|
| F-1 | HIGH | **PARTLY FIXED** | GAP now correct: Jun 9,000 · **Jul NULL `no_source_covers_period`** · Aug opens at the printed **4,000 → 3,500 (verified)**; closing cross-check wired (GAP: no mismatch; MIDTYPED: `statement_balance_mismatch` raised). **But** the carry into a month that is *not fully stated* still publishes a value whenever the cash family is "covered" by something else: (a) GAPGL — same statements as GAP plus a GL: **Jul `closing_cash` 9,000.00** (truth 4,000; the GL's own cash account shows −5,000), `net_cash_movement` 0.00 on a "ledger" basis, **`working_capital` Jul 10,000.00** (truth 5,000); August B1 "no clear trend" where the truth (9,000 / 4,000 / 3,500) is "falling"; (b) PARTJUL — a July statement ending on the 15th: **Jul `closing_cash` 7,000.00 `verified`** (truth 4,000), and a **HIGH `cash.decline` in August "3,500, down 3,500 from 7,000"** — the invented-July alert ADR-123 says it removed (it was *added* by ADR-123: mid→new diff). The first audit named this case ("the same mechanism applies to any partly covered month"). → new finding **N-1**. |
| F-2 | HIGH | **PARTLY FIXED** | MIDSTART correct: Jul NULL `no_opening_cash`, Aug 5,500 → 5,600. **But** the same shape with a typed opening balance on the account (MIDTYPED, 10,000 at 31 May — the common case) gives **Jul 10,500.00 at completeness 1** and **Aug 10,600.00 at completeness 1** (truth 5,500 / 5,600); August's printed 5,500 opening is ignored. July is treated as the chain's *first* period (no single statement spans June), so the stale typed balance is accepted. Only a `statement_balance_mismatch` warning marks it. → **N-2**. |
| F-3 | HIGH | **FIXED** (for its reproduction) | LEDGER2: 6,000 / 7,000 / 5,000; drill-down 5,000 = 5,000. A related shape (journal dated mid-month) still double-counts → **N-5**. |
| F-4 | HIGH | **FIXED** (for its reproduction) | BSREV Feb receivables NULL `stale_invoice_data`; a June list committed 5 July no longer covers May (boundary probe). The new rule has its own false-verified case → **N-4**. |
| F-5 | MED | **FIXED** | BSREV Apr/May `receivables_days` NULL (`insufficient_history`), receivables 3,000 from the balance sheet. |
| F-6 | MED | **FIXED** | TBBS receivables 9,000 → drill-down 9,000 (1 row); payables 4,000 → 4,000. `balance_kind` filter: optional in the schema (old descriptors still parse), a scalar in the RFC 8785 hash, emitted only for `period_balances` receivables/payables. |
| F-7 | MED | **FIXED** | PARTIALPD Jul/Aug receivables and overdue 600 → 600, 1 row. |
| F-8 | MED | **FIXED** | BIGINV Jul/Aug receivables and overdue 10,500 → 10,500, 1,050 rows (on `mid`: `InternalError`). |
| F-9 | MED | **FIXED** | CURRENT Sep (as of 15 Sep, list committed 10 Sep): 1,500 / overdue 1,000. Fixtures pin `COMMITTED_AT`. |
| F-10 | MED | **PARTLY FIXED** | `top3_share` ≤ 1 (INVBANK 1.000000); CREDITHEAVY Aug (net credit −700) raises nothing; figures signed. **But the headline `share` still exceeds 100 %:** CNFUTURE (invoice 1,000 overdue; credit note 800 not yet due) raises a **HIGH** `receivables.deterioration` with `share 5.000000` → "1,000.00 of the 200.00 owed to you is overdue (500%)". → **N-7**. |
| F-11 | MED | **NOT CLOSED** | The table is accurate for the 18 organisations in category terms (my independent diff agrees, §5), but (i) ADR-123 itself says the change set "needs the product owner's sign-off" and none is recorded; (ii) it is not complete: my organisations show Health/alert changes outside categories A–E, driven by wrong figures (PARTJUL `cash.decline`; GAPGL B1) and by a spec-nonconforming NULL (NEWACCT loses its `cash_flow` dimension). |
| L-3 | LOW | **FIXED** | MOVTB: receivables 9,000 / payables 4,000 from the cumulative balance sheet; drill-down 9,000. |
| L-4 | LOW | **FIXED** (code) | `latestPerAccount` orders by `committed_at` desc then id. No test exercises it. |
| L-5 | LOW | **FIXED** | Migration `20260930000002`: audits only when no queued `calculation.run` existed (the idempotency key covers exactly queued jobs, so this equals "a job was inserted"). pgTAP `15_engine_upgrade` asserts one audit row after two sweeps. |
| L-9 | LOW | **PARTLY FIXED** | Future months' cash is NULL (LONG Sep 2026–Aug 2027). The `attention.overflow` alert the first audit cited still lands on **2027-08** (LONG). |
| L-10 | LOW | **FIXED** | `supabase/tests/15_engine_upgrade.test.sql` (12 assertions: existence, definer, grants, role check, version validation, eligibility, idempotence, audit-once). |

---

## 4. New findings

| ID | Sev | Area | Evidence | Reproduction | Recommended fix | Blocks |
|---|---|---|---|---|---|---|
| N-1 | **HIGH** | Cash chain (F-1 residual) | A month not fully stated by statements still gets `opening = P−1 close` and a published `closing_cash`: GAPGL Jul **9,000** (truth 4,000; `net_cash_movement` 0.00 "ledger" while the GL shows −5,000), `working_capital` Jul **10,000** (truth 5,000); PARTJUL Jul **7,000 `verified`** (truth 4,000) → **HIGH `cash.decline` Aug "fell 3,500 from 7,000"** (added by ADR-123); GAPGL Aug B1 "no clear trend" (truth: falling). Cause: `run.ts:514–527` carries whenever P−1 was stated, whatever P's own coverage; `cash.ts` NULLs only `basis = 'none'`; cash movements always come from bank cells (`compose.ts` `bankMovements`) even on a ledger/balance cash basis. | `audit2-probes.ts` GAPGL (statements Jun+Aug, GL Jun–Aug with cash lines) and PARTJUL (Jul statement 1–15 Jul) | For a completed period that no statement fully covers, write `closing_cash`/`opening_cash` (and every carry out of it) NULL with a reason, unless its own cash basis actually states the balance; never compute a ledger-basis cash figure from bank cells; keep the current period's as-of partial if intended but label it. Add GAPGL/PARTJUL to `adr123-remediation`. | **Yes** |
| N-2 | **HIGH** | CD-06 opening (F-2 residual) | MIDTYPED (MIDSTART + typed 10,000 at 31 May): **Jul 10,500 c=1**, **Aug 10,600 c=1** (truth 5,500 / 5,600), `calculated`, only `statement_balance_mismatch`; Aug's printed 5,500 unused. Health: B1 scored on it. `cashCoveredBefore` requires one batch to span a whole earlier month, so July is the chain's "first period" and `pickCandidate` accepts a typed balance dated months earlier (`asAtDate ≤ periodStart`). (1443e76 was also wrong: 10,500 / 10,100; ADR-123 records F-2 as FIXED.) | MIDTYPED | Treat any period after the first month with bank data as a restart (`openingExactOnly`), or roll a typed balance forward over the statement rows since its date; start the chain at the first month with *any* statement, not the first fully spanned one. | **Yes** |
| N-3 | MEDIUM | Cash restart (new in ADR-123) | A restart needs an exact opening for **every** covered account, and a month missing any active account forces a restart. NEWACCT (A: monthly CSV statements without printed balances, typed opening; B opened in Aug): **Apr–Aug `closing_cash` NULL** (mid: 9,000 … 7,000, Aug 9,100 = truth). August loses C1/C4 and the whole `cash_flow` dimension. §3.3's "new account mid-history: its opening balance joins at its first covered period" is now unreachable (the joiner branch only runs when P−1 was fully covered, which a joiner never is). Not in ADR-123's change set. | NEWACCT | Restart per account: carry each account whose own statements are continuous, and require an exact opening only for the account(s) with the gap or joining; or store per-account closings. Record the rule and its Health effect. | **Yes** |
| N-4 | MEDIUM | AR/AP freshness (new rule) | A list committed **during** a completed period covers it and outranks that period's own balance sheet: BSLIST (monthly balance sheets 3,000; one sales list declared 1 Jun–3 Aug, committed 3 Aug) → **Aug receivables 5,000.00 `invoices` `verified` c=1** (mid: 3,000 from the balance sheet). The list knew nothing after 3 August. Boundary probes: a list "as at 1 Aug" (range to 1 Aug, committed 1 Aug) covers all of August; a list declared 25–31 Aug covers August. | BSLIST; `zz-audit2-boundaries` | Apply the "committed on or after P.start" branch only to the period containing the run's as-of date; for a completed P keep "range spans P, or committed 0–45 days after P.end with range reaching P.end". Ask the owner to confirm the implementation-added overlap clause. | **Yes** |
| N-5 | MEDIUM | Ledger fallback | Journal start is resolved at **period** granularity: movements dated before an opening journal inside the journal's own month are added on top of it. LEDGER3 (export A 1 Jun–14 Jul, export B from 15 Jul with an IMP-GL-011 journal restating receivables at 7,000): **Aug 6,000** (truth 5,000; mid 12,000); Q3 "> 90 days" scored; drill-down reconciles to the wrong 6,000. | LEDGER3 | Start at the journal's **entry date**: exclude ledger rows dated before the journal within its period (needs a date-aware aggregate or the journal date in the cell), or refuse (NULL) when the journal is not on a period start. | **Yes** |
| N-6 | MEDIUM | Engine versioning / upgrade | ADR-123 changes existing figures (cash chain, AR/AP coverage, ledger) but `ENGINE_VERSION` stays **2.0.0** (§6: major). `7a139b8` is on `origin/main` and `/api/jobs/nightly` runs `enqueue_engine_upgrade('2.0.0')`. Probe: GAP/LEDGER2/BSREV computed by `7a139b8` → on `8493362` the sweep returns **0 jobs for them** (they already have a succeeded 2.0.0 run); an `import_commit` for September then **carries the stale Aug 8,500 → Sep 8,400** (truth 3,400); LEDGER2 keeps 13,000/11,000. Only a manual recalc repairs them. | `zz-audit2-version` (seed on mid, import on new) | Bump to 2.1.0/3.0.0 (or record that 2.0.0 never ran anywhere persistent and re-run the sweep keyed on a remediation marker). | **Yes** |
| N-7 | MEDIUM | Alerts (F-10 residual) | `share = overdue / total` is unbounded when not-yet-due credit notes reduce `total` but not `overdue`: CNFUTURE **HIGH** alert, `share 5.000000`, `total 200.00`, `overdue 1000.00` → "1,000.00 of the 200.00 owed to you is overdue (500%)". | CNFUTURE | Compute the share on gross overdue ÷ gross open invoices (the population the sentence names), or clamp and say credits exist. Thresholds unchanged. | **Yes** |
| N-8 | LOW | Unreconciled flag | `unreconciledIn` looks at every committed statement overlapping P, including one a later upload superseded: UNRECON June carries `unreconciled_statement` though the current June statement reconciles. | UNRECON | Consider only the winning (latest committed) statement per account and range. | No |
| N-9 | LOW | Opening-date semantics | A typed balance dated exactly `P.period_start` is accepted at a chain start but refused at a restart (only `dayBefore` qualifies); a typed balance dated months earlier is accepted at a chain start (see N-2). | boundary probe | One rule: "balance at close of D" ⇒ exact for P iff D = P.start − 1, everywhere. | No |
| N-10 | LOW | AR/AP freshness | The implementation-added overlap clause removes §2.2's aged-debtors use case: an `open_items` list as at 5 Sep declared 1–5 Sep or 5–5 Sep no longer covers August (it did under ADR-120). Conservative (NULL), but not what the owner approved. | boundary probe | Owner confirmation; or keep an as-at exception for `open_items` lists committed 0–45 days after P.end. | No |
| N-11 | LOW | L-9 residual | `attention.overflow` still dated 2027-08 (LONG). | LONG | Evaluate state/overflow alerts only up to the as-of period. | No |
| N-12 | LOW | Data-quality labels | NULL cash figures carry `assurance verified` and completeness 0.25 (NEWACCT Apr–Jul; MIDSTART Jul `verified` NULL). | NEWACCT | NULL ⇒ completeness 0, assurance of the missing input. | No |
| N-13 | LOW | Tests | "so August raises no 'cash fell from 9,000' alert" also passes on `7a139b8` (not discriminating); no unit test covers the run-loop restart (`run.ts`), L-4, or a partly covered / ledger-covered gap month. | ran on mid | Add GAPGL, PARTJUL, MIDTYPED, NEWACCT, BSLIST, LEDGER3, CNFUTURE as regression fixtures. | No |
| P-2 | — | Pre-existing (all three engines) | Statements on a non-calendar cycle (5th→4th) never span a month: CYCLE opens **every** month at the typed 10,000 (9,000 each month, truth 9,000/8,000/7,000/6,000), the same values on 1443e76 (at completeness 1), 7a139b8 and 8493362 (at completeness 0). | CYCLE | Coverage by the union of a month's statements (ADR-047.6 follow-up). | No |
| P-1 | — | Pre-existing | `scenarios.test.ts` `beforeAll` 60 s timeout — did not reproduce in my full run (§2). | — | — | No |

---

## 5. Health / alert before-after (1443e76 vs 8493362) and the F-11 table

27 organisations computed by `1443e76` and by `8493362` in separate worktrees on the one DB, as_of 2026-09-15; every Health rule of every dimension and period, and every alert (rule | subject | severity | period). Raw: `out/diff-old-new.txt`; ADR-123-only effect: `out/diff-mid-new.txt`.

**The 18 organisations of ADR-123's table**

| Organisation | Rule / alert changes (old → new) | ADR-123 category | Legitimate? |
|---|---|---|---|
| BANK | C3 Jun/Jul "negative in all 3" −20 → skipped; B1 Aug no trend → falling −15; C2 Aug → "3 to 6 months" +5; `recurring.new` 2027-08 → 2026-08 | C, B, A, E | yes (BANK not listed under A) |
| INVBANK | C3 Jun/Jul → skipped (Jul 75 → 71); C2 Aug +20; Q3 Aug "60 to 90" −10 (Aug 71 → 75); + `receivables.deterioration` (med), `payables.deterioration` (high), `concentration.supplier`; − `cash.decline` Aug; `recurring.*` re-dated | C, A, D, B, E | yes |
| INVONLY | Q3 Aug −10 (72 → 70); + `receivables.deterioration` | A | yes |
| LEDGER | C3 Jun/Jul → skipped (Jul 69 → 65); B1 rising +15; C2 cash generative +20; Q3 "≤ 30" +15 (Aug 69 → 76); + `revenue.decline` Jul/Aug; `recurring.*` re-dated | C, B, A, D, E | yes |
| TB | C3 Jun/Jul → skipped; C2 cash generative +20 (Aug 70 → 80) | C, A | yes (TB not listed under A) |
| HISTORY | C1 +10 and `cash_flow` included Jun–Aug; B1 rising +15; C2 cash generative +20 (Jun 75 → 71, Aug 78 → 84) | B, A | yes (not listed under A) |
| GAP | C1 +10, C4 +5, `cash_flow` included Jun/Aug; C3 → skipped | B, C | yes — now on true figures (GAP not listed under C) |
| MIDSTART | C3 Jul → skipped; C1 Aug +10, `cash_flow` included; − `bank.unusual_transaction` Jun, − `variance.significant` Aug | C, B | yes |
| LEDGER2 | Q3 Aug "> 90 days" −20; `revenue.decline` replaces `variance.significant` | A, D | yes (true 5,000 balance) |
| CURRENT | Q3 Aug −20; + `receivables.deterioration`, `revenue.decline` for `variance.significant` | A, D | yes |
| CREDITHEAVY | + `receivables.deterioration` Jul (high, share 0.56), `revenue.decline` Jul | A, D | yes |
| PARTIALPD | Q3 Aug "30 to 60" 0; + `receivables.deterioration` Aug; `revenue.decline` for `variance.significant` Jul/Aug | A, D | yes |
| LONG | 93 diffs over 13 months: B1 ×13, C2 ×13, Q3 ×13, K1 ×3, G1 ×3, G2 ×3, dimension inclusion; scores +3…+11 (Aug **56 → 67**) | B, A, D | yes |
| BIGINV | unscored → **59 / 76 / 50**; B2, C4, K1, P1, P2, P4, G1, B1, C2, C3, Q3; + `cash.decline`, `receivables.deterioration`, `revenue.decline` Aug | D, A, B | yes |
| TBBS, MOVTB, BSREV, EMPTY | none | — | — |

My diff agrees with ADR-123's table in category terms for all 18 (including every score it quotes: LONG Aug 56 → 67, BIGINV 59/76/50). Its "Where" column omits BANK, TB and HISTORY under A (C2) and GAP under C — LOW (N-13 family).

**My 9 organisations (not in ADR-123's table)**

| Organisation | Change (old → new) | Explained by | Legitimate? |
|---|---|---|---|
| GAPGL | C1/C4/`cash_flow` Jun+Aug; C3 skipped; Aug B1 "no clear trend" | B/C, **but** Aug B1 rests on the invented Jul 9,000 (truth: falling) | **No** (N-1) |
| PARTJUL | C1/C4 Jun+Aug; B1 Aug "falling" −15; **+ HIGH `cash.decline` Aug** (from Jul 7,000) | B, **but** the alert and B1 rest on the invented Jul 7,000 | **No** (N-1) |
| NEWACCT | Aug: C1 +10 → skipped, C4 +5 → skipped, `cash_flow` dimension excluded (mid→new: also B1) | not A–E: a spec-nonconforming NULL (joiner) | **No** (N-3) |
| MIDTYPED | B1 Aug "rising" +15; C3 Jul skipped | B, **but** on Jul 10,500 / Aug 10,600 (truth 5,500 / 5,600) | **No** (N-2) |
| LEDGER3 | Q3 Aug "> 90 days" −20; `revenue.decline` | A, on 6,000 (truth 5,000) — the band would be the same on the truth | figure wrong (N-5) |
| CNFUTURE | Q3 −20; + HIGH `receivables.deterioration` "500 %" | A, with an impossible stated share | alert text **No** (N-7) |
| UNRECON | C3 skipped; B1 falling −15; C2 +20; + `cash.decline` (three real falls) | C, B, A | yes |
| BSLIST | none (no Health dimension reads it) — but Aug receivables changed 3,000 → 5,000 `verified` | — | **No** (N-4) |
| CYCLE | − 4 × `bank.unusual_transaction` (June–Aug) | P-2 / C | neutral |

**Assessment of ADR-123's F-11 table.** Accurate for the organisations it covers, with small omissions in its "Where" column. It is **not** the complete change set its heading claims: realistic data shapes it did not test produce changes driven by wrong figures (N-1, N-2), by a spec-nonconforming NULL (N-3) and by an impossible alert fact (N-7). Owner sign-off is still outstanding by ADR-123's own statement. Thresholds, rules and `health.config.v1` are unchanged (`git diff 1443e76..8493362 -- src/modules/health/domain src/modules/alerts/domain/rules/cash.ts` is empty; the working-capital rule changed only its selection/share computation); Phase 15 (`portfolio`, `ai`) untouched; no Phase 16 code, table, route or flag.

---

## 6. Sweep count 104 → 56

I ran an instrumented copy of the sweep (lists every descriptor with its period) on `7a139b8` (**104 checked, 0 mismatches**) and `8493362` (**56 checked, 0 mismatches**). The 48 descriptors present only on `7a139b8`:

- **46** — `cash_inflows` / `cash_outflows` of the sweep's bank organisation for 23 months that no statement covers (Sep 2025 – Jul 2026 and Sep 2026 – Aug 2027), each `basis none`, figure 0.00 = evidence 0.00. These were invented zero movements; now NULL `no_source_covers_period` with no descriptor. **Correct to drop.**
- **2** — the invoice organisation's `receivables` and `receivables_overdue` (22,200.00, basis `invoices`, `open_as_of` with no period filter) for the **current period (September)**. On `7a139b8` September was covered only because the sweep stamps `committed_at = now()` (after the as-of date — the F-9 artefact); on `8493362` a list declared 1–31 Aug does not overlap September, so it is NULL `stale_invoice_data`.

No descriptor appeared only on `8493362`. **The implementer's claim is essentially right but imprecise:** 46 of 48 are uncovered months' invented cash figures; 2 are current-period receivables/overdue that the new freshness rule no longer states (an honest NULL, not an invented cash figure). No real coverage of a figure that is still published was lost. Note the sweep itself still stamps `committed_at = now()` and contains none of the shapes F-6/F-7/F-8 or my N-findings need; those are covered only by `adr123-remediation.test.ts`. My own 27-organisation evidence pass on `8493362`: **290 / 290 leaf descriptors reconcile** (on `7a139b8`: 877 / 887 — TBBS ×2, PARTIALPD ×4, BIGINV ×4 errors, matching F-6/F-7/F-8). Reconciliation is arithmetic only: LEDGER3 (6,000) and BSLIST (5,000) reconcile to wrong figures.

---

## 7. Tests

**Would the new tests fail on the defect?** Run against `7a139b8` (fixtures and tests copied into the `mid` worktree):
- `adr123-remediation.test.ts`: **15 of 18 fail** on `7a139b8` (F-1 ×2, F-2 ×2, F-3 ×2, F-4, F-5, F-6 ×2 incl. L-3, F-7, F-8, F-9, F-10 ×2). The three that pass on both: "June opens at 10,000" (a precondition), the LONG chunk-boundary chain, and **"so August raises no 'cash fell from 9,000' alert"** — `7a139b8` raised none either, so that test does not discriminate (N-13).
- `receivables-recovery.test.ts` (new version): 2 of 33 fail on `7a139b8` — "a month without a statement is unknown" and the `top3_share` 100 % test. Both meaningful.
- Unit (`engine-receivables-wiring`, `evidence-descriptor`, new versions): **6 fail** on `7a139b8` (F-4, F-9, restart refusal of a stale typed balance, closing cross-check, unreconciled flag, `balance_kind` compile).

**Changed assertions — justified?**
- *INVBANK current period* (4,400 → NULL `stale_invoice_data`): **justified.** The old assertion passed only because batches were stamped `now()`; with the pinned 10 Sep commit, a list declared 1 Jun–31 Aug states nothing about September's invoices. It no longer proves current-month aging; CURRENT does (1,500 / 1,000), and passes only on `8493362`.
- *"A month without a statement"* (`bank_coverage_partial` → NULL `no_source_covers_period`): **justified** for BANK's September (no source at all) and fails on `7a139b8`. It does not cover a gap month that another source covers, which is where N-1 lives.
- *Unit freshness test* (a list declared 1–10 Sep, committed 15 Oct, no longer covers August; the case is now declared 15 Aug–10 Sep): **justified** — the old case was the F-4 defect itself (a range starting after P); the 45/46-day boundary is kept.

**Weakened tests:** none found. `git diff 7a139b8..8493362 -- test` removes no assertion other than the two above; the mocks rename `loadStatementOpenings` → `loadStatements`.

**Gaps:** no test for the run-loop restart itself, for L-4, for a ledger/balance-covered gap month, a partly covered month, a typed opening with a split first statement, a joining account, a list committed inside a completed month, a mid-month journal, or a not-yet-due credit note (N-13).

**`ai-eval-record` isolated rate:** 7/10 pass; 3 failures, all `get_alerts #16 output shape` (known, pre-existing).

---

## 8. Security re-check

- **`loadStatements`** (`financial-engine/data/repository.ts`): the run's org-scoped client, `organization_id = orgId`, `status = committed`, `target_table = bank_transactions`, paged and ordered by id; reads balance columns that hold only parsed/reviewer-typed values (migration `20260905000032`) and `batch_issues` codes. No new exposure.
- **Open-invoice loader** (alerts, from `7a139b8`): unchanged by ADR-123; paged, org-filtered, non-void.
- **Resolver**: the `open_at` post-filter now calls the engine's `invoiceOutstandingAt` on columns already in the invoice projection (`invoice_type`, `total_amount`, `balance_due`, `paid_date`); rows still come through the caller's RLS client and the as-of lifecycle filter. `ID_BATCH` 300 → 100 affects only request size (BIGINV 1,050 rows resolve). The new `balance_kind` filter is an `eq` on a whitelisted column of `period_balances`. Cross-tenant resolution and role coverage (owner, admin, client, assigned/unassigned employee, super admin at aal1/aal2) are exercised by `receivables-recovery.test.ts`, which passed in the integration gate.
- **`api_server.enqueue_engine_upgrade`** (migration `20260930000002`): `security definer`, `search_path = ''`, owner `motion_definer`, `role_claim() = service_role` check, EXECUTE revoked from public/anon/authenticated and granted to `service_role`; version validated `^\d+\.\d+\.\d+$`. pgTAP `15_engine_upgrade` asserts the grants, the refusal without the claim (42501) and the validation (22023); `00_structure` covers every `api_server` function generically.
- No RLS policy, grant or table change in ADR-123 (`55` tables / `126` api functions, schema check).

---

## 9. VERDICT

**NOT READY.**

The ADR-120 dependency is **not** cleared for Phase 16.

**Blocking (inside ADR-120 / ADR-123 scope):**
- HIGH: **N-1** (F-1 residual — a month no statement fully covers still publishes a carried closing balance, a wrong working capital and a false HIGH `cash.decline`), **N-2** (F-2 residual — a typed opening balance plus a split first statement gives wrong figures at completeness 1).
- MEDIUM: **N-3** (restart makes a whole history NULL when an account joins or one account has a gap — contradicts §3.3), **N-4** (a list committed during a completed month outranks that month's balance sheet with a verified figure), **N-5** (mid-month opening journal double-counts), **N-6** (engine version not bumped: figures written by `7a139b8` are never recomputed by the upgrade sweep and are carried forward), **N-7** (F-10 residual — "500 % overdue").
- First-audit dispositions: F-1, F-2, F-10 **partly fixed**; F-11 **not closed** (incomplete change set; owner sign-off outstanding). F-3…F-9, L-3, L-4, L-5, L-10 **fixed**; L-9 partly.

**What is now sound:** the GAP and MIDSTART reproductions; the ledger's latest-journal rule for whole-month journals; per-side AR/AP freshness for the current month and for lists that start after P; the days denominator; the three evidence reconciliation defects (F-6/F-7/F-8 — 290/290 descriptors reconcile); the upgrade sweep's audit trail and its pgTAP coverage; thresholds, rules, Phase 15 and the Phase 16 boundary are untouched; all gates green.

**To clear:** fix N-1…N-7 (or obtain an explicit, recorded owner decision for N-4 and N-3's rule), bump the engine version, add GAPGL, PARTJUL, MIDTYPED, NEWACCT, BSLIST, LEDGER3 and CNFUTURE (`…/adr120-audit-2/src/audit2-probes.ts`) as permanent fixtures, restate the F-11 change set and obtain the owner's sign-off, then re-audit.
