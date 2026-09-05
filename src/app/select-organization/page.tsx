import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { listMyOrganizations } from '@/modules/tenancy';
import { Card, CardBody, Badge } from '@/components/ui/surfaces';
import { ORG_STATUS_LABELS, ROLE_LABELS } from '@/components/labels';
import type { EffectiveRole } from '@/core/permissions';

export const dynamic = 'force-dynamic';

export default async function SelectOrganizationPage() {
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect('/sign-in?next=/select-organization');

  const organizations = await listMyOrganizations(db);
  if (organizations.length === 0) redirect('/onboarding');
  if (organizations.length === 1) redirect(`/app/${organizations[0]!.slug}/home`);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Choose an organisation</h1>
      <ul className="flex flex-col gap-3">
        {organizations.map((organization) => (
          <li key={organization.organizationId}>
            <Link href={`/app/${organization.slug}/home`} className="block">
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
    </main>
  );
}
