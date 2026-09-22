# Phase 13 — Banking Intelligence (REQ-BK-01…11, ADR-101)

Scope: Banking Intelligence only. No Commercial Intelligence, no Adviser/CFO Command Centre, no
Funding Readiness, no Reporting, no knowledge-base or embedding work. Phases 1–12 are not redesigned.

## 0. What already existed

The brief said the documentation and the code may disagree, so the first pass was an inventory.

| Piece | State before Phase 13 | Where |
|---|---|---|
| `bank_accounts`, `bank_transactions` (signed, masked description, category, transfer state, statement balance, provenance), `recurring_payment_groups`, `category_history` | existed, RLS forced, no write grants | Phase 4 schema, ADR-028/034/038.4 |
| The categorisation ladder, transfer pairing with the description gate, recurring detection, the bank-basis P&L proxy | existed as **pure functions with unit tests** | `banking/domain/*` (Phase 6) |
| **Anything that RAN those three rules over an organisation's rows** | **absent.** No code set `category_account_id` except a person; no code paired a transfer except a person; `recurring_payment_groups` was never written | — |
| Cash metrics from bank rows (in/out/net/opening/closing/runway) with coverage, `statement_balance_mismatch` and `unreconciled_statement` cross-checks, evidence descriptors | existed | engine `cash.ts` (Phase 6) |
| Alert rules `bank.unusual_transaction`, `duplicate.transaction`, `recurring.*` | existed and ran — but the four recurring rules could never fire (no groups), and "unusual" could not exclude a standing order | `alerts/domain/rules` (Phase 7) |
| A Money → "Bank activity" page (three figures, accounts' opening balances, 200 rows) | existed | Phase 7 |
| A way to create a bank account in the UI | **absent** — the import wizard pointed at a form on the Cash page that did not exist | — |
| Currency on bank rows | a file with no currency column committed as `'GBP'` whatever the organisation reports in; `api.create_bank_account` defaulted to `'GBP'` | commit SQL, `api_financial.sql` |
| `rejected_reason` on `bank_transactions` in the `authenticated` column grant | **missing** — the record provenance read failed on every bank row, for every role | migration 30 |
| AI: tool 6 `get_cash_analysis`, tools 13/16 for rows and records | existed | Phase 9 |
| Any live bank integration, provider abstraction or credential | **absent** (CD-21) | — |

Phase 13 therefore has two halves: making the banking rules that already existed actually run, and
building the surfaces, tools, reconciliation and freshness statements on top of what they produce.

## 1. Banking architecture

```
statement upload ──► import pipeline (rows stamped with the organisation's currency)
                          │ commit
                          ▼
              bank_transactions (accepted, masked, provenance)
                          │
   calculation.run ──► bankingStep ──► planBankingPass (pure) ──► api_server.apply_banking_pass
   (top of runCalculation,             categorise · pair · group         idempotent, never over a person,
    before the fingerprint)                                                kind derived in SQL
                          │
                          ▼
   app.aggregate_periods → engine cash family → metric_snapshots / metric_current
                          │                                   │
   alerts.evaluate (recurring.*, bank.unusual_transaction, duplicate.transaction)
                          │
   api.bank_period_summary (per account / per category / statements / freshness; same transfer rule)
                          │
   dashboard/services/banking.ts ──► /money/banking, /transactions, /transactions/[id] ──► AI tools 20–23
```

One rule governs the whole phase: **nothing is calculated twice.** Cash figures are the engine's;
everything else is an aggregation of the same accepted rows under the same transfer rule, and an
integration test asserts the two agree to the penny.

## 2. Bank account model

Unchanged table. Fields used: name, bank, masked last-four and sort code (the full number is never
stored), currency, type (`current`, `savings`, `credit_card`, `loan`, `other`), opening balance and
its date, active flag. Only `current`/`savings` count as cash (ADR-028). New in Phase 13:

- `api.create_bank_account` defaults `currency` to `organizations.base_currency`; the TypeScript
  input no longer defaults to `'GBP'` and the form sends no currency.
- An **Add a bank account** form on `/money/banking` for `financials.edit` (name, bank, type, last
  four digits, optional sort code). No credentials, PINs or logins exist anywhere to store.
- Per account and month the page shows: the balance printed on the statement at its last line (a
  fact with its date, never a calculation), money in/out/net with own-account transfers left out,
  transfers between own accounts, row and uncategorised counts, statement freshness (covering-to and
  import dates), reconciliation status, and whether an opening balance is still needed.

## 3. Transaction model

Unchanged table; no duplicate model. Preserved per row: source document, import batch, import row,
`source_ref` (page/line), bank account, transaction and posted dates, masked description, signed
amount, currency, statement running balance (`balance_after`), reference, category and its source,
transfer state and kind, recurring group, `record_status`, `assurance_level`, supersession.
`description_raw` and `counterparty_name_raw` stay unreadable by every role (ADR-044.2).

## 4. Source ingestion

CSV, XLSX and PDF statements through the existing wizard (unchanged flow). Two corrections:

- The pipeline stamps every committable row with the organisation's currency when the file names
  none, and upper-cases one it does name; IMP-CUR-007 still refuses a row in another currency.
- The wizard's hint now points at the Banking page's add-account form (the one it referred to did
  not exist).

## 5. Categorisation

The §4.1 ladder now runs on every calculation: user override → (saved organisation rule — none
exist yet) → platform keyword set → none. The pass writes only rows whose category or source would
change, so a second run writes nothing; every change appends `category_history`. A row a person
categorised (`category_source = 'user'`) is never touched by a rule, before or after they decide.
A transfer leg is given the category its kind implies (`transfer`, `credit_card`, `loan`). The
transaction page lets `banking.reconcile` change a category; the choice is recorded as theirs.
Bank movement and accounting classification remain distinct: money into the bank is never called
revenue by a rule, and "where the money went" is labelled as bank movement, not a P&L.

## 6. Recurring payment detection

§4.3, unchanged rule: ≥ 3 occurrences of one signature on one account in one direction within 18
months; cadence from the median gap with ≥ 70 % of gaps within ±20 %; `expected_amount` = median;
tolerance = max(10 %, MAD/median); `changed` when the last amount drifts beyond tolerance;
`stopped` when `asOf` passes `next_expected + 1.5 × cadence`. New: the pass upserts the groups on
their stable key, points members at them, and marks groups no longer detected `stopped` (never
deleted — alerts and evidence may cite them). Transfer legs are excluded: a sweep to savings is not a
payment to anybody. Surfaced under **Regular payments** and through tool 21; a group links to every
occurrence. No schedule is invented: `next_expected` is shown only when the detector computed it.

## 7. Unusual transaction detection

Deterministic, unchanged rules (`bank.unusual_transaction`: max(£1,000-equivalent floor, median +
3 × MAD) or a new counterparty ≥ 10 % of the month's outflows, recurring and transfers excluded;
`duplicate.transaction`; `recurring.amount_changed / missed / inflow_missed / new`). Phase 13 makes
them effective — the recurring rules had no groups to read — and surfaces their open and
acknowledged alerts under **Things to notice**, each with reason, severity, account, transaction,
period and evidence bundle, linking to the alert page. Added to the same list: rows that look like a
transfer but found no matching leg (still counted as money in or out, said so), uncategorised
counts, and statements that do not reconcile. The model never decides what is unusual (tool 22).

## 8. Liquidity

From `metric_current` only: cash available (`closing_cash`), how long it would last
(`cash_runway_months`, "36+" cap as elsewhere), the month's net movement, a three-month trend of
closing cash (rising / falling / mixed / not enough data), and where the cash sits (largest
account's share of statement balances, only when every cash-like account has one). Each indicator
says why it cannot be given rather than guessing; no ratio requiring accounting data is invented.

## 9. Reconciliation

CD-20, extended to the account and the month:

| Status | Meaning |
|---|---|
| Reconciled | a committed statement covers the month for the account, its printed opening and closing balances were captured, and the rows add up to them (no IMP-BAL-006/007) |
| Does not reconcile | the rows did not add up at import (IMP-BAL-006/007); the figures from it carry `unreconciled_statement` |
| Not checked | the printed balances were not captured; they can be typed on the import page |
| No statement | no committed statement covers the month for the account |

At organisation level the engine's own cross-check is shown: Σ statement closing balances vs
MOTION's `closing_cash`, with the difference (`statement_delta`) when both exist. A line is never
marked reconciled because it was imported; line-by-line matching to ledger entries
(`matched_ledger_entry_id`) is not built and the page says so.

## 10. Transfer handling

Pairing requires amount, ≤ 3 days, different accounts of the same organisation AND the description
gate (ADR-047.12). The kind is derived in SQL from the two account types — never from the plan,
never from a person (ADR-028): only cash-like ↔ cash-like is a `cash_transfer` and leaves the cash
figures; card and loan legs stay in cash. A leg somebody decided about (`category_source = 'user'`)
is never auto-paired; a transfer somebody marked or unmarked is left alone. Look-alikes without a
partner are not paired and are named on the page. The transaction page offers candidate legs to
`banking.reconcile` (opposite sign, same size, another account, ≤ 3 days, undecided) with the
meaning each pairing would have, and an un-pair for a marked transfer.

## 11. Currency behaviour

Transaction currency, account currency and organisation currency are all the organisation's, by
construction: import refuses any other (IMP-CUR-007), the pipeline stamps the base currency on rows
that name none, accounts default to it, and the one-off migration corrected rows and accounts
written as `'GBP'` elsewhere. No conversion, no exchange rate, anywhere. Every figure on the pages
and in the tools carries the organisation's currency (INR, AED, GBP … asserted in tests).

## 12. Data quality

Record statuses are unchanged and respected: only `accepted`, non-superseded rows enter sums, the
pass, the summary and the tools; a `rejected`, `duplicate`, `incomplete` or `needs_review` row is
shown on its own page with its standing and is not counted; a superseded row says it was replaced.
No zero stands in for a missing figure: a missing cash balance is "—" with its reason; a missing
statement balance is "not on the statement". Data-quality codes on the month's cash figures
(`bank_coverage_partial`, `statement_balance_mismatch`, `unreconciled_statement`,
`unpaired_transfer_candidate`, `no_opening_cash` …) are printed with the shared copy.

## 13. Evidence

The Phase 8 system, unchanged. Bank insight → figure (drawer level 1) → components → descriptor →
rows → source document; alert → transaction → source; balance → `closing_cash` components →
opening balances and statement balances. The transaction page links to the record page
(`/evidence/record/bank/[id]`), which is where the statement is opened for `documents.view`
through the audited 60-second signed URL. Fixing the `rejected_reason` grant made that page work
for bank rows.

## 14. AI integration

Four read-only tools (`banking.view`), all through `dashboard/services/banking.ts`:

| # | Tool | Answers |
|---|---|---|
| 20 | `get_bank_accounts` | accounts for a month: statement balance, in/out/net, own-account transfers, reconciliation, freshness |
| 21 | `get_recurring_payments` | regular payments and receipts, usual and last amount, changed/stopped |
| 22 | `get_unusual_transactions` | the banking alerts for a month plus transfer look-alikes |
| 23 | `get_bank_categories` | where money went by category (bank movement, not P&L) |

No tool takes an organisation, user or assignment; a period is a label from `period_context`.
Every result carries `source: 'imported_statements'` and `connected: false`. The prompt
(`analyst-v3.3`) tells the model banking IS available through these tools, and forbids "live",
"connected", "synced", any balance a tool did not return, adding balances, deciding what is unusual,
or treating inflows as revenue / outflows as expenses. Eight eval cases refuse asks for a sync, a
live balance, an estimated balance and a self-judged "unusual" list; the corpus is re-recorded.

## 15. Live vs imported banking

There is no live integration. The database says so (`source = 'imported_statements'`), the tools
say so, and every banking page prints: *"Bank figures come from the statements you have uploaded.
MOTION is not connected to your bank."* with the last statement's import and covering-to dates.
"Connected", "live", "synced" appear nowhere; journey 13 asserts it for owner and client. A future
provider would enter through the same import pipeline as a batch with `source_ref`s; the pass,
summary, pages and tools would not change.

## 16. RBAC

No new permission. `banking.view` (all five roles) reads the pages, the summary and tools 20–23;
`banking.reconcile` (not client) categorises and pairs; `financials.edit` (not client) adds an
account; `documents.view` (not client) opens the statement, only through the record page;
`data.export` (not client) governs the unchanged CSV export. A client sees no form, no button, and
the page tells them their role stops at the document. Every `api.*` function re-checks in SQL.

## 17. Tenant isolation

Service layer (`organization_id` on every read), RLS (forced on every table; the summary and pass
functions resolve the organisation through the accessible set), and composite foreign keys
(`(organization_id, id)` on every reference the pass writes). Tested: organisation B's owner and an
unassigned employee get NOT_FOUND from the summary, from every banking write with A's ids, from
provenance and from a cross-organisation pair; an A row paired with a B id is refused; tools
resolved against A by B's owner return nothing of A; a smuggled `organization_id` in a tool input
is ignored by the schema.

## 18. Performance

No month of rows reaches the browser. `api.bank_period_summary` aggregates per account and category
in SQL over the indexed `(organization_id, period_id)` rows; the transactions page is paged (200) and
filtered on the server with an exact count; the pass reads rows in pages of 1,000 once per run and
writes only differences; the overview loads a bounded 500-row sample only to count transfer
look-alikes. Nothing re-parses a file.

## 19. Security

Raw statement text remains unreadable by any role; only masked descriptions reach pages, tools and
exports. No credentials exist. Statements open only through the audited signed URL. `api_server.
apply_banking_pass` carries the service-role guard and the organisation-scope assertion, is owned by
`motion_definer`, and is not executable by `authenticated` or `anon` (pgTAP). `api.bank_period_
summary` re-checks the accessible set and `banking.view` in its body. No new table, no new grant
beyond the one missing column.

## 20. Tests

| Layer | Suite | Covers |
|---|---|---|
| Unit | `test/unit/banking-pass.test.ts` (8) | composition, determinism, order-independence, idempotent plan, user decisions untouched, transfer legs out of recurring, rule withdrawal, look-alikes and versions |
| Integration | `test/integration/banking.test.ts` (20) | rule categorisation, pairing with kind derived in SQL, unpaired look-alikes, recurring groups and members, one history row per change, `no_change` on the second run, override survives, summary = engine to the penny, categories third-party-only, statements and reconciliation facts, client/employee/other-org/unassigned access, pass writer unreachable, INR everywhere, account inherits currency, tools 20–23 for owner/client/employee, smuggled inputs, cross-org reads, cross-org writes (categorise, pair, un-pair, cross pair, unassigned employee), client look-not-touch incl. export and document, provenance NOT_FOUND across organisations, export masked and in currency |
| Integration | `test/integration/ai-tools.test.ts` | registry of 23; role × tool matrix incl. the four banking tools |
| Integration | `test/integration/ai-eval-record.test.ts` | recording re-made at `analyst-v3.3` with the four banking calls |
| Eval | `test/eval/ai-eval.test.ts` (166) | +8 banking refusal cases |
| pgTAP | `supabase/tests/10_banking_intelligence.test.sql` (9) | function existence, ownership, privileges; groups table read-only |
| Playwright | `e2e/journey-13-banking.spec.ts` | add account → import statement → overview (source sentence, month figures, notices, accounts, categories, reconciliation) → transactions → detail → record page → categorise → client with no controls; "connected/synced/live" absent throughout |
| Regression | all eleven gates on a clean database (final section) | Phases 1–12 |

## 21. Known limitations

1. **No saved "apply to similar" rule** (§4.1 point 2): the ladder's second rung has no table and
   is skipped; a person's choice applies to one row.
2. **No line-by-line reconciliation** to ledger entries; `matched_ledger_entry_id` is unused (CD-20).
3. **No live bank integration**, by design (CD-21); the seam is the import pipeline.
4. **Multi-currency accounts are refused at import**, not converted (IMP-CUR-007).
5. **A single signed-amount CSV on a current account** needs a sign convention the upload form does
   not ask for (`resolveBankSign` returns null and `imports.start` refuses with a clear message);
   two-column (paid out / paid in) files import. Pre-existing wizard behaviour, not changed here.
6. **Transfer look-alikes are counted from a 500-row sample** of the month; a month with more rows
   than that shows a lower bound.
7. **The first calculation after this migration** re-categorises an existing organisation's history
   by rule (a person's choices untouched) and writes recurring groups; expect one recalculation.
8. **Per-account closing balances are statement facts**, not a per-account cash calculation; where a
   statement carries no running balance the card says so.
9. The intermittent `ai-eval-record` flake (Phase 7 alert-set nondeterminism) is unchanged and
   documented; it passed on the final run.

## 22. Gates (final run, clean database, 2026-09-22)

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS |
| Permission matrix | in sync (121 grants; no new permission) |
| Unit | 67 files, 1,961 passed (+8) |
| AI eval | 166 passed (+8, recording at `analyst-v3.3`) |
| Production build | PASS — `/money/banking`, `/money/banking/transactions`, `/money/banking/transactions/[transactionId]` |
| pgTAP | PASS (incl. `10_banking_intelligence.test.sql`) |
| Schema drift | 48 tables, 111 api functions, RLS forced everywhere, no write grants, no reachable server functions |
| Integration | 38 files, 634 passed (+20, `banking.test.ts`) |
| Playwright | 63 passed, 1 skipped (+ `journey-13-banking`) |
| Authorization / tenant isolation | covered by `authorization-status`, `rls-isolation`, `isolation-cases` and the banking suite's cross-organisation, role and employee-assignment cases — all PASS |
