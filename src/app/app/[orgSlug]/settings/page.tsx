import { Building2, Globe, Landmark, Receipt, ScrollText, Store, TriangleAlert, Users } from 'lucide-react';
import { getAccessContext, taxSettingsOf, vatStatusOf } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { ShortcutLink } from '@/components/dashboard/department-card';
import { OrganizationForm } from './organization-form';
import { VatForm } from './vat-form';
import { CurrencyForm } from './currency-form';
import { TaxForm } from './tax-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'settings.manage');

  const { data } = await ctx.db
    .from('organizations')
    .select('name, timezone, fiscal_year_start_month, base_currency, country_code, status, settings')
    .eq('id', ctx.orgId!)
    .single();

  const tax = taxSettingsOf(data?.settings);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Details about this organisation and who can see it."
      />
      <nav className="mt-4 flex flex-wrap gap-3 text-sm">
        <ShortcutLink href={`/app/${orgSlug}/settings/team`} label="Team" icon={<Users aria-hidden="true" />} />
        {/* ADR-170: what the Marketing report is written from. */}
        {can(ctx, 'customers.edit') && (
          <ShortcutLink href={`/app/${orgSlug}/settings/company-profile`} label="Company profile" icon={<Store aria-hidden="true" />} />
        )}
        {can(ctx, 'audit.view') && (
          <ShortcutLink href={`/app/${orgSlug}/settings/audit`} label="Audit log" icon={<ScrollText aria-hidden="true" />} />
        )}
        {can(ctx, 'org.delete') && (
          <ShortcutLink href={`/app/${orgSlug}/settings/danger`} label="Danger zone" icon={<TriangleAlert aria-hidden="true" />} />
        )}
      </nav>
      <div className="mt-8">
        <Card>
          <CardHeader icon={<Building2 />} tint="violet" title="Organisation" description="The business's name, financial year and time zone." />
          <CardBody>
            <OrganizationForm
              orgSlug={orgSlug}
              name={data?.name ?? ''}
              timezone={data?.timezone ?? 'Europe/London'}
              fiscalYearStartMonth={data?.fiscal_year_start_month ?? 1}
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
      <div className="mt-8">
        <Card>
          <CardHeader icon={<Globe />} tint="violet" title="Currency and country" description="Where the business is based and the currency its figures are kept in." />
          <CardBody>
            <CurrencyForm
              orgSlug={orgSlug}
              currency={data?.base_currency ?? 'GBP'}
              country={data?.country_code ?? 'GB'}
            />
          </CardBody>
        </Card>
      </div>
      <div className="mt-8">
        <Card>
          <CardHeader icon={<Landmark />} tint="pink" title="Tax" description="Used for the indicative VAT return and the Corporation Tax estimate." />
          <CardBody>
            <TaxForm
              orgSlug={orgSlug}
              vatQuarterEndMonth={tax.vatQuarterEndMonth}
              vatScheme={tax.vatScheme}
              ctAssociatedCompanies={tax.ctAssociatedCompanies}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
