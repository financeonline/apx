import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { StatusBadgeView } from '@/components/dashboard';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { TOUCH_TARGET } from '@/components/ui/clickable-card';
import type { MetricCardView } from '@/modules/dashboard';

/**
 * A statement, rendered as rows rather than cards (UX_ARCHITECTURE.md §12: "denser tables allowed
 * on Money sub-pages").
 *
 * Every row is still a whole number in the §4 sense: one status badge, a "Why?" into the evidence
 * drawer, and the change against last month. What differs from Home is only density and pence
 * (§8.2) — both decided before the value reaches this component, which formats nothing.
 *
 * On a phone each row is a small block of its own (`TableWrap stack`): the figure's name, then its
 * amount and change, each beside its column's name, then the badge and "Why?".
 */
export function FigureTable({
  rows,
  caption,
  comparisonLabel,
}: {
  rows: readonly MetricCardView[];
  caption: string;
  comparisonLabel: string;
}) {
  return (
    <TableWrap stack>
      <caption className="sr-only">{caption}</caption>
      <THead columns={['Figure', 'Amount', `Change vs ${comparisonLabel}`, '']} />
      <TBody>
        {rows.map((row) => (
          <FigureRow key={row.metricKey} row={row} changeLabel={`Change vs ${comparisonLabel}`} />
        ))}
      </TBody>
    </TableWrap>
  );
}

export function FigureRow({
  row,
  label,
  changeLabel = 'Change',
}: {
  row: MetricCardView;
  label?: string;
  /** The change column's name, shown beside the change when the table is stacked on a phone. */
  changeLabel?: string;
}) {
  const notComputable = row.status.kind === 'not_available';

  return (
    <TR>
      <TD className="max-sm:font-medium">
        <span title={[row.technicalLabel, row.basisText].filter(Boolean).join(' · ')}>
          {label ?? row.label}
        </span>
        <span className="sr-only"> — {row.technicalLabel}</span>
      </TD>
      <TD className="text-right" label="Amount">
        <span
          className={`tabular ${notComputable ? 'text-ink-faint' : ''}`.trim()}
          title={notComputable ? row.status.tooltip : undefined}
        >
          {row.value}
        </span>
        {/* Never a 0 and never a blank: an em dash that says why (§4). */}
        {notComputable ? <span className="sr-only"> — {row.status.tooltip}</span> : null}
      </TD>
      <TD className="text-sm text-ink-muted" label={changeLabel}>
        <ChangeCell row={row} />
      </TD>
      <TD className="whitespace-nowrap text-right text-sm">
        {/* Exactly one badge per number (§8.1); the dash on the value is the badge when NULL. */}
        {notComputable ? null : <StatusBadgeView status={row.status} size="sm" />}{' '}
        <WhyLink row={row} />
      </TD>
    </TR>
  );
}

function ChangeCell({ row }: { row: MetricCardView }) {
  if (!row.change) return <span className="text-ink-faint">no comparison yet</span>;
  if (row.change.basisDiffers) {
    return (
      <span className="text-ink-faint">
        <span className="tabular">{row.change.amount}</span> compared on a different basis
      </span>
    );
  }
  return <span className="tabular">{row.change.text}</span>;
}

/** The "Why?" affordance every number carries (§4). Always visible, never hover-only (§10). */
export function WhyLink({ row, className = '' }: { row: MetricCardView; className?: string }) {
  return (
    <Link
      href={row.whyHref}
      className={`inline-flex items-center gap-0.5 rounded-xl border border-accent/45 bg-surface px-2.5 py-0.5 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft ${TOUCH_TARGET} ${className}`.trim()}
    >
      Why?
      <ChevronRight aria-hidden="true" className="size-4" />
      <span className="sr-only">
        {' '}
        See the evidence behind {row.label} for {row.period.label}
      </span>
    </Link>
  );
}
