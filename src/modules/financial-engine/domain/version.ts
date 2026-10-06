/**
 * The engine version (FINANCIAL_ENGINE.md §6).
 *
 * Semver, and the rules for bumping it are not stylistic:
 *   PATCH — a bug fix that changes NO golden output.
 *   MINOR — a new metric or a new warning; existing values unchanged.
 *   MAJOR — any change to an existing formula, to precedence, or to a category set.
 *
 * A major bump enqueues a full recalculation for every active organization at deploy time. Until it
 * completes, an organization keeps reading its old snapshots: pointers stand until they are replaced
 * atomically per period, so nobody ever sees half a year computed one way and half the other.
 *
 * The version is written onto every `calculation_runs` row, which is what makes the reproducibility
 * guarantee checkable: given a run id, its fingerprint and the tagged version from git, a replay
 * must reproduce every snapshot value.
 */
/**
 * 2.0.0 (ADR-120): MAJOR. The run now carries cash and the runway window between periods (existing
 * cash values change) and writes the receivables family for the first time. §6: a change to an
 * existing value is a major bump, and the first run on it recomputes each organisation's history.
 */
/**
 * 3.0.0 (ADR-124): MAJOR. Cash is solved per bank account, day by day, from what the statements state
 * (D-1, D-2); a completed month's receivables and payables need a list that states the month's END
 * (D-3); a ledger balance starts on its opening journal's DATE (D-4). It also carries ADR-123's
 * figure changes, which were released on 2.0.0 without the bump §6 requires — so organisations a
 * 2.0.0 engine computed before ADR-123 were never recomputed (audit N-6).
 *
 * The bump is ENFORCED, not remembered: `test/unit/engine-version-golden.test.ts` hashes the engine's
 * outputs over a fixed corpus and fails when they change while this string does not.
 */
/**
 * 4.0.0 (ADR-122 FU-1): MAJOR. The invoices source covers a month's P&L and customer figures only
 * when a FULL SALES list establishes it — its declared range spans the month, or, in the current
 * month, reaches into it (revenue to date, `partial_month`). The AR/AP freshness branch that used to
 * hand the P&L to any invoice list committed within 45 days of a month — including lists committed
 * BEFORE it — and to open-items and purchase lists, is gone. Those months stated revenue 0.00 no list
 * established; they now fall through §2.3 to the bank (a cash proxy) or to NULL with
 * `no_source_covers_period`. §6: existing values change, so the first run recomputes every
 * organisation's history. Record: docs/FU-1_ENGINE_REGRESSION_RECORD.md; ADR-122 amendment (FU-1).
 */
/**
 * 5.0.0 (ADR-122 FU-12): MAJOR. The cost-side twin of FU-1. On the INVOICE P&L basis the cost side is
 * stated only where committed FULL PURCHASE lists establish the month, by FU-1's own rules (effective
 * range declared start → min(declared end, commit date); lists that meet combine; the current month to
 * date with `partial_month`; never a month not yet begun — `invoiceCostCoverage`). A sales list alone
 * used to state cost of sales and every expense category 0.00, so gross, operating and net profit
 * equalled revenue and every margin read 100%. Uncovered, every expense-side figure and every figure
 * derived from one (gross / operating / net profit, the margins, contribution) is NULL
 * `no_source_covers_period`, ahead of the no-cost-of-sales-account path; no expense category is
 * written; and on an invoice counterparty basis no supplier spend is written and supplier
 * concentration is NULL. Revenue, the customer side, AR/AP and the ledger / balance / bank bases are
 * unchanged. In the CURRENT month costs are stated only when the purchase lists reach exactly as far
 * as the sales lists (a profit is revenue less costs over the same days). Purchases no list
 * establishes are left out of the whole invoice-basis fold (no income category, no uncategorised
 * share), and an expense category absent from a month whose spending nothing establishes is unknown
 * to the variance pass, never a known zero — on EVERY basis, so a ledger / balance / bank month next
 * to a month no source covers now carries a NULL category variance where it read −100% or a 0.00
 * comparison (`new_in_period`). ADR-126; regression record
 * docs/FU-12_ENGINE_REGRESSION_RECORD.md. §6: existing values change, so the first run recomputes
 * every organisation's history.
 */
/**
 * 6.0.0 (Step 0B: ADR-128 FU-15, ADR-129 FU-9, ADR-130): MAJOR, three existing values change.
 *   - FU-15: a completed month's receivables and payables are stated by an invoice list only when it
 *     knows through the month's last day — min(declared end, commit date), the effective range revenue
 *     and costs already use. A list committed mid-month with the form's default whole-month range used
 *     to state the month-end position VERIFIED (missing everything after the commit); it now falls
 *     through to the balance sheet / ledger, else NULL `stale_invoice_data`. Same range for the DSO
 *     sales history (`fullListSpans`), and for an aged-debtors list's as-at date.
 *   - FU-9: `payables_days` divides a VAT-inclusive balance by a base on the same footing, from recorded
 *     data only — the purchase lists' gross on the invoice basis; a gross expense base otherwise, else
 *     NULL `vat_basis_unknown`. It used to divide gross by net and overstate days by the VAT rate.
 *   - ADR-130: a bank-sourced figure is no firmer than the bank rows under it (commit stamps AI-read rows
 *     `inferred`, unreconciled PDF rows `calculated`); cash and bank-basis P&L / customer figures used to
 *     be badged by source alone. Values unchanged; assurance changes.
 * Regression record: docs/STEP_0B_ENGINE_REGRESSION_RECORD.md.
 */
/**
 * 7.0.0 (Step 0C: ADR-133): MAJOR. 6.0.0 was never released; its hash is kept, and this bump follows
 * the golden test's rule that a recorded version's outputs never change.
 *   - `receivables_days` from a balance divides by revenue only when revenue is gross (`vatFooting`);
 *     the receivable is never netted down by `default_vat_rate` (ADR-027.4's netting withdrawn). Net or
 *     unknown footing: NULL `vat_basis_unknown`.
 *   - Bank-proxy flows the proxy netted by a default rate are `unknown`, not gross, for both days
 *     figures (6.0.0 treated bank costs as always gross).
 */
/**
 * 8.0.0 (Step 0D, ADR-137): MAJOR (assurance only — no value changes). 7.0.0 was never released; its
 * hash is kept.
 *   - A cash balance is no firmer than the anchor that attests it and the rows of every statement the
 *     chain crossed since (`cash-history.ts`). Cash carried out of an AI-read or unreconciled month is
 *     `inferred` / `calculated` in every later month until a verified printed balance that agrees with
 *     the chain attests it again; a balance printed on an AI-read statement anchors as `inferred`.
 *   - `opening_cash` and `closing_cash` take that per-account assurance instead of the period's
 *     statements: an opening no longer takes the weakness of its own month's rows (it does not rest
 *     on them), and a closing attested by a verified printed balance is verified.
 *   - Both carry `rests_on_statements` (the weaker batches) in their components, per account and total.
 */
/**
 * 9.0.0 (Step 0E, ADR-138): MAJOR. 8.0.0 was never released; its hash is kept.
 *   - H-2: a trial balance's or P&L report's P&L is stated from `closing_balance` by §3: as is on a
 *     movement report; closing(P) − closing(P_prev) of the same kind and basis on a cumulative one
 *     (the fiscal year frozen on the batch resets it; no prior report → NULL `no_prior_trial_balance`).
 *     It was a verified 0.00 for every such month (the fold read debit/credit totals no import fills).
 *     Only the winning report kind is read; a kind with no row for P does not cover P; the batch's
 *     confirmed basis is read (it was hard-coded movement). Balance evidence filters by report kind and
 *     is omitted for a cumulative difference (no leaf can total to it, ADR-109).
 *   - H-1: coverage also states `bankEvidenceRatio` (NULL = no cash-like account in scope), which
 *     Health reads instead of the completeness ratio (see HEALTH_CONFIG_VERSION).
 */
/**
 * 10.0.0 (Step 0E corrections after review, ADR-138): MAJOR. 9.0.0 was never released; its hash is kept.
 *   - A cumulative report's month carries `kind: 'difference'` evidence: both periods' records and the
 *     subtraction, or the reason a term is unavailable (9.0.0 wrote no evidence for it).
 *   - An account in one month's cumulative report and not the other's is a zero only when that report
 *     establishes completeness (a trial balance that balances); otherwise NULL `account_absent_unconfirmed`
 *     (9.0.0 inferred zero on both sides).
 *   - A balance batch states a month only where it has rows (per batch, `row_months`); a batch whose
 *     rows are all in other months is unavailable there.
 */
/**
 * 11.0.0 (Step 0F, ADR-139): MAJOR. 10.0.0 was never released; its hash is kept.
 *   - N-1: a trial balance's or P&L report's category with NO line is a zero only when the report is
 *     COMPLETE: the reviewer attested at import that it lists every account (IMP-TB-016) and, for a
 *     trial balance, it balances. Otherwise it is NULL `category_not_in_report` (10.0.0 read it as
 *     0.00, so a cash-only trial balance stated a verified zero revenue). A cumulative month needs both
 *     months complete. An account in one month's report and not the other's needs the same (10.0.0
 *     took a balancing trial balance as complete). Existing imports carry no attestation: incomplete.
 *   - N-1: an incomplete report yields the P&L family to a covering ledger or invoices source (the
 *     whole family, never mixed; warning `balance_report_incomplete`); with only the bank beside it,
 *     the report keeps it with its NULLs. A complete report always keeps it (a stated zero stands).
 *   - N-2: each term of a `difference` evidence query states the total the engine read for it
 *     (`expected`), so each side's records reconcile to their own value and then the formula.
 */
/**
 * 12.0.0 (Step 0F follow-up, ADR-139 amendment): MAJOR. 11.0.0 was never released; its hash is kept
 * with the commit under review (4e3913c).
 *   - A report's completeness is per MONTH: an owner's or admin's attestation for that month, else
 *     the import's answer (IMP-TB-016). An absent category the report was never asked about is NULL
 *     `report_completeness_unconfirmed` (a confirmation is still possible); one it was answered
 *     partial for stays `category_not_in_report`. 11.0.0 gave both the latter.
 *   - Completeness is not accuracy: a report-basis P&L takes the weakest of the report's own record
 *     assurance (and, for a cumulative month, the prior report's). No current import produces a report
 *     weaker than verified (AI reading is refused for anything but bank statements), so no stored
 *     assurance changes; the rule stops an attestation from ever raising one.
 *   - The run fingerprint includes the current attestation per (import, month), so confirming or
 *     correcting one recalculates instead of finishing `no_change`.
 */
/**
 * 13.0.0 (owner decisions R-2, R-3 after the audit of c5a8473): MAJOR. 12.0.0 was never released.
 *   - R-2: a FULL invoice list states receivables or payables only once someone confirmed it holds
 *     every invoice still unpaid at its start (IMP-INV-013, or an owner's attestation). Otherwise the
 *     family falls through §2.3 (balance sheet, trial balance, ledger), else NULL
 *     `opening_invoices_unconfirmed`. An open-items list is unaffected; revenue and costs too.
 *   - R-3: a receivables or payables figure resting on payments with no date is `estimated`, never
 *     `verified`, and its components state the range it could be in (`range_low`/`range_high`, and
 *     the overdue range).
 */
/**
 * 14.0.0 (re-review of 6a551de: NF-1, NF-2, NF-4, NF-6, NF-7; owner decision D-6): MAJOR. 13.0.0 was
 * never released.
 *   - NF-1: the payables expense base is NULL when a category in it is unknown (was read as zero).
 *   - NF-2: a trial balance's absent receivables/payables (or working-capital) line is unknown unless
 *     the trial balance is complete for P; never a 0.00 from a partial or unconfirmed one.
 *   - NF-4: a cumulative month over an incomplete prior report yields to a covering ledger.
 *   - NF-6: reasons `prior_report_not_complete` and `trial_balance_not_balanced`.
 *   - NF-7: P&L figures whose zeros rest on a completeness confirmation carry `zero_by_completeness`.
 *   - D-6 (FU-5): a ledger with no opening journal is anchored by the latest earlier cumulative balance
 *     sheet or trial balance stating the category; evidence `opening_balance + movements`.
 * The golden corpus has none of these shapes, so its hash does not move; the bump is the rule (§6).
 */
/**
 * 15.0.0 (owner decision 2026-10-06): MAJOR. 14.0.0 was never released. Balance sheets are asked
 * whether they list every account (IMP-TB-016); a balance sheet's missing receivables, payables or
 * working-capital line is unknown unless it is confirmed complete for P — NF-2's rule, which 14.0.0
 * applied to trial balances only.
 */
export const ENGINE_VERSION = '15.0.0';

/** Bumped independently of the engine (§6). */
/**
 * health.config.v2 (ADR-134): a dimension resting on `inferred` (AI-read) figures takes the existing
 * cap of 70 with its own reason, as `estimated` ones did. Scores that rested on AI-read cash can fall.
 */
/**
 * health.config.v3 (Step 0E, H-1): banking_health is excluded (`no_bank_coverage`) when no cash-like
 * account is in scope; it used to score 60 with B4 "full coverage", from the completeness ratio of 1.
 * Weights, thresholds and caps are unchanged; the cap of 70 for AI-read inputs still awaits approval.
 */
/**
 * health.config.v4 (audit H-3): the ADR-134 / ADR-035 cap looks at every figure a dimension's rules
 * scored — earlier months a trend rule read included — not only at its required metrics. Banking
 * health, which has no required metric, can now be capped (B1's closings, B2's flows), and cash
 * flow's C3 sees earlier months' movement. Weights and thresholds unchanged; the cap of 70 still
 * awaits approval (D-2).
 */
export const HEALTH_CONFIG_VERSION = 'health.config.v4';
/**
 * alerts.rules.v2 (Step 0F, N-5): an expense spike on a trial-balance or P&L-report basis cites the
 * report lines its figure was read from (both year-to-date sides for a cumulative month), not ledger
 * entries the figure never read. Conditions and thresholds are unchanged.
 */
// Also in v2 (unreleased): audit R-4 — the consecutive cash-decline trigger is worded as net outflow
// for N months, not as a falling balance (a joining account can raise the balance meanwhile).
export const ALERT_RULE_VERSION = 'alerts.rules.v2';

/** At most this many consecutive months per chunk (§2.4). */
export const CHUNK_PERIODS = 12;

/** Comparison inputs read back this far before the first affected period (§2.4 step 2). */
export const COMPARISON_LOOKBACK_MONTHS = 12;
