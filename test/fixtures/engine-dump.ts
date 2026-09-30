/**
 * What the engine regression record compares (ADR-124): for one organisation, every headline figure
 * with its basis, assurance and data quality, every Health breakdown rule by rule, and every alert.
 * Keyed by period start, never by id, so two runs on two seedings of the same fixture compare
 * line for line. Adapted from the second independent audit's dump (docs/ADR-120_SECOND_INDEPENDENT_AUDIT.md §1).
 */
import { adminSql } from '../integration/setup';

export interface EngineDump {
  readonly engineVersions: readonly string[];
  readonly metrics: readonly string[];
  readonly health: ReadonlyArray<{
    readonly period: string;
    readonly score: number | null;
    readonly used: number | null;
    readonly dimensions: ReadonlyArray<{
      readonly key: string;
      readonly score: number | null;
      readonly included: boolean;
      readonly exclusion: string | null;
      readonly rules: ReadonlyArray<{ readonly rule: string; readonly result: string; readonly points: number | null }> | null;
    }> | null;
  }>;
  readonly alerts: readonly string[];
}

const lines = (sql: string): string[] => adminSql(sql).split('\n').map((l) => l.trim()).filter(Boolean);

export function engineDump(org: string): EngineDump {
  const metrics = lines(`select p.period_start || '|' || c.metric_key || '|' || coalesce(s.value::text, 'NULL') || '|' || s.basis
      || '|' || s.assurance_level || '|c=' || coalesce(s.data_quality->>'completeness', '?')
      || '|m=' || coalesce((s.data_quality->'missing')::text, '[]') || '|w=' || coalesce((s.data_quality->'warnings')::text, '[]')
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
    where c.organization_id = '${org}' and c.dimension_type = 'none' order by 1`);
  const health = lines(`select json_build_object('period', p.period_start, 'score', h.score, 'used', h.dimensions_used,
      'dimensions', (select json_agg(json_build_object('key', d->>'key', 'score', d->'score', 'included', d->'included',
        'exclusion', d->'exclusion_reason', 'rules', (select json_agg(json_build_object('rule', r->>'rule', 'result', r->>'result', 'points', r->'points'))
          from jsonb_array_elements(d->'rules') r))) from jsonb_array_elements(h.breakdown) d))::text
    from public.health_current hc join public.health_scores h on h.id = hc.health_score_id and h.organization_id = hc.organization_id
    join public.fiscal_periods p on p.id = hc.period_id and p.organization_id = hc.organization_id
    where hc.organization_id = '${org}' order by p.period_start`).map((l) => JSON.parse(l) as EngineDump['health'][number]);
  const alerts = lines(`select a.rule_key || '|' || coalesce(a.subject_type::text, '-') || '|' || a.status || '|' || a.severity
      || '|' || p.period_start || '|' || coalesce(a.threshold_summary::text, '{}')
    from public.alerts a join public.fiscal_periods p on p.id = a.period_id and p.organization_id = a.organization_id
    where a.organization_id = '${org}' order by 1`);
  const engineVersions = lines(`select distinct engine_version from public.calculation_runs
    where organization_id = '${org}' and status = 'succeeded' order by 1`);
  return { engineVersions, metrics, health, alerts };
}
