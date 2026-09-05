import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { listMyOrganizations } from '@/modules/tenancy';
import { PageHeader, Card, CardBody, EmptyState, Badge } from '@/components/ui/surfaces';
import { ORG_STATUS_LABELS } from '@/components/labels';

export const dynamic = 'force-dynamic';

/**
 * The adviser's landing page (TENANCY_MODEL.md §5.6). One statement over the caller's accessible
 * set — a read-only aggregate projection, not a cross-tenant query.
 */
export default async function PortfolioPage() {
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect('/sign-in?next=/portfolio');

  const organizations = await listMyOrganizations(db);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <PageHeader
        title="Your client organisations"
        description="The organisations you have been assigned to help with."
      />
      <div className="mt-8">
        {organizations.length === 0 ? (
          <EmptyState title="No client organisations assigned yet">
              A MOTION super admin assigns you to a client organisation. When they do, it appears here.
            </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {organizations.map((organization) => (
              <li key={organization.organizationId}>
                <Link href={`/app/${organization.slug}/home`}>
                  <Card className="h-full transition-colors hover:border-line-strong">
                    <CardBody className="flex items-start justify-between gap-3">
                      <span>
                        <span className="block font-medium">{organization.name}</span>
                        <span className="block text-sm text-ink-muted">
                          Health score and alerts arrive with the dashboard.
                        </span>
                      </span>
                      {organization.status !== 'active' && (
                        <Badge tone="warn">{ORG_STATUS_LABELS[organization.status]}</Badge>
                      )}
                    </CardBody>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
