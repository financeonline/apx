import type { CSSProperties } from 'react';
import type { Mix } from '@/modules/departments';
import { DataIcon } from './icon';

const COLORS = ['#c12591', '#3284d8', '#dce9f9'] as const;
const CIRCUMFERENCE = 339.292; // 2π × 54

/** "The bigger picture" donut (`app.js#render` → `#donut-chart`, `#mix-legend`). */
export function RevenueMix({ mix }: { mix: Mix }) {
  // Each segment starts where the shares before it end.
  const starts = mix.slices.map((_, i) => mix.slices.slice(0, i).reduce((acc, s) => acc + s.share, 0));
  const segments = mix.slices.map((slice, i) => {
    const offset = starts[i] ?? 0;
    const dash = Math.max(0, (slice.share * CIRCUMFERENCE) / 100 - 3);
    const segment = (
      <circle
        key={slice.label}
        className="apx-sweep"
        style={{ '--apx-len': CIRCUMFERENCE, '--apx-i': i } as CSSProperties}
        cx="70" cy="70" r="54" fill="none"
        stroke={COLORS[i] ?? COLORS[2]}
        strokeWidth="13"
        strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
        strokeDashoffset={(-offset * CIRCUMFERENCE) / 100}
      />
    );
    return segment;
  });
  const label = `${mix.title}: ${mix.slices.map((s) => `${s.label} ${s.shareDisplay}`).join(', ') || 'no figures yet'}`;

  return (
    <section className="chart-card composition-card" data-section="composition" style={{ '--apx-i': 2 } as CSSProperties}>
      <div className="chart-heading">
        <div><span className="eyebrow">THE BIGGER PICTURE</span><h3 id="composition-title">{mix.title}</h3></div>
        <DataIcon name="pie" className="muted-icon" />
      </div>
      <div className="composition">
        <div className="donut-wrap">
          <svg id="donut-chart" viewBox="0 0 140 140" role="img" aria-label={label}>
            <circle cx="70" cy="70" r="54" fill="none" stroke="#f6edf3" strokeWidth="13" />
            {segments}
          </svg>
          <div className="donut-label"><strong id="donut-value">{mix.total}</strong><span id="donut-caption">{mix.caption}</span></div>
        </div>
        <div className="mix-legend" id="mix-legend">
          {mix.slices.map((s, i) => (
            <div className="mix-row" key={s.label}><i style={{ background: COLORS[i] ?? COLORS[2] }} /><span>{s.label}</span><strong>{s.shareDisplay}</strong></div>
          ))}
        </div>
      </div>
    </section>
  );
}
