import { describe, it, expect } from 'vitest';
import {
  DIMENSION_WEIGHTS, HEALTH_CONFIG_VERSION, HEALTH_DIMENSION_KEYS, MIN_REQUIRED_COMPLETENESS,
  INFERRED_CAP_NOTE, PROXY_CAP, PROXY_CAP_NOTE, computeHealthScore, dimensionScoreFromRules, scoreFromBreakdown,
  type DimensionBreakdown, type RuleApplication,
} from '@/modules/health';
import {
  baselineSnapshots, healthInput, withMetric, withoutMetric,
} from '../fixtures/health';

/** Assembly: the gate, exclusion, the proxy cap, renormalisation and reproduction (§7.2, §7.4). */

describe('§7.2 the completeness gate', () => {
  it('writes no score at all for an incomplete period (ADR-030.4)', () => {
    expect(computeHealthScore(healthInput({ isComplete: false }))).toBeNull();
  });

  it('scores a complete period', () => {
    const score = computeHealthScore(healthInput());
    expect(score).not.toBeNull();
    expect(score!.score).toBeGreaterThan(0);
    expect(score!.configVersion).toBe(HEALTH_CONFIG_VERSION);
    expect(score!.dimensionsTotal).toBe(6);
  });
});

describe('§7.2 exclusion and renormalisation', () => {
  it('scales the remaining weights to 100 and reports 4 of 6', () => {
    // Customer quality loses its required metric; banking health loses its coverage.
    const snapshots = withoutMetric(baselineSnapshots(), 'customer_concentration_top1');
    const score = computeHealthScore(healthInput({ snapshots, bankCoverageRatio: 0 }))!;

    expect(score.dimensionsUsed).toBe(4);
    expect(score.dimensionsTotal).toBe(6);

    const included = score.breakdown.filter((d) => d.included);
    expect(included.map((d) => d.key)).toEqual([
      'profitability', 'cash_flow', 'revenue_growth', 'cost_control',
    ]);

    // 25/80 → 31.25 → 31.3, 15/80 → 18.75 → 18.8, each rounded once to the 1 dp §7.4 stores.
    expect(included.map((d) => d.weight_applied)).toEqual([31.3, 31.3, 18.8, 18.8]);

    /*
     * Rounding four weights to one decimal place cannot land on exactly 100 for every split —
     * here it lands on 100.2. That drift is why the score divides by the SUM OF THE STORED
     * weights rather than by 100: the number on the card is then reproducible from the breakdown
     * exactly, instead of within a rounding error (ADR-054.7).
     */
    const appliedTotal = included.reduce((t, d) => t + d.weight_applied, 0);
    expect(appliedTotal).toBeCloseTo(100, 0);
  });

  it('names the reason a dimension was excluded rather than dropping it silently', () => {
    const snapshots = withoutMetric(baselineSnapshots(), 'customer_concentration_top1');
    const score = computeHealthScore(healthInput({ snapshots, bankCoverageRatio: 0 }))!;

    const quality = score.breakdown.find((d) => d.key === 'customer_quality')!;
    expect(quality.included).toBe(false);
    expect(quality.exclusion_reason).toBe('required_metric_missing');
    expect(quality.score).toBeNull();
    expect(quality.weight_applied).toBe(0);
    expect(quality.weight_config).toBe(10);

    const banking = score.breakdown.find((d) => d.key === 'banking_health')!;
    expect(banking.exclusion_reason).toBe('no_bank_coverage');
  });

  it('excludes a dimension whose required metrics are thinner than 0.6 complete', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'net_margin', value: '0.08', completeness: MIN_REQUIRED_COMPLETENESS - 0.01,
    });
    const score = computeHealthScore(healthInput({ snapshots }))!;
    const profitability = score.breakdown.find((d) => d.key === 'profitability')!;
    expect(profitability.included).toBe(false);
    expect(profitability.exclusion_reason).toBe('insufficient_completeness');
  });

  it('includes a dimension exactly at 0.6', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'net_margin', value: '0.08', completeness: MIN_REQUIRED_COMPLETENESS,
    });
    const score = computeHealthScore(healthInput({ snapshots }))!;
    expect(score.breakdown.find((d) => d.key === 'profitability')!.included).toBe(true);
  });

  it('returns a NULL score when fewer than three dimensions survive', () => {
    let snapshots = withoutMetric(baselineSnapshots(), 'customer_concentration_top1');
    snapshots = withoutMetric(snapshots, 'net_margin');
    snapshots = withoutMetric(snapshots, 'revenue_growth_yoy');
    snapshots = withoutMetric(snapshots, 'revenue_growth_mom');
    snapshots = withoutMetric(snapshots, 'operating_expenses');

    const score = computeHealthScore(healthInput({ snapshots, bankCoverageRatio: 0 }))!;
    expect(score.dimensionsUsed).toBeLessThan(3);
    expect(score.score).toBeNull();
    expect(score.band).toBeNull();
  });
});

describe('§7.2 the proxy cap (F-B-09)', () => {
  it('includes a dimension resting on estimated figures, capped at 70, with the note', () => {
    // Give profitability a strong hand, then mark its required figures as bank estimates.
    let snapshots = withMetric(baselineSnapshots(), {
      key: 'net_margin', value: '0.30', assurance: 'estimated', proxy: true,
    });
    snapshots = withMetric(snapshots, {
      key: 'gross_margin', value: '0.60', assurance: 'estimated', proxy: true,
    });

    const score = computeHealthScore(healthInput({ snapshots }))!;
    const profitability = score.breakdown.find((d) => d.key === 'profitability')!;

    expect(profitability.included).toBe(true);
    expect(profitability.score).toBe(PROXY_CAP);
    expect(profitability.capped).toBe(true);
    expect(profitability.cap_reason).toBe(PROXY_CAP_NOTE);
    expect(score.capped).toBe(true);
  });

  it('caps on data_quality.proxy alone, even when the assurance level is calculated', () => {
    const snapshots = withMetric(baselineSnapshots(), {
      key: 'net_margin', value: '0.30', assurance: 'calculated', proxy: true,
    });
    const dimension = computeHealthScore(healthInput({ snapshots }))!
      .breakdown.find((d) => d.key === 'profitability')!;
    expect(dimension.capped).toBe(true);
    expect(dimension.score).toBe(PROXY_CAP);
  });

  it('ADR-134: a dimension resting on AI-read (inferred) figures is capped too, and says so', () => {
    let snapshots = withMetric(baselineSnapshots(), { key: 'net_margin', value: '0.30', assurance: 'inferred' });
    snapshots = withMetric(snapshots, { key: 'gross_margin', value: '0.60', assurance: 'inferred' });
    const score = computeHealthScore(healthInput({ snapshots }))!;
    const profitability = score.breakdown.find((d) => d.key === 'profitability')!;
    expect(profitability.included).toBe(true);
    expect(profitability.score).toBe(PROXY_CAP);
    expect(profitability.capped).toBe(true);
    expect(profitability.cap_reason).toBe(INFERRED_CAP_NOTE);
    expect(score.capped).toBe(true);
  });

  it('ADR-134: the same strong figures, verified, are not capped — the cap is about assurance alone', () => {
    let snapshots = withMetric(baselineSnapshots(), { key: 'net_margin', value: '0.30', assurance: 'verified' });
    snapshots = withMetric(snapshots, { key: 'gross_margin', value: '0.60', assurance: 'verified' });
    const profitability = computeHealthScore(healthInput({ snapshots }))!.breakdown.find((d) => d.key === 'profitability')!;
    expect(profitability.capped).toBe(false);
    expect(profitability.score).toBeGreaterThan(PROXY_CAP);
    expect(profitability.cap_reason).toBeNull();
  });

  it('ADR-134: bank-only AND AI-read names both reasons', () => {
    let snapshots = withMetric(baselineSnapshots(), { key: 'net_margin', value: '0.30', assurance: 'inferred' });
    snapshots = withMetric(snapshots, { key: 'gross_margin', value: '0.60', assurance: 'estimated', proxy: true });
    const profitability = computeHealthScore(healthInput({ snapshots }))!.breakdown.find((d) => d.key === 'profitability')!;
    expect(profitability.cap_reason).toBe(`${PROXY_CAP_NOTE}, and ${INFERRED_CAP_NOTE}`);
  });

  it('does not raise a weak dimension to the cap', () => {
    // A capped dimension scoring below 70 keeps its own score; the cap is a ceiling, not a floor.
    let snapshots = withMetric(baselineSnapshots(), {
      key: 'net_margin', value: '-0.10', assurance: 'estimated', proxy: true,
    });
    snapshots = withMetric(snapshots, {
      key: 'gross_margin', value: '0.10', assurance: 'estimated', proxy: true,
    });
    const dimension = computeHealthScore(healthInput({ snapshots }))!
      .breakdown.find((d) => d.key === 'profitability')!;
    expect(dimension.score).toBeLessThan(PROXY_CAP);
    expect(dimension.capped).toBe(true);
  });
});

describe('§7.4 explainability reproduction', () => {
  it('re-derives the score from the stored breakdown alone', () => {
    const score = computeHealthScore(healthInput())!;
    expect(scoreFromBreakdown(score.breakdown)).toBe(score.score);
  });

  it('re-derives every dimension score from its stored rules alone', () => {
    const score = computeHealthScore(healthInput())!;
    for (const dimension of score.breakdown.filter((d) => d.included)) {
      expect(dimensionScoreFromRules(dimension), dimension.key).toBe(dimension.score);
    }
  });

  it('reproduces after renormalisation and after a cap', () => {
    let snapshots = withoutMetric(baselineSnapshots(), 'customer_concentration_top1');
    snapshots = withMetric(snapshots, {
      key: 'net_margin', value: '0.30', assurance: 'estimated', proxy: true,
    });
    const score = computeHealthScore(healthInput({ snapshots, bankCoverageRatio: 0.4 }))!;
    expect(scoreFromBreakdown(score.breakdown)).toBe(score.score);
    for (const dimension of score.breakdown.filter((d) => d.included)) {
      expect(dimensionScoreFromRules(dimension), dimension.key).toBe(dimension.score);
    }
  });

  it('pins the snapshot behind every metric a dimension rested on', () => {
    const score = computeHealthScore(healthInput())!;
    const profitability = score.breakdown.find((d) => d.key === 'profitability')!;
    const netMargin = profitability.metrics.find((m) => m.metric_key === 'net_margin')!;
    expect(netMargin.snapshot_id).toMatch(/^snap-/);
    expect(netMargin.value).toBe('0.08');
  });
});

describe('determinism', () => {
  it('two runs over identical data produce identical output', () => {
    const first = computeHealthScore(healthInput());
    const second = computeHealthScore(healthInput());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('the breakdown is in a fixed dimension order', () => {
    const score = computeHealthScore(healthInput())!;
    expect(score.breakdown.map((d) => d.key)).toEqual([
      'profitability', 'cash_flow', 'revenue_growth', 'cost_control',
      'customer_quality', 'banking_health',
    ]);
  });

  it('does not depend on the order snapshots arrive in', () => {
    const snapshots = baselineSnapshots();
    const forward = computeHealthScore(healthInput({ snapshots }))!;
    const reversed = computeHealthScore(healthInput({ snapshots: [...snapshots].reverse() }))!;
    expect(reversed.score).toBe(forward.score);
    expect(reversed.breakdown.map((d) => d.score)).toEqual(forward.breakdown.map((d) => d.score));
  });
});

/**
 * The 0 and 100 boundaries (Phase 6 brief).
 *
 * §7.3 starts every dimension at 50 and lets rules add and subtract; profitability's four rules can
 * reach +55 and −65, so both bounds are reachable from real rule combinations rather than from
 * contrived arithmetic. The clamp is what stops a run of good months reporting 105 out of 100, and
 * a catastrophic one reporting a negative score — either would be visibly wrong to a customer, and
 * both would break the "0–100" the product promises.
 */
describe('score boundaries (0 and 100)', () => {
  const rules = (points: readonly number[]): RuleApplication[] =>
    points.map((p, i) => ({ rule: `R${i + 1}`, result: 'band', points: p, value: '0', skipped_reason: null }));
  const dimension = (over: Partial<DimensionBreakdown>): DimensionBreakdown => ({
    key: 'profitability', score: null, weight_config: 25, weight_applied: 25, included: true,
    exclusion_reason: null, metrics: [], rules: [], conditions: [], capped: false, cap_reason: null,
    positives: [], negatives: [], positives_structured: [], negatives_structured: [],
    data_quality: { completeness: 1, warnings: [] }, ...over,
  });

  it('clamps a dimension at 100 when its rules would take it past the top', () => {
    // 50 + 30 + 10 + 10 + 5 = 105 — profitability's own maximum.
    expect(dimensionScoreFromRules(dimension({ rules: rules([30, 10, 10, 5]) }))).toBe(100);
    expect(dimensionScoreFromRules(dimension({ rules: rules([30, 10, 10, 5, 40]) }))).toBe(100);
  });

  it('clamps a dimension at 0 when its rules would take it below the bottom', () => {
    // 50 − 30 − 10 − 15 − 10 = −15 — profitability's own minimum.
    expect(dimensionScoreFromRules(dimension({ rules: rules([-30, -10, -15, -10]) }))).toBe(0);
    expect(dimensionScoreFromRules(dimension({ rules: rules([-30, -10, -15, -10, -40]) }))).toBe(0);
  });

  it('lands exactly on 100 and exactly on 0 without stepping past them', () => {
    expect(dimensionScoreFromRules(dimension({ rules: rules([50]) }))).toBe(100);
    expect(dimensionScoreFromRules(dimension({ rules: rules([-50]) }))).toBe(0);
  });

  it('reports an overall 100 when every included dimension is at the top, and 0 when all are at the bottom', () => {
    const all = (score: number) => HEALTH_DIMENSION_KEYS.map((key) => dimension({
      key, score, weight_config: DIMENSION_WEIGHTS[key], weight_applied: DIMENSION_WEIGHTS[key],
    }));
    expect(scoreFromBreakdown(all(100))).toBe(100);
    expect(scoreFromBreakdown(all(0))).toBe(0);
  });

  it('a capped dimension cannot exceed the cap even when its rules reach the top', () => {
    expect(dimensionScoreFromRules(dimension({ rules: rules([30, 10, 10, 5]), capped: true }))).toBe(PROXY_CAP);
  });
});

/**
 * H-3 (independent audit of c5a8473): the ADR-134 cap looked only at a dimension's REQUIRED metrics.
 * Banking health has none, so it could never be capped; cash flow's C3 reads earlier months' movement
 * that the cap never saw. The cap now looks at every figure a rule actually scored.
 */
describe('H-3 · the cap reaches every input a rule scored', () => {
  // Strong banking: closing cash rising 40k → 45k → 50k (B1 +), inflows 100k against outflows 80k (B2 +15).
  const strongBanking = (assurance: 'verified' | 'inferred', which: 'p2' | 'inflows') => {
    let s = withMetric(baselineSnapshots(), { key: 'closing_cash', value: '40000', unit: 'money', periodId: 'p-2026-01',
      assurance: which === 'p2' ? assurance : 'verified' });
    s = withMetric(s, { key: 'closing_cash', value: '45000', unit: 'money', periodId: 'p-2026-02' });
    s = withMetric(s, { key: 'closing_cash', value: '50000', unit: 'money' });
    s = withMetric(s, { key: 'cash_inflows', value: '100000', unit: 'money', assurance: which === 'inflows' ? assurance : 'verified' });
    return s;
  };
  const banking = (snapshots: ReturnType<typeof baselineSnapshots>) =>
    computeHealthScore(healthInput({ snapshots }))!.breakdown.find((d) => d.key === 'banking_health')!;

  it('banking health scored on verified figures is not capped (control)', () => {
    const b = banking(strongBanking('verified', 'p2'));
    expect(b.capped).toBe(false);
    expect(b.score).toBeGreaterThan(PROXY_CAP);
  });

  it('B1 reading an AI-read closing two months back caps banking health at 70', () => {
    const b = banking(strongBanking('inferred', 'p2'));
    expect(b.capped).toBe(true);
    expect(b.score).toBe(PROXY_CAP);
    expect(b.cap_reason).toBe(INFERRED_CAP_NOTE);
  });

  it('B2 reading AI-read inflows caps banking health at 70', () => {
    const b = banking(strongBanking('inferred', 'inflows'));
    expect(b.capped).toBe(true);
    expect(b.score).toBe(PROXY_CAP);
  });

  it('cash flow: C3 reading an AI-read movement from an earlier month caps the dimension', () => {
    const snapshots = withMetric(baselineSnapshots(), { key: 'net_cash_movement', value: '1000', unit: 'money',
      periodId: 'p-2026-02', assurance: 'inferred' });
    const cashFlow = computeHealthScore(healthInput({ snapshots }))!.breakdown.find((d) => d.key === 'cash_flow')!;
    expect(cashFlow.capped).toBe(true);
    expect(cashFlow.cap_reason).toBe(INFERRED_CAP_NOTE);
    expect(cashFlow.score).toBeLessThanOrEqual(PROXY_CAP);
  });

  it('a weak figure no rule scored does not cap (an AI-read month outside every rule\'s window)', () => {
    const snapshots = withMetric(baselineSnapshots(), { key: 'net_cash_movement', value: '1000', unit: 'money',
      periodId: 'p-2025-10', assurance: 'inferred' });
    const cashFlow = computeHealthScore(healthInput({ snapshots }))!.breakdown.find((d) => d.key === 'cash_flow')!;
    expect(cashFlow.capped).toBe(false);
  });
});
