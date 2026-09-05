import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, EmptyState } from '@/components/ui/surfaces';

export const dynamic = 'force-dynamic';

export default async function HomePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);

  return (
    <>
      <PageHeader
        title="How is my business doing?"
        description="Your health score, headline numbers and what needs attention will appear here."
      />
      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader title="No data yet" />
          <CardBody>
            <EmptyState
              title="There is nothing to show until you add data"
              actionHref={can(ctx, 'settings.manage') ? `/app/${orgSlug}/settings/team` : undefined}
              actionLabel={can(ctx, 'settings.manage') ? 'Invite your team' : undefined}
            >
              MOTION reads the files you already have — bank statements, ledgers and invoice lists —
              and turns them into figures you can check line by line. Importing is the next thing we
              are building.
            </EmptyState>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
