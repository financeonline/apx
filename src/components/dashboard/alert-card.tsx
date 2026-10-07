import Link from 'next/link';
import { ChevronRight, CircleAlert, Info, ShieldAlert } from 'lucide-react';
import { Badge, Card, CardBody, IconBadge } from '@/components/ui/surfaces';
import type { AlertView } from '@/modules/dashboard';
import { reasonText, severityLabel, severityTone } from './alert-presentation';

/**
 * One alert (UX_ARCHITECTURE.md §5, §8.3).
 *
 * Rendered in the three labelled parts §8.3 requires — **What happened**, **Why it matters**, **What
 * you can do** — because an alert that gives a number and an instruction without the middle part is
 * telling somebody to act without telling them why. The threshold that fired sits in the tooltip, so
 * a reader who disagrees can see the rule rather than guess at it.
 *
 * Two variants and no others (§5): `compact` for Home's top-risks band, `full` for Insights.
 */
export type AlertCardVariant = 'compact' | 'full';

/** The reference's outlined link-button (ADR-155). */
const PILL = 'inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft';

export function AlertCard({
  alert,
  variant = 'full',
  actions,
}: {
  alert: AlertView;
  variant?: AlertCardVariant;
  /** The status controls. Absent for a role that may not change this alert's status (§7.4). */
  actions?: React.ReactNode;
}) {
  const compact = variant === 'compact';
  const reason = reasonText(alert.statusReasonCode);

  return (
    <Card className="h-full">
      <CardBody className={compact ? 'px-4 py-3' : ''}>
        <div className="flex items-start justify-between gap-3">
          {/* The reference's icon tile (ADR-155): pink for the serious ones. Decorative. */}
          <IconBadge tint={alert.severity === 'critical' || alert.severity === 'high' ? 'pink' : 'violet'} size="sm">
            {alert.severity === 'critical' || alert.severity === 'high' ? <ShieldAlert />
              : alert.severity === 'info' ? <Info /> : <CircleAlert />}
          </IconBadge>
          <div className="min-w-0 flex-1">
            <h3 className={`text-ink ${compact ? 'text-sm' : ''}`}>{alert.title}</h3>
            <p className="mt-0.5 text-xs text-ink-faint">
              {alert.family} · {alert.periodLabel}
              {alert.recurring ? ' · seen since ' + alert.firstSeenLabel : null}
            </p>
          </div>
          <span
            className="shrink-0"
            title={alert.thresholdNote ?? undefined}
          >
            <Badge tone={severityTone(alert.severity)}>{severityLabel(alert.severity)}</Badge>
          </span>
        </div>

        <div className={compact ? 'mt-2 space-y-1' : 'mt-3 space-y-2'}>
          <Part label="What happened" text={alert.whatHappened} compact={compact} />
          {compact ? null : (
            <>
              <Part label="Why it matters" text={alert.whyItMatters} compact={compact} />
              <Part label="What you can do" text={alert.whatYouCanDo} compact={compact} />
            </>
          )}
        </div>

        {reason ? <p className="mt-2 text-xs text-ink-muted">{reason}</p> : null}

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {alert.evidenceHref ? (
            <Link href={alert.evidenceHref} className={PILL}>
              Why? <ChevronRight aria-hidden="true" className="size-4" />
            </Link>
          ) : null}
          {alert.detailHref ? (
            <Link href={alert.detailHref} className={PILL}>
              History <ChevronRight aria-hidden="true" className="size-4" />
            </Link>
          ) : null}
          {actions}
        </div>
      </CardBody>
    </Card>
  );
}

function Part({ label, text, compact }: { label: string; text: string | null; compact: boolean }) {
  if (text === null || text === '') return null;
  return (
    <p className={compact ? 'text-sm text-ink-muted' : 'text-sm text-ink'}>
      {compact ? null : (
        <span className="mr-1 text-xs uppercase tracking-wide text-ink-faint">{label}:</span>
      )}
      {text}
    </p>
  );
}
