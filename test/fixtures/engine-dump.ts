/**
 * What the engine regression record compares (ADR-124): for one organisation, every headline figure
 * with its basis, assurance and data quality, every Health breakdown rule by rule, and every alert.
 * Keyed by period start, never by id, so two runs on two seedings of the same fixture compare
 * line for line. Adapted from the second independent audit's dump (docs/ADR-120_SECOND_INDEPENDENT_AUDIT.md §1).
 *
 * Read from Firestore (FIRESTORE_DATA_MODEL.md §3) and printed EXACTLY as the PostgreSQL dump's text
 * casts printed it — a `numeric(20,6)` value with its six places, `jsonb::text` with PostgreSQL's
 * spacing and key order — so a dump taken before the move compares line for line with one taken after.
 */
import { Decimal } from '@/core/money/decimal';
import { orgCollection } from '@/db/schema';
import { fs } from '../integration/setup';

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

/**
 * `jsonb::text`: `", "` between elements, `": "` after a key, and an object's keys in jsonb's own
 * order — shorter keys first, then by bytes (that is how jsonb stores them, whatever order they
 * were written in).
 */
export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => {
      const la = Buffer.byteLength(a); const lb = Buffer.byteLength(b);
      return la !== lb ? la - lb : Buffer.compare(Buffer.from(a), Buffer.from(b));
    });
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText((value as Record<string, unknown>)[k])}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** `metric_snapshots.value::text`: a `numeric(20,6)` with its six places, or null. */
export function metricValueText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return new Decimal(String(value)).toFixed(6);
}

/** Byte order, as `order by 1` over these ASCII keys sorts. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function engineDump(org: string): Promise<EngineDump> {
  const f = fs();
  const [periodsSnap, currentSnap, healthCurrentSnap, alertsSnap, runsSnap] = await Promise.all([
    orgCollection(f, org, 'fiscal_periods').get(),
    orgCollection(f, org, 'metric_current').where('dimension_type', '==', 'none').get(),
    orgCollection(f, org, 'health_current').get(),
    orgCollection(f, org, 'alerts').get(),
    orgCollection(f, org, 'calculation_runs').where('status', '==', 'succeeded').get(),
  ]);
  const periodStart = new Map(periodsSnap.docs.map((d) => [d.id, String(d.get('period_start'))]));

  const snapshotRefs = currentSnap.docs.map((c) => orgCollection(f, org, 'metric_snapshots').doc(String(c.get('snapshot_id'))));
  const snapshots = snapshotRefs.length > 0 ? await f.getAll(...snapshotRefs) : [];
  const metrics: string[] = [];
  currentSnap.docs.forEach((c, i) => {
    const s = snapshots[i];
    const start = periodStart.get(String(c.get('period_id')));
    if (!s?.exists || start === undefined) return; // the SQL's inner joins
    const dq = (s.get('data_quality') ?? {}) as Record<string, unknown>;
    const completeness = dq.completeness === undefined || dq.completeness === null ? '?' : String(dq.completeness);
    metrics.push(`${start}|${String(c.get('metric_key'))}|${metricValueText(s.get('value')) ?? 'NULL'}|${String(s.get('basis'))}`
      + `|${String(s.get('assurance_level'))}|c=${completeness}`
      + `|m=${dq.missing === undefined || dq.missing === null ? '[]' : jsonbText(dq.missing)}`
      + `|w=${dq.warnings === undefined || dq.warnings === null ? '[]' : jsonbText(dq.warnings)}`);
  });
  metrics.sort(byText);

  const scoreRefs = healthCurrentSnap.docs.map((h) => orgCollection(f, org, 'health_scores').doc(String(h.get('health_score_id'))));
  const scores = scoreRefs.length > 0 ? await f.getAll(...scoreRefs) : [];
  const health: Array<EngineDump['health'][number]> = [];
  healthCurrentSnap.docs.forEach((hc, i) => {
    const h = scores[i];
    const start = periodStart.get(String(hc.get('period_id')));
    if (!h?.exists || start === undefined) return;
    const breakdown = h.get('breakdown') as Array<Record<string, unknown>> | null | undefined;
    // `json_agg` over an empty set is NULL; jsonb `->` of an absent key is NULL.
    const dimensions = Array.isArray(breakdown) && breakdown.length > 0
      ? breakdown.map((d) => {
        const rules = d.rules as Array<Record<string, unknown>> | null | undefined;
        return {
          key: d.key === undefined || d.key === null ? null as unknown as string : String(d.key),
          score: (d.score ?? null) as number | null,
          included: (d.included ?? null) as boolean,
          exclusion: (d.exclusion_reason ?? null) as string | null,
          rules: Array.isArray(rules) && rules.length > 0
            ? rules.map((r) => ({
              rule: r.rule === undefined || r.rule === null ? null as unknown as string : String(r.rule),
              result: r.result === undefined || r.result === null ? null as unknown as string : String(r.result),
              points: (r.points ?? null) as number | null,
            }))
            : null,
        };
      })
      : null;
    health.push({
      period: start, score: (h.get('score') ?? null) as number | null, used: (h.get('dimensions_used') ?? null) as number | null,
      dimensions,
    });
  });
  health.sort((a, b) => byText(a.period, b.period));

  const alerts: string[] = [];
  for (const a of alertsSnap.docs) {
    const start = periodStart.get(String(a.get('period_id')));
    if (start === undefined) continue;
    const summary = a.get('threshold_summary');
    alerts.push(`${String(a.get('rule_key'))}|${a.get('subject_type') == null ? '-' : String(a.get('subject_type'))}`
      + `|${String(a.get('status'))}|${String(a.get('severity'))}|${start}|${summary == null ? '{}' : jsonbText(summary)}`);
  }
  alerts.sort(byText);

  const engineVersions = [...new Set(runsSnap.docs.map((r) => String(r.get('engine_version'))))].sort(byText);
  return { engineVersions, metrics, health, alerts };
}
