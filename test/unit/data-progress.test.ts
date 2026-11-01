import { describe, expect, it } from 'vitest';
/* Relative import: `motion/no-deep-module-import` refuses `@/modules/<m>/domain/...`, and the barrel imports `server-only`. */
import {
  batchPipeline, complianceCard, coverageByMonth, headlineStatus, markGaps, missingMonths, monthKeys, monthList,
  orderBlockers, shortDate, sourceOf, type Blocker, type PipelineInput,
} from '../../src/modules/departments/domain/data-progress';

/** Data progress and the Compliance View card (owner, 2026-11-02). */

const input = (status: string, extra: Partial<PipelineInput> = {}): PipelineInput => ({
  status, committedAt: null, errorStage: null, recalculatedAt: null, recalculating: false, runFailedSinceCommit: false, ...extra,
});
const states = (status: string, extra: Partial<PipelineInput> = {}) => batchPipeline(input(status, extra)).steps.map((s) => s.state);

describe('an upload’s place in the pipeline', () => {
  it('follows import_batches.status step by step', () => {
    expect(states('parsing')).toEqual(['done', 'current', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(states('mapping')).toEqual(['done', 'done', 'current', 'todo', 'todo', 'todo', 'todo']);
    expect(states('validating')).toEqual(['done', 'done', 'done', 'current', 'todo', 'todo', 'todo']);
    const review = batchPipeline(input('awaiting_review'));
    expect(review.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'waiting', 'todo', 'todo']);
    expect([review.summary, review.needsYou]).toEqual(['Needs your review', true]);
    expect(states('committing')).toEqual(['done', 'done', 'done', 'done', 'done', 'current', 'todo']);
  });

  it('is in the figures only once a successful calculation finished after the commit', () => {
    const committedAt = '2026-10-29T10:00:00Z';
    expect(batchPipeline(input('committed', { committedAt, recalculatedAt: '2026-10-29T10:05:00Z' })).summary).toBe('In your figures');
    expect(states('committed', { committedAt, recalculatedAt: '2026-10-29T10:05:00Z' }).every((s) => s === 'done')).toBe(true);
    expect(batchPipeline(input('committed', { committedAt, recalculatedAt: '2026-10-28T09:00:00Z' })).steps[6]!.state).toBe('waiting');
    expect(batchPipeline(input('committed', { committedAt, recalculating: true })).steps[6]!.state).toBe('current');
    expect(batchPipeline(input('committed', { committedAt, runFailedSinceCommit: true })).steps[6]!.state).toBe('failed');
  });

  it('a failed upload stops where it failed and needs you; a removed or discarded one does not', () => {
    const failed = batchPipeline(input('failed', { errorStage: 'mapping' }));
    expect(failed.steps.map((s) => s.state)).toEqual(['done', 'done', 'failed', 'todo', 'todo', 'todo', 'todo']);
    expect([failed.summary, failed.needsYou]).toEqual(['Stopped at “Columns matched”', true]);
    expect(batchPipeline(input('failed', { errorStage: 'parsing' })).summary).toBe('Could not be read');
    expect(batchPipeline(input('rolled_back')).steps[6]!.state).toBe('stopped');
    expect(batchPipeline(input('rejected')).steps[4]!.state).toBe('stopped');
    expect(batchPipeline(input('rejected')).needsYou).toBe(false);
  });
});

describe('month coverage', () => {
  const months = monthKeys('2026-09', 4);
  it('counts the declared range, whole and part months', () => {
    expect(months).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
    expect(coverageByMonth([{ start: '2026-06-01', end: '2026-07-15' }, { start: '2026-07-16', end: '2026-07-31' }], months))
      .toEqual(['full', 'full', 'none', 'none']);
    expect(coverageByMonth([{ start: '2026-09-01', end: '2026-09-14' }], months)).toEqual(['none', 'none', 'none', 'partial']);
  });
  it('finds the missing months and marks gaps only inside the covered range', () => {
    const ranges = [{ start: '2026-06-01', end: '2026-07-31' }, { start: '2026-09-01', end: '2026-09-30' }];
    expect(missingMonths(ranges, '2026-06', '2026-09')).toEqual(['2026-08']);
    const cells = coverageByMonth(ranges, ['2026-05', ...months]);
    expect(markGaps(cells, ['2026-05', ...months], '2026-09')).toEqual(['none', 'full', 'full', 'gap', 'full']);
    expect(markGaps(['full', 'none', 'none'], ['2026-08', '2026-09', '2026-10'], '2026-09')).toEqual(['full', 'gap', 'none']);
  });
  it('names months in words', () => {
    expect(monthList(['2026-08'])).toBe('Aug 2026');
    expect(monthList(['2026-06', '2026-08'])).toBe('Jun and Aug 2026');
    expect(monthList(['2025-12', '2026-01'])).toBe('Dec 2025 and Jan 2026');
    expect(monthList(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'])).toBe('Jan 2026, Feb 2026, Mar 2026, Apr 2026 and 2 more');
  });
});

describe('what we are stuck on', () => {
  const b = (kind: Blocker['kind'], at: string | null = null): Blocker => ({ kind, sentence: kind, detail: null, action: null, needsYou: true, at });
  it('orders blockers: a failed calculation, failed uploads, reviews, then each source, then tax', () => {
    const ordered = orderBlockers([b('ct_unknown'), b('awaiting_review', '2026-10-01'), b('month_gap'), b('awaiting_review', '2026-10-20'), b('upload_failed'), b('run_failed'), b('vat_setup')]);
    expect(ordered.map((x) => `${x.kind}${x.at ? `@${x.at}` : ''}`)).toEqual([
      'run_failed', 'upload_failed', 'awaiting_review@2026-10-20', 'awaiting_review@2026-10-01', 'month_gap', 'vat_setup', 'ct_unknown',
    ]);
  });
  it('the headline: a failed run first, then updating, then what needs you', () => {
    expect(headlineStatus({ recalculating: false, lastRunFailed: true, needsYou: 3 }).title).toBe('Last update failed');
    expect(headlineStatus({ recalculating: true, lastRunFailed: true, needsYou: 0 }).title).toBe('Updating your numbers');
    expect(headlineStatus({ recalculating: false, lastRunFailed: false, needsYou: 1 }).title).toBe('1 thing needs you');
    expect(headlineStatus({ recalculating: false, lastRunFailed: false, needsYou: 2 }).title).toBe('2 things need you');
    expect(headlineStatus({ recalculating: false, lastRunFailed: false, needsYou: 0 }).title).toBe('Up to date');
    expect(headlineStatus({ recalculating: false, lastRunFailed: false, needsYou: 0, waitingForUpdate: 2 }).line).toContain('2 uploads go');
  });
  it('sorts every import type into its source', () => {
    expect(['bank_statement', 'trial_balance', 'sales_invoices', 'purchase_invoices', 'balance_sheet', 'budget', 'other'].map(sourceOf))
      .toEqual(['bank', 'accounts', 'sales', 'purchases', 'balance_sheet', 'budget', null]);
  });
});

describe('the Compliance View card', () => {
  const facts = {
    base: '/app/acme', recalculating: false, basisLine: 'Based on your bank statements · Sep 2026 (latest complete month)',
    imports: { awaitingReview: 0, failed: 0 }, lastDataAdded: '2026-10-29T08:00:00Z', canAddData: true,
    tax: { vatRegistered: null, vatQuarter: null, corporationTax: { dueDate: '2027-10-01' } }, today: '2026-11-02',
  };
  it('shows the older Home’s four lines and opens Data progress', () => {
    const card = complianceCard(facts);
    expect(card.status).toBe('Figures up to date');
    expect(card.rows.map((r) => [r.title, r.value, r.attention])).toEqual([
      ['Uploads waiting for review', '0', false], ['Last data added', '29 Oct 2026', false],
      ['VAT', 'Not set up', false], ['Corporation Tax', 'Due 1 Oct 2027', false],
    ]);
    expect(card.progressHref).toBe('/app/acme/data/progress');
  });
  it('words VAT and attention as before, and leaves out what the reader may not see', () => {
    const vat = complianceCard({ ...facts, tax: { vatRegistered: true, vatQuarter: { end: '2026-12-31' }, corporationTax: null } });
    expect(vat.rows.slice(2).map((r) => r.value)).toEqual(['Quarter ends 31 Dec 2026', 'No date yet']);
    expect(complianceCard({ ...facts, tax: { vatRegistered: true, vatQuarter: null, corporationTax: null } }).rows[2]!.value).toBe('Set your quarter months');
    const busy = complianceCard({ ...facts, recalculating: true, imports: { awaitingReview: 2, failed: 1 } });
    expect([busy.status, busy.rows[0]!.value, busy.rows[0]!.attention]).toEqual(['Updating your numbers', '2 · 1 failed', true]);
    const client = complianceCard({ ...facts, imports: null, tax: null });
    expect([client.rows.length, client.progressHref]).toEqual([0, null]);
  });
  it('dates as the rest of APX writes them', () => {
    expect(shortDate('2026-10-29T23:30:00Z')).toBe('29 Oct 2026');
    expect(shortDate('2027-10-01')).toBe('1 Oct 2027');
    expect(shortDate(null)).toBe('—');
  });
});
