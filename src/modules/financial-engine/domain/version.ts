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
export const ENGINE_VERSION = '7.0.0';

/** Bumped independently of the engine (§6). */
/**
 * health.config.v2 (ADR-134): a dimension resting on `inferred` (AI-read) figures takes the existing
 * cap of 70 with its own reason, as `estimated` ones did. Scores that rested on AI-read cash can fall.
 */
export const HEALTH_CONFIG_VERSION = 'health.config.v2';
export const ALERT_RULE_VERSION = 'alerts.rules.v1';

/** At most this many consecutive months per chunk (§2.4). */
export const CHUNK_PERIODS = 12;

/** Comparison inputs read back this far before the first affected period (§2.4 step 2). */
export const COMPARISON_LOOKBACK_MONTHS = 12;
