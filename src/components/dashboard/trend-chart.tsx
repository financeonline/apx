'use client';

import { useId, useState } from 'react';
import { TBody, TD, THead, TR, TableWrap } from '@/components/ui/table';
import {
  CHART_FILL,
  CHART_STROKE,
  DEFAULT_CHART_BOX,
  chartClass,
  chartDash,
  columnX,
  polylinePoints,
  scaleFor,
  segmentsFor,
  valueY,
  type TrendSeriesView,
} from './presentation';

/**
 * Twelve months of up to three figures (UX_ARCHITECTURE.md §4 level 3, §5, §11).
 *
 * Hand-drawn SVG, no charting library, for one reason above all the others: a month with no figure
 * has to be a GAP in the line (§4). Every library's default is to join across it, which draws a
 * confident straight line through a month nobody has data for. The rest — direct labels instead of
 * a colour key, a real data table behind a toggle, a baseline that always includes zero — follows
 * from the same instinct that the picture must not claim more than the data supports.
 *
 * Every string it draws arrives formatted (`point.display`); the only numbers it works out are
 * pixel coordinates, in `presentation.ts`.
 */
export function TrendChart({
  series,
  ariaSummary,
  tableFallbackId,
  highlightPeriodId,
}: {
  series: readonly TrendSeriesView[];
  /**
   * The trend in words, for a screen reader: "Sales rose from £38,000 in April 2025 to £45,200 in
   * March 2026" (§11). Written by the service, because summarising a movement is a judgement about
   * numbers and components do not make those.
   */
  ariaSummary: string;
  tableFallbackId: string;
  highlightPeriodId?: string;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [tableVisible, setTableVisible] = useState(false);
  const headingId = useId();

  const shown = series.filter((one) => !hidden.has(one.key));
  const scale = scaleFor(shown);
  const box = DEFAULT_CHART_BOX;

  // The columns are fixed by the first series so the three lines and the month labels line up.
  const columns = series[0]?.points ?? [];
  const zeroY = valueY(0, scale, box);

  function toggle(key: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby={headingId}>
          <span id={headingId} className="sr-only">
            Choose which figures to show
          </span>
          {series.map((one, index) => {
            const isShown = !hidden.has(one.key);
            return (
              <button
                key={one.key}
                type="button"
                aria-pressed={isShown}
                onClick={() => toggle(one.key)}
                className={
                  'inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium '
                  + 'transition-colors duration-100 '
                  + (isShown
                    ? 'border-line-strong bg-surface text-ink'
                    : 'border-line bg-surface-sunken text-ink-faint')
                }
              >
                <svg width="18" height="8" aria-hidden="true" className="shrink-0">
                  <line
                    x1="0"
                    y1="4"
                    x2="18"
                    y2="4"
                    strokeWidth="2"
                    strokeDasharray={chartDash(index)}
                    className={isShown ? chartClass(CHART_STROKE, index) : 'stroke-current'}
                  />
                </svg>
                {one.label}
                <span className="sr-only">{isShown ? ' (showing)' : ' (hidden)'}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          aria-expanded={tableVisible}
          aria-controls={tableFallbackId}
          onClick={() => setTableVisible((v) => !v)}
          className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium transition-colors duration-100 hover:bg-surface-sunken"
        >
          {tableVisible ? 'Hide table' : 'Show as table'}
        </button>
      </div>

      {scale.empty ? (
        <p className="mt-4 text-sm text-ink-faint">Nothing to plot for these months yet.</p>
      ) : (
        <svg
          role="img"
          aria-label={ariaSummary}
          viewBox={`0 0 ${box.width} ${box.height}`}
          className="mt-4 h-auto w-full"
        >
          {/* The baseline. Zero is always inside the plot, so a small profit never looks large. */}
          <line
            x1={box.padding.left}
            y1={zeroY}
            x2={box.width - box.padding.right}
            y2={zeroY}
            className="stroke-line-strong"
            strokeWidth="1"
          />

          {highlightPeriodId
            ? columns.map((point, index) =>
                point.periodId === highlightPeriodId ? (
                  <line
                    key={point.periodId}
                    x1={columnX(index, columns.length, box)}
                    y1={box.padding.top}
                    x2={columnX(index, columns.length, box)}
                    y2={box.height - box.padding.bottom}
                    className="stroke-line"
                    strokeWidth="1"
                  />
                ) : null,
              )
            : null}

          {shown.map((one) => {
            const index = series.findIndex((s) => s.key === one.key);
            const segments = segmentsFor(one, scale, box);
            const last = segments.at(-1)?.at(-1) ?? null;

            return (
              <g key={one.key}>
                {segments.map((segment, s) =>
                  segment.length === 1 ? (
                    // A lone month between two gaps: a dot, because a line of one point is nothing.
                    <circle
                      key={s}
                      cx={segment[0]!.x}
                      cy={segment[0]!.y}
                      r="2.5"
                      className={chartClass(CHART_FILL, index)}
                    />
                  ) : (
                    <polyline
                      key={s}
                      points={polylinePoints(segment)}
                      fill="none"
                      strokeWidth="2"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      strokeDasharray={chartDash(index)}
                      className={chartClass(CHART_STROKE, index)}
                    />
                  ),
                )}
                {/*
                  A direct label at the end of the line. Series are never told apart by colour alone
                  (§11, DESIGN.md), so the name travels with the line rather than sitting in a key.
                */}
                {last ? (
                  <text
                    x={last.x + 8}
                    y={last.y + 4}
                    className={`${chartClass(CHART_FILL, index)} text-[11px]`}
                  >
                    {one.label}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* Only the two ends are labelled: twelve month names under a chart is noise, and the
              table behind the toggle carries every month in full. */}
          <text
            x={box.padding.left}
            y={box.height - 8}
            className="fill-current text-[11px] text-ink-faint"
          >
            {columns.at(0)?.periodLabel}
          </text>
          <text
            x={box.width - box.padding.right}
            y={box.height - 8}
            textAnchor="end"
            className="fill-current text-[11px] text-ink-faint"
          >
            {columns.at(-1)?.periodLabel}
          </text>
        </svg>
      )}

      {/*
        The table is ALWAYS in the document (§11): "Show as table" changes whether it is visible,
        never whether it exists, so a screen reader has the figures whatever a sighted user has
        chosen. `sr-only` hides it from the page and keeps it in the accessibility tree.
      */}
      <div id={tableFallbackId} className={tableVisible ? 'mt-4' : 'sr-only'}>
        <TableWrap>
          <caption className="sr-only">{ariaSummary}</caption>
          <THead columns={['Month', ...series.map((one) => one.label)]} />
          <TBody>
            {columns.map((column, index) => (
              <TR key={column.periodId}>
                <TD>{column.periodLabel}</TD>
                {series.map((one) => (
                  <TD key={one.key} className="tabular">
                    {one.points[index]?.display ?? '—'}
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </TableWrap>
      </div>
    </div>
  );
}
