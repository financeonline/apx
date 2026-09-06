/**
 * `deviation.large_transaction` (FINANCIAL_ENGINE.md §8.2).
 *
 * The ledger-side counterpart of `bank.unusual_transaction`: an entry or invoice far larger than the
 * account it was coded to usually sees. The two rules deliberately do not overlap — §8.2 scopes this
 * one to the ledger/TB basis and says "the bank rule above covers bank basis" — because otherwise
 * one payment that appears in both a bank statement and a ledger would raise two alerts saying the
 * same thing in different words.
 *
 * "Usual" is the account's own median over the trailing months, not a fixed number: £5,000 is
 * unremarkable for payroll and extraordinary for stationery.
 *
 * Pure.
 */

import { Decimal, toMoneyString, toRatioString, tryParseDecimal } from '@/core/money';
import { median, queryPin, valueOf, type RuleContext } from '../context';
import { minAbsThreshold } from '../suppression';
import { NO_SUBJECT, type EvidencePin, type RecordObservation, type RuleOutcome } from '../types';

/** Defaults, CD-18. */
export const DEVIATION_MULTIPLE = new Decimal('3');
export const DEVIATION_FLOOR = new Decimal('1000');

/** The ledger and invoice tables only; the bank rule covers bank rows (§8.2). */
const LEDGER_TABLES: readonly RecordObservation['table'][] = ['ledger_entries', 'invoices'];

function magnitude(record: RecordObservation): Decimal | null {
  const amount = tryParseDecimal(record.amount);
  return amount === null ? null : amount.abs();
}

/** Median |amount| per account over the trailing complete months (§8.1, §8.2). */
export function accountMedians(ctx: RuleContext): Map<string, Decimal> {
  const byAccount = new Map<string, Decimal[]>();
  for (const record of ctx.trailingRecords) {
    if (!LEDGER_TABLES.includes(record.table)) continue;
    const accountId = record.accountId ?? null;
    if (accountId === null) continue;
    const amount = magnitude(record);
    if (amount === null || amount.isZero()) continue;
    const list = byAccount.get(accountId) ?? [];
    list.push(amount);
    byAccount.set(accountId, list);
  }

  const out = new Map<string, Decimal>();
  for (const [accountId, amounts] of byAccount) {
    const centre = median(amounts);
    if (centre !== null && centre.greaterThan(0)) out.set(accountId, centre);
  }
  return out;
}

export function evaluateLargeTransactionDeviation(ctx: RuleContext): readonly RuleOutcome[] {
  const medians = accountMedians(ctx);
  const floor = minAbsThreshold(valueOf(ctx.snapshots, ctx.periodId, 'revenue'));
  const accountsById = new Map(ctx.accounts.map((a) => [a.id, a]));

  const outcomes: RuleOutcome[] = [];

  const candidates = [...ctx.records]
    .filter((r) => LEDGER_TABLES.includes(r.table) && (r.accountId ?? null) !== null)
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));

  for (const record of candidates) {
    const amount = magnitude(record);
    if (amount === null) continue;
    // Both floors: §8.2's flat £1,000 and §8.1's revenue-relative minimum.
    if (amount.lessThan(DEVIATION_FLOOR)) continue;
    if (amount.lessThan(floor)) continue;

    const centre = medians.get(record.accountId!);
    // No history for the account is not "unusual" — it is "we have never seen this account before",
    // which is a different statement and not one this rule is entitled to make.
    if (centre === undefined) continue;
    if (amount.lessThan(centre.times(DEVIATION_MULTIPLE))) continue;

    const account = accountsById.get(record.accountId!);
    const evidence: EvidencePin[] = [{
      itemType: record.table === 'invoices' ? 'invoice' : 'ledger_entry',
      refId: record.id,
      queryDescriptor: null,
      label: record.descriptionNormalized ?? 'The transaction',
      claim: 'The transaction this alert is about',
      assuranceLevel: 'verified',
    },
    ...queryPin(ctx, 'ledger_entries', {
      account_ids: [record.accountId!],
    }, {
      label: `Other entries on ${account?.name ?? 'this account'}`,
      claim: 'What this account usually sees',
      order: [{ field: 'amount', dir: 'desc' }],
      limit: 10,
    })];
    if (account !== undefined) {
      evidence.push({
        itemType: 'account',
        refId: account.id,
        queryDescriptor: null,
        label: account.name,
        claim: 'The account the transaction was coded to',
        assuranceLevel: 'verified',
      });
    }

    outcomes.push({
      ruleKey: 'deviation.large_transaction',
      severity: 'medium',
      /*
       * §8.2 names the subject as `ledger_entry` or `invoice`, and `alert_subject_enum` has neither
       * (ADR-054.4). The record is pinned instead, so nothing is lost but the label.
       */
      subject: NO_SUBJECT,
      periodId: ctx.periodId,
      metricKey: 'expense_by_account',
      thresholdSummary: {
        description: record.descriptionNormalized,
        amount: toMoneyString(amount),
        account: account?.name ?? null,
        account_median: toMoneyString(centre),
        multiple: toRatioString(amount.dividedBy(centre)),
        threshold_multiple: DEVIATION_MULTIPLE.toString(),
        threshold_floor: toMoneyString(DEVIATION_FLOOR),
        record_table: record.table,
        date: record.date,
      },
      snapshotIds: [],
      recordIds: [record.id],
      evidence,
    });
  }

  return outcomes;
}
