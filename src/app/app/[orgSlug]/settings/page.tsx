import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { OrganizationForm } from './organization-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'settings.manage');

  const { data } = await ctx.db
    .from('organizations')
    .select('name, timezone, fiscal_year_start_month, base_currency, status')
    .eq('id', ctx.orgId!)
    .single();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Details about this organisation and who can see it."
      />
      <nav className="mt-4 flex gap-4 text-sm">
        <Link href={`/app/${orgSlug}/settings/team`} className="underline">Team</Link>
        {can(ctx, 'audit.view') && (
          <Link href={`/app/${orgSlug}/settings/audit`} className="underline">Audit log</Link>
        )}
        {can(ctx, 'org.delete') && (
          <Link href={`/app/${orgSlug}/settings/danger`} className="underline">Danger zone</Link>
        )}
      </nav>
      <div className="mt-8">
        <Card>
          <CardHeader title="Organisation" description="Currency cannot change once figures exist." />
          <CardBody>
            <OrganizationForm
              orgSlug={orgSlug}
              name={data?.name ?? ''}
              timezone={data?.timezone ?? 'Europe/London'}
              fiscalYearStartMonth={data?.fiscal_year_start_month ?? 1}
              baseCurrency={data?.base_currency ?? 'GBP'}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
