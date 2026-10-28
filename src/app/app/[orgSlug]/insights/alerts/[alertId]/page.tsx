import Link from 'next/link';
import { ClipboardCheck, History } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { loadAlertDetail, type AlertHistoryView } from '@/modules/dashboard';
import { PageHeader, Card, CardBody, Badge, IconBadge } from '@/components/ui/surfaces';
import { AlertCard, severityLabel, severityTone } from '@/components/dashboard';
import { AlertActions } from '../alert-actions';
import { ConvertControl } from './convert-control';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * One alert and everything it has ever said (ADR-034, F-C-16).
 *
 * The history is the point of the page. An alert is re-evaluated every time the figures change, and
 * what it said in March is not what it says in June — so "you told me this was £2,900 last quarter"
 * has to be answerable, with the evidence that was pinned at the time rather than the evidence that
 * would be pinned now.
 */
export default async function AlertPage({
  params,
}: {
  params: Promise<{ orgSlug: string; alertId: string }>;
}) {
  const { orgSlug, alertId } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  const detail = await loadAlertDetail(ctx.db, ctx.orgId!, orgSlug, alertId, ctx.requestId);
  // Cross-organisation or invented: NOT FOUND, never FORBIDDEN (SECURITY_MODEL.md §14).
  if (detail === null) notFound();

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/app/${orgSlug}/insights`} className="text-accent underline underline-offset-2">
          Back to Insights
        </Link>
      </p>
      {/*
        * "Alert" rather than the rule family: the card below already names the family ("Big change
        * from last month"), and saying it twice above the title adds nothing.
        */}
      <PageHeader eyebrow="Alert" title={detail.alert.title} />

      <div className="mt-8 flex flex-col gap-6">
        <AlertCard
          alert={detail.alert}
          linked={false}
          actions={can(ctx, 'alerts.manage') ? (
            <AlertActions
              orgSlug={orgSlug}
              alertId={detail.alert.id}
              status={detail.alert.status}
              role={ctx.effectiveRole}
            />
          ) : undefined}
        />

        {can(ctx, 'actions.create') ? (
          <Card>
            <CardBody>
              <div className="flex items-center gap-3">
                <IconBadge tint="violet" size="sm"><ClipboardCheck /></IconBadge>
                <h2 className="font-serif text-lg text-ink">Do something about it</h2>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                Turn this into a task in the Action Centre, so someone can own it and see it through.
                The task keeps a copy of today&rsquo;s figures, so you can always see why it was
                raised, even after they change.
              </p>
              <div className="mt-3">
                <ConvertControl
                  orgSlug={orgSlug}
                  alertId={detail.alert.id}
                  actionId={detail.alert.actionId ?? null}
                />
              </div>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardBody>
            <div className="flex items-center gap-3">
              <IconBadge tint="pink" size="sm"><History /></IconBadge>
              <h2 className="font-serif text-lg text-ink">What this alert has said</h2>
            </div>
            <p className="mt-1 text-sm text-ink-muted">
              Every time your figures changed, we checked again. The latest check is first.
            </p>

            {/*
              * Newest first. Only the latest is open: a long run of near-identical earlier checks
              * pushed the one that matters off the screen. The rest are one click away, unchanged.
              */}
            {detail.revisions.length === 0 ? null : (
              <ol className="mt-4 space-y-4">
                <Revision revision={detail.revisions[0]!} />
              </ol>
            )}
            {detail.revisions.length <= 1 ? null : (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium text-accent">
                  Earlier checks ({detail.revisions.length - 1})
                </summary>
                <ol className="mt-3 space-y-4">
                  {detail.revisions.slice(1).map((revision) => (
                    <Revision key={revision.revisionNo} revision={revision} />
                  ))}
                </ol>
              </details>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/** One check of the alert: how serious it was, when, what it said, and the figures pinned then. */
function Revision({ revision }: { revision: AlertHistoryView['revisions'][number] }) {
  return (
    <li className="border-l-2 border-accent/40 pl-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge tone={severityTone(revision.severity)}>
          {severityLabel(revision.severity)}
        </Badge>
        <span className="text-sm text-ink-faint">{revision.at}</span>
      </div>
      <p className="mt-1 text-sm text-ink">{revision.explanation}</p>
      {revision.evidenceHref ? (
        <p className="mt-1 text-sm">
          <Link href={revision.evidenceHref} className="text-accent underline underline-offset-2">
            The figures behind this
          </Link>
        </p>
      ) : null}
    </li>
  );
}
