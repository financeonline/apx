import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { DangerForms } from './danger-forms';

export const dynamic = 'force-dynamic';

export default async function DangerPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  assertCan(ctx, 'org.delete');

  return (
    <>
      <PageHeader
        title="Danger zone"
        description="Deleting an organisation removes its data. There is a 30-day window to change your mind."
      />
      <div className="mt-8">
        <Card>
          <CardHeader
            title={ctx.organizationStatus === 'pending_deletion' ? 'Deletion scheduled' : 'Delete this organisation'}
            description={
              ctx.organizationStatus === 'pending_deletion'
                ? 'Everything is still here. Cancelling stops the deletion.'
                : 'Nothing is removed immediately: the data is kept for 30 days first.'
            }
          />
          <CardBody>
            <DangerForms orgSlug={orgSlug} pendingDeletion={ctx.organizationStatus === 'pending_deletion'} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
