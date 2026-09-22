# Phase 13 — Banking Intelligence — Independent Final Audit

**Audited tree:** the uncommitted Phase 13 working tree on `main` after `b2a73ea` (44 files; migration `20260922000001_banking_intelligence.sql`).
**Rule:** READY requires CRITICAL = 0 and HIGH = 0 and nothing that makes Phase 14 unsafe to begin. No code was modified by this audit.

## Executive summary

Phase 13 was audited by reading the shipped code and by probes written outside the repository (`scratchpad/audit/banking.probe.ts`, 10 cases against the real database, calculation job and alerts job on four organisations — GBP, USD, AED and a second GBP tenant; `banking.pw.ts`, one browser run at 1280 px and 375 px for an owner and a client). The repository's own gates were also re-read for what they prove rather than counted.

The financial and security properties hold. Bank A → Bank B with transfer wording leaves cash, revenue and expenses on both legs; without wording it stays in and is named to the reader. Money into the bank is never revenue by a rule (the only August inflow counted as revenue was the one matching the `invoice` keyword, £4,800 of £14,578). A card repayment stays in cash outflows and is categorised `credit_card`. Per-account sums equal the engine's `cash_inflows`/`cash_outflows` to the penny; there is no second cash engine. USD and AED organisations carry `$` and `AED` through the summary and tool 20; no exchange rate exists. Nothing on any page or in any tool result says connected, live or synced; the database, the tools and the pages say "imported statements". Every cross-tenant read and write tried — accounts, transactions, evidence, provenance, statement balances, category, transfer, tool inputs naming another organisation — fails safely for another owner, an unassigned employee and a client.

Four findings are MEDIUM. None is a security or financial-integrity defect; all four are about what the intelligence *says* — two of them in Phase 7 rules that Phase 13 has made visible for the first time — and one is a mobile layout defect on the new transactions page. Seven are LOW.

**CRITICAL 0 · HIGH 0 · MEDIUM 4 · LOW 7 → READY FOR PHASE 14.**

## 1. Bank account review

Unchanged table; organisation-composite key on every reference; currency now defaults to `organizations.base_currency` in `api.create_bank_account` (probe: an account created without a currency in the INR organisation is INR). No credential-like column exists on `bank_accounts` or `bank_transactions` (probe: `information_schema` search for password/pin/secret/token/credential → none). The add-account path stores only the last four digits (`****4321`). Statement balances are shown as facts with their date; freshness per account is the covering-to and import date of its latest committed statement. **Observation (LOW-2):** the sort code is stored as typed (`12-34-56`) in a column named `sort_code_masked`.

## 2. Transaction review

Signed amounts (positive = inflow), masked description only, period assigned by trigger, currency the organisation's, statement running balance preserved, `record_status`/`assurance_level`/supersession respected: only accepted, non-superseded rows enter the pass, the summary, the pages and the tools. Duplicate handling is the import engine's (dedupe hash, reviewer decision) plus the `duplicate.transaction` alert — three identical same-day rows produced two duplicate alerts in the probe. No sign, currency or period error found: August outflows on the probe organisation were £9,852.00 by the engine and £9,852.00 by the summary, composed exactly of the seeded rows with the paired transfer leg excluded and the card purchases (not cash-like) excluded.

## 3. Banking vs accounting

Probe evidence (`AUDIT aug cash`): inflows 14,578.00, outflows 9,852.00, **revenue 4,800.00**, operating expenses 2,500.00. The £9,000 monthly receipt with no keyword stayed uncategorised and never became revenue; the £778 unpaired credit stayed in cash and out of revenue; the paired £1,000 sweep left cash on both legs (`true|cash_transfer` × 2); the unpaired £777 `TFR TO OTHER BANK` stayed in outflows and appeared as "One transaction looks like a transfer between your own accounts but has no matching leg". The categories view excludes every transfer kind (no `transfer`/`credit_card` rows). Card purchases appear as bank movement on the card account and in categories, not in cash.

## 4. Cash

Opening/inflows/outflows/net/closing are the engine's rows from `metric_current`; the page renders them through the same `toFigure` the Money pages use, with their status badges and evidence links. The organisation-level reconciliation shows the engine's own `statement_closing_cash`/`statement_delta` components and says honestly when a running balance is missing ("Not every account's statement carries a running balance for this month"). The three-month trend and concentration read stored closings and statement balances only.

## 5. Categorisation

The ladder runs inside every calculation through `planBankingPass` → `api_server.apply_banking_pass`; user overrides are skipped in TypeScript and again in SQL; every change appends `category_history`; a second run is `no_change` with no new history (repository suite); the override of a wage run survived a later run. Invalid categories: an account of another organisation is refused (NOT_FOUND). **Observation (LOW-3):** `api.override_bank_category` accepts any of the organisation's accounts, including balance-sheet ones (`cash` accepted in the probe) — pre-existing Phase 4 behaviour, not introduced here. Category never alters `assurance_level`.

## 6. Recurring payments

Two occurrences never form a group (probe). Three monthly wage runs and seven monthly receipts form `monthly` groups. **Finding (MEDIUM-1):** three payments at random gaps (Feb, Apr, Aug) and three identical same-day payments both became groups with cadence `irregular`, were listed under **Regular payments** as "Regular · now and then", and raised `recurring.new` ("A new regular payment to random shop / same day vendor"). The detector (`detectRecurring`, Phase 6) emits `irregular` groups and `recurring.new` (Phase 7) fires at exactly three occurrences with no cadence condition; Phase 13's pass is the first thing to run them, and its page presents every group as "Regular". A secondary effect: rows in such a group are excluded from `bank.unusual_transaction` as "recurring", so three same-day duplicates of a large payment would be shielded from the unusual rule (they still raise `duplicate.transaction`).

## 7. Anomaly detection

Rules-based, in the alerts job; the model reports only (tool 22 returns alert rows and a look-alike count). With seven months of history the £5,000 payment to a new counterparty raised `bank.unusual_transaction` (medium) carrying the transaction id, the period, the severity and an evidence bundle, and the routine £101 did not. **Finding (MEDIUM-2):** with one month of three rows the rule flagged a routine £2,500 payroll and a £1,000 transfer look-alike as "much larger than usual" (browser probe, `AUDIT notices`). The threshold is `max(£1,000, median + 3 × MAD)` over trailing records with no minimum-history condition; the first-period suppression in `suppression.ts` covers variance rules only. A Phase 7 rule, now on the first screen a new customer reads.

## 8. Reconciliation

Statement-level, per CD-20: per account and month from the covering statement batch, plus the engine's cross-check at organisation level; a client cannot type statement balances (`set_statement_balances` → 42501); no column on `bank_transactions` says "reconciled" and the page says a line is never marked reconciled because it was imported. **Finding (MEDIUM-3):** a committed batch declared 15 Jul – 14 Aug with balances captured and no IMP-BAL issue makes August read **Reconciled** for that account, while the card's freshness line says "covering to 14 Aug". The summary selects any batch *overlapping* the month; the engine's coverage test requires the declared range to *span* it. The label overstates what was checked.

## 9. Currency

INR, USD and AED organisations: rows, accounts, summary money, page figures and tool 20 all carry their own currency (`₹`, `$`, `AED`); GBP is not hard-coded on any reachable path (three `?? 'GBP'` fallbacks sit behind a NOT NULL read); no conversion, no FX table or function (the only `%rate%` table is `api_rate_limits`); `base_currency` is read-only after creation, so the one-off backfill cannot relabel history.

## 10. Live vs imported

Imported banking data only. `api.bank_period_summary` returns `source = 'imported_statements'`; tools 20–23 return `connected: false`; every banking page prints "Bank figures come from the statements you have uploaded. MOTION is not connected to your bank." with the last import and covering-to dates. The forbidden vocabulary (connected/synced/live feed/real-time/automatically synced) is absent on the overview, transactions and transaction pages for owner and client (browser probe and journey 13).

## 11. Evidence

Phase 8 reused, nothing new. Figure → drawer → rows → statement via `whyHref`; transaction → record page (`/evidence/record/bank/[id]`) → statement for `documents.view`; alert → transaction → bundle. The `rejected_reason` grant fix made the record page work for bank rows (journey 13 opens it as owner and as client; the client sees no filename). Cross-organisation provenance and transaction loaders return NOT_FOUND/null.

## 12. AI

Tools 20–23 read through the Banking page's services; no SQL, no organisation input (a smuggled `organization_id`/`bank_account_id` is dropped by the schema — probe: B's owner reading with A's ids got B's account only); balances and categories are returned as branded numbers; unusual items are alert rows. Prompt `analyst-v3.3` forbids live/connected/synced, invented balances, summing balances and self-judged anomalies; eight refusal cases in the corpus; grounding would reject a "connected" claim against `connected: false`. Data minimisation: tool 20 returns per-account aggregates, tool 22 alert rows plus a count, tool 23 category sums; none returns transaction histories.

## 13. RBAC

Matches `RBAC_MATRIX.md`: `banking.view` (all five roles) reads pages, summary and tools; `banking.reconcile` (client ✗) categorises/pairs — client refused in SQL and shown no controls; `financials.edit` (client ✗) adds an account — client refused, form hidden; `documents.view` (client ✗) — client reaches the record page but not the file; `data.export` (client ✗) — export throws PERMISSION_DENIED for a client, owner export is masked and in currency. Super admin was not separately exercised (its path is the platform role; unchanged by Phase 13).

## 14. Employee assignment

Assigned employee (aal2): summary and all four tools succeed on A. Unassigned employee: NOT_FOUND on the summary, on category override, on account creation. Direct ids: account, transaction, evidence bundle, document (via provenance) and organisation all fail safely across tenants.

## 15. Tenant isolation

Service layer (`organization_id` on every read), RLS (forced on all 48 tables; the two new functions resolve the organisation through `app.accessible_org_ids()`), composite FKs on every pass write. A cannot read B's accounts (tool/summary), transactions (RLS returns nothing; page loader null → 404), modify B's categories (P0002), reconcile B's rows (P0002), pair an A row with a B row (P0002), read B's evidence or provenance (NOT_FOUND). Reverse direction identical.

## 16. Source documents

Private bucket, no policies for `authenticated`, audited 60-second signed URL minted only after `documents.view` (Phase 5–9, unchanged). The banking pages never link to a file; the record page does, and only for the permitted role. No public URL exists. The summary function exposes statement dates, printed balances and batch ids to `banking.view` — batch ids are not openable without `imports.review` (403).

## 17. AI data minimisation

Verified as in §12. Internally tool 22 and the overview load a bounded 500-row sample to count look-alikes; nothing from it leaves the server.

## 18. UX

Reader's order holds (screenshots `audit13-overview-desktop.png`, `audit13-overview-375.png`, `audit13-client-detail.png`): cash, this month, things to notice, accounts, then six disclosures. Plain words, pence shown, currency correct, freshness banner, imported-not-live sentence, keyboard-toggleable disclosures, captions and sr-only headings, empty states, 404 for malformed and cross-organisation ids, client sees no controls. **Finding (MEDIUM-4):** at 375 px the **transactions page** scrolls the whole document horizontally (document 553 px in a 375 px viewport). The table sits in its scroll container; the six filter links in the card header's `shrink-0` action slot do not wrap within the card. The overview and the transaction page stay at 375 px. The accessibility sweep does not visit this route, so the repository's gates could not catch it. **LOW-5:** on the 375 px account card the net figure wraps ("+ / £5,500.00").

## 19. Performance

Aggregation in SQL; paged, counted lists; the pass reads rows in pages of 1,000 once per run and writes differences only; no N+1 (parallel loads per page). **LOW-6:** `loadLatestGroupMembers` selects every member row of every recurring group on each overview load (bounded by 18 months × groups, but unbounded in code). **LOW-7:** the look-alike count is a lower bound from a 500-row sample.

## 20. Regression

All eleven gates pass on a clean database at the audited tree: typecheck, lint, matrix (121 grants, unchanged), unit 1,961/67, eval 166, build, pgTAP, drift 48/111, integration 634/38, Playwright 63 passed / 1 skipped. Forecast, scenarios, evidence, health, alerts, AI, actions, RBAC and isolation suites are among them and unchanged in content. The fingerprint change (`bankingRuleVersions()`) means every existing organisation's next run is a full recompute — documented, one-off.

## 21. Test quality

`test/integration/banking.test.ts` proves negatives (unpaired look-alike, two occurrences), idempotence (`no_change`, no history), user override survival, engine = summary to the penny, currency (INR), IDOR on reads and writes across tenants, client look-not-touch including export and document, provenance NOT_FOUND, tool fencing. Journey 13 proves the wizard path, the record page for two roles and the vocabulary rule. The audit probes add USD/AED, the alerts job end to end, partial-coverage reconciliation, recurring edge cases and the mobile sweep — which is where the four MEDIUM findings surfaced, i.e. outside the shipped suites.

## 22. Known issues

The `ai-eval-record` flake is unchanged: the pass runs on the recording organisation (no bank rows → an empty, deterministic plan and one audit row), adds no nondeterminism, and the test passed on the final run. It remains Phase 7 alert-set ordering.

## 23. Findings

| # | Sev. | Finding | Where | Suggested fix (not applied) |
|---|---|---|---|---|
| MEDIUM-1 | MEDIUM | Irregular-cadence groups (random gaps; same-day duplicates) are persisted, listed as "Regular payments", and raise `recurring.new`; their members are excluded from the unusual rule | `banking/domain/recurring.ts`, `alerts/domain/rules/recurring-anomaly.ts`, `dashboard/services/banking.ts` | Do not persist `irregular` groups (or present them as "seen 3 times, no pattern" and exclude from `recurring.new` and from the unusual rule's recurring exclusion); require ≥ 1 distinct gap |
| MEDIUM-2 | MEDIUM | `bank.unusual_transaction` fires on routine payments when history is thin (one month, three rows): threshold collapses to the £1,000 floor | `alerts/domain/rules/bank-unusual.ts`, `suppression.ts` | Require a minimum trailing history (e.g. ≥ 3 months or ≥ 20 outflows) before the rule may fire; surface `insufficient_history` |
| MEDIUM-3 | MEDIUM | "Reconciled" shown for a month a statement only partly covers | `api.bank_period_summary` (overlap) vs `dashboard/services/banking.ts` `reconciliationFor` | Require the declared range to span the month for `reconciled`; otherwise a "Partly covered to {date}" status |
| MEDIUM-4 | MEDIUM | Transactions page scrolls horizontally at 375 px (document 553 px) | `money/banking/transactions/page.tsx` filter nav in `CardHeader action` | Move the filters below the header or allow the action slot to wrap; add the route to the accessibility sweep |
| LOW-1 | LOW | Identical duplicate-alert sentences repeated for one triple (one alert per pair) | Phase 7 dedupe granularity | Group duplicate alerts per signature/day in "Things to notice" |
| LOW-2 | LOW | Sort code stored as typed in `sort_code_masked` | `add-account-form.tsx`, `createBankAccountAction` | Mask to `**-**-56` before sending |
| LOW-3 | LOW | Category override accepts balance-sheet accounts (e.g. `cash`) | `api.override_bank_category` (Phase 4) | Restrict to P&L and the transfer/liability categories |
| LOW-4 | LOW | Single signed-amount CSV on a current account needs a sign convention the upload form does not ask for | import wizard (pre-existing) | Ask the convention in the wizard |
| LOW-5 | LOW | Net figure wraps on the 375 px account card | `money/banking/page.tsx` | `whitespace-nowrap` on the figure |
| LOW-6 | LOW | `loadLatestGroupMembers` unbounded | `banking/data/repository.ts` | `DISTINCT ON` in SQL or a per-group limit |
| LOW-7 | LOW | Look-alike count is a 500-row lower bound | `dashboard/services/banking.ts` | Count in SQL |

**CRITICAL 0 · HIGH 0 · MEDIUM 4 · LOW 7**

None of the MEDIUM findings concerns money being miscounted, a tenant boundary, a permission, a document, or a claim of connectivity; each concerns how an already-correct fact is labelled or laid out, and each has a contained fix. Nothing here makes Commercial Intelligence unsafe to begin.

## Final verdict

**READY FOR PHASE 14**
