import Link from 'next/link';
import { Activity, Building2, Clock, KeyRound, MessageSquareText } from 'lucide-react';
import { countOpenFeedback } from '@/modules/ai';
import { countGlobal, readableOrganizations } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, StatTile } from '@/components/ui/surfaces';
import { CLICKABLE_CARD } from '@/components/ui/clickable-card';

export const dynamic = 'force-dynamic';

/**
 * Each count opens the page it counts (owner, 2026-10-14: every card that opens something is
 * clickable as a whole): the tile is the link, with a clickable card's glow.
 */
const TILE_LINK = `block h-full rounded-card ${CLICKABLE_CARD}`;

export default async function PlatformOverviewPage() {
  const ctx = await getPlatformContext();

  // Each count is what the table's read policy admits (`src/modules/platform/services/reads.ts`).
  const [organizations, platformUsers, jobs, openFeedback] = await Promise.all([
    readableOrganizations(ctx.db).then((rows) => rows.length),
    countGlobal(ctx.db, 'platform_users'),
    countGlobal(ctx.db, 'jobs', (q) => q.where('status', '==', 'queued')),
    countOpenFeedback(ctx),
  ]);

  return (
    <>
      <PageHeader title="Platform" description="Operating APX itself." />
      <div className="mt-8">
        <Card>
          <CardHeader icon={<Activity />} tint="violet" title="At a glance" />
          <CardBody>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Link href="/platform/organizations" className={TILE_LINK}>
                <StatTile label="Organisations" value={organizations ?? 0} icon={<Building2 />} tint="violet" />
              </Link>
              <Link href="/platform/users" className={TILE_LINK}>
                <StatTile label="Platform accounts" value={platformUsers ?? 0} icon={<KeyRound />} tint="pink" />
              </Link>
              <Link href="/platform/jobs?status=all" className={TILE_LINK}>
                <StatTile label="Jobs waiting" value={jobs ?? 0} icon={<Clock />} tint="violet" />
              </Link>
              <Link href="/platform/ai-feedback" className={TILE_LINK}>
                <StatTile label="Open AI feedback" value={openFeedback} icon={<MessageSquareText />} tint="pink" />
              </Link>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
