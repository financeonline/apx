import { ClipboardCheck } from 'lucide-react';
import { Badge, Card, CardBody, IconBadge, type BadgeTone } from '@/components/ui/surfaces';
import { ABOVE_CARD_LINK, CLICKABLE_CARD, CardLink } from '@/components/ui/clickable-card';
import { ownerLabel, type Action, type ActionPriority, type ActionStatus } from '@/modules/actions';
import { formatDate } from '@/components/labels';

/**
 * `ActionCard` (UX_ARCHITECTURE.md §7; SOW §17).
 *
 * An action is a commitment somebody made, so the card leads with what was decided and who owns it,
 * not with where it came from. The source matters — an action born of an alert carries the figures
 * that prompted it — but it is provenance, and provenance belongs beside the claim rather than in
 * front of it.
 *
 * The whole card opens the action (owner, 2026-10-14): its title is the one link, stretched over the
 * card (`ui/clickable-card`), and the status controls sit above it with their own targets.
 */

const PRIORITY_LABELS: Readonly<Record<ActionPriority, string>> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
};

const PRIORITY_TONES: Readonly<Record<ActionPriority, BadgeTone>> = {
  critical: 'danger', high: 'warn', medium: 'neutral', low: 'neutral',
};

export const STATUS_LABELS: Readonly<Record<ActionStatus, string>> = {
  open: 'To do', in_progress: 'In progress', completed: 'Done', dismissed: 'Dismissed',
};

/** Where an action came from, in the words a reader would use (§8.1, ADR-037). */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  ai: 'From an answer the analyst gave',
  alert: 'From something we spotted',
  health_score: 'From your health score',
  report: 'From a report',
  user: 'Added by someone here',
};

export function priorityLabel(priority: ActionPriority): string {
  return PRIORITY_LABELS[priority];
}

export function ActionCard({
  action,
  href,
  today,
  viewerUserId,
  compact = false,
  children,
}: {
  action: Action;
  href: string;
  /** Passed in rather than read from a clock, so the server and a test agree what day it is. */
  today: string;
  /** Who is reading: their own name is "you", and a client never learns a colleague's. */
  viewerUserId: string;
  compact?: boolean;
  /** The status controls, when this reader may move it. */
  children?: React.ReactNode;
}) {
  const overdue = action.dueDate !== null
    && (action.status === 'open' || action.status === 'in_progress')
    && action.dueDate < today;

  return (
    <Card className={CLICKABLE_CARD}>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* The reference's icon tile (ADR-155). Decorative; pink while overdue. */}
          <IconBadge tint={overdue ? 'pink' : 'violet'} size="sm"><ClipboardCheck /></IconBadge>
          <div className="min-w-0 flex-1">
            <h3 className="text-ink">
              <CardLink href={href} className="underline-offset-2 hover:underline group-hover:underline">
                {action.title}
              </CardLink>
            </h3>
            {compact || action.issue === null ? null : (
              <p className="mt-1 text-sm text-ink-muted">{action.issue}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PRIORITY_TONES[action.priority]}>{PRIORITY_LABELS[action.priority]}</Badge>
            <Badge tone="neutral">{STATUS_LABELS[action.status]}</Badge>
          </div>
        </div>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-muted">
          <div className="flex gap-1">
            <dt>Owner</dt>
            <dd className="text-ink">{ownerLabel(action, viewerUserId)}</dd>
          </div>
          {action.dueDate === null ? null : (
            <div className="flex gap-1">
              <dt>Due</dt>
              <dd className={overdue ? 'text-danger' : 'text-ink'}>
                {formatDate(action.dueDate)}
                {overdue ? <span className="sr-only"> — overdue</span> : null}
              </dd>
            </div>
          )}
          <div className="flex gap-1">
            <dt className="sr-only">Where it came from</dt>
            <dd>{SOURCE_LABELS[action.sourceType] ?? SOURCE_LABELS.user}</dd>
          </div>
        </dl>

        {children === undefined ? null : <div className={`mt-4 ${ABOVE_CARD_LINK}`}>{children}</div>}
      </CardBody>
    </Card>
  );
}
