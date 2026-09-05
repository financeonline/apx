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
  const { data } = await ctx.db
    .from('organization_assignments')
    .select('id, organization_id, employee_user_id, status, ends_at')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(100);

  const assignments = (data ?? []) as AssignmentRecord[];

  return (
    <>
      <PageHeader
        title="Adviser assignments"
        description="An adviser sees only the organisations assigned here. The organisation's owner can remove access at any time."
      />
      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader title="Active assignments" />
          <CardBody>
            {assignments.length === 0 ? (
              <EmptyState title="No active assignments">Assign an adviser to a client organisation below.</EmptyState>
            ) : (
              <TableWrap>
                <THead columns={['Organisation', 'Adviser', 'Access ends', '']} />
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
          <CardHeader title="Assign an adviser" description="Requires a recent re-authentication." />
          <CardBody><CreateAssignmentForm /></CardBody>
        </Card>
      </div>
    </>
  );
}
