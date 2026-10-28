import { describe, expect, it } from 'vitest';
import {
  KIND_LABELS, canCreateActionFrom, dataQualityNoteLine, drainSse, notCoveredLine, quotaNotice,
  remainingLine, revealSteps, statusLine,
} from '@/components/dashboard/analyst-presentation';

/**
 * The analyst page's pure rules (UX_ARCHITECTURE.md §5, §7.1–7.2, §8.1; AI_ARCHITECTURE.md §7.8).
 * The component is thin on purpose; what a test can pin lives here.
 */

describe('§8.1: one kind badge per statement, from the canonical table', () => {
  it('uses the five canonical labels and never the enum value', () => {
    expect(KIND_LABELS).toEqual({
      verified_fact: 'Fact',
      deterministic_calculation: 'Calculated',
      estimate: 'Estimate',
      inference: 'Analysis',
      recommendation: 'Recommendation',
    });
    for (const label of Object.values(KIND_LABELS)) expect(label).not.toMatch(/_/);
  });
});

describe('ADR-032.5: "Create action" only when the whole answer passed', () => {
  it('is absent for degraded, failed and unknown verdicts, and for a role that cannot create', () => {
    expect(canCreateActionFrom('passed', true)).toBe(true);
    expect(canCreateActionFrom('degraded', true)).toBe(false);
    expect(canCreateActionFrom('failed', true)).toBe(false);
    expect(canCreateActionFrom(null, true)).toBe(false);
    expect(canCreateActionFrom('passed', false)).toBe(false);
  });
});

describe('§7.8: "Not covered" is plain words around a server-generated topic', () => {
  it('renders the topic with the reason spelled out', () => {
    expect(notCoveredLine({ topic: 'marketing spend for March 2026', reason: 'unverified' }))
      .toBe('Not covered: marketing spend for March 2026 — figure could not be verified');
  });
  it('never shows an unknown reason code raw', () => {
    expect(notCoveredLine({ topic: 'x', reason: 'something_else' })).not.toMatch(/something_else/);
  });
});

describe('R2-C-08: a data-quality note is a code; the page chooses the prose', () => {
  it('renders a known code as a sentence with its period', () => {
    expect(dataQualityNoteLine({ code: 'cash_basis_proxy', period: 'March 2026' }))
      .toBe('Figures are estimated from bank activity, not from your accounts (March 2026).');
  });
  it('degrades an unknown code to readable words rather than hiding it', () => {
    expect(dataQualityNoteLine({ code: 'weird_new_code', period: null })).toBe('Weird new code.');
  });
});

describe('§7.1: the status line is plain text, never JSON', () => {
  it('capitalises the label and adds an ellipsis', () => {
    expect(statusLine('looking up a figure')).toBe('Looking up a figure…');
    expect(statusLine('')).toBe('Working on it…');
  });
});

describe('ROUTE_ARCHITECTURE §121: the quota notice carries the reset time', () => {
  const quota = { dailyLimit: 100, resetsAt: '2026-06-16T00:00:00.000Z' };
  it('says when more questions are available', () => {
    expect(quotaNotice('daily', quota)).toBe("You've used today's 100 questions. You can ask more at 00:00 UTC.");
  });
  it('names the month for the token ceiling', () => {
    expect(quotaNotice('monthly', quota)).toMatch(/monthly analyst allowance/);
  });
  it('is silent when nothing is exhausted', () => {
    expect(quotaNotice(null, quota)).toBeNull();
  });
  it('counts the questions left, singular and plural', () => {
    expect(remainingLine(1)).toBe('1 question left today for your business');
    expect(remainingLine(7)).toBe('7 questions left today for your business');
    expect(remainingLine(null)).toBeNull();
  });
});

describe('the stream is cut into events at blank lines', () => {
  it('parses complete frames and keeps a partial one', () => {
    const { events, rest } = drainSse(
      'event: status\ndata: {"tool":"get_metric","label":"looking up a figure"}\n\nevent: answer\ndata: {"a":1}\n\nevent: sta',
    );
    expect(events).toEqual([
      { event: 'status', data: { tool: 'get_metric', label: 'looking up a figure' } },
      { event: 'answer', data: { a: 1 } },
    ]);
    expect(rest).toBe('event: sta');
  });
  it('skips a frame whose data is not JSON rather than throwing mid-stream', () => {
    const { events } = drainSse('event: x\ndata: not json\n\nevent: y\ndata: 2\n\n');
    expect(events).toEqual([{ event: 'y', data: 2 }]);
  });
});

describe('ADR-032.4: sections are revealed one by one from the single validated event', () => {
  it('counts the direct answer, each non-empty section, and the closing block', () => {
    expect(revealSteps({ key_findings: [1], causes: [], risks: [1], opportunities: [], recommended_actions: [1], unsupported: [] })).toBe(5);
    expect(revealSteps({ key_findings: [], causes: [], risks: [], opportunities: [], recommended_actions: [], unsupported: [] })).toBe(2);
  });
});
