import { Building2, Receipt, ScrollText, TriangleAlert, Users } from 'lucide-react';
import { getAccessContext, vatStatusOf } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { ShortcutLink } from '@/components/dashboard/department-card';
import { OrganizationForm } from './organization-form';
import { VatForm } from './vat-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'settings.manage');

  const { data } = await ctx.db
    .from('organizations')
    .select('name, timezone, fiscal_year_start_month, base_currency, status, settings')
    .eq('id', ctx.orgId!)
    .single();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Details about this organisation and who can see it."
      />
      <nav className="mt-4 flex flex-wrap gap-3 text-sm">
        <ShortcutLink href={`/app/${orgSlug}/settings/team`} label="Team" icon={<Users aria-hidden="true" />} />
        {can(ctx, 'audit.view') && (
          <ShortcutLink href={`/app/${orgSlug}/settings/audit`} label="Audit log" icon={<ScrollText aria-hidden="true" />} />
        )}
        {can(ctx, 'org.delete') && (
          <ShortcutLink href={`/app/${orgSlug}/settings/danger`} label="Danger zone" icon={<TriangleAlert aria-hidden="true" />} />
        )}
      </nav>
      <div className="mt-8">
        <Card>
          <CardHeader icon={<Building2 />} tint="violet" title="Organisation" description="Currency cannot change once figures exist." />
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
      <div className="mt-8">
        <Card>
          <CardHeader icon={<Receipt />} tint="pink" title="VAT" description="Whether your sales and costs are recorded with or without VAT." />
          <CardBody>
            <VatForm orgSlug={orgSlug} status={vatStatusOf(data?.settings)} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
