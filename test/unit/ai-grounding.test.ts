import { describe, expect, it } from 'vitest';
import {
  allowedSet, ground, modeAdmissible, numeric, unsupportedTopicsClean,
  type GroundingContext, type Statement, type SubmitAnswer, type ToolResult,
} from '@/modules/ai';

/**
 * Grounding v3 (AI_ARCHITECTURE.md §7) and the trap set `TEST_STRATEGY.md §10.2` / §12 name.
 *
 * Every trap here is a real number used dishonestly — the right figure attached to the wrong month,
 * the wrong metric, the wrong customer, the wrong direction. That is the shape a model's mistakes
 * actually take: fabricating a number outright is rare, and misattributing one is not. v1 and v2
 * were both withdrawn for passing exactly these (F-C-01, R2-C-01/03/07), so each trap below names
 * the finding it stands for.
 */

const CUSTOMERS: ToolResult = {
  seq: 1,
  name: 'get_customer_profitability',
  ok: true,
  data: {
    rows: [
      {
        subject: { type: 'counterparty', id: 'cp-acme', name: 'Acme Trading Ltd' },
        revenue: numeric('52000.00', '£52,000', 'money'),
        share: numeric('0.41', '41%', 'ratio'),
        snapshot_id: 's-acme',
        metric_key: 'revenue',
      },
      {
        subject: { type: 'counterparty', id: 'cp-beta', name: 'Beta Ltd' },
        revenue: numeric('48000.00', '£48,000', 'money'),
        share: numeric('0.38', '38%', 'ratio'),
        snapshot_id: 's-beta',
        metric_key: 'revenue',
      },
    ],
  },
  meta: { periods: [{ id: 'p-march', label: 'March 2026' }] },
};

const PROFIT: ToolResult = {
  seq: 2,
  name: 'get_metric',
  ok: true,
  data: {
    metric_key: 'net_profit',
    period: { id: 'p-march', label: 'March 2026' },
    value: numeric('16000.00', '£16,000', 'money'),
    snapshot_id: 's-profit',
    variance: {
      prev_period: {
        value: numeric('-3000.00', '-£3,000', 'money'),
        comparison_period: { id: 'p-february', label: 'February 2026' },
        snapshot_id: 's-profit-prev',
      },
    },
  },
  meta: { periods: [{ id: 'p-march', label: 'March 2026' }] },
};

const REVENUE: ToolResult = {
  seq: 3,
  name: 'get_metric',
  ok: true,
  data: {
    metric_key: 'revenue',
    period: { id: 'p-march', label: 'March 2026' },
    value: numeric('120000.00', '£120,000', 'money'),
    snapshot_id: 's-revenue',
  },
  meta: { periods: [{ id: 'p-march', label: 'March 2026' }] },
};

const CONTEXT: GroundingContext = {
  entries: allowedSet([CUSTOMERS, PROFIT, REVENUE]),
  periodLabels: ['March 2026'],
  periodIdByLabel: { 'March 2026': 'p-march' },
  entityNamesById: { 'cp-acme': 'Acme Trading Ltd', 'cp-beta': 'Beta Ltd' },
  references: [],
  descriptorHashes: [],
  assuranceById: {
    's-acme': 'calculated', 's-beta': 'calculated', 's-profit': 'calculated',
    's-profit-prev': 'calculated', 's-revenue': 'verified',
  },
  comparisonLabels: ['February 2026'],
  periodAmbiguous: false,
  allToolsNoData: false,
  toolCallCount: 3,
};

function statement(over: Partial<Statement> = {}): Statement {
  return {
    statement: 'Revenue was £120,000.',
    kind: 'deterministic_calculation',
    period: 'March 2026',
    evidence_refs: [{ type: 'metric_snapshot', id: 's-revenue' }],
    numbers: [{ text: '£120,000', tool_call_seq: 3, path: 'value', metric_key: 'revenue', entity_id: null }],
    entity_refs: [],
    ...over,
  };
}

function answer(direct: Statement, over: Partial<SubmitAnswer> = {}): SubmitAnswer {
  return {
    mode: 'answer',
    direct_answer: direct,
    key_findings: [],
    causes: [],
    risks: [],
    opportunities: [],
    recommended_actions: [],
    confidence: { data_quality_notes: [] },
    evidence: [],
    unsupported: [],
    ...over,
  };
}

const reasonFor = (s: Statement): string | null =>
  ground(answer(s), CONTEXT).mismatches[0]?.reason ?? null;

describe('an honest answer passes', () => {
  it('a level, named, in its own period, with the snapshot it came from', () => {
    expect(ground(answer(statement()), CONTEXT).status).toBe('passed');
  });

  it('a change, with the direction word that gives it its sign', () => {
    expect(ground(answer(statement({
      statement: 'Net profit fell £3,000.',
      period: 'March 2026',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-profit-prev' }],
      numbers: [{
        text: '£3,000', tool_call_seq: 2, path: 'variance.prev_period.value',
        metric_key: 'net_profit', entity_id: null,
      }],
    })), CONTEXT).status).toBe('passed');
  });

  it('a customer’s figure, bound to that customer', () => {
    expect(ground(answer(statement({
      statement: 'Acme Trading Ltd billed £52,000 in revenue.',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-acme' }],
      numbers: [{
        text: '£52,000', tool_call_seq: 1, path: 'rows[0].revenue',
        metric_key: 'revenue', entity_id: 'cp-acme',
      }],
      entity_refs: [{ type: 'counterparty', id: 'cp-acme', name: 'Acme Trading Ltd' }],
    })), CONTEXT).status).toBe('passed');
  });

  it('an inference carrying no number, but carrying evidence (§6.3)', () => {
    expect(ground(answer(statement({
      statement: 'The fall looks seasonal rather than structural.',
      kind: 'inference',
      period: null,
      numbers: [],
      evidence_refs: [{ type: 'metric_snapshot', id: 's-profit' }],
    })), CONTEXT).status).toBe('passed');
  });
});

describe('the trap set — a real number used dishonestly (§12, §10.2)', () => {
  it('the correct number under the WRONG METRIC NOUN (R2-C-01)', () => {
    // £120,000 is real; it is revenue, and the sentence calls it net profit.
    expect(reasonFor(statement({
      statement: 'Net profit was £120,000.',
      numbers: [{ text: '£120,000', tool_call_seq: 3, path: 'value', metric_key: 'net_profit', entity_id: null }],
    }))).toMatch(/attributes .* to net_profit, but value is revenue/);
  });

  it('the right metric_key but the noun beside it belongs to another metric', () => {
    expect(reasonFor(statement({
      statement: 'Cash was £120,000.',
    }))).toMatch(/without naming revenue beside it/);
  });

  it('a number attributed to the WRONG CUSTOMER (F-C-04)', () => {
    expect(reasonFor(statement({
      statement: 'Beta Ltd billed £52,000 in revenue.',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-acme' }],
      numbers: [{
        text: '£52,000', tool_call_seq: 1, path: 'rows[0].revenue',
        metric_key: 'revenue', entity_id: 'cp-acme',
      }],
      entity_refs: [{ type: 'counterparty', id: 'cp-acme', name: 'Acme Trading Ltd' }],
    }))).toMatch(/beside Beta Ltd, but cites another entity's row|names "Beta Ltd" without an entity_ref/);
  });

  it('two entities SWAPPED inside one sentence (R2-C-03)', () => {
    const swapped = statement({
      statement: 'Acme Trading Ltd billed £48,000 in revenue.',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-beta' }],
      numbers: [{
        text: '£48,000', tool_call_seq: 1, path: 'rows[1].revenue',
        metric_key: 'revenue', entity_id: 'cp-beta',
      }],
      entity_refs: [{ type: 'counterparty', id: 'cp-beta', name: 'Beta Ltd' }],
    });
    expect(reasonFor(swapped)).not.toBeNull();
  });

  it('a FLIPPED SIGN on a change (R2-C-07)', () => {
    expect(reasonFor(statement({
      statement: 'Net profit rose £3,000.',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-profit-prev' }],
      numbers: [{
        text: '£3,000', tool_call_seq: 2, path: 'variance.prev_period.value',
        metric_key: 'net_profit', entity_id: null,
      }],
    }))).toMatch(/rose .* moved the other way/);
  });

  it('an UNANCHORED DIRECTION WORD on a level value (R2-C-07)', () => {
    // The level is right; the sentence asserts a movement the cited number cannot show.
    expect(reasonFor(statement({
      statement: 'Revenue rose to £120,000.',
    }))).toMatch(/says "rose" beside a level value/);
  });

  it('a change stated with no direction at all', () => {
    expect(reasonFor(statement({
      statement: 'Net profit moved by £3,000.',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-profit-prev' }],
      numbers: [{
        text: '£3,000', tool_call_seq: 2, path: 'variance.prev_period.value',
        metric_key: 'net_profit', entity_id: null,
      }],
    }))).toMatch(/without saying which way it went/);
  });

  it('a PROSE PERIOD different from the statement’s period (R2-C-01)', () => {
    expect(reasonFor(statement({
      statement: 'Revenue in Q1 2026 was £120,000.',
    }))).toMatch(/mentions the period "Q1 2026"/);
  });

  it('a RATIO OFF BY FOUR POINTS', () => {
    expect(reasonFor(statement({
      statement: 'Acme Trading Ltd is 45% of revenue.',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-acme' }],
      numbers: [{
        text: '45%', tool_call_seq: 1, path: 'rows[0].share',
        metric_key: 'revenue', entity_id: 'cp-acme',
      }],
      entity_refs: [{ type: 'counterparty', id: 'cp-acme', name: 'Acme Trading Ltd' }],
    }))).toMatch(/but rows\[0\]\.share is 41%/);
  });

  it('a PERCENTAGE QUOTED FOR A MONEY FIELD', () => {
    expect(reasonFor(statement({
      statement: 'Revenue was 120,000%.',
      numbers: [{ text: '120,000%', tool_call_seq: 3, path: 'value', metric_key: 'revenue', entity_id: null }],
    }))).toMatch(/but value is £120,000/);
  });

  it('a number cited at a path no tool returned', () => {
    expect(reasonFor(statement({
      statement: 'Revenue was £120,000.',
      numbers: [{ text: '£120,000', tool_call_seq: 3, path: 'invented', metric_key: 'revenue', entity_id: null }],
    }))).toMatch(/returned no such number/);
  });

  it('a number with no NumberRef at all', () => {
    expect(reasonFor(statement({
      statement: 'Revenue was £120,000 and costs were £45,000.',
    }))).toMatch(/with no NumberRef/);
  });

  it('an UNGROUNDED AMOUNT INSIDE A RECOMMENDATION', () => {
    const result = ground(answer(statement(), {
      recommended_actions: [{
        title: statement({ statement: 'Renegotiate the contract.', period: null, numbers: [] }),
        issue: statement({ statement: 'It costs £4,800 a month.', period: 'March 2026', numbers: [] }),
        recommendation: statement({ statement: 'Ask for better terms.', period: null, numbers: [] }),
        priority: 'high',
      }],
    }), CONTEXT);
    expect(result.status).toBe('degraded');
    expect(result.mismatches.some((m) => m.path.includes('recommended_actions[0].issue'))).toBe(true);
  });

  it('a statement of any kind with no evidence at all (§6.3, F-C-06)', () => {
    expect(reasonFor(statement({
      statement: 'Margins are under pressure.',
      kind: 'inference',
      period: null,
      numbers: [],
      evidence_refs: [],
    }))).toMatch(/every kind requires evidence/);
  });

  it('a number cited without listing the snapshot it came from (R2-C-02)', () => {
    expect(reasonFor(statement({
      evidence_refs: [{ type: 'metric_snapshot', id: 's-profit' }],
    }))).toMatch(/without listing the metric_snapshot it came from/);
  });

  it('an entity named without an entity_ref (§7.5)', () => {
    expect(reasonFor(statement({
      statement: 'Acme Trading Ltd drove revenue of £120,000.',
    }))).toMatch(/without an entity_ref/);
  });

  it('a period this turn does not know', () => {
    expect(reasonFor(statement({ period: 'April 2026' }))).toMatch(/does not know/);
  });
});

describe('kind is recomputed downward, never upward (§6.2, R2-C-02)', () => {
  it('caps a claimed verified_fact at the assurance of the row it cites', () => {
    const result = ground(answer(statement({
      statement: 'Net profit was £16,000.',
      kind: 'verified_fact',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-profit' }],
      numbers: [{ text: '£16,000', tool_call_seq: 2, path: 'value', metric_key: 'net_profit', entity_id: null }],
    })), CONTEXT);
    expect(result.status).toBe('passed');
    // The snapshot is `calculated`; the model said `verified_fact`; the server says calculated.
    expect(result.kinds.direct_answer).toBe('deterministic_calculation');
  });

  it('leaves a weaker claim alone — the cap only ever moves down', () => {
    const result = ground(answer(statement({
      statement: 'Net profit was £16,000.',
      kind: 'estimate',
      evidence_refs: [{ type: 'metric_snapshot', id: 's-profit' }],
      numbers: [{ text: '£16,000', tool_call_seq: 2, path: 'value', metric_key: 'net_profit', entity_id: null }],
    })), CONTEXT);
    expect(result.kinds.direct_answer).toBe('estimate');
  });
});

describe('mode admissibility is the validator’s decision, not the model’s (§7.7, R2-C-06)', () => {
  const base = answer(statement());

  it('refuses a clarification when nothing was ambiguous', () => {
    expect(modeAdmissible({ ...base, mode: 'clarification' }, CONTEXT))
      .toMatch(/only admissible when the period is ambiguous/);
  });

  it('refuses a clarification that ran tools or carried numbers', () => {
    const ambiguous = { ...CONTEXT, periodAmbiguous: true };
    expect(modeAdmissible({ ...base, mode: 'clarification' }, ambiguous)).toMatch(/runs no tools/);
    expect(modeAdmissible(
      { ...base, mode: 'clarification' },
      { ...ambiguous, toolCallCount: 0 },
    )).toMatch(/carries no numbers/);
  });

  it('accepts a clarification that is a single question with nothing else in it', () => {
    expect(modeAdmissible(
      answer(statement({
        statement: 'Do you mean the calendar quarter or your fiscal quarter?',
        period: null, numbers: [], evidence_refs: [{ type: 'metric_snapshot', id: 's-revenue' }],
      }), { mode: 'clarification' }),
      { ...CONTEXT, periodAmbiguous: true, toolCallCount: 0 },
    )).toBeNull();
  });

  it('refuses no_data when the tools returned data', () => {
    expect(modeAdmissible({ ...base, mode: 'no_data' }, CONTEXT))
      .toMatch(/only admissible when every tool returned no data/);
  });

  it('refuses an answer when every tool returned no data', () => {
    expect(modeAdmissible(base, { ...CONTEXT, allToolsNoData: true }))
      .toMatch(/an answer is not admissible/);
  });

  it('refuses a refusal that names an entity or carries a figure', () => {
    expect(modeAdmissible(
      answer(statement({ statement: 'I cannot forecast that.', period: null, numbers: [], entity_refs: [{ type: 'counterparty', id: 'cp-acme', name: 'Acme Trading Ltd' }] }), { mode: 'refusal' }),
      CONTEXT,
    )).toMatch(/names no entities/);
  });
});

describe('a removed sentence cannot reappear carrying its figure (§7.8, R2-C-04)', () => {
  it('rejects an unsupported topic containing a digit', () => {
    expect(unsupportedTopicsClean(answer(statement(), {
      unsupported: [{ topic: 'the £4,800 monthly contract', reason: 'unverified' }],
    }))).toMatch(/contains a digit/);
  });

  it('accepts a topic that names the subject without the number', () => {
    expect(unsupportedTopicsClean(answer(statement(), {
      unsupported: [{ topic: 'marketing spend for the month', reason: 'unverified' }],
    }))).toBeNull();
  });
});
