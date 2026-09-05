import { describe, it, expect } from 'vitest';
import {
  HEALTH_CONFIG_VERSION, MIN_REQUIRED_COMPLETENESS, PROXY_CAP, PROXY_CAP_NOTE,
  computeHealthScore, dimensionScoreFromRules, scoreFromBreakdown,
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
