import type { CSSProperties } from 'react';
import type { Metric, Spark } from '@/modules/departments';

/** The three `.metric` cards (`app.js#render` → `#metrics`), each with its spark. */
export function Metrics({ metrics }: { metrics: readonly Metric[] }) {
  return (
    <div className="metrics" data-section="metrics" id="metrics">
      {metrics.map((m, i) => (
        <article className="metric" key={m.label} style={{ '--apx-i': i } as CSSProperties}>
          <span className="metric-label">{m.label}</span>
          <strong className="metric-value" style={{ '--apx-i': i } as CSSProperties}>{m.value}</strong>
          <div className="metric-bottom">
            <span className="metric-change"><b>{m.change}</b><br />{m.note}</span>
            {m.spark === null ? null : m.spark.labels ? <MonthSpark spark={m.spark} labels={m.spark.labels} index={i} /> : <PlainSpark spark={m.spark} index={i} />}
          </div>
        </article>
      ))}
    </div>
  );
}

const range = (values: readonly number[]) => {
  const lo = Math.min(...values), hi = Math.max(...values);
  return { lo, span: hi - lo || 1 };
};

/** `app.js#spark`: a 52×20 line; a single value is a flat line. */
function PlainSpark({ spark, index }: { spark: Spark; index: number }) {
  const values = spark.values;
  if (values.length === 0) return null;
  const { lo, span } = range(values);
  const points = values.length === 1
    ? '0,12 25,12 50,12'
    : values.map((v, i) => `${(i * 50) / (values.length - 1)},${17 - ((v - lo) / span) * 14}`).join(' ');
  return (
    <svg className="metric-spark" viewBox="0 0 52 20" aria-hidden="true">
      <polyline className="apx-draw" pathLength={1} style={{ '--apx-len': 1, '--apx-i': index } as CSSProperties} points={points} fill="none" stroke="var(--dash-spark)" strokeWidth="1.3" />
    </svg>
  );
}

/** `app.js#monthSpark`: three months with points and labels, 124×45. */
function MonthSpark({ spark, labels, index }: { spark: Spark; labels: readonly string[]; index: number }) {
  const values = spark.values;
  if (values.length === 0) return null;
  const { lo, span } = range(values);
  const x = (i: number) => 9 + i * 53;
  const y = (v: number) => 24 - ((v - lo) / span) * 17;
  return (
    <svg className="metric-spark month-trend" viewBox="0 0 124 45" role="img" aria-label={`Three-month trend: ${spark.titles.join(', ')}`}>
      <polyline className="apx-draw" pathLength={1} style={{ '--apx-len': 1, '--apx-i': index } as CSSProperties} points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none" stroke="var(--dash-accent)" strokeWidth="1.3" />
      {values.map((v, i) => (
        <g key={i}>
          <circle className="apx-pop" style={{ '--apx-i': index * 3 + i } as CSSProperties} cx={x(i)} cy={y(v)} r="2.4" fill="var(--dash-card)" stroke="var(--dash-accent)" strokeWidth="1.3"><title>{spark.titles[i]}</title></circle>
          <text x={x(i)} y="42" textAnchor="middle" fill="var(--dash-muted)" fontSize="9">{labels[i]}</text>
        </g>
      ))}
    </svg>
  );
}
