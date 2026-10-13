import { Megaphone, Settings, Store } from 'lucide-react';
import { can } from '@/core/permissions';
import { getAccessContext } from '@/modules/tenancy';
import { getCompanyProfile, marketingEnabled, PROFILE_LIMITS } from '@/modules/marketing';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { ShortcutLink } from '@/components/dashboard/department-card';
import { requirePermission } from '@/app/_lib/authz';
import { CompanyProfileForm } from './company-profile-form';

export const dynamic = 'force-dynamic';

/**
 * The company profile (ADR-170): what the business sells, its industry, a short description, its
 * website and its social pages — filled in once by the analyst; the Marketing report is written from
 * it. `customers.edit` opens it: the owner, an admin and the assigned APX adviser. It sits under
 * Settings but is not gated by `settings.manage`, which the adviser does not hold.
 */
export default async function CompanyProfilePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'customers.edit');
  const profile = await getCompanyProfile(ctx);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Company profile"
        description="What the business sells, its industry, its website and its social pages. The Marketing report is written from this."
      />
      <nav className="mt-4 flex flex-wrap gap-3 text-sm">
        {can(ctx, 'settings.manage') && (
          <ShortcutLink href={`/app/${orgSlug}/settings`} label="Settings" icon={<Settings aria-hidden="true" />} />
        )}
        {marketingEnabled(ctx) && can(ctx, 'reports.view') && (
          <ShortcutLink href={`/app/${orgSlug}/marketing`} label="Marketing" icon={<Megaphone aria-hidden="true" />} />
        )}
      </nav>
      <div className="mt-8">
        <Card>
          <CardHeader
            icon={<Store />}
            tint="violet"
            title="About the business"
            description="Say what the company sells or its industry, at least, before the first report is written."
          />
          <CardBody>
            <CompanyProfileForm orgSlug={orgSlug} profile={profile} limits={PROFILE_LIMITS} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
