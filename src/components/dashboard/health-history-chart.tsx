import { TBody, TD, THead, TR } from '@/components/ui/table';
import { Table } from '@/components/ui/shadcn';
import type { HealthHistoryPoint } from '@/modules/health';
import {
  CHART_STROKE, COMPACT_CHART_BOX, DEFAULT_CHART_BOX, chartClass, columnX, polylinePoints, segmentsFor, valueY,
  type ChartBox, type ChartScale, type TrendSeriesView,
} from './presentation';
import { BAND_SCALE, bandText } from './health-presentation';

/**
 * The monthly score history (UX_ARCHITECTURE.md §Level 1 "monthly history chart").
 *
 * Fixed 0–100 scale, always. A chart auto-scaled to the observed range would draw a business that
 * moved from 61 to 64 as a steep climb, and one that sat at 38 all year as a flat line near the top
 * — which is the opposite of what those two years mean. A score out of a hundred has to be drawn out
 * of a hundred.
 *
 * A month with no score is a GAP, not a zero (§4): a month nobody could score and a month that
 * scored nothing are different, and joining across the first would invent a trend.
 *
 * Drawn twice, and one is shown (owner, 2026-10-14: every screen): in a column narrower than 36rem —
 * a phone — a compact drawing whose labels are still readable once it is scaled down, with the band
 * names inside the plot; from 36rem the full one. The other is `display: none`, so a screen reader
 * meets one picture.
 */
const SCALE: ChartScale = { min: 0, max: 100, empty: false };

export function HealthHistoryChart({
  points,
  labels,
  tableFallbackId,
}: {
  points: readonly HealthHistoryPoint[];
  /** "March 2026" per period id, from `core/periods` — never built here (§8.2). */
  labels: ReadonlyMap<string, string>;
  tableFallbackId: string;
}) {
  const series: TrendSeriesView = {
    key: 'health',
    label: 'Health score',
    points: points.map((point) => ({
      periodId: point.periodId,
      periodLabel: labels.get(point.periodId) ?? point.periodId,
      value: point.score,
      display: point.score === null ? '—' : String(point.score),
    })),
  };

  const scored = points.filter((p) => p.score !== null);

  if (scored.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No months have been scored yet. A score appears once a month is complete.
      </p>
    );
  }

  return (
    <figure className="space-y-2">
      <figcaption className="text-xs uppercase tracking-wide text-ink-muted">
        Health score, month by month
      </figcaption>

      <div className="@container">
        <div className="@xl:hidden">
          <ScoreDrawing series={series} box={COMPACT_CHART_BOX} compact tableFallbackId={tableFallbackId} />
        </div>
        <div className="hidden @xl:block">
          <ScoreDrawing series={series} box={DEFAULT_CHART_BOX} compact={false} tableFallbackId={tableFallbackId} />
        </div>
      </div>

      {/* §11: the picture always has a real table behind it, not a caption describing it. */}
      <Table id={tableFallbackId} className="min-w-0">
        <caption className="sr-only">Health score by month</caption>
        <THead columns={['Month', 'Score', 'Band']} />
        <TBody>
          {points.map((point) => (
            <TR key={point.periodId}>
              <TD>{labels.get(point.periodId) ?? point.periodId}</TD>
              <TD className="tabular">{point.score === null ? '—' : point.score}</TD>
              <TD>{point.score === null ? 'Not scored' : bandText(point.band)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </figure>
  );
}

/**
 * The picture itself, in either box. Compact: bigger labels for the smaller drawing, band names just
 * above their line inside the plot rather than in a margin it has no room for, and never wider than
 * 28rem, so in a middling column it does not grow to a poster.
 */
function ScoreDrawing({
  series,
  box,
  compact,
  tableFallbackId,
}: {
  series: TrendSeriesView;
  box: ChartBox;
  compact: boolean;
  tableFallbackId: string;
}) {
  const segments = segmentsFor(series, SCALE, box);
  return (
    <svg
      viewBox={`0 0 ${box.width} ${box.height}`}
      className={compact ? 'w-full max-w-md' : 'w-full'}
      role="img"
      // An `img` with no accessible NAME is announced as "graphic" and nothing else. The
      // description says where the numbers are; the label says what the picture is (§11).
      aria-label="Health score by month"
      aria-describedby={tableFallbackId}
    >
      {/* The band boundaries, so a reader can see which band a month sat in without a key. */}
      {BAND_SCALE.filter((band) => band.min > 0).map((band) => (
        <g key={band.band}>
          <line
            x1={box.padding.left}
            x2={box.width - box.padding.right}
            y1={valueY(band.min, SCALE, box)}
            y2={valueY(band.min, SCALE, box)}
            className="stroke-line"
            strokeDasharray="2 4"
          />
          <text
            x={compact ? box.padding.left + 2 : box.width - box.padding.right + 6}
            y={compact ? valueY(band.min, SCALE, box) - 4 : valueY(band.min, SCALE, box) + 4}
            className={`fill-ink-faint ${compact ? 'text-[12px]' : 'text-[11px]'}`}
          >
            {band.label}
          </text>
        </g>
      ))}

      {segments.map((segment, index) => (
        segment.length === 1 ? (
          <circle
            key={`dot-${segment[0]!.point.periodId}`}
            cx={segment[0]!.x}
            cy={segment[0]!.y}
            r={3}
            className={chartClass(CHART_STROKE, 0)}
          />
        ) : (
          <polyline
            key={`seg-${index}-${segment[0]!.point.periodId}`}
            points={polylinePoints(segment)}
            fill="none"
            strokeWidth={2}
            className={chartClass(CHART_STROKE, 0)}
          />
        )
      ))}

      {series.points.map((point, index) => (
        <text
          key={`x-${point.periodId}`}
          x={columnX(index, series.points.length, box)}
          y={box.height - 8}
          textAnchor="middle"
          className={`fill-ink-faint ${compact ? 'text-[11px]' : 'text-[10px]'}`}
        >
          {point.periodLabel.slice(0, 3)}
        </text>
      ))}
    </svg>
  );
}
