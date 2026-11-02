'use client';

import { useState, type CSSProperties } from 'react';
import type { MainChart as MainChartView } from '@/modules/departments';
import { useDash } from './dash-context';
import { DataIcon } from './icon';
import { downloadChartCsv, unitLabel, type ExportMeta } from './export-csv';

/**
 * The main performance chart (`app.js#renderChart`): legend toggles (one series always stays —
 * "Keep at least one chart series visible."), Compare baseline, the area under the first series,
 * focusable points with the tooltip, the axis ticks, the insight and figure underneath, and the
 * "View chart data" table. The values are the service's; this only places them on the 680×235 plot.
 * A month without a figure is a gap in the line, never a zero.
 */
const W = 680, H = 235, LEFT = 43, RIGHT = 17, TOP = 17, BOTTOM = 32;
const PLOT_W = W - LEFT - RIGHT, PLOT_H = H - TOP - BOTTOM;
const COLORS = ['var(--dash-accent)', 'var(--dash-second)'] as const;

type Pt = { x: number; y: number; i: number };

/** Consecutive known points: each run is one polyline (a null breaks the line). */
function runs(values: readonly (number | null)[], x: (i: number) => number, y: (v: number) => number): Pt[][] {
  const out: Pt[][] = [];
  let current: Pt[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) { if (current.length) out.push(current); current = []; return; }
    current.push({ x: x(i), y: y(v), i });
  });
  if (current.length) out.push(current);
  return out;
}
const pts = (run: Pt[]) => run.map((p) => `${p.x},${p.y}`).join(' ');

export function MainChart({ chart, meta }: { chart: MainChartView; meta: ExportMeta }) {
  const { notify, showDialog, closeDialog } = useDash();
  const [visible, setVisible] = useState<[boolean, boolean]>([true, true]);
  const [compare, setCompare] = useState(true);
  const [tip, setTip] = useState<string | null>(null);

  const n = chart.labels.length;
  const cap = chart.cap > 0 ? chart.cap : 1;
  const x = (i: number) => (n === 1 ? LEFT + PLOT_W / 2 : LEFT + (i * PLOT_W) / (n - 1));
  const y = (v: number) => TOP + PLOT_H - (v / cap) * PLOT_H;
  const tickY = (i: number) => TOP + PLOT_H - (i / Math.max(1, chart.ticks.length - 1)) * PLOT_H;
  const hasBaseline = chart.baseline !== null && chart.baseline.some((v) => v !== null);
  const showBaseline = compare && hasBaseline;

  function toggle(index: 0 | 1) {
    const next: [boolean, boolean] = [visible[0], visible[1]];
    next[index] = !next[index];
    if (!next.some(Boolean)) { notify('Keep at least one chart series visible.'); return; }
    setVisible(next);
  }

  function showData() {
    const unitCaption = chart.unit === 'money'
      ? `Amounts in ${meta.currency}, rounded to the nearest whole unit.`
      : `Amounts in ${unitLabel(meta, chart.unit).toLowerCase()}.`;
    showDialog('CHART DATA · ACTUAL FIGURES', (
      <>
        <h2 id="dialog-title">{chart.title}</h2>
        <div className="dialog-copy">{meta.period} · {meta.scenario}</div>
        <table className="data-table">
          <caption>{unitCaption} Baseline: {chart.baselineLabel.toLowerCase()}.</caption>
          <thead><tr><th scope="col">Period</th><th scope="col">{chart.series[0]}</th><th scope="col">{chart.series[1]}</th><th scope="col">Baseline</th></tr></thead>
          <tbody>
            {chart.rows.map((r) => (
              <tr key={r.period}><th scope="row">{r.period}</th><td>{r.first}</td><td>{r.second}</td><td>{r.baseline}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="dialog-copy">
          <p>Baseline: {chart.baselineLabel}, from the company’s own figures where APX has them. A dash means no figure for that month — it is never counted as zero.</p>
        </div>
      </>
    ), <button type="button" className="secondary-button" onClick={closeDialog}>Close</button>);
  }

  const firstRuns = runs(chart.first, x, y);
  const secondRuns = runs(chart.second, x, y);
  const baselineRuns = chart.baseline ? runs(chart.baseline, x, y) : [];
  const bottomY = TOP + PLOT_H;

  return (
    <section className="chart-card" data-section="performance" style={{ '--apx-i': 0 } as CSSProperties}>
      <div className="chart-heading">
        <div><span className="eyebrow" id="chart-kicker">{chart.kicker}</span><h3 id="chart-title">{chart.title}</h3></div>
        <button type="button" id="data-btn" className="icon-btn" aria-label="View chart data" title="View chart data" onClick={showData}><DataIcon name="table" /></button>
      </div>
      <div className="chart-controls">
        <div className="legend" id="line-legend">
          {chart.series.map((s, i) => (
            <button
              type="button"
              key={s}
              data-series={i}
              aria-pressed={visible[i]}
              aria-label={`${visible[i] ? 'Hide' : 'Show'} ${s}`}
              onClick={() => toggle(i as 0 | 1)}
            >
              <i className={`legend-line ${i ? 'secondary' : ''}`} />{s}
            </button>
          ))}
        </div>
        <label className="compare" title={hasBaseline ? undefined : 'No figures for the same months last year'}>
          <input type="checkbox" id="compare" checked={showBaseline} disabled={!hasBaseline} onChange={(e) => setCompare(e.target.checked)} /> Compare baseline
        </label>
      </div>
      <div className="chart-wrap">
        <svg id="main-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="chart-title chart-desc">
          <defs>
            <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop stopColor="var(--dash-accent)" stopOpacity=".1" /><stop offset="1" stopColor="var(--dash-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {chart.ticks.map((label, i) => (
            <g key={`t${i}`}>
              <line className="chart-grid" x1={LEFT} x2={W - RIGHT} y1={tickY(i)} y2={tickY(i)} />
              <text className="chart-label" x={LEFT - 10} y={tickY(i) + 3} textAnchor="end">{label}</text>
            </g>
          ))}
          {visible[0] && n > 1 ? firstRuns.filter((r) => r.length > 1).map((run, k) => (
            <polygon
              key={`a${k}`}
              className="apx-fade"
              points={`${run[0]!.x},${bottomY} ${pts(run)} ${run.at(-1)!.x},${bottomY}`}
              fill="url(#area-fill)"
            />
          )) : null}
          {showBaseline ? baselineRuns.map((run, k) => (
            run.length > 1
              ? <polyline key={`b${k}`} className="apx-fade" points={pts(run)} fill="none" stroke="var(--dash-baseline)" strokeWidth="1.5" strokeDasharray="5 5" />
              : <circle key={`b${k}`} className="apx-pop" cx={run[0]!.x} cy={run[0]!.y} r="4" fill="var(--dash-baseline)" />
          )) : null}
          {([firstRuns, secondRuns] as const).map((seriesRuns, j) => {
            if (!visible[j]) return null;
            const color = COLORS[j];
            const titles = j ? chart.secondTitles : chart.firstTitles;
            return (
              <g key={`s${j}`}>
                {seriesRuns.filter((r) => r.length > 1).map((run, k) => (
                  <polyline
                    key={`l${k}`}
                    className="apx-draw"
                    pathLength={1}
                    style={{ '--apx-len': 1, '--apx-i': j } as CSSProperties}
                    points={pts(run)}
                    fill="none"
                    stroke={color}
                    strokeWidth="2.4"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
                {seriesRuns.flat().map((p) => {
                  const title = titles[p.i] ?? '';
                  return (
                    <circle
                      key={`p${p.i}`}
                      className="data-point apx-pop"
                      style={{ '--apx-i': p.i + j * n } as CSSProperties}
                      data-point={`${j}-${p.i}`}
                      cx={p.x}
                      cy={p.y}
                      r="3.5"
                      stroke={color}
                      strokeWidth="1.8"
                      fill="white"
                      tabIndex={0}
                      role="img"
                      aria-label={title}
                      onPointerEnter={() => setTip(title)}
                      onFocus={() => setTip(title)}
                      onPointerLeave={() => setTip(null)}
                      onBlur={() => setTip(null)}
                    >
                      <title>{title}</title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
          {chart.labels.map((label, i) => (
            <text key={`x${i}`} className="chart-label" textAnchor="middle" x={x(i)} y={H - 9}>{label}</text>
          ))}
        </svg>
        <p className="sr-only" id="chart-desc">{chart.description}</p>
        <div className="chart-tooltip" id="chart-tooltip" role="status" hidden={tip === null}>{tip}</div>
      </div>
      <div className="chart-bottom">
        <span><span className="small-dot" /><span id="chart-insight">{chart.insight}</span></span>
        <strong id="chart-growth">{chart.figure}</strong>
      </div>
    </section>
  );
}

/** "Export" in the section heading: the same CSV as the chart (`#export-btn`). */
export function ExportButton({ chart, meta }: { chart: MainChartView; meta: ExportMeta }) {
  const { notify } = useDash();
  return (
    <button
      type="button"
      className="subtle-button export-btn"
      id="export-btn"
      onClick={() => { downloadChartCsv(chart, meta); notify('Dashboard data exported as CSV.'); }}
    >
      <DataIcon name="download" /> Export
    </button>
  );
}
