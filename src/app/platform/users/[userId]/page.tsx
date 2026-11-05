import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { permissionsFor } from '@/core/permissions';
import { listPlatformUsers, loadAnalystAccess, readableOrganizations } from '@/modules/platform';
import { DEPARTMENT_KEYS, DEPARTMENT_WORDS, PERMISSION_WORDS, SWITCHABLE_PERMISSIONS, getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardBody, CardHeader, EmptyState } from '@/components/ui/surfaces';
import { AnalystAccessForm } from './access-form';

export const dynamic = 'force-dynamic';

/**
 * One Financial Analyst's access, company by company (ADR-187): the super admin ticks the departments
 * they can open and what they can see and do. They manage the company's people within these ticks.
 */
export default async function AnalystAccessPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const ctx = await getPlatformContext();
  const [users, organizations] = await Promise.all([listPlatformUsers(ctx), readableOrganizations(ctx.db)]);
  const analyst = users.find((u) => u.userId === userId && u.platformRole === 'employee');
  if (!analyst) notFound();
  const access = await loadAnalystAccess(ctx, userId);
  const nameOf = new Map(organizations.map((o) => [String(o.id), String(o.name)]));
  const defaults = permissionsFor('employee');
  const departments = DEPARTMENT_KEYS.map((key) => ({ key, ...DEPARTMENT_WORDS[key] }));
  const permissions = SWITCHABLE_PERMISSIONS.map((key) => ({ key, ...PERMISSION_WORDS[key] }));
  const rows = access
    .filter((a) => nameOf.has(a.organizationId))
    .sort((a, b) => nameOf.get(a.organizationId)!.localeCompare(nameOf.get(b.organizationId)!));

  return (
    <>
      <PageHeader
        eyebrow="Platform accounts"
        title={`${analyst.fullName ?? analyst.email ?? 'Financial Analyst'}: access`}
        description="For each company this analyst has, choose the departments they can open and what they can see and do. They cannot change their own access."
      />
      <p className="mt-2 text-sm"><Link className="font-medium text-accent hover:underline" href="/platform/users">Back to Platform accounts</Link></p>
      <div className="mt-6 flex flex-col gap-6">
        {rows.length === 0 ? (
          <EmptyState title="No companies yet">Tick companies for them on Platform accounts, or they can create their own.</EmptyState>
        ) : rows.map((a) => (
          <Card key={a.organizationId}>
            <CardHeader
              icon={<ShieldCheck />} tint="violet" title={nameOf.get(a.organizationId)!}
              description={a.createdByAnalyst ? 'They created this company.' : a.endsAt ? `Given until ${new Date(a.endsAt).toLocaleDateString('en-GB')}.` : 'Given by you.'}
            />
            <CardBody>
              <AnalystAccessForm
                userId={userId} orgId={a.organizationId}
                departments={departments} departmentsOn={a.departments ?? DEPARTMENT_KEYS}
                permissions={permissions}
                permissionsOn={SWITCHABLE_PERMISSIONS.filter((p) => a.switches.get(p) ?? defaults.has(p))}
              />
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
