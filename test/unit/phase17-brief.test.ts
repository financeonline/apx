import { describe, expect, it } from 'vitest';
import { computeInterimFigures, type InterimInput } from '@/modules/financial-engine';
import {
  BRIEF_LIST_CAP, assembleBrief, customQuestionMessage, entriesFromConversation, notShown, renderAdviserPdf,
  renderBriefPdf, renderCustomPdf, renderFundingPdf, resolveHref,
  type AdviserContent, type BriefActionLine, type BriefAlertLine, type BriefSources, type CustomReportContent,
  type FundingReportContent,
} from '@/modules/reporting';

/** Phase 17: the brief assembler, the custom report's pairing rule and the PDFs. */

const interimInput = (over: Partial<InterimInput> = {}): InterimInput => ({
  window: { start: '2026-09-07', end: '2026-09-13' },
  baseCurrency: 'GBP',
  bank: [],
  invoices: [],
  accounts: [{ bankAccountId: 'a', name: 'Current', latestDate: '2026-09-30' }],
  hasInvoiceData: true,
  ...over,
});

const alert = (id: string, severity: BriefAlertLine['severity'], at: string): BriefAlertLine => ({
  id, severity, title: `Alert ${id}`, explanation: `Alert ${id} explained.`, nextStep: null, periodLabel: null, at,
  href: `/app/{org}/insights/alerts/${id}`,
});

const action = (id: string, dueDate: string | null, status: BriefActionLine['status'] = 'open'): BriefActionLine => ({
  id, title: `Action ${id}`, priority: 'medium', status, dueDate, assigned: false, at: null, href: `/app/{org}/actions/${id}`,
});

const sources = (over: Partial<BriefSources> = {}): BriefSources => ({
  kind: 'weekly_intelligence',
  organisationName: 'Acme',
  timezone: 'Europe/London',
  window: { start: '2026-09-07', end: '2026-09-13' },
  previousWindow: { start: '2026-08-31', end: '2026-09-06' },
  composedAt: '2026-09-14T01:00:00.000Z',
  interim: computeInterimFigures(interimInput()),
  previousInterim: computeInterimFigures(interimInput({ window: { start: '2026-08-31', end: '2026-09-06' } })),
  alertsRaised: [],
  alertsResolved: [],
  standingAlerts: [],
  actionsCreated: [],
  actionsCompleted: [],
  openActions: [],
  dataRefreshedAt: null,
  latestMonth: null,
  ...over,
});

describe('assembling a brief', () => {
  it('orders alerts worst first, then newest, and caps the list while stating the total', () => {
    const many = Array.from({ length: BRIEF_LIST_CAP + 3 }, (_, i) =>
      alert(`m${String(i).padStart(2, '0')}`, 'medium', `2026-09-08T0${i % 10}:00:00Z`));
    const brief = assembleBrief(sources({
      alertsRaised: [...many, alert('crit', 'critical', '2026-09-07T01:00:00Z'), alert('high', 'high', '2026-09-09T01:00:00Z')],
    }));
    expect(brief.events.alertsRaised.total).toBe(BRIEF_LIST_CAP + 5);
    expect(brief.events.alertsRaised.items).toHaveLength(BRIEF_LIST_CAP);
    expect(brief.events.alertsRaised.items.slice(0, 2).map((a) => a.id)).toEqual(['crit', 'high']);
    expect(notShown(brief.events.alertsRaised)).toBe(5);
  });

  it('counts standing alerts by severity, and lists only critical and high', () => {
    const brief = assembleBrief(sources({
      standingAlerts: [alert('c', 'critical', '2026-09-01T00:00:00Z'), alert('m', 'medium', '2026-09-01T00:00:00Z'), alert('l', 'low', '2026-09-01T00:00:00Z')],
    }));
    expect(brief.attention.standingBySeverity).toEqual({ critical: 1, high: 0, medium: 1, low: 1, info: 0 });
    expect(brief.attention.standingAlerts.items.map((a) => a.id)).toEqual(['c']);
  });

  it('splits open actions into overdue (due by the window\'s last day) and due within seven days after', () => {
    const brief = assembleBrief(sources({
      openActions: [
        action('on-last-day', '2026-09-13'),
        action('early', '2026-09-01'),
        action('next-day', '2026-09-14'),
        action('seventh-day', '2026-09-20'),
        action('eighth-day', '2026-09-21'),
        action('undated', null),
        action('closed', '2026-09-01', 'completed'),
      ],
    }));
    expect(brief.attention.overdueActions.items.map((a) => a.id)).toEqual(['early', 'on-last-day']);
    expect(brief.attention.dueSoonActions.items.map((a) => a.id)).toEqual(['next-day', 'seventh-day']);
  });

  it('pairs each figure with the window before it', () => {
    const brief = assembleBrief(sources({
      interim: computeInterimFigures(interimInput({
        bank: [{ id: 'b', bankAccountId: 'a', date: '2026-09-08', amount: '120.00', currency: 'GBP', transferKind: null, description: null }],
      })),
      previousInterim: computeInterimFigures(interimInput({
        window: { start: '2026-08-31', end: '2026-09-06' },
        bank: [{ id: 'p', bankAccountId: 'a', date: '2026-09-02', amount: '20.00', currency: 'GBP', transferKind: null, description: null }],
      })),
    }));
    expect(brief.comparison.find((row) => row.key === 'cash_in')).toMatchObject({ change: '100.00' });
  });

  it('says why a figure is missing, in words', () => {
    const brief = assembleBrief(sources({ interim: computeInterimFigures(interimInput({ accounts: [], hasInvoiceData: false })) }));
    expect(brief.notices.map((n) => n.kind)).toEqual(['no_bank_accounts', 'no_invoice_data', 'no_month_yet']);
  });

  it('fills the organisation into stored links only when shown', () => {
    expect(resolveHref('/app/{org}/actions/1', 'acme ltd')).toBe('/app/acme%20ltd/actions/1');
  });
});

describe('the Custom AI Report takes answers only from the conversation as stored', () => {
  const messages = [
    { id: 'u1', role: 'user' as const, content: 'For August 2026: Why?', structured: null, groundingStatus: null, evidenceBundleId: null },
    { id: 'a1', role: 'assistant' as const, content: null, structured: null, groundingStatus: 'failed', evidenceBundleId: null },
    { id: 'u2', role: 'user' as const, content: 'For August 2026: What changed?', structured: null, groundingStatus: null, evidenceBundleId: null },
    { id: 'a2', role: 'assistant' as const, content: null, structured: null, groundingStatus: 'passed', evidenceBundleId: 'e2' },
  ];

  it('pairs each answer with the question asked just before it, in the order requested', () => {
    expect(entriesFromConversation(messages, ['a2', 'a1'])?.map((e) => [e.asked, e.groundingStatus])).toEqual([
      ['For August 2026: What changed?', 'passed'],
      ['For August 2026: Why?', 'failed'],
    ]);
  });

  it('refuses an id that is not an answer in this conversation, or a repeat', () => {
    expect(entriesFromConversation(messages, ['u1'])).toBeNull();
    expect(entriesFromConversation(messages, ['nope'])).toBeNull();
    expect(entriesFromConversation(messages, ['a2', 'a2'])).toBeNull();
  });

  it('writes the month and areas into the question in words', () => {
    expect(customQuestionMessage('August 2026', ['cash', 'costs'], ' Why is cash falling? '))
      .toBe('For August 2026, looking at cash, costs: Why is cash falling?');
    expect(customQuestionMessage('August 2026', [], 'What changed?')).toBe('For August 2026: What changed?');
  });
});

describe('the PDFs render the stored content', () => {
  const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';

  it('renders a brief, including characters the standard fonts cannot draw', async () => {
    const brief = assembleBrief(sources({
      alertsRaised: [{ ...alert('x', 'high', '2026-09-08T00:00:00Z'), explanation: 'Revenue fell — by £1,200 “sharply” … İzmir' }],
      openActions: [action('o', '2026-09-01')],
    }));
    expect(isPdf(await renderBriefPdf(brief))).toBe(true);
  });

  it('renders an adviser report and a custom report', async () => {
    const month = {
      periodId: 'p', label: 'August 2026', comparisonLabel: null, basisLine: 'From your ledger.',
      cards: [{ metricKey: 'revenue', label: 'Sales', value: '£20,000', change: null, statusLabel: null, href: '/app/{org}/x' }],
      health: { score: 62, band: 'stable', changeVsPrevious: -4, dimensionsUsed: 4, dimensionsTotal: 6, capped: false },
      adverse: [], favourable: [],
    };
    const adviser: AdviserContent = {
      version: 'adviser.v1', organisationName: 'Acme', timezone: 'Europe/London', currency: 'GBP',
      composedAt: '2026-09-14T01:00:00.000Z', asOfDate: '2026-09-14', month,
      dimensions: [{ key: 'cash_flow', score: null, included: false, exclusionReason: 'no_bank_coverage', capped: false, positives: [], negatives: [] }],
      trend: [{ periodLabel: 'Aug 2026', score: 62, band: 'stable' }],
      attention: ['1 critical alert'],
      alerts: { bySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, standing: { items: [alert('c', 'critical', '2026-09-01T00:00:00Z')], total: 1 } },
      actions: {
        open: 1, overdue: { items: [action('o', '2026-09-01')], total: 1 }, urgent: { items: [], total: 0 },
        completedRecently: { items: [{ ...action('d', null, 'completed'), outcomeValue: '500.00', outcomeCurrency: 'GBP' }], total: 1 },
      },
      dataQuality: { dataRefreshedAt: '2026-09-13T10:00:00Z', bankAccounts: [{ name: 'Current', latestDate: '2026-09-30' }], monthsWithoutData: ['Jul 2026'] },
      disclaimer: 'An indicator, not a lending decision.',
    };
    expect(isPdf(await renderAdviserPdf(adviser))).toBe(true);

    const custom: CustomReportContent = {
      version: 'custom.v1', organisationName: 'Acme',
      period: { id: 'p', label: 'August 2026', start: '2026-08-01', end: '2026-08-31' },
      dimensions: ['cash'], conversationId: 'c', composedAt: '2026-09-14T01:00:00.000Z',
      entries: [
        { asked: 'For August 2026: Why?', messageId: 'a1', groundingStatus: 'failed', evidenceBundleId: null, answer: null },
        {
          asked: 'For August 2026: What changed?', messageId: 'a2', groundingStatus: 'degraded', evidenceBundleId: null,
          answer: {
            mode: 'answer',
            direct_answer: { statement: 'Costs rose.', kind: 'inference', period: 'August 2026', evidence_refs: [], numbers: [], entity_refs: [] },
            key_findings: [{ statement: 'Payroll rose.', kind: 'verified_fact', period: 'August 2026', evidence_refs: [], numbers: [], entity_refs: [] }],
            causes: [], risks: [], opportunities: [], recommended_actions: [],
            confidence: { data_quality_notes: [{ code: 'partial_month', period: 'August 2026' }] }, evidence: [],
            unsupported: [{ topic: 'customers', reason: 'no_data' }],
          },
        },
      ],
    };
    expect(isPdf(await renderCustomPdf(custom))).toBe(true);
  });

  it('renders a Funding Readiness Report, scored or not', async () => {
    const factor = (key: 'F1' | 'F4', scored: boolean): FundingReportContent['assessment']['factors'][number] => ({
      key, name: key === 'F1' ? 'Revenue and profitability' : 'Existing debt', weight: 20, appliedWeight: scored ? 20 : 0,
      status: scored ? 'scored' : 'missing', score: scored ? 64 : null, reason: scored ? null : 'no_balance_sheet',
      missingCodes: scored ? [] : ['no_balance_sheet'], capped: false, capReason: null, completeness: scored ? 1 : null,
      rules: [], metrics: [],
      positives: scored ? [{ rule: 'F1.1', template: 't', text: 'Revenue grew.', values: {}, snapshotIds: [] }] : [],
      negatives: [],
      missing: scored ? [] : [{ factor: key, rule: null, reason: 'no_balance_sheet', text: 'Debt could not be established.' }],
      actions: [],
    });
    const content = (status: 'scored' | 'insufficient_data'): FundingReportContent => ({
      version: 'funding.v1', organisationName: 'Acme',
      period: { id: 'p', label: 'August 2026', start: '2026-08-01', end: '2026-08-31' },
      assessment: {
        id: 'a', status, score: status === 'scored' ? 64 : null, band: status === 'scored' ? 'Developing' : null,
        dataCoveragePercent: 71, factorsUsed: 1, factors: [factor('F1', true), factor('F4', false)],
        actions: [{ factor: 'F4', rule: null, reason: 'no_balance_sheet', text: 'Import a trial balance.', priority: 'high', evidence: [] }],
        rulesVersion: 'funding_readiness.v1', engineVersion: '15.1.0', calculationRunId: '12345678-0000', assessedAt: '2026-09-14T01:00:00.000Z',
        disclaimer: 'Funding Readiness is an indicative assessment.',
      },
      composedAt: '2026-09-14T02:00:00.000Z',
    });
    expect(isPdf(await renderFundingPdf(content('scored')))).toBe(true);
    expect(isPdf(await renderFundingPdf(content('insufficient_data')))).toBe(true);
  });
});
