import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { platformHomeFor } from '@/modules/tenancy';
import { landingPathForRole, listMyOrganizations, sessionUserOf } from '@/modules/tenancy';
import { adviserOrganisations } from '@/modules/portfolio';
import { Card, CardBody, Badge } from '@/components/ui/surfaces';
import { ORG_STATUS_LABELS, ROLE_LABELS } from '@/components/labels';
import type { EffectiveRole } from '@/core/permissions';
import { BrandedScreen } from '@/components/dashboard/branded-screen';
import { CLICKABLE_CARD, CardLink } from '@/components/ui/clickable-card';

export const dynamic = 'force-dynamic';

export default async function SelectOrganizationPage() {
  const db = await createUserClient();
  if (!sessionUserOf(db)) redirect('/sign-in?next=/select-organization');
  // Platform accounts are never members of a customer organisation (§8.5).
  const platformHome = await platformHomeFor(db);
  if (platformHome) redirect(platformHome);

  const organizations = await listMyOrganizations(db);
  if (organizations.length === 0) redirect('/onboarding');
  // Departments, or Home for a person without `financials.view` — a 3rd party must not land on a
  // refusal (ADR-172 follow-up; `landingPathForRole`). The Departments page corrects a switch the
  // role alone cannot see.
  if (organizations.length === 1) redirect(landingPathForRole(organizations[0]!.slug, organizations[0]!.role));

  const advises = adviserOrganisations(organizations).length > 0;

  // Each card opens from anywhere on it, as every clickable card does (`ui/clickable-card`): the name is
  // its one link, stretched over the card, so the link is named by the organisation alone.
  return (
    <BrandedScreen width="lg" panel={false}>
      <h1 className="text-3xl">Choose an organisation</h1>
      {advises ? (
        <Card className={`border-line-strong ${CLICKABLE_CARD}`}>
          <CardBody className="flex items-center justify-between gap-4">
            <span className="min-w-0">
              <CardLink href="/portfolio" className="block font-medium">Command Centre</CardLink>
              <span className="block text-sm text-ink-muted">Health, alerts and actions across every organisation you advise.</span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-sm text-accent">Open</span>
          </CardBody>
        </Card>
      ) : null}
      <ul className="flex flex-col gap-3">
        {organizations.map((organization) => (
          <li key={organization.organizationId}>
            <Card className={CLICKABLE_CARD}>
              <CardBody className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <CardLink href={landingPathForRole(organization.slug, organization.role)} className="block font-medium [overflow-wrap:anywhere]">
                    {organization.name}
                  </CardLink>
                  <span className="block text-sm text-ink-muted">
                    {ROLE_LABELS[organization.role as EffectiveRole] ?? organization.role}
                  </span>
                </span>
                {organization.status !== 'active' && (
                  <span className="shrink-0"><Badge tone="warn">{ORG_STATUS_LABELS[organization.status]}</Badge></span>
                )}
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </BrandedScreen>
  );
}
