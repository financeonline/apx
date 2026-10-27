/**
 * The pure half of the dashboard components (UX_ARCHITECTURE.md §8.1, §4, §11).
 *
 * Everything a dashboard component decides that is not JSX lives here: which tone a status badge
 * wears, whether a movement is coloured favourably, how a series of monthly figures becomes SVG
 * geometry. Keeping it in one framework-free file is what lets the rules in §4 and §8.1 be asserted
 * in a unit test without a DOM: the JSX around it is a thin wrapper with nothing to get wrong.
 *
 * Nothing here computes or formats a financial figure. `MetricCardView.value`,
 * `ChangeView.text` and the chart's `display` strings arrive already formatted by
 * `modules/dashboard` (SERVICE_ARCHITECTURE.md §8). The only numbers this file touches are pixel
 * coordinates.
 */

import type { BadgeTone } from '@/components/ui/surfaces';
import type { StatusKind } from '@/modules/dashboard';

// -----------------------------------------------------------------------------------------------
// Status badges (§8.1)
// -----------------------------------------------------------------------------------------------

/**
 * The tone each status wears.
 *
 * Colour is reserved for meaning (DESIGN.md): "Please check" and "Partial data" are warnings about
 * how far a figure can be trusted, so they carry the warning tone; "Estimate" and "Calculated" are
 * statements of method rather than problems, so they stay neutral. Nothing here is decorative, and
 * every badge carries its word as well as its colour (§11).
 */
const STATUS_TONES: Readonly<Record<StatusKind, BadgeTone>> = {
  none: 'neutral',
  calculated: 'neutral',
  partial: 'warn',
  estimate: 'neutral',
  check: 'warn',
  not_available: 'neutral',
};

export function statusTone(kind: StatusKind): BadgeTone {
  return STATUS_TONES[kind];
}

/**
 * The canonical label for each status, straight from the §8.1 table.
 *
 * `statusFor` already puts this on the badge it derives; this map exists so the table can be
 * asserted directly and so a component that is handed only a `StatusKind` cannot invent a wording.
 */
export const STATUS_LABELS: Readonly<Record<StatusKind, string | null>> = {
  none: null,
  calculated: 'Calculated',
  partial: 'Partial data',
  estimate: 'Estimate',
  check: 'Please check',
  not_available: '—',
};

export type BadgeSize = 'sm' | 'md';

/**
 * The two sizes §5 allows on `DataQualityBadge`, and no others.
 *
 * They are expressed as overrides on the kit's `Badge` rather than as a second badge style, so
 * tone, radius and border keep exactly one definition. `md` is the kit's own size and adds nothing.
 * The strings are literal because Tailwind reads the source, not the running program.
 */
export const BADGE_SIZE_CLASS: Readonly<Record<BadgeSize, string>> = {
  sm: '[&>span]:px-1.5 [&>span]:py-0 [&>span]:text-[0.6875rem]',
  md: '',
};

// -----------------------------------------------------------------------------------------------
// Change lines (§4, §8.2)
// -----------------------------------------------------------------------------------------------

/**
 * Red, amber and green mean alert severity, health band, or favourable/unfavourable change, and
 * nothing else (§4). `favourable` is metric-aware and arrives on the view model — a fall in
 * expenses is good news — so this function never looks at the sign of the number.
 */
export function changeToneClass(favourable: boolean | null): string {
  if (favourable === null) return 'text-ink-muted';
  return favourable ? 'text-good' : 'text-danger';
}

/**
 * The word a screen reader hears, so favourability is never carried by colour alone (§11).
 * Null direction says nothing rather than guessing.
 */
export function changeToneWord(favourable: boolean | null): string | null {
  if (favourable === null) return null;
  return favourable ? 'Favourable' : 'Unfavourable';
}

/** ADR-030: a variance measured across two different bases never gets a percentage. */
export const BASIS_DIFFERS_TEXT = 'compared on a different basis';

// -----------------------------------------------------------------------------------------------
// Period picker (§5)
// -----------------------------------------------------------------------------------------------

export interface PeriodOptionInput {
  readonly id: string;
  readonly label: string;
  readonly isComplete: boolean;
}

export interface PeriodOptionView {
  readonly id: string;
  readonly label: string;
  readonly isCurrent: boolean;
  /**
   * The latest complete month, which Home, Insights and Reports open on (§4, ADR-030). Exactly one
   * option carries it: the newest complete month in the list.
   */
  readonly isLatestComplete: boolean;
}

/**
 * Marks the option a reader should treat as the default.
 *
 * `periods` arrive newest first (the repository orders by `period_start` descending) and contain
 * only months that carry data — the picker never offers an empty month (§5). The latest complete
 * one is therefore the first complete entry, and only that one is marked.
 */
export function toPeriodOptions(
  periods: readonly PeriodOptionInput[],
  currentId: string | null,
): PeriodOptionView[] {
  const latestComplete = periods.find((period) => period.isComplete)?.id ?? null;
  return periods.map((period) => ({
    id: period.id,
    label: period.label,
    isCurrent: period.id === currentId,
    isLatestComplete: period.id === latestComplete,
  }));
}

// -----------------------------------------------------------------------------------------------
// Trend chart geometry (§5, §11)
// -----------------------------------------------------------------------------------------------

export interface TrendPointView {
  readonly periodId: string;
  /** "March 2026" (§8.2). */
  readonly periodLabel: string;
  /** The plotted figure. Null is a GAP in the line, never a zero (§4). */
  readonly value: number | null;
  /** What the reader sees in the table: "£12,400", or "—" when there is no figure (§4). */
  readonly display: string;
}

export interface TrendSeriesView {
  readonly key: string;
  readonly label: string;
  readonly points: readonly TrendPointView[];
}

export interface ChartBox {
  readonly width: number;
  readonly height: number;
  readonly padding: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
}

export const DEFAULT_CHART_BOX: ChartBox = {
  width: 720,
  height: 260,
  padding: { top: 16, right: 84, bottom: 28, left: 16 },
};

/**
 * The box for a phone-width column (owner, 2026-10-14). A chart is drawn in its box's units and then
 * scaled to fit the page, so the 720-wide box shrinks its 11px labels to about 5px on a phone. Half
 * as wide, the same labels come out at about 9–10px. No right margin: a compact chart names its
 * lines in a key or inside the plot instead of at their ends.
 */
export const COMPACT_CHART_BOX: ChartBox = {
  width: 360,
  height: 240,
  padding: { top: 14, right: 14, bottom: 26, left: 10 },
};

export interface ChartScale {
  readonly min: number;
  readonly max: number;
  /** True when no series has a single figure: the chart draws nothing and says so. */
  readonly empty: boolean;
}

/**
 * The vertical extent of the plot.
 *
 * Zero is always inside it. A profit chart whose baseline floats above zero makes a small profit
 * look like a large one, and a loss look like an absence of one; the reader of this product is
 * being asked to trust the picture, so the picture is not allowed to flatter.
 */
export function scaleFor(series: readonly TrendSeriesView[]): ChartScale {
  const values: number[] = [];
  for (const one of series) {
    for (const point of one.points) {
      if (point.value !== null && Number.isFinite(point.value)) values.push(point.value);
    }
  }
  if (values.length === 0) return { min: 0, max: 1, empty: true };

  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  // A flat series still needs a band to sit in, or every point would land on the same pixel row.
  if (min === max) return { min: min - 1, max: max + 1, empty: false };
  return { min, max, empty: false };
}

export interface PlottedPoint {
  readonly x: number;
  readonly y: number;
  readonly point: TrendPointView;
}

/**
 * The x positions, one per column, whether or not that column has a figure.
 * Columns are fixed by the period list so the three series line up with each other and with the
 * month labels underneath.
 */
export function columnX(index: number, columns: number, box: ChartBox = DEFAULT_CHART_BOX): number {
  const usable = box.width - box.padding.left - box.padding.right;
  if (columns <= 1) return box.padding.left + usable / 2;
  return box.padding.left + (usable * index) / (columns - 1);
}

export function valueY(value: number, scale: ChartScale, box: ChartBox = DEFAULT_CHART_BOX): number {
  const usable = box.height - box.padding.top - box.padding.bottom;
  const span = scale.max - scale.min;
  const ratio = span === 0 ? 0.5 : (value - scale.min) / span;
  return box.padding.top + usable * (1 - ratio);
}

/**
 * Splits a series into the runs of consecutive months that actually have a figure.
 *
 * This is the whole reason the chart is hand-drawn: a month with no figure is a GAP (§4), and every
 * charting library's default is to join across it, which draws a straight line through a month
 * nobody has data for and invites the reader to believe it.
 */
export function segmentsFor(
  series: TrendSeriesView,
  scale: ChartScale,
  box: ChartBox = DEFAULT_CHART_BOX,
): PlottedPoint[][] {
  const segments: PlottedPoint[][] = [];
  let run: PlottedPoint[] = [];

  series.points.forEach((point, index) => {
    if (point.value === null || !Number.isFinite(point.value)) {
      if (run.length > 0) segments.push(run);
      run = [];
      return;
    }
    run.push({
      x: columnX(index, series.points.length, box),
      y: valueY(point.value, scale, box),
      point,
    });
  });

  if (run.length > 0) segments.push(run);
  return segments;
}

/** An SVG `points` attribute for one unbroken run. A run of one is drawn as a dot instead. */
export function polylinePoints(segment: readonly PlottedPoint[]): string {
  return segment.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The six-colour chart palette from DESIGN.md, as Tailwind utilities. Never a hex value: the tokens
 * are re-tuned for the dark scheme in `globals.css`, and a literal would not follow.
 */
export const CHART_STROKE = [
  'stroke-chart-1', 'stroke-chart-2', 'stroke-chart-3',
  'stroke-chart-4', 'stroke-chart-5', 'stroke-chart-6',
] as const;

export const CHART_FILL = [
  'fill-chart-1', 'fill-chart-2', 'fill-chart-3',
  'fill-chart-4', 'fill-chart-5', 'fill-chart-6',
] as const;

export const CHART_TEXT = [
  'text-chart-1', 'text-chart-2', 'text-chart-3',
  'text-chart-4', 'text-chart-5', 'text-chart-6',
] as const;

/** Wraps round the palette rather than running out, so a fourth series is still drawn. */
export function chartClass(list: readonly string[], index: number): string {
  return list[index % list.length] ?? list[0] ?? '';
}

/**
 * Series are never distinguished by colour alone (§11, DESIGN.md): each line carries a direct
 * label at its last plotted point, and a dash pattern that differs per series.
 */
export const CHART_DASH = ['none', '6 3', '2 3', '9 3 2 3', '4 2', '1 3'] as const;

export function chartDash(index: number): string | undefined {
  const dash = CHART_DASH[index % CHART_DASH.length];
  return dash === 'none' ? undefined : dash;
}

// -----------------------------------------------------------------------------------------------
// The client lobby (ADR-176)
// -----------------------------------------------------------------------------------------------

/** A trend series as `loadTrend` returns it: the figure is the snapshot's decimal string. */
export interface TrendSeriesInput {
  readonly key: string;
  readonly label: string;
  readonly points: ReadonlyArray<{ period: string; label: string; plotted: number | null; display: string }>;
}

/**
 * `loadTrend`'s series in the chart's shape. The position comes from the service's `plotted` number
 * (parsed with Decimal there, ADR-006); the figure the reader sees is its `display` string.
 */
export function chartSeriesFrom(trend: readonly TrendSeriesInput[]): TrendSeriesView[] {
  return trend.map((series) => ({
    key: series.key,
    label: series.label,
    points: series.points.map((point) => ({
      periodId: point.period,
      periodLabel: point.label,
      value: point.plotted,
      display: point.display,
    })),
  }));
}

/** The small line in a lobby figure card's corner: no labels, so no margins. */
export const SPARK_BOX: ChartBox = {
  width: 96,
  height: 34,
  padding: { top: 3, right: 3, bottom: 3, left: 3 },
};

/**
 * The runs of a series as sparkline `points` attributes, gaps kept (§4). Zero stays inside the
 * scale, as on the full chart, so the corner line never flatters a small change.
 */
export function sparklineRuns(series: TrendSeriesView): string[] {
  const scale = scaleFor([series]);
  if (scale.empty) return [];
  return segmentsFor(series, scale, SPARK_BOX).filter((run) => run.length > 1).map(polylinePoints);
}
