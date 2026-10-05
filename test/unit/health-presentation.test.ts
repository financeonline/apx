import { describe, it, expect } from 'vitest';
import {
  BAND_SCALE, BAND_TONES, DIMENSION_LABELS, EXCLUSION_TEXT, HEALTH_DISCLAIMER,
  NOT_ENOUGH_DATA_TITLE, RULE_LABELS, SKIP_TEXT, bandText, bandTone, changeText, changeTone,
  dimensionsNote, orderedDimensions, pointsText, skipText,
} from '@/components/dashboard';
import {
  BANKING_HEALTH_RULES, CASH_FLOW_RULES, COST_CONTROL_RULES, CUSTOMER_QUALITY_RULES,
  HEALTH_DIMENSION_KEYS, PROFITABILITY_RULES, REVENUE_GROWTH_RULES, computeHealthScore,
} from '@/modules/health';
import { healthInput } from '../fixtures/health';

/** The presentation decisions, asserted without a DOM (UX §Level 1, §4 colour semantics). */

describe('colour is reserved for the band', () => {
  it('maps each band to its meaning, not to a decoration', () => {
    expect(BAND_TONES).toEqual({
      at_risk: 'danger', needs_attention: 'warn', stable: 'neutral', strong: 'accent',
    });
  });

  it('gives a missing band a neutral tone rather than a colour', () => {
    expect(bandTone(null)).toBe('neutral');
    expect(bandText(null)).toBeNull();
  });

  it('states the four bands with their boundaries', () => {
    expect(BAND_SCALE).toEqual([
      { band: 'strong', label: 'Strong', min: 80 },
      { band: 'stable', label: 'Stable', min: 60 },
      { band: 'needs_attention', label: 'Needs attention', min: 40 },
      { band: 'at_risk', label: 'At risk', min: 0 },
    ]);
  });
});

describe('"based on N of 6 areas"', () => {
  it('appears only when a dimension is missing', () => {
    expect(dimensionsNote(6, 6)).toBeNull();
    expect(dimensionsNote(4, 6)).toBe('Based on 4 of 6 areas');
  });
});

describe('the change line', () => {
  it('never shows a zero for a missing comparison', () => {
    expect(changeText(null, 'February 2026')).toBe('no comparison yet');
    expect(changeTone(null)).toBe('none');
  });

  it('distinguishes no change from no comparison', () => {
    expect(changeText(0, 'February 2026')).toBe('no change vs February 2026');
    expect(changeTone(0)).toBe('flat');
  });

  it('renders a real minus sign, not a hyphen', () => {
    expect(changeText(-4, 'February 2026')).toBe('−4 vs February 2026');
    expect(changeText(3, 'February 2026')).toBe('+3 vs February 2026');
    expect(changeTone(-4)).toBe('down');
    expect(changeTone(3)).toBe('up');
  });

  it('omits the comparison month when there is not one to name', () => {
    expect(changeText(3, null)).toBe('+3');
  });
});

describe('points read as arithmetic', () => {
  it.each([[15, '+15'], [-20, '−20'], [0, '0']])('%i prints as %s', (points, text) => {
    expect(pointsText(points)).toBe(text);
  });
});

describe('every rule and every skip reason has words', () => {
  it('labels every rule in §7.3', () => {
    const ruleIds = [
      ...Object.keys(PROFITABILITY_RULES), ...Object.keys(CASH_FLOW_RULES),
      ...Object.keys(REVENUE_GROWTH_RULES), ...Object.keys(COST_CONTROL_RULES),
      ...Object.keys(CUSTOMER_QUALITY_RULES), ...Object.keys(BANKING_HEALTH_RULES),
      'C3', 'G2', 'G3', 'B1', 'B4',
    ];
    for (const rule of ruleIds) {
      expect(RULE_LABELS[rule], `${rule} needs a label`).toBeTruthy();
    }
  });

  it('labels every dimension', () => {
    for (const key of HEALTH_DIMENSION_KEYS) {
      expect(DIMENSION_LABELS[key]).toBeTruthy();
    }
  });

  it('explains every exclusion reason the engine can produce', () => {
    expect(Object.keys(EXCLUSION_TEXT).sort()).toEqual([
      'insufficient_completeness', 'no_bank_coverage', 'required_metric_missing',
    ]);
  });

  it('explains every skip reason the rules can produce', () => {
    // Every reason a rule can carry must have a sentence: a blank cell in the panel would leave the
    // arithmetic unexplained at exactly the row a reader is querying.
    const score = computeHealthScore(healthInput({ conditions: null }))!;
    for (const dimension of score.breakdown) {
      for (const rule of dimension.rules) {
        if (rule.skipped_reason === null) continue;
        expect(SKIP_TEXT[rule.skipped_reason], `${rule.rule}: ${rule.skipped_reason}`).toBeTruthy();
      }
    }
  });

  it('falls back to a sentence rather than a blank for an unknown reason', () => {
    expect(skipText('something_new')).toBe('This check could not run on this month’s data.');
    expect(skipText(null)).toBeNull();
  });
});

describe('the panel’s ordering', () => {
  it('lists included dimensions first, worst score first', () => {
    const score = computeHealthScore(healthInput({ bankCoverageRatio: 0 }))!;
    const ordered = orderedDimensions(score.breakdown);
    const included = ordered.filter((d) => d.included);
    const excluded = ordered.filter((d) => !d.included);

    expect(ordered.slice(0, included.length)).toEqual(included);
    expect(excluded.length).toBeGreaterThan(0);
    for (let i = 1; i < included.length; i += 1) {
      expect(included[i]!.score!).toBeGreaterThanOrEqual(included[i - 1]!.score!);
    }
  });
});

describe('SOW §9', () => {
  it('is one string, so no screen can paraphrase it', () => {
    expect(HEALTH_DISCLAIMER.length).toBeGreaterThan(40);
    expect(NOT_ENOUGH_DATA_TITLE).toBe('Not enough data yet');
  });
});

describe('ADR-134 · the cap sentence a reader sees', () => {
  it('says why: bank data only, AI-read figures, or both — and nothing when not capped', async () => {
    const { capNote } = await import('@/components/dashboard/health-presentation');
    const { INFERRED_CAP_NOTE, PROXY_CAP_NOTE } = await import('@/modules/health');
    expect(capNote({ capped: false, cap_reason: null })).toBeNull();
    expect(capNote({ capped: true, cap_reason: PROXY_CAP_NOTE })).toBe('Capped at 70 — based on bank data only.');
    expect(capNote({ capped: true, cap_reason: INFERRED_CAP_NOTE })).toBe('Capped at 70 — includes figures read from a PDF by AI.');
    // A breakdown stored before ADR-134 has no reason: it was the bank-only cap.
    expect(capNote({ capped: true, cap_reason: null })).toBe('Capped at 70 — based on bank data only.');
    // H-4: the cap applied but did not bind — a 65 was not cut to 65.
    expect(capNote({ capped: true, cap_reason: INFERRED_CAP_NOTE, score: 65 })).toBe('Can score at most 70 — includes figures read from a PDF by AI.');
    expect(capNote({ capped: true, cap_reason: INFERRED_CAP_NOTE, score: 70 })).toBe('Capped at 70 — includes figures read from a PDF by AI.');
  });
});
