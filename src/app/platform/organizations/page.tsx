import Link from 'next/link';
import { toMotionError } from '@/core/errors';
import { getPlatformContext } from '@/modules/tenancy';
import { listCompanyOwners } from '@/modules/platform';
import { Building2 } from 'lucide-react';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardBody, CardHeader, EmptyState, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { ORG_STATUS_LABELS } from '@/components/labels';
import { Input } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { CreateCompanyForm } from './create-org-form';
import { OrgStatusRowControl } from './[orgId]/org-controls';
import { CompanyRowActions } from './company-row-actions';

export const dynamic = 'force-dynamic';

/**
 * A list of names, kinds and dates only. Opening tenant CONTENT is what writes org.data_viewed
 * (ADR-038.6), and that happens in the tenant layout.
 */
/**
 * The search term, reduced to letters, digits, spaces, hyphens, ampersands and full stops: it goes
 * into a PostgREST `or` filter, whose own syntax (commas, brackets, `*`) must not be injectable.
 */
function searchTerm(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? '').replace(/[^\p{L}\p{N} &.-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

export default async function PlatformOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getPlatformContext();
  const q = searchTerm((await searchParams).q);
  let query = ctx.db
    .from('organizations')
    .select('id, slug, name, legal_name, country_code, base_currency, fiscal_year_start_month, status, plan, created_at')
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })
    .limit(100);
  // Name, slug or legal name containing the words, in any case.
  if (q) query = query.or(`name.ilike.*${q}*,slug.ilike.*${q}*,legal_name.ilike.*${q}*`);
  const { data, error } = await query;

  // Never `data ?? []` on its own: a failing query rendered as an empty list is the one thing a
  // platform page must not show (PRODUCTION_AUDIT.md M2; ADR-070).
  if (error) throw toMotionError(error, ctx.requestId);
  const organizations = data ?? [];
  const mayCreate = can(ctx, 'platform.orgs.manage');
  // ADR-167: whose login the Edit dialog changes.
  const owners = mayCreate ? await listCompanyOwners(ctx, organizations.map((o) => o.id)) : new Map();

  return (
    <>
      <PageHeader title="Organisations" description="Every customer organisation on the platform." />
      <div className="mt-8 flex flex-col gap-6">
        {mayCreate && (
          <Card>
            <CardHeader icon={<Building2 />} tint="violet" title="Create a company"
              description="The company is set up for its owner, who signs in with the password you set or joins through an invitation link. You do not become a member." />
            <CardBody><CreateCompanyForm /></CardBody>
          </Card>
        )}
        <Card>
          <CardBody className="flex flex-col gap-4">
            <form role="search" action="/platform/organizations" className="flex flex-wrap items-center gap-3">
              <Input
                name="q" type="search" defaultValue={q} placeholder="Search companies by name"
                aria-label="Search companies" className="min-w-0 flex-1 sm:max-w-md"
              />
              <Button type="submit">Search</Button>
              {q ? <Link href="/platform/organizations" className="text-sm text-accent underline">Clear</Link> : null}
            </form>
            {organizations.length === 0 ? (
              q ? (
                <EmptyState title="No company matches">Nothing is called “{q}”. Check the spelling, or clear the search.</EmptyState>
              ) : (
                <EmptyState title="No organisations yet">They appear here as customers sign up, or create one above.</EmptyState>
              )
            ) : (
              <TableWrap>
                <THead columns={mayCreate ? ['Name', 'Slug', 'Plan', 'Status', 'Created', 'Manage'] : ['Name', 'Slug', 'Plan', 'Status', 'Created']} />
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
                      {mayCreate ? (
                        <TD>
                          <div className="flex flex-wrap items-center gap-2">
                          <OrgStatusRowControl orgId={organization.id} name={organization.name} status={organization.status} />
                          <CompanyRowActions company={{
                            id: organization.id, name: organization.name, legalName: organization.legal_name,
                            countryCode: organization.country_code, baseCurrency: organization.base_currency,
                            fiscalYearStartMonth: Number(organization.fiscal_year_start_month), plan: organization.plan,
                            status: organization.status, owner: owners.get(organization.id) ?? null,
                          }} />
                          </div>
                        </TD>
                      ) : null}
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
