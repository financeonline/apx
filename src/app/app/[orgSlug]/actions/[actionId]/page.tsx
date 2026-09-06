import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { formatMoney } from '@/core/money';
import { todayInTimeZone, systemClock } from '@/core/periods';
import { assignableOwners, canManage, getAction, ownerLabel } from '@/modules/actions';
import { getAccessContext } from '@/modules/tenancy';
import { ACTION_SOURCE_LABELS, ACTION_STATUS_LABELS, priorityLabel } from '@/components/dashboard';
import { Badge, Card, CardBody, DetailList, PageHeader } from '@/components/ui/surfaces';
import { StatusControls } from '../status-controls';
import { AssignControl } from './assign-control';

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
  if (!can(ctx, 'actions.view')) notFound();

  // Cross-organisation or invented: NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14).
  const action = await getAction(ctx, actionId);
  if (action === null) notFound();

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
                  <h2 className="font-serif text-lg text-ink">What prompted it</h2>
                  <p className="mt-1 text-sm text-ink">{action.issue}</p>
                </>
              )}
              {action.recommendation === null ? null : (
                <>
                  <h2 className="mt-4 font-serif text-lg text-ink">What was suggested</h2>
                  <p className="mt-1 text-sm text-ink">{action.recommendation}</p>
                </>
              )}
            </CardBody>
          </Card>
        )}

        {action.evidenceBundleId === null ? null : (
          <Card>
            <CardBody>
              <h2 className="font-serif text-lg text-ink">The figures behind this</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Exactly what was on the screen when this was decided — kept as it was, even though
                the numbers have moved on since.
              </p>
              <p className="mt-3 text-sm">
                <Link
                  href={`/app/${orgSlug}/evidence/${action.evidenceBundleId}`}
                  className="text-accent underline underline-offset-2"
                >
                  Open the evidence
                </Link>
              </p>
            </CardBody>
          </Card>
        )}

        {action.outcomeNotes === null && action.outcomeValue === null ? null : (
          <Card>
            <CardBody>
              <h2 className="font-serif text-lg text-ink">What came of it</h2>
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
              <h2 className="font-serif text-lg text-ink">Move it along</h2>
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
      </div>
    </>
  );
}
