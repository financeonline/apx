import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { loadOrganizationDetail } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, CardHeader, DetailList, PageHeader } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate, formatDateTime, MEMBERSHIP_ROLE_LABELS, ORG_STATUS_LABELS } from '@/components/labels';
import { OrgFeatureToggle, OrgQuotasForm, OrgStatusControl } from './org-controls';

export const dynamic = 'force-dynamic';

/**
 * One customer organisation (ROUTE_ARCHITECTURE.md §150; MVP_SCOPE.md §2.2).
 *
 * Everything a super admin needs to answer "what is this customer's state, and why is their
 * analyst refusing" in one place: who is in it, who advises it, what it is allowed to do, and the
 * limits that apply. "Open as staff" goes into the tenant shell, which records `org.data_viewed` in
 * the organisation's OWN audit log — the customer can see that a member of staff looked (CD-13).
 */
export default async function PlatformOrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const ctx = await getPlatformContext();
  assertCan(ctx, 'platform.orgs.manage');
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) notFound();

  let detail;
  try {
    detail = await loadOrganizationDetail(ctx, orgId);
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
  const { organization: org, quotas, members, assignments, counts } = detail;
  const aiExtraction = org.features.ai_pdf_extraction === true;
  const fundingReadiness = org.features.funding_readiness === true;

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/platform/organizations" className="underline">Back to organisations</Link></p>
      <PageHeader title={org.name} description={`${org.slug} · created ${formatDate(org.createdAt)}`} />

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title={`Members (${members.length})`} />
            <CardBody>
              {members.length === 0 ? <p className="text-sm text-ink-muted">Nobody has joined yet.</p> : (
                <TableWrap>
                  <THead columns={['Name', 'Email', 'Role', 'Status', 'Joined']} />
                  <TBody>
                    {members.map((m) => (
                      <TR key={m.userId}>
                        <TD>{m.fullName ?? '—'}</TD>
                        <TD className="text-ink-muted">{m.email}</TD>
                        <TD>{MEMBERSHIP_ROLE_LABELS[m.role] ?? m.role}</TD>
                        <TD>{m.status === 'active' ? 'Active' : <Badge tone="warn">{m.status}</Badge>}</TD>
                        <TD className="text-ink-muted">{formatDate(m.joinedAt)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </TableWrap>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={`Assigned staff (${assignments.length})`} />
            <CardBody>
              {assignments.length === 0 ? (
                <p className="text-sm text-ink-muted">Nobody is assigned. <Link className="underline" href="/platform/assignments">Assign an employee</Link>.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {assignments.map((a) => (
                    <li key={a.id}>
                      <span className="font-mono text-xs">{a.employeeUserId}</span>
                      <span className="ml-2 text-ink-muted">{a.status}{a.endsAt ? ` · ends ${formatDate(a.endsAt)}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="What this organisation may do" />
            <CardBody>
              <div className="flex flex-col gap-3">
                <OrgFeatureToggle orgId={org.id} feature="ai_pdf_extraction" label="Read PDFs with AI"
                  hint="statement text is sent to the AI provider; the customer consents per import (CD-35)"
                  enabled={aiExtraction} features={org.features} />
                {/* Phase 16 (D-5, ADR-121): default off; switching it on assesses every eligible month. */}
                <OrgFeatureToggle orgId={org.id} feature="funding_readiness" label="Funding Readiness"
                  hint="an indicative readiness assessment; switching it on assesses every complete month, and switching it off hides it everywhere"
                  enabled={fundingReadiness} features={org.features} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Limits" />
            <CardBody>
              <p className="mb-3 text-sm text-ink-muted">Leave a field blank to use the platform default from <Link className="underline" href="/platform/settings">settings</Link>.</p>
              <OrgQuotasForm orgId={org.id} quotas={quotas} />
            </CardBody>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="State" />
            <CardBody>
              <DetailList items={[
                { label: 'Status', value: org.status === 'active' ? ORG_STATUS_LABELS[org.status] : <Badge tone="warn">{ORG_STATUS_LABELS[org.status] ?? org.status}</Badge> },
                { label: 'Plan', value: org.plan },
                { label: 'Kind', value: org.kind ?? '—' },
                { label: 'Country', value: org.countryCode ?? '—' },
                { label: 'Industry', value: org.industry ?? '—' },
                { label: 'Currency', value: org.baseCurrency },
                { label: 'Year starts', value: `month ${org.fiscalYearStartMonth}` },
                { label: 'Timezone', value: org.timezone ?? '—' },
                ...(org.deletionRequestedAt ? [{ label: 'Deletion requested', value: formatDateTime(org.deletionRequestedAt) }] : []),
              ]} />
              <div className="mt-4"><OrgStatusControl orgId={org.id} status={org.status} /></div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="What is in it" />
            <CardBody>
              <DetailList items={[
                { label: 'Documents', value: counts.documents },
                { label: 'Imports', value: counts.batches },
                { label: 'Analyst conversations', value: counts.conversations },
              ]} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Open as staff" />
            <CardBody>
              <p className="text-sm text-ink-muted">
                Opening this customer&rsquo;s pages is recorded in <em>their</em> audit log, and they can see it (CD-13).
              </p>
              <p className="mt-3 text-sm">
                <Link className="underline" href={`/app/${org.slug}/home`}>Open {org.name}</Link>
              </p>
              <p className="mt-3 text-sm">
                <Link className="underline" href={`/platform/audit?org=${org.id}`}>This organisation&rsquo;s audit trail</Link>
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
