import { describe, expect, it } from 'vitest';
import { allowedSet, entryAt, numeric, type ToolResult } from '@/modules/ai';

/**
 * The grounding allowed set (AI_ARCHITECTURE.md §7.1).
 *
 * The property under test is the one v1 got wrong and was withdrawn for (F-C-01, F-C-09): a number
 * is groundable if and only if a TOOL published it as a branded numeric field. Everything else —
 * a figure inside a transaction description, an alert sentence, an error hint, a customer's name —
 * is prose, and prose is not evidence.
 */

const metricResult: ToolResult = {
  seq: 1,
  name: 'get_metric',
  ok: true,
  data: {
    metric_key: 'revenue',
    period: { id: 'p-march', label: 'March 2026' },
    value: numeric('120000.00', '£120,000', 'money'),
    snapshot_id: 's-revenue-march',
    variance: {
      prev_period: {
        value: numeric('-3000.00', '-£3,000', 'money'),
        pct_change: numeric('-0.024', '-2.4%', 'ratio'),
        comparison_period: { id: 'p-february', label: 'February 2026' },
        snapshot_id: 's-revenue-february',
      },
    },
  },
  meta: { periods: [{ id: 'p-march', label: 'March 2026' }], calculation_run_id: 'run-1' },
};

describe('only branded fields enter the set', () => {
  it('collects the numbers a tool published, and nothing else', () => {
    const entries = allowedSet([metricResult]);
    expect(entries.map((e) => e.path).sort()).toEqual([
      'value', 'variance.prev_period.pct_change', 'variance.prev_period.value',
    ]);
  });

  it('ignores every number that is only text (F-C-09)', () => {
    const prose: ToolResult = {
      seq: 2,
      name: 'get_transactions_for_evidence',
      ok: true,
      data: {
        records: [{
          type: 'bank_transaction',
          id: 'txn-1',
          // Every one of these carries a number a v1 check would have matched against.
          description: 'REFUND 4,800 REF 2026/114',
          counterparty: { id: 'cp-1', name: 'Beta 12% Ltd' },
          amount: numeric('4800.00', '£4,800', 'money'),
        }],
        note: 'Excludes 3 transfers.',
      },
    };
    const paths = allowedSet([prose]).map((e) => e.path);
    expect(paths, 'the amount, and only the amount').toEqual(['records[0].amount']);
  });

  it('ignores a failed call entirely — its hint is prose too', () => {
    const failed: ToolResult = {
      seq: 3, name: 'get_metric', ok: false,
      data: { error: { code: 'NO_DATA', message: 'No data for 2026-04', hint: 'Try 2026-03' } },
    };
    expect(allowedSet([failed])).toEqual([]);
  });
});

describe('each entry carries what the rest of §7 binds against', () => {
  it('the metric, the period and the snapshot the number came from', () => {
    const entry = entryAt(allowedSet([metricResult]), 1, 'value')!;
    expect(entry.metricKey).toBe('revenue');
    expect(entry.periodIds).toEqual(['p-march']);
    expect(entry.derivedEvidenceId, '§7.6 derives the id from the ROW, not from the model')
      .toBe('s-revenue-march');
    expect(entry.derivedEvidenceType).toBe('metric_snapshot');
  });

  it('the display precision a tolerance is read from (§7.3)', () => {
    const entries = allowedSet([metricResult]);
    expect(entryAt(entries, 1, 'value')!.displayPrecision, '£120,000 commits to whole pounds').toBe(0);
    expect(entryAt(entries, 1, 'variance.prev_period.pct_change')!.displayPrecision).toBe(1);
  });

  /*
   * The level/change distinction decides how a sign is read (§7.5): a change takes its sign from
   * the direction word beside it, a level must match literally. Getting it wrong turns "profit fell
   * £3,000" into a claim about a level of −£3,000 that no tool ever returned.
   */
  it('whether the field is a level or a change (§7.1)', () => {
    const entries = allowedSet([metricResult]);
    expect(entryAt(entries, 1, 'value')!.fieldKind).toBe('level');
    expect(entryAt(entries, 1, 'variance.prev_period.value')!.fieldKind).toBe('change');
    expect(entryAt(entries, 1, 'variance.prev_period.pct_change')!.fieldKind).toBe('change');
  });

  it('a nested variance row keeps its OWN snapshot, not its parent’s', () => {
    const entry = entryAt(allowedSet([metricResult]), 1, 'variance.prev_period.value')!;
    expect(entry.derivedEvidenceId).toBe('s-revenue-february');
  });

  it('the entity a row is about, from its subject (ADR-045.3)', () => {
    const ranked: ToolResult = {
      seq: 1, name: 'get_customer_profitability', ok: true,
      data: {
        rows: [
          {
            subject: { type: 'counterparty', id: 'cp-acme', name: 'Acme Trading Ltd' },
            revenue: numeric('52000.00', '£52,000', 'money'),
            snapshot_id: 's-acme',
          },
          {
            subject: { type: 'counterparty', id: 'cp-beta', name: 'Beta 12% Ltd' },
            revenue: numeric('48000.00', '£48,000', 'money'),
            snapshot_id: 's-beta',
          },
        ],
      },
      meta: { periods: [{ id: 'p-march', label: 'March 2026' }] },
    };
    const entries = allowedSet([ranked]);
    // Each row's number is bound to its own customer — which is what makes the swapped-entity trap
    // (§7.5, R2-C-03) decidable at all.
    expect(entryAt(entries, 1, 'rows[0].revenue')!.rowEntityIds).toEqual(['cp-acme']);
    expect(entryAt(entries, 1, 'rows[1].revenue')!.rowEntityIds).toEqual(['cp-beta']);
    expect(entryAt(entries, 1, 'rows[1].revenue')!.derivedEvidenceId).toBe('s-beta');
  });

  it('an alert row derives its pinned revision, not just its id (§2.2)', () => {
    const alerts: ToolResult = {
      seq: 1, name: 'get_alerts', ok: true,
      data: {
        alerts: [{
          id: 'alert-1', revision_no: 3, rule_key: 'customer_concentration',
          explanation: 'Acme is 41% of revenue.',
          threshold_summary: { share: numeric('0.41', '41%', 'ratio') },
        }],
      },
    };
    const entry = entryAt(allowedSet([alerts]), 1, 'alerts[0].threshold_summary.share')!;
    expect(entry.derivedEvidenceType).toBe('alert');
    expect(entry.derivedRevisionNo).toBe(3);
  });

  it('falls back to meta for a figure the row does not place in a period', () => {
    const entry = entryAt(allowedSet([metricResult]), 1, 'value')!;
    expect(entry.periodIds).toEqual(['p-march']);
  });
});
