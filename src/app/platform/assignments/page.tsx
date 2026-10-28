import { Briefcase, UserPlus } from 'lucide-react';
import { readActiveAssignments } from '@/modules/platform';
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
  const assignments = (await readActiveAssignments(ctx.db, 100)) as AssignmentRecord[];

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
                      employeeUserId={assignment.employee_user_id}
                      endsAt={assignment.ends_at}
                    />
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader icon={<UserPlus />} tint="pink" title="Assign a Financial Analyst" description="Requires a recent re-authentication." />
          <CardBody><CreateAssignmentForm /></CardBody>
        </Card>
      </div>
    </>
  );
}
