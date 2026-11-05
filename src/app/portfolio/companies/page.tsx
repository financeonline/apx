import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Building2, Plus } from 'lucide-react';
import { listManagedCompanies } from '@/modules/platform';
import { getPortfolioContext } from '@/modules/portfolio';
import { resolvePlatformRole } from '@/modules/tenancy';
import { PageHeader, Card, CardBody, CardHeader, EmptyState } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { CreateCompanyForm } from '@/app/platform/organizations/create-org-form';
import { createCompanyAsAnalystAction } from './actions';
import { CompanyStatusButton, OwnerLoginForm } from './company-actions';

export const dynamic = 'force-dynamic';

const LINK = 'text-sm font-medium text-accent hover:underline';

/**
 * A Financial Analyst's companies (ADR-187): the ones they created and the ones the super admin gave
 * them. From here they create a company, switch one off or on, and change its owner's login; its
 * people and settings are managed inside the company (Settings → Team, Settings).
 */
export default async function AnalystCompaniesPage() {
  const ctx = await getPortfolioContext();
  if ((await resolvePlatformRole(ctx.db, ctx.requestId)) !== 'employee') notFound();
  const companies = await listManagedCompanies(ctx);

  return (
    <>
      <PageHeader
        eyebrow="Command Centre"
        title="Your companies"
        description="The companies you created and the ones the super admin gave you. You manage their people, what each person sees, their settings and their owner's login."
      />
      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader icon={<Building2 />} tint="violet" title="Companies you manage" />
          <CardBody>
            {companies.length === 0 ? (
              <EmptyState title="No companies yet">Create one below, or ask the super admin to give you one.</EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Company', 'Owner', 'Status', 'Manage', '']} />
                <TBody>
                  {companies.map((c) => (
                    <TR key={c.id}>
                      <TD>
                        <span className="block font-medium text-ink">{c.name}</span>
                        <span className="block text-xs text-ink-muted">{c.createdByAnalyst ? 'You created it' : 'Given by the super admin'}</span>
                      </TD>
                      <TD className="break-all">
                        {c.owner ? (
                          <>
                            <span className="block text-sm">{c.owner.fullName ?? c.owner.email}</span>
                            <OwnerLoginForm orgId={c.id} email={c.owner.email} />
                          </>
                        ) : <span className="text-xs text-ink-muted">No owner login yet (invitation sent)</span>}
                      </TD>
                      <TD>{c.status === 'suspended' ? 'Deactivated' : c.status === 'active' ? 'Active' : c.status}</TD>
                      <TD>
                        <div className="flex flex-col gap-1">
                          <Link className={LINK} href={`/app/${c.slug}/home`}>Open</Link>
                          {c.status === 'active' ? (
                            <>
                              <Link className={LINK} href={`/app/${c.slug}/settings/team`}>People and access</Link>
                              <Link className={LINK} href={`/app/${c.slug}/settings`}>Settings</Link>
                            </>
                          ) : null}
                        </div>
                      </TD>
                      <TD>
                        {c.status === 'active' || c.status === 'suspended'
                          ? <CompanyStatusButton orgId={c.id} name={c.name} active={c.status === 'active'} />
                          : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            icon={<Plus />}
            tint="pink"
            title="Create a company"
            description="You manage every company you create. Set the owner's password to let them sign in straight away, or leave it empty to get an invitation link."
          />
          <CardBody><CreateCompanyForm action={createCompanyAsAnalystAction} /></CardBody>
        </Card>
      </div>
    </>
  );
}
