import Link from 'next/link';
import { Activity, Briefcase, ChevronRight, Database, Gauge, LogIn, ToggleRight, UsersRound } from 'lucide-react';
import { notFound } from 'next/navigation';
import { isMotionError } from '@/core/errors';
import { assertCan } from '@/core/permissions';
import { loadOrganizationDetail } from '@/modules/platform';
import { MODULES, enabledModules, getPlatformContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, CardHeader, DetailList, PageHeader } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate, formatDateTime, MEMBERSHIP_ROLE_LABELS, ORG_STATUS_LABELS } from '@/components/labels';
import { OrgModuleSwitch, OrgQuotasForm, OrgStatusControl } from './org-controls';

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
  const systems = enabledModules(org.features);

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/platform/organizations" className="underline">Back to organisations</Link></p>
      <PageHeader title={org.name} description={`${org.slug} · created ${formatDate(org.createdAt)}`} />

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader icon={<UsersRound />} tint="violet" title={`Members (${members.length})`} />
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
            <CardHeader icon={<Briefcase />} tint="pink" title={`Assigned staff (${assignments.length})`} />
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
            <CardHeader icon={<ToggleRight />} tint="violet" title="Systems this company can use" />
            <CardBody>
              <p className="mb-4 text-sm text-ink-muted">Home, Money, Insights, Departments, Data &amp; Forms and Settings are always on.</p>
              <div className="flex flex-col gap-3">
                {MODULES.map((m) => (
                  <OrgModuleSwitch key={m.key} orgId={org.id} featureKey={m.featureKey}
                    label={m.label} description={m.description} on={systems.has(m.key)} />
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader icon={<Gauge />} tint="pink" title="Limits" />
            <CardBody>
              <p className="mb-3 text-sm text-ink-muted">Leave a field blank to use the platform default from <Link className="underline" href="/platform/settings">settings</Link>.</p>
              <OrgQuotasForm orgId={org.id} quotas={quotas} />
            </CardBody>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader icon={<Activity />} tint="violet" title="State" />
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
            <CardHeader icon={<Database />} tint="pink" title="What is in it" />
            <CardBody>
              <DetailList items={[
                { label: 'Documents', value: counts.documents },
                { label: 'Imports', value: counts.batches },
                { label: 'Analyst conversations', value: counts.conversations },
              ]} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader icon={<LogIn />} tint="violet" title="Open as staff" />
            <CardBody>
              <p className="text-sm text-ink-muted">
                Opening this customer&rsquo;s pages is recorded in <em>their</em> audit log, and they can see it (CD-13).
              </p>
              <p className="mt-3 text-sm">
                <Link className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft" href={`/app/${org.slug}/departments`}>Open {org.name} <ChevronRight aria-hidden="true" className="size-4" /></Link>
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
