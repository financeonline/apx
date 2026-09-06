/**
 * `duplicate.transaction` (FINANCIAL_ENGINE.md §8.2), one of the conditions health rule B3 counts.
 *
 * Two ways a duplicate is found. An EXACT match shares a `dedupe_hash` — the same identity the
 * import engine computes, so the alert engine and the importer can never disagree about what "the
 * same transaction" means. A FUZZY match is the case the hash misses: the same money to the same
 * payee a day apart, entered twice with different references.
 *
 * A pair where either row carries `duplicate_reviewed = true` is skipped (§8.1, ADR-029.6). Somebody
 * has already looked and said these are two genuine payments; re-raising it every month would teach
 * them to ignore the rule.
 *
 * Pure.
 */

import { Decimal, tryParseDecimal, toMoneyString } from '@/core/money';
import { valueOf, type RuleContext } from '../context';
import { minAbsThreshold } from '../suppression';
import type { AlertSubject, RecordObservation, RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const DUPLICATE_MIN_AMOUNT = new Decimal('50');
export const DUPLICATE_CRITICAL_AMOUNT = new Decimal('5000');
export const DUPLICATE_CRITICAL_OUTFLOW_SHARE = new Decimal('0.05');
/** Fuzzy matches must be within this many days of each other (§8.2). */
export const DUPLICATE_MAX_DAY_GAP = 1;

function daysBetween(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86_400_000;
}

/**
 * Average monthly outflows over the trailing complete months (§8.1, ADR-047.6).
 *
 * The partial current month is excluded deliberately: on the 3rd of the month it would be a third
 * of its eventual size, and every payment that day would look like a large share of it.
 */
export function monthlyOutflows(ctx: RuleContext): Decimal | null {
  const periods = ctx.trailingCompletePeriodIds.slice(-3);
  const values = periods
    .map((periodId) => valueOf(ctx.snapshots, periodId, 'cash_outflows'))
    .filter((v): v is Decimal => v !== null);
  if (values.length === 0) return null;
  return values.reduce((total, v) => total.plus(v.abs()), new Decimal(0)).dividedBy(values.length);
}

function subjectFor(record: RecordObservation): AlertSubject {
  /*
   * The subject enum has `bank_transaction` but no `ledger_entry` (DATABASE_ARCHITECTURE.md §6),
   * while §8.2 names both. A ledger duplicate is therefore recorded with no subject and its rows
   * pinned in `recordIds`, rather than mislabelled as a bank transaction it is not (ADR-054.4).
   */
  return record.table === 'bank_transactions'
    ? { type: 'bank_transaction', id: record.id, key: null }
    : { type: 'none', id: null, key: null };
}

interface Pair {
  readonly left: RecordObservation;
  readonly right: RecordObservation;
  readonly kind: 'exact' | 'fuzzy';
}

/** Deterministic pair identity, so the same two rows are never reported twice in one period. */
function pairId(a: RecordObservation, b: RecordObservation): string {
  return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
}

export function evaluateDuplicateTransaction(ctx: RuleContext): readonly RuleOutcome[] {
  const revenue = valueOf(ctx.snapshots, ctx.periodId, 'revenue');
  const floor = minAbsThreshold(revenue);
  const outflows = monthlyOutflows(ctx);

  const candidates = [...ctx.records]
    .filter((r) => !r.duplicateReviewed)
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));

  const seen = new Set<string>();
  const pairs: Pair[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const left = candidates[i]!;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const right = candidates[j]!;
      if (left.table !== right.table) continue;
      if (left.id === right.id) continue;

      const exact = left.dedupeHash !== null && left.dedupeHash === right.dedupeHash;

      const leftAmount = tryParseDecimal(left.amount);
      const rightAmount = tryParseDecimal(right.amount);
      const sameAmount = leftAmount !== null && rightAmount !== null
        && leftAmount.abs().equals(rightAmount.abs());
      const sameSignature = left.descriptionNormalized !== null
        && left.descriptionNormalized === right.descriptionNormalized;
      const fuzzy = sameAmount && sameSignature
        && daysBetween(left.date, right.date) <= DUPLICATE_MAX_DAY_GAP;

      if (!exact && !fuzzy) continue;

      const id = pairId(left, right);
      if (seen.has(id)) continue;
      seen.add(id);
      pairs.push({ left, right, kind: exact ? 'exact' : 'fuzzy' });
    }
  }

  const outcomes: RuleOutcome[] = [];

  for (const pair of pairs) {
    const amount = tryParseDecimal(pair.left.amount)?.abs() ?? null;
    if (amount === null) continue;
    if (amount.lessThan(DUPLICATE_MIN_AMOUNT)) continue;
    if (amount.lessThan(floor)) continue;

    const isCritical = amount.greaterThanOrEqualTo(DUPLICATE_CRITICAL_AMOUNT)
      || (outflows !== null && outflows.greaterThan(0)
        && amount.dividedBy(outflows).greaterThanOrEqualTo(DUPLICATE_CRITICAL_OUTFLOW_SHARE));

    outcomes.push({
      ruleKey: 'duplicate.transaction',
      severity: isCritical ? 'critical' : 'high',
      subject: subjectFor(pair.left),
      periodId: ctx.periodId,
      thresholdSummary: {
        amount: toMoneyString(amount),
        match_kind: pair.kind,
        signature: pair.left.descriptionNormalized,
        first_date: pair.left.date,
        second_date: pair.right.date,
        record_table: pair.left.table,
        monthly_outflows: outflows === null ? null : toMoneyString(outflows),
      },
      snapshotIds: [],
      recordIds: [pair.left.id, pair.right.id],
      // §8.2 pins both records, and nothing else: the whole finding is that these two rows exist.
      evidence: [pair.left, pair.right].map((r) => ({
        itemType: r.table === 'invoices' ? 'invoice' as const
          : r.table === 'ledger_entries' ? 'ledger_entry' as const
          : 'bank_transaction' as const,
        refId: r.id,
        queryDescriptor: null,
        label: `${r.descriptionNormalized ?? 'Transaction'} on ${r.date}`,
        claim: 'One of the two payments that look like duplicates',
        assuranceLevel: 'verified' as const,
      })),
    });
  }

  return outcomes;
}
