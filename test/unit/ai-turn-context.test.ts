import { describe, expect, it } from 'vitest';
import {
  applyKinds, buildGroundingContext, DEGRADED_DIRECT_ANSWER, degrade, ground, resolvePeriodContext,
  topicFor, unwrapData, type GroundingResult, type PeriodContext, type SubmitAnswer, type ToolResult,
} from '@/modules/ai';

/**
 * The turn context and §7.8 degradation (AI_ARCHITECTURE.md §7.6, §7.8; R2-C-02, R2-C-04, F-C-14).
 *
 * Both are pure, and both are the kind of code whose bugs look like correct answers: a context that
 * silently admitted an id from history, or a degradation that kept a fabricated sentence with a
 * caveat, would each pass every happy-path test. So the assertions here are the negative space —
 * what is NOT in the context, what is NOT in the rendered answer.
 */

const num = (value: string, display: string, unit: 'money' | 'ratio' | 'count' | 'days' = 'money') => ({ value, display, unit });

const MARCH = { id: 'p-march', label: 'March 2026' };
const FEB = { id: 'p-feb', label: 'February 2026' };

const REVENUE: ToolResult = {
  seq: 1, name: 'get_metric', ok: true,
  data: {
    metric_key: 'revenue', period: MARCH, value: num('120000.00', '£120,000'),
    basis: 'ledger', assurance_level: 'verified', snapshot_id: 'aaaaaaaa-0000-4000-8000-0000000000e1',
    variance: { prev_period: { value: num('-3000.00', '-£3,000'), pct_change: num('-0.024', '-2.4%', 'ratio'), comparison_period: FEB, basis_differs: false, snapshot_id: 'aaaaaaaa-0000-4000-8000-0000000000e2' } },
  },
  meta: { periods: [MARCH, FEB], calculation_run_id: 'bbbbbbbb-0000-4000-8000-0000000000b1' },
};

const CUSTOMERS: ToolResult = {
  seq: 2, name: 'get_customer_profitability', ok: true,
  data: {
    rows: [
      { subject: { type: 'counterparty', id: '11111111-1111-4111-8111-111111111111', name: '<data name="name">Acme Trading Ltd</data>' },
        period: MARCH, revenue: num('48000.00', '£48,000'), share: num('0.40', '40.0%', 'ratio'), snapshot_id: 'aaaaaaaa-0000-4000-8000-0000000000e3', assurance_level: 'estimated' },
    ],
  },
  meta: { periods: [MARCH], calculation_run_id: null },
};

const NO_DATA: ToolResult = { seq: 3, name: 'get_cash_analysis', ok: false, data: { code: 'NO_DATA', message: 'no cash figures' } };

const periodContext: PeriodContext = resolvePeriodContext({
  question: 'how was March?',
  periods: [
    { id: FEB.id, label: FEB.label, periodStart: '2026-02-01', isComplete: true, hasData: true },
    { id: MARCH.id, label: MARCH.label, periodStart: '2026-03-01', isComplete: true, hasData: true },
  ],
  fiscalYearStartMonth: 1,
});

describe('buildGroundingContext derives everything from THIS turn', () => {
  const context = buildGroundingContext({ periodContext, results: [REVENUE, CUSTOMERS, NO_DATA] });

  it('collects only branded numbers into the allowed set, with their evidence ids', () => {
    const paths = context.entries.map((e) => `${e.toolCallSeq}:${e.path}`);
    // Fixture ids are UUID-shaped on purpose: harvest() keys assurance by id and guards on the
    // shape, because a real snapshot or run id is always a uuid and a bare label never is.
    expect(paths).toContain('1:value');
    expect(paths).toContain('1:variance.prev_period.value');
    expect(paths).toContain('2:rows[0].share');
    expect(context.entries.find((e) => e.path === 'value')?.derivedEvidenceId).toBe('aaaaaaaa-0000-4000-8000-0000000000e1');
  });

  it('names an entity by the id a tool returned, unwrapped from its <data> element', () => {
    expect(context.entityNamesById['11111111-1111-4111-8111-111111111111']).toBe('Acme Trading Ltd');
  });

  it('knows the assurance of each evidence id, so kind is recomputed from the data (§6.2)', () => {
    expect(context.assuranceById['aaaaaaaa-0000-4000-8000-0000000000e1']).toBe('verified');
    expect(context.assuranceById['aaaaaaaa-0000-4000-8000-0000000000e3']).toBe('estimated');
    expect(context.assuranceById['bbbbbbbb-0000-4000-8000-0000000000b1']).toBe('calculated');
  });

  it('admits the turn’s period labels and the comparison label, and nothing else', () => {
    expect(context.periodLabels).toContain('March 2026');
    expect(context.comparisonLabels).toEqual(['February 2026']);
    expect(context.periodIdByLabel['March 2026']).toBe('p-march');
  });

  it('counts every call, and is not "all no data" when any tool returned figures', () => {
    expect(context.toolCallCount).toBe(3);
    expect(context.allToolsNoData).toBe(false);
    expect(buildGroundingContext({ periodContext, results: [NO_DATA] }).allToolsNoData).toBe(true);
    expect(buildGroundingContext({ periodContext, results: [] }).allToolsNoData).toBe(false);
  });

  it('unwraps the fixed escape form in the fixed order', () => {
    expect(unwrapData('<data name="x">a &amp;lt;b&amp;gt; c</data>')).toBe('a &lt;b&gt; c');
  });
});

describe('degrade removes, never caveats (§7.8)', () => {
  const context = buildGroundingContext({ periodContext, results: [REVENUE, CUSTOMERS] });
  const good = (statement: string, extra: Partial<SubmitAnswer['direct_answer']> = {}): SubmitAnswer['direct_answer'] => ({
    statement, kind: 'verified_fact', period: 'March 2026',
    evidence_refs: [{ type: 'metric_snapshot', id: 'aaaaaaaa-0000-4000-8000-0000000000e1' }],
    numbers: [{ text: '£120,000', tool_call_seq: 1, path: 'value', metric_key: 'revenue', entity_id: null }],
    entity_refs: [], ...extra,
  });
  const fabricated: SubmitAnswer['direct_answer'] = {
    statement: 'Marketing spend was £9,999 in March 2026.', kind: 'verified_fact', period: 'March 2026',
    evidence_refs: [{ type: 'metric_snapshot', id: 'aaaaaaaa-0000-4000-8000-0000000000e1' }],
    numbers: [{ text: '£9,999', tool_call_seq: 1, path: 'nowhere', metric_key: 'marketing', entity_id: null }],
    entity_refs: [],
  };
  const answer: SubmitAnswer = {
    mode: 'answer',
    direct_answer: good('Revenue was £120,000 in March 2026.'),
    key_findings: [good('Revenue was £120,000 in March 2026.'), fabricated],
    causes: [], risks: [], opportunities: [],
    // A recommendation resting ONLY on the fabricated finding's evidence: with no surviving
    // statement citing snap-marketing, it must go. (One citing snap-rev, which the good finding
    // also cites, would rightly survive — a recommendation is judged by what it rests on.)
    recommended_actions: [{
      title: { ...fabricated, statement: 'Cut marketing', numbers: [], evidence_refs: [{ type: 'metric_snapshot', id: 'aaaaaaaa-0000-4000-8000-0000000000e4' }] },
      issue: { ...fabricated, statement: 'It is high', numbers: [], evidence_refs: [{ type: 'metric_snapshot', id: 'aaaaaaaa-0000-4000-8000-0000000000e4' }] },
      recommendation: { ...fabricated, statement: 'Reduce it', numbers: [], evidence_refs: [{ type: 'metric_snapshot', id: 'aaaaaaaa-0000-4000-8000-0000000000e4' }] },
      priority: 'medium',
    }],
    confidence: { data_quality_notes: [] },
    evidence: [{ type: 'metric_snapshot', id: 'aaaaaaaa-0000-4000-8000-0000000000e1' }],
    unsupported: [],
  };

  const result = ground(answer, context);
  const degraded = degrade(answer, result, context);

  it('the fabricated finding is gone from the answer and present only in the report', () => {
    expect(result.status).toBe('degraded');
    expect(JSON.stringify(degraded.answer)).not.toContain('9,999');
    expect(degraded.removed.some((m) => m.statement.includes('£9,999'))).toBe(true);
  });

  it('its topic is server-generated and digit-free — never the sentence, never the model’s own key', () => {
    const topics = degraded.answer.unsupported.map((u) => u.topic);
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) expect(t).not.toMatch(/\d/);
    // "marketing" was the MODEL's metric_key on a path no tool returned: model text, so not echoed.
    expect(topics.some((t) => /marketing/i.test(t))).toBe(false);
    expect(topics.some((t) => /a figure for March/i.test(t))).toBe(true);
    expect(degraded.answer.unsupported.every((u) => u.reason === 'unverified')).toBe(true);
  });

  it('never echoes a period the turn does not know — an injected label stays out of "Not covered"', () => {
    const s: SubmitAnswer['direct_answer'] = {
      statement: 'x', kind: 'estimate', period: 'Jul-Sep', evidence_refs: [], entity_refs: [],
      numbers: [{ text: '£120,000', tool_call_seq: 1, path: 'value', metric_key: 'revenue', entity_id: null }],
    };
    expect(topicFor(s, context)).toBe('Sales');
  });

  it('a recommendation resting only on removed evidence goes with it', () => {
    expect(degraded.answer.recommended_actions).toEqual([]);
  });

  it('a surviving direct answer is kept as it was', () => {
    expect(degraded.answer.direct_answer.statement).toBe('Revenue was £120,000 in March 2026.');
    expect(degraded.answer.key_findings).toHaveLength(1);
  });

  it('a removed direct answer is replaced by the fixed sentence citing the survivors', () => {
    const withBadDirect: SubmitAnswer = { ...answer, direct_answer: fabricated };
    const r = ground(withBadDirect, context);
    const d = degrade(withBadDirect, r, context);
    expect(d.answer.direct_answer.statement).toBe(DEGRADED_DIRECT_ANSWER);
    expect(d.answer.direct_answer.kind).toBe('inference');
    expect(d.answer.direct_answer.numbers).toEqual([]);
    expect(d.answer.direct_answer.evidence_refs.map((e) => e.id)).toContain('aaaaaaaa-0000-4000-8000-0000000000e1');
  });

  it('topicFor uses entity names and metric labels, and strips any digit', () => {
    const s: SubmitAnswer['direct_answer'] = {
      statement: 'x', kind: 'estimate', period: 'March 2026',
      evidence_refs: [], entity_refs: [{ type: 'counterparty', id: '11111111-1111-4111-8111-111111111111', name: 'Acme Trading Ltd' }],
      numbers: [{ text: '40%', tool_call_seq: 2, path: 'rows[0].share', metric_key: 'customer_revenue_share', entity_id: '11111111-1111-4111-8111-111111111111' }],
    };
    const topic = topicFor(s, context);
    expect(topic).toMatch(/Acme Trading Ltd/);
    expect(topic).not.toMatch(/\d/);
    expect(topic).toMatch(/March/);
  });
});

describe('applyKinds overrides the model’s label with the server’s', () => {
  it('downgrades a statement the server computed as estimate', () => {
    const answer: SubmitAnswer = {
      mode: 'answer',
      direct_answer: { statement: 'x', kind: 'verified_fact', period: null, evidence_refs: [], numbers: [], entity_refs: [] },
      key_findings: [], causes: [], risks: [], opportunities: [], recommended_actions: [],
      confidence: { data_quality_notes: [] }, evidence: [], unsupported: [],
    };
    const kinds: GroundingResult['kinds'] = { direct_answer: 'estimate' };
    expect(applyKinds(answer, kinds).direct_answer.kind).toBe('estimate');
  });
});
