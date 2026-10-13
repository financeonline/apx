import type { LineChart, PresentedChart, RiskChart, RiskLevel, SplitChart } from '@/modules/investment';
import {
  CHART_FILL, CHART_STROKE, chartClass, chartDash, columnX, polylinePoints, segmentsFor, valueY,
  type ChartBox, type ChartScale, type TrendSeriesView,
} from '@/components/dashboard/presentation';
import { ChartFrame } from './chart-frame';

/**
 * The pack's four charts on screen (ADR-171), drawn by hand in SVG and CSS as the app's other charts
 * are (`components/dashboard/trend-chart.tsx` — the app uses no charting library), in the chart
 * tokens `--color-chart-1..6` through their Tailwind utilities, never a hex value:
 *
 *   - the surplus split as a DONUT, with a key naming each part, its share and its amount;
 *   - the five-year revenue and profit scenarios as LINE charts: a money axis from zero (so a small
 *     figure is never flattered), a line per scenario in its own colour AND dash pattern, a dot per
 *     year, and the scenario's name at the end of its line — never told apart by colour alone;
 *   - the relative risk positioning as a GRID of the six levels, lower to very high, each option's
 *     dot in its level's column.
 *
 * Every figure, label and axis tick arrives as text or as a plotted number from the presentation
 * (`presentInvestmentReport`); the only arithmetic here is pixel geometry. Each chart sits in a
 * `ChartFrame`, which carries its summary and its table — the text equivalent.
 */

/** The chart palette as fills for HTML swatches (static, so Tailwind sees them). */
const CHART_BG = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6'] as const;

/** Each risk level's colour index, as the printed files' (`RISK_CHART_INDEX`): green to coral. */
const RISK_BG: Readonly<Record<RiskLevel, string>> = {
  lower: 'bg-chart-5', low_medium: 'bg-chart-3', medium: 'bg-chart-4', higher: 'bg-chart-2', high: 'bg-chart-1', very_high: 'bg-chart-1',
};

const LINE_BOX: ChartBox = { width: 720, height: 280, padding: { top: 16, right: 112, bottom: 32, left: 96 } };

/** Moves end labels apart where two lines finish close together: at least `gap` pixels between them. */
function spread(positions: readonly { readonly key: number; readonly y: number }[], gap: number): Map<number, number> {
  const sorted = [...positions].sort((a, b) => b.y - a.y);
  const placed = new Map<number, number>();
  let previous = Number.POSITIVE_INFINITY;
  for (const p of sorted) {
    const y = Math.min(p.y, previous - gap);
    placed.set(p.key, y);
    previous = y;
  }
  return placed;
}

function LineChartView({ chart }: { chart: LineChart }) {
  const box = LINE_BOX;
  const scale: ChartScale = { min: 0, max: chart.max > 0 ? chart.max : 1, empty: false };
  const views: TrendSeriesView[] = chart.series.map((s) => ({
    key: s.key,
    label: s.label,
    points: chart.categories.map((category, i) => ({ periodId: `${i}`, periodLabel: category, value: s.values[i] ?? null, display: s.displays[i] ?? '' })),
  }));
  const plotted = views.map((view) => segmentsFor(view, scale, box));
  const ends = spread(plotted.flatMap((segments, index) => {
    const last = segments.at(-1)?.at(-1);
    return last ? [{ key: index, y: last.y }] : [];
  }), 14);

  return (
    <svg role="img" aria-label={chart.summary} viewBox={`0 0 ${box.width} ${box.height}`} className="h-auto w-full">
      {chart.ticks.map((tick) => {
        const y = valueY(tick.value, scale, box);
        return (
          <g key={tick.value}>
            <line
              x1={box.padding.left} x2={box.width - box.padding.right} y1={y} y2={y}
              className={tick.value === 0 ? 'stroke-line-strong' : 'stroke-line'} strokeWidth="1"
            />
            <text x={box.padding.left - 10} y={y + 4} textAnchor="end" className="fill-current text-[11px] text-ink-faint tabular">{tick.label}</text>
          </g>
        );
      })}
      {chart.categories.map((category, i) => (
        <text key={category} x={columnX(i, chart.categories.length, box)} y={box.height - 10} textAnchor="middle" className="fill-current text-[11px] text-ink-faint">
          {category}
        </text>
      ))}
      {plotted.map((segments, index) => (
        <g key={views[index]?.key ?? index}>
          {segments.map((segment, s) => (segment.length > 1 ? (
            <polyline
              key={s} points={polylinePoints(segment)} fill="none" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
              strokeDasharray={chartDash(index)} className={chartClass(CHART_STROKE, index)}
            />
          ) : null))}
          {segments.flat().map((point) => (
            <circle key={point.point.periodId} cx={point.x} cy={point.y} r="3.5" className={chartClass(CHART_FILL, index)} />
          ))}
          {(() => {
            const last = segments.at(-1)?.at(-1);
            const y = ends.get(index);
            return last && y !== undefined ? (
              <text x={last.x + 10} y={y + 4} className={`${chartClass(CHART_FILL, index)} text-[12px] font-semibold`}>{views[index]?.label}</text>
            ) : null;
          })()}
        </g>
      ))}
    </svg>
  );
}

const DONUT = { size: 160, radius: 60, stroke: 22 } as const;

function SplitChartView({ chart }: { chart: SplitChart }) {
  const centre = DONUT.size / 2;
  const circumference = 2 * Math.PI * DONUT.radius;
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
      <svg role="img" aria-label={chart.summary} viewBox={`0 0 ${DONUT.size} ${DONUT.size}`} className="size-44 shrink-0">
        <circle cx={centre} cy={centre} r={DONUT.radius} fill="none" strokeWidth={DONUT.stroke} className="stroke-surface-sunken" />
        {chart.slices.map((slice, i) => {
          const length = Math.max(0, (slice.percent / 100) * circumference - 2);
          return (
            <circle
              key={slice.key}
              cx={centre} cy={centre} r={DONUT.radius} fill="none" strokeWidth={DONUT.stroke}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-((slice.start / 100) * circumference)}
              transform={`rotate(-90 ${centre} ${centre})`}
              className={chartClass(CHART_STROKE, i)}
            />
          );
        })}
        <text x={centre} y={centre - 2} textAnchor="middle" className="fill-current font-mono text-[17px] font-semibold text-ink tabular">{chart.total}</text>
        <text x={centre} y={centre + 16} textAnchor="middle" className="fill-current text-[10px] uppercase tracking-[0.12em] text-ink-muted">surplus</text>
      </svg>
      <ul className="flex w-full min-w-0 flex-col gap-2.5">
        {chart.slices.map((slice, i) => (
          <li key={slice.key} className="flex items-center gap-3 border-b border-line pb-2.5 last:border-b-0 last:pb-0">
            <span aria-hidden="true" className={`size-3 shrink-0 rounded-sm ${CHART_BG[i % CHART_BG.length]}`} />
            <span className="min-w-0 flex-1 text-ink">{slice.label}</span>
            <span className="tabular text-ink-muted">{slice.share}</span>
            <span className="w-24 text-right font-mono tabular text-ink">{slice.amount}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RiskChartView({ chart }: { chart: RiskChart }) {
  const columns = { gridTemplateColumns: `minmax(9rem, 1.6fr) repeat(${chart.levels.length}, minmax(0, 1fr))` };
  return (
    // The grid is the picture; its words and positions are in the table behind "Show as table".
    <div role="img" aria-label={chart.summary} className="min-w-0">
      <div aria-hidden="true">
        <div className="grid items-end gap-x-1 pb-2" style={columns}>
          <span className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">Option</span>
          {chart.levels.map((level) => (
            <span key={level.key} className="text-center text-[10px] leading-tight text-ink-muted sm:text-xs">{level.label}</span>
          ))}
        </div>
        <div className="grid gap-x-1" style={columns}>
          <span className="h-1.5 rounded-full bg-linear-to-r from-chart-5 via-chart-2 to-chart-1" style={{ gridColumn: '2 / -1' }} />
        </div>
        <ol className="mt-2 flex flex-col">
          {chart.points.map((point) => (
            <li key={point.number} className="grid items-center gap-x-1 border-b border-line py-2 last:border-b-0" style={columns}>
              <span className="flex min-w-0 gap-2 text-sm">
                <span className="tabular font-semibold text-accent">{point.number}</span>
                <span className="min-w-0 text-ink">{point.label}</span>
              </span>
              {chart.levels.map((level, i) => (
                <span key={level.key} className="flex justify-center">
                  {i === point.level
                    ? <span className={`size-4 rounded-full ring-4 ring-surface ${RISK_BG[point.risk]}`} />
                    : <span className="size-1 rounded-full bg-line-strong" />}
                </span>
              ))}
            </li>
          ))}
        </ol>
        <p className="mt-2 flex justify-between text-xs text-ink-faint">
          <span>Lower risk</span>
          <span>Very high risk</span>
        </p>
      </div>
    </div>
  );
}

/** A chart of the pack in its frame; untitled when the heading above already names it. */
export function ChartBlock({ chart, heading }: { chart: PresentedChart; heading: string | null }) {
  const drawing = chart.type === 'lines'
    ? <LineChartView chart={chart} />
    : chart.type === 'split' ? <SplitChartView chart={chart} /> : <RiskChartView chart={chart} />;
  return (
    <ChartFrame id={chart.id} title={chart.title} showTitle={chart.title !== heading} table={chart.table}>
      {drawing}
    </ChartFrame>
  );
}
