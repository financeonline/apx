import Link from 'next/link';
import { toMotionError } from '@/core/errors';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardBody, EmptyState, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { ORG_STATUS_LABELS } from '@/components/labels';

export const dynamic = 'force-dynamic';

/**
 * A list of names, kinds and dates only. Opening tenant CONTENT is what writes org.data_viewed
 * (ADR-038.6), and that happens in the tenant layout.
 */
export default async function PlatformOrganizationsPage() {
  const ctx = await getPlatformContext();
  const { data, error } = await ctx.db
    .from('organizations')
    .select('id, slug, name, status, plan, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  // Never `data ?? []` on its own: a failing query rendered as an empty list is the one thing a
  // platform page must not show (PRODUCTION_AUDIT.md M2; ADR-070).
  if (error) throw toMotionError(error, ctx.requestId);
  const organizations = data ?? [];

  return (
    <>
      <PageHeader title="Organisations" description="Every customer organisation on the platform." />
      <div className="mt-8">
        <Card>
          <CardBody>
            {organizations.length === 0 ? (
              <EmptyState title="No organisations yet">They appear here as customers sign up.</EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Name', 'Slug', 'Plan', 'Status', 'Created']} />
                <TBody>
                  {organizations.map((organization) => (
                    <TR key={organization.id}>
                      <TD><Link href={`/platform/organizations/${organization.id}`} className="underline">{organization.name}</Link></TD>
                      <TD>{organization.slug}</TD>
                      <TD>{organization.plan}</TD>
                      <TD>
                        {organization.status === 'active' ? (
                          ORG_STATUS_LABELS[organization.status]
                        ) : (
                          <Badge tone="warn">{ORG_STATUS_LABELS[organization.status]}</Badge>
                        )}
                      </TD>
                      <TD>{new Date(organization.created_at).toLocaleDateString('en-GB')}</TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
