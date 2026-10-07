import { Activity, Building2, Clock, KeyRound, MessageSquareText } from 'lucide-react';
import { countOpenFeedback } from '@/modules/ai';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, StatTile } from '@/components/ui/surfaces';

export const dynamic = 'force-dynamic';

export default async function PlatformOverviewPage() {
  const ctx = await getPlatformContext();

  const [{ count: organizations }, { count: platformUsers }, { count: jobs }, openFeedback] = await Promise.all([
    ctx.db.from('organizations').select('id', { count: 'exact', head: true }),
    ctx.db.from('platform_users').select('user_id', { count: 'exact', head: true }),
    ctx.db.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'queued'),
    countOpenFeedback(ctx),
  ]);

  return (
    <>
      <PageHeader title="Platform" description="Operating MOTION itself." />
      <div className="mt-8">
        <Card>
          <CardHeader icon={<Activity />} tint="violet" title="At a glance" />
          <CardBody>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Organisations" value={organizations ?? 0} icon={<Building2 />} tint="violet" />
              <StatTile label="Platform accounts" value={platformUsers ?? 0} icon={<KeyRound />} tint="pink" />
              <StatTile label="Jobs waiting" value={jobs ?? 0} icon={<Clock />} tint="violet" />
              <StatTile label="Open AI feedback" value={openFeedback} icon={<MessageSquareText />} tint="pink" />
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
