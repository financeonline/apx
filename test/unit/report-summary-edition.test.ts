import { describe, expect, it } from 'vitest';
import type { MetricCardView } from '@/modules/dashboard';
import type { DimensionBreakdown, HealthCardView } from '@/modules/health';
import {
  SUMMARY_EDITION_TITLE, composeSummaryEdition, renderSummaryPdf, summaryEditionNotice,
  type SummaryEditionSources,
} from '@/modules/reporting';
import { tokenisePdf } from '../../src/modules/imports/domain/parsers/pdf-text';

/**
 * The Monthly Management Report's summary edition — the pure half (ADR-172 addendum).
 *
 * The edition is an ALLOW-LIST: whatever the sources carry beyond the fields it names — a card's
 * evidence link, a breakdown's metrics, rules, conditions (whose subjects name suppliers), snapshot
 * ids, a free-text cap reason — does not reach the view or the PDF. These tests put named detail in
 * every place it could hide in the inputs and assert it is absent from the output, and that the
 * figures and the score are present. The integration suite (`report-summary-edition`) does the same
 * against the database, through the reader's own client.
 */

const PERIOD = { id: '11111111-1111-4111-8111-111111111111', label: 'May 2026', periodStart: '2026-05-01', periodEnd: '2026-05-31', isComplete: true };

const SECRET = {
  supplier: 'Zephyr Haulage Ltd',
  subjectKey: 'fps credit zephyr haulage inv',
  snapshot: '22222222-2222-4222-8222-222222222222',
  record: '33333333-3333-4333-8333-333333333333',
  capText: 'because Zephyr Haulage Ltd paid late',
};

function card(metricKey: string, label: string, value: string, change: string | null): MetricCardView {
  return {
    metricKey, label, technicalLabel: label, value, rawValue: '1.00',
    secondaryLine: null,
    change: change === null ? null : {
      text: change, amount: '+£1', percent: null, favourable: true, basisDiffers: false, comparisonLabel: 'April 2026',
    },
    status: { kind: 'none', label: null, tooltip: 'From your records' },
    basisText: 'From your accounts',
    period: PERIOD,
    whyHref: `/app/acme/evidence?metric=${metricKey}&period=${PERIOD.id}`,
  };
}

function dimension(over: Partial<DimensionBreakdown> & Pick<DimensionBreakdown, 'key'>): DimensionBreakdown {
  return {
    score: 70, weight_config: 20, weight_applied: 20, included: true, exclusion_reason: null,
    metrics: [{ metric_key: 'closing_cash', value: '-30.00', snapshot_id: SECRET.snapshot }] as unknown as DimensionBreakdown['metrics'],
    rules: [{ rule: 'B1', result: 'rising', points: 10, value: '3', skipped_reason: null }] as unknown as DimensionBreakdown['rules'],
    conditions: [{
      rule_key: 'recurring.amount_changed', subject_id: SECRET.record, subject_key: SECRET.subjectKey,
      snapshot_ids: [SECRET.snapshot], record_ids: [SECRET.record],
    }] as unknown as DimensionBreakdown['conditions'],
    capped: false, cap_reason: null,
    positives: ['The bank balance has risen for three months'],
    negatives: [],
    positives_structured: [], negatives_structured: [],
    data_quality: { completeness: 1, warnings: [] },
    ...over,
  };
}

function health(over: Partial<HealthCardView> = {}): HealthCardView {
  return {
    periodId: PERIOD.id, score: 68, band: 'stable', changeVsPrevious: 3, dimensionsUsed: 3, dimensionsTotal: 4,
    capped: true, configVersion: 'health.config.v5',
    breakdown: [
      dimension({ key: 'banking_health' }),
      dimension({ key: 'cash_flow', score: 60, capped: true, cap_reason: 'based on bank data only', negatives: ['Cash fell for 2 months in a row'] }),
      dimension({ key: 'cost_control', score: 55, capped: true, cap_reason: SECRET.capText }),
      dimension({ key: 'customer_quality', score: null, included: false, exclusion_reason: 'required_metric_missing', positives: ['must not print'] }),
    ],
    updatedAt: '2026-06-02T10:00:00Z', evidenceBundleId: SECRET.snapshot,
    ...over,
  };
}

function sources(over: Partial<SummaryEditionSources> = {}): SummaryEditionSources {
  return {
    organisationName: 'Acme Widgets Ltd',
    period: PERIOD,
    comparisonLabel: 'April 2026',
    cards: [
      card('revenue', 'Sales', '£40,000', '+£2,100 (+5.5%) vs April 2026'),
      card('closing_cash', 'Cash at the end of the month', '£12,345', null),
    ],
    health: health(),
    summary: 'May 2026: health score 68.',
    basisLine: 'Based on your accounts · May 2026 (latest complete month)',
    asOf: { engineVersion: '9.9.9', finishedAt: '2026-06-01T09:00:00Z' },
    generatedAt: '2026-06-15T00:00:00.000Z',
    ...over,
  };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const tokens = await tokenisePdf(bytes);
  return tokens.pages.flatMap((page) => page.lines.map((line) => line.text)).join('\n').replace(/\s+/g, ' ');
}

describe('composeSummaryEdition: an allow-list of the overview', () => {
  it('says which edition it is, for whom, and what is left out', () => {
    const view = composeSummaryEdition(sources());
    expect(view.edition).toBe('summary');
    expect(view.title).toBe(SUMMARY_EDITION_TITLE);
    expect(view.notice).toBe('Summary edition for external readers: figures and Business Health Score only');
    expect(summaryEditionNotice('3rd parties')).toBe('Summary edition for 3rd parties: figures and Business Health Score only');
    expect(view.leftOut).toMatch(/Alerts, open actions and the names of customers, suppliers and bank accounts/);
  });

  it('keeps each figure as the reader takes it, and drops its evidence link and raw value', () => {
    const view = composeSummaryEdition(sources());
    expect(view.figures).toEqual([
      { metricKey: 'revenue', label: 'Sales', value: '£40,000', secondary: null, change: '+£2,100 (+5.5%) vs April 2026', status: null },
      { metricKey: 'closing_cash', label: 'Cash at the end of the month', value: '£12,345', secondary: null, change: null, status: null },
    ]);
    expect(JSON.stringify(view)).not.toContain('/evidence?');
  });

  it('reduces the health breakdown to labels, scores and the engine\'s sentences — no metrics, rules, conditions or ids', () => {
    const view = composeSummaryEdition(sources());
    const json = JSON.stringify(view);
    for (const secret of [SECRET.supplier, SECRET.subjectKey, SECRET.snapshot, SECRET.record, SECRET.capText, 'recurring.amount_changed', '"B1"']) {
      expect(json, `${secret} must not reach the summary edition`).not.toContain(secret);
    }
    expect(view.health).toMatchObject({
      score: 68, bandKey: 'stable', band: 'Stable', changeVsPrevious: 3, changeText: '+3 vs April 2026',
      dimensionsUsed: 3, dimensionsTotal: 4,
    });
    expect(view.health!.areas.map((a) => [a.label, a.score, a.note])).toEqual([
      ['Banking', 70, null],
      ['Cash', 60, 'Capped: based on bank data only.'],
      // A cap reason that is not one of the engine's fixed notes is not printed.
      ['Costs', 55, 'Capped.'],
      ['Customers', null, 'Not scored — we do not have the figures this needs yet.'],
    ]);
    expect(view.health!.areas[0]!.helped).toEqual(['The bank balance has risen for three months']);
    expect(view.health!.areas[1]!.heldBack).toEqual(['Cash fell for 2 months in a row']);
    // An area that was not scored has no factor sentences to explain a score it does not have.
    expect(view.health!.areas[3]!.helped).toEqual([]);
    expect(view.health!.disclaimer).toMatch(/not a credit rating/);
  });

  it('says "no comparison" rather than a movement when there is none, and a fall with its sign', () => {
    expect(composeSummaryEdition(sources({ health: health({ changeVsPrevious: null }) })).health!.changeText).toBeNull();
    expect(composeSummaryEdition(sources({ health: health({ changeVsPrevious: -2 }) })).health!.changeText).toBe('-2 vs April 2026');
    expect(composeSummaryEdition(sources({ health: null })).health).toBeNull();
  });

  it('has nowhere to put an alert or an action, even if a caller tries', () => {
    const smuggled = {
      ...sources(),
      alerts: [{ title: 'One customer is 41% of revenue', explanation: 'Acme Trading Ltd is 41% of revenue this month.' }],
      openActions: [{ title: 'Chase Acme Trading Ltd for the March invoice' }],
    };
    const json = JSON.stringify(composeSummaryEdition(smuggled));
    expect(json).not.toContain('Acme Trading Ltd');
    expect(json).not.toContain('Chase');
    expect(Object.keys(composeSummaryEdition(smuggled)).sort()).toEqual([
      'asOf', 'basisLine', 'comparisonLabel', 'edition', 'figures', 'generatedAt', 'health', 'leftOut', 'notice',
      'organisationName', 'period', 'summary', 'title', 'version',
    ]);
  });
});

describe('renderSummaryPdf', () => {
  it('prints the cover line, the figures and the score — and none of the detail', async () => {
    const text = await pdfText(await renderSummaryPdf(composeSummaryEdition(sources())));
    expect(text).toContain('Summary edition for external readers: figures and Business Health Score only');
    expect(text).toContain('Monthly management report - summary edition - May 2026');
    expect(text).toContain('£40,000');
    expect(text).toContain('£12,345');
    expect(text).toContain('Score out of 100');
    expect(text).toMatch(/\b68\b/);
    expect(text).toContain('The bank balance has risen for three months');
    for (const secret of [SECRET.supplier, SECRET.subjectKey, SECRET.capText, 'must not print']) {
      expect(text, `${secret} must not be printed`).not.toContain(secret);
    }
  });

  it('renders a month with no score without inventing one', async () => {
    const text = await pdfText(await renderSummaryPdf(composeSummaryEdition(sources({ health: null }))));
    expect(text).toContain('No Business Health Score is available for this month.');
    expect(text).not.toContain('Score out of 100');
  });
});
