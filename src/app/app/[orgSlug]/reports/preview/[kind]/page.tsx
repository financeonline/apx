import Link from 'next/link';
import { notFound } from 'next/navigation';
import { KIND_LABELS, previewBrief, windowLabel } from '@/modules/reporting';
import { getAccessContext } from '@/modules/tenancy';
import { Banner, PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { BriefView } from '../../_components/brief-view';

export const dynamic = 'force-dynamic';

/**
 * Today so far / this week so far (Phase 17, R17-3). Composed now and not stored: the period has not
 * finished, and a stored report would say it had been reported on.
 */
export default async function BriefPreviewPage({ params }: { params: Promise<{ orgSlug: string; kind: string }> }) {
  const { orgSlug, kind } = await params;
  if (kind !== 'daily_brief' && kind !== 'weekly_intelligence') notFound();
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');

  const content = await previewBrief(ctx, kind);
  const daily = kind === 'daily_brief';

  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href={`/app/${orgSlug}/reports`} className="text-accent underline underline-offset-2">Back to reports</Link>
      </p>
      <PageHeader
        eyebrow={content.organisationName}
        title={`${KIND_LABELS[kind]} — ${daily ? 'today so far' : 'this week so far'}`}
        description={windowLabel(content.window.start, content.window.end)}
      />
      <Banner tone="info" title={daily ? 'This day is not over' : 'This week is not over'}>
        These figures will change as the {daily ? 'day' : 'week'} goes on and more data arrives. The finished
        {daily ? ' brief is produced shortly after midnight' : ' report is produced early on Monday'}, and kept.
      </Banner>
      <div className="mt-8">
        <BriefView content={content} orgSlug={orgSlug} />
      </div>
    </>
  );
}
