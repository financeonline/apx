import Link from 'next/link';
import { ClipboardCheck, History } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { loadAlertDetail } from '@/modules/dashboard';
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
      <PageHeader eyebrow={detail.alert.family} title={detail.alert.title} />

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
                The action keeps the figures behind this alert exactly as they are now, even after
                the alert is looked at again.
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
              Every time your figures changed, we looked again. This is what we found each time.
            </p>

            <ol className="mt-4 space-y-4">
              {detail.revisions.map((revision) => (
                <li key={revision.revisionNo} className="border-l-2 border-accent/40 pl-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge tone={severityTone(revision.severity)}>
                      {severityLabel(revision.severity)}
                    </Badge>
                    <span className="text-sm text-ink-faint">{revision.at}</span>
                  </div>
                  <p className="mt-1 text-sm text-ink">{revision.explanation}</p>
                  {revision.evidenceHref ? (
                    <p className="mt-1 text-sm">
                      <Link
                        href={revision.evidenceHref}
                        className="text-accent underline underline-offset-2"
                      >
                        The figures behind this
                      </Link>
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
