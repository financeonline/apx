import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { formatMoney } from '@/core/money';
import { todayInTimeZone, systemClock } from '@/core/periods';
import { assignableOwners, canManage, getAction, ownerLabel } from '@/modules/actions';
import { getAccessContext } from '@/modules/tenancy';
import { ACTION_SOURCE_LABELS, ACTION_STATUS_LABELS, priorityLabel } from '@/components/dashboard';
import {
  ArrowRightLeft, ChartColumn, ChevronRight, Lightbulb, MessageSquare, Target, TriangleAlert,
} from 'lucide-react';
import { Badge, Card, CardBody, DetailList, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { StatusControls } from '../status-controls';
import { AssignControl } from './assign-control';
import { requirePermission } from '@/app/_lib/authz';
import { listActionComments } from '@/modules/engagement';
import { CommentForm } from '@/components/engagement/forms';
import { addActionCommentAction } from '../../engagement/actions';

export const dynamic = 'force-dynamic';

/**
 * One action: what was decided, who owns it, and the evidence it rested on
 * (ROUTE_ARCHITECTURE.md §117; SOW §17).
 *
 * The evidence link is the point of the page. An action created from an alert or an answer carries
 * a COPY of what was shown at the time (EVIDENCE_MODEL.md §5), so "why did we do this?" is
 * answerable months later even though the alert has been re-evaluated a dozen times since.
 */
export default async function ActionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; actionId: string }>;
}) {
  const { orgSlug, actionId } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'actions.view');

  // Cross-organisation or invented: NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14).
  const action = await getAction(ctx, actionId);
  if (action === null) notFound();

  const comments = await listActionComments(ctx, action.id);
  const today = todayInTimeZone(systemClock, 'UTC');
  const overdue = action.dueDate !== null
    && (action.status === 'open' || action.status === 'in_progress')
    && action.dueDate < today;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/app/${orgSlug}/actions`} className="text-accent underline underline-offset-2">
          Back to the Action Centre
        </Link>
      </p>
      <PageHeader eyebrow={ACTION_SOURCE_LABELS[action.sourceType]} title={action.title} />

      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{ACTION_STATUS_LABELS[action.status]}</Badge>
              <Badge tone={action.priority === 'critical' ? 'danger' : 'neutral'}>
                {priorityLabel(action.priority)}
              </Badge>
              {overdue ? <Badge tone="warn">Overdue</Badge> : null}
            </div>

            <DetailList
              items={[
                { label: 'Owner', value: ownerLabel(action, ctx.userId) },
                { label: 'Due', value: action.dueDate ?? 'No date set' },
                { label: 'Added', value: action.createdAt.slice(0, 10) },
                ...(action.completedAt === null
                  ? []
                  : [{ label: 'Finished', value: action.completedAt.slice(0, 10) }]),
              ]}
            />
          </CardBody>
        </Card>

        {action.issue === null && action.recommendation === null ? null : (
          <Card>
            <CardBody>
              {action.issue === null ? null : (
                <>
                  <div className="flex min-w-0 items-center gap-3">
                    <IconBadge tint="violet" size="sm"><TriangleAlert /></IconBadge>
                    <h2 className="min-w-0 font-serif text-lg text-ink">What prompted it</h2>
                  </div>
                  <p className="mt-1 text-sm text-ink">{action.issue}</p>
                </>
              )}
              {action.recommendation === null ? null : (
                <>
                  <div className="mt-4 flex min-w-0 items-center gap-3">
                    <IconBadge tint="pink" size="sm"><Lightbulb /></IconBadge>
                    <h2 className="min-w-0 font-serif text-lg text-ink">What was suggested</h2>
                  </div>
                  <p className="mt-1 text-sm text-ink">{action.recommendation}</p>
                </>
              )}
            </CardBody>
          </Card>
        )}

        {action.evidenceBundleId === null ? null : (
          <Card>
            <CardBody>
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="violet" size="sm"><ChartColumn /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">The figures behind this</h2>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                Exactly what was on the screen when this was decided — kept as it was, even though
                the numbers have moved on since.
              </p>
              <p className="mt-3 text-sm">
                <Link
                  href={`/app/${orgSlug}/evidence/${action.evidenceBundleId}`}
                  className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft"
                >
                  Open the evidence
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              </p>
            </CardBody>
          </Card>
        )}

        {action.outcomeNotes === null && action.outcomeValue === null ? null : (
          <Card>
            <CardBody>
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="pink" size="sm"><Target /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">What came of it</h2>
              </div>
              {action.outcomeNotes === null ? null : (
                <p className="mt-1 text-sm text-ink">{action.outcomeNotes}</p>
              )}
              {action.outcomeValue === null ? null : (
                <p className="mt-2 font-serif text-2xl text-ink">
                  {formatMoney(action.outcomeValue, {
                    currency: action.outcomeCurrency ?? 'GBP', showMinorUnits: true,
                  })}
                </p>
              )}
            </CardBody>
          </Card>
        )}

        {canManage(ctx, action) ? (
          <Card>
            <CardBody>
              <div className="flex min-w-0 items-center gap-3">
                <IconBadge tint="violet" size="sm"><ArrowRightLeft /></IconBadge>
                <h2 className="min-w-0 font-serif text-lg text-ink">Move it along</h2>
              </div>
              <div className="mt-3">
                <StatusControls
                  orgSlug={orgSlug}
                  actionId={action.id}
                  status={action.status}
                  withOutcome
                />
              </div>
            </CardBody>
          </Card>
        ) : null}

        {can(ctx, 'actions.assign') ? (
          <AssignControl
            orgSlug={orgSlug}
            actionId={action.id}
            ownerUserId={action.ownerUserId}
            owners={await assignableOwners(ctx)}
          />
        ) : null}

        {/* ADR-144: the conversation about this action, between the team and the client. */}
        <Card>
          <CardBody>
            <div className="flex min-w-0 items-center gap-3">
              <IconBadge tint="violet" size="sm"><MessageSquare /></IconBadge>
              <h2 className="min-w-0 font-serif text-lg text-ink">Comments</h2>
            </div>
            {comments.length === 0 ? <p className="mt-2 text-sm text-ink-muted">No comments yet.</p> : (
              <ol className="mt-3 flex flex-col gap-3 text-sm">
                {comments.map((c) => (
                  <li key={c.id} className="border-b border-line pb-2 last:border-0">
                    <p className="text-ink">{c.author}<span className="text-ink-muted"> · {c.createdAt.slice(0, 16).replace('T', ' ')} UTC</span></p>
                    <p className="mt-1 whitespace-pre-line text-ink-muted">{c.body}</p>
                  </li>
                ))}
              </ol>
            )}
            <div className="mt-4">
              <CommentForm action={addActionCommentAction} hidden={{ org_slug: orgSlug, action_id: action.id }} />
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
