import { Briefcase, UserPlus } from 'lucide-react';
import { listPlatformUsers, readActiveAssignments, readableOrganizations } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, EmptyState } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody } from '@/components/ui/table';
import { CreateAssignmentForm, AssignmentRow } from './assignment-forms';

export const dynamic = 'force-dynamic';

interface AssignmentRecord {
  id: string;
  organization_id: string;
  employee_user_id: string;
  status: string;
  ends_at: string | null;
}

export default async function PlatformAssignmentsPage() {
  const ctx = await getPlatformContext();
  // A failing read throws rather than rendering as an empty list — the one thing a platform page
  // must not show (PRODUCTION_AUDIT.md M2; ADR-070).
  const [assignments, organizations, platformUsers] = await Promise.all([
    readActiveAssignments(ctx.db, 100) as Promise<AssignmentRecord[]>,
    readableOrganizations(ctx.db),
    listPlatformUsers(ctx),
  ]);
  // The form and the table name companies and analysts: no screen shows a user's id, so a form that
  // asked for raw ids could not be filled in from the app (QA, 2 Nov 2026).
  const companies = organizations
    .filter((o) => o.status !== 'deleted')
    .map((o) => ({ id: String(o.id), name: String(o.name), slug: String(o.slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const analysts = platformUsers
    .filter((u) => u.platformRole === 'employee' && u.status === 'active')
    .map((u) => ({ id: u.userId, name: u.fullName ? `${u.fullName} (${u.email ?? u.userId})` : (u.email ?? u.userId) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const analystName = new Map(platformUsers.map((u) => [u.userId, u.fullName ?? u.email ?? u.userId]));

  return (
    <>
      <PageHeader
        title="Financial Analyst assignments"
        description="A Financial Analyst sees only the organisations assigned here. The organisation's owner can remove access at any time."
      />
      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader icon={<Briefcase />} tint="violet" title="Active assignments" />
          <CardBody>
            {assignments.length === 0 ? (
              <EmptyState title="No active assignments">Assign a Financial Analyst to a client organisation below.</EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Organisation', 'Financial Analyst', 'Access ends', '']} />
                <TBody>
                  {assignments.map((assignment) => (
                    <AssignmentRow
                      key={assignment.id}
                      assignmentId={assignment.id}
                      organizationId={assignment.organization_id}
                      organizationName={companyName.get(assignment.organization_id) ?? null}
                      employeeUserId={assignment.employee_user_id}
                      employeeName={analystName.get(assignment.employee_user_id) ?? null}
                      endsAt={assignment.ends_at}
                    />
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader icon={<UserPlus />} tint="pink" title="Assign a Financial Analyst" />
          <CardBody><CreateAssignmentForm companies={companies} analysts={analysts} /></CardBody>
        </Card>
      </div>
    </>
  );
}
