import { countOpenFeedback } from '@/modules/ai';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, DetailList } from '@/components/ui/surfaces';

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
          <CardHeader title="At a glance" />
          <CardBody>
            <DetailList
              items={[
                { label: 'Organisations', value: organizations ?? 0 },
                { label: 'Platform accounts', value: platformUsers ?? 0 },
                { label: 'Jobs waiting', value: jobs ?? 0 },
                { label: 'Open AI feedback', value: openFeedback },
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
