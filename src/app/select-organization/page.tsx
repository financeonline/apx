import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { listMyOrganizations } from '@/modules/tenancy';
import { adviserOrganisations } from '@/modules/portfolio';
import { Card, CardBody, Badge } from '@/components/ui/surfaces';
import { ORG_STATUS_LABELS, ROLE_LABELS } from '@/components/labels';
import type { EffectiveRole } from '@/core/permissions';
import { BrandedScreen } from '@/components/dashboard/branded-screen';

export const dynamic = 'force-dynamic';

export default async function SelectOrganizationPage() {
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect('/sign-in?next=/select-organization');

  const organizations = await listMyOrganizations(db);
  if (organizations.length === 0) redirect('/onboarding');
  if (organizations.length === 1) redirect(`/app/${organizations[0]!.slug}/departments`);

  const advises = adviserOrganisations(organizations).length > 0;

  return (
    <BrandedScreen width="lg" panel={false}>
      <h1 className="text-3xl">Choose an organisation</h1>
      {advises ? (
        <Link href="/portfolio" className="block">
          <Card className="border-line-strong transition-colors hover:border-accent">
            <CardBody className="flex items-center justify-between gap-4">
              <span>
                <span className="block font-medium">Command Centre</span>
                <span className="block text-sm text-ink-muted">Health, alerts and actions across every organisation you advise.</span>
              </span>
              <span className="text-sm text-accent">Open</span>
            </CardBody>
          </Card>
        </Link>
      ) : null}
      <ul className="flex flex-col gap-3">
        {organizations.map((organization) => (
          <li key={organization.organizationId}>
            <Link href={`/app/${organization.slug}/departments`} className="block">
              <Card className="transition-colors hover:border-line-strong">
                <CardBody className="flex items-center justify-between gap-4">
                  <span>
                    <span className="block font-medium">{organization.name}</span>
                    <span className="block text-sm text-ink-muted">
                      {ROLE_LABELS[organization.role as EffectiveRole] ?? organization.role}
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
    </BrandedScreen>
  );
}
