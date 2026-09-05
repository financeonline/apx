import { Badge } from '@/components/ui/surfaces';
import { statusFor, type StatusBadge } from '@/modules/dashboard';
import type { AssuranceLevel, DataQualityMissing, DataQualityWarning } from '@/modules/financial-engine';
import { BADGE_SIZE_CLASS, statusTone, type BadgeSize } from './presentation';

/**
 * The one status badge a figure carries (UX_ARCHITECTURE.md §5, §8.1).
 *
 * §4 is emphatic that a number carries EXACTLY ONE badge — the worst of its assurance level and its
 * data-quality state. Basis ("From bank statements") and individual warnings belong in the tooltip
 * and in the evidence drawer, never as a second badge, because two badges ask the reader to weigh
 * one against the other, which is the judgement the product is supposed to have made for them.
 *
 * The derivation is `statusFor` in `modules/dashboard`; this file only paints it.
 */

/**
 * Renders an already-derived badge.
 *
 * `kind: 'none'` deliberately renders nothing: a verified, complete figure is the ordinary case,
 * and the ordinary case is not decorated.
 *
 * The tooltip is carried twice on purpose — `title` for a pointer, and an `sr-only` copy for a
 * screen reader, which never sees a `title`. The badge always carries its word as well as its
 * tone, so nothing is said by colour alone (§11).
 */
export function StatusBadgeView({
  status,
  size = 'md',
}: {
  status: StatusBadge;
  size?: BadgeSize;
}) {
  if (status.label === null) return null;

  return (
    <span className={`inline-flex ${BADGE_SIZE_CLASS[size]}`.trim()} title={status.tooltip}>
      <Badge tone={statusTone(status.kind)}>{status.label}</Badge>
      <span className="sr-only"> — {status.tooltip}</span>
    </span>
  );
}

/**
 * The §5 contract: given the raw quality of a figure, show the badge the §8.1 table prescribes.
 *
 * Used where a component holds quality but not a whole `MetricCardView` — a table cell, a drawer
 * heading, a report row.
 */
export function DataQualityBadge({
  completeness,
  warnings,
  assurance,
  size = 'md',
  available = true,
  proxy = false,
  missing = [],
}: {
  completeness: number;
  warnings: readonly DataQualityWarning[];
  assurance: AssuranceLevel;
  size?: BadgeSize;
  /** False when the figure could not be computed: the badge becomes "—" plus the reason (§4). */
  available?: boolean;
  proxy?: boolean;
  missing?: readonly DataQualityMissing[];
}) {
  const status = statusFor({
    // `statusFor` tests only whether a figure exists. The badge never shows the number, so the
    // string standing in for "there is one" is never rendered.
    value: available ? '' : null,
    assurance,
    dataQuality: { completeness, proxy, warnings, missing },
  });

  return <StatusBadgeView status={status} size={size} />;
}
