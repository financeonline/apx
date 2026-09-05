import Link from 'next/link';
import { StatusBadgeView } from '@/components/dashboard';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import type { MetricCardView } from '@/modules/dashboard';

/**
 * A statement, rendered as rows rather than cards (UX_ARCHITECTURE.md §12: "denser tables allowed
 * on Money sub-pages").
 *
 * Every row is still a whole number in the §4 sense: one status badge, a "Why?" into the evidence
 * drawer, and the change against last month. What differs from Home is only density and pence
 * (§8.2) — both decided before the value reaches this component, which formats nothing.
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
    <TableWrap>
      <caption className="sr-only">{caption}</caption>
      <THead columns={['Figure', 'Amount', `Change vs ${comparisonLabel}`, '']} />
      <TBody>
        {rows.map((row) => (
          <FigureRow key={row.metricKey} row={row} />
        ))}
      </TBody>
    </TableWrap>
  );
}

export function FigureRow({ row, label }: { row: MetricCardView; label?: string }) {
  const notComputable = row.status.kind === 'not_available';

  return (
    <TR>
      <TD>
        <span title={[row.technicalLabel, row.basisText].filter(Boolean).join(' · ')}>
          {label ?? row.label}
        </span>
        <span className="sr-only"> — {row.technicalLabel}</span>
      </TD>
      <TD className="text-right">
        <span
          className={`tabular ${notComputable ? 'text-ink-faint' : ''}`.trim()}
          title={notComputable ? row.status.tooltip : undefined}
        >
          {row.value}
        </span>
        {/* Never a 0 and never a blank: an em dash that says why (§4). */}
        {notComputable ? <span className="sr-only"> — {row.status.tooltip}</span> : null}
      </TD>
      <TD className="text-sm text-ink-muted">
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
export function WhyLink({ row }: { row: MetricCardView }) {
  return (
    <Link
      href={row.whyHref}
      className="text-accent underline underline-offset-2 transition-colors duration-100 hover:text-accent-hover"
    >
      Why?
      <span className="sr-only">
        {' '}
        See the evidence behind {row.label} for {row.period.label}
      </span>
    </Link>
  );
}
