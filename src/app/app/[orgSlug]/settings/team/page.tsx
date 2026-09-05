import { getAccessContext, listMembers, listInvitations, listAdvisers } from '@/modules/tenancy';
import { assertCan, can, canInviteRole, ceilingAllows } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, Badge, EmptyState } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody } from '@/components/ui/table';
import { MEMBERSHIP_ROLE_LABELS, MEMBER_STATUS_LABELS } from '@/components/labels';
import { InviteForm, MemberRow, InvitationRow, AdviserRow } from './team-forms';

export const dynamic = 'force-dynamic';

export default async function TeamPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  assertCan(ctx, 'users.view');

  const [members, invitations, advisers] = await Promise.all([
    listMembers(ctx),
    can(ctx, 'users.invite') ? listInvitations(ctx) : Promise.resolve([]),
    can(ctx, 'assignments.view') ? listAdvisers(ctx) : Promise.resolve([]),
  ]);

  const mayInvite = can(ctx, 'users.invite');
  const mayManage = can(ctx, 'users.manage');
  const invitableRoles = (['owner', 'admin', 'client'] as const).filter((role) =>
    canInviteRole(ctx.effectiveRole, role),
  );

  return (
    <>
      <PageHeader title="Team" description="Who can see this organisation, and what they can do." />

      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader title="People" />
          <CardBody>
            <TableWrap>
              <THead columns={['Name', 'Email', 'Role', 'Status', '']} />
              <TBody>
                {members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    orgSlug={orgSlug}
                    member={member}
                    canManage={mayManage && ceilingAllows(ctx.effectiveRole, member.role)}
                    isSelf={member.userId === ctx.userId}
                    roleLabel={MEMBERSHIP_ROLE_LABELS[member.role] ?? member.role}
                    statusLabel={MEMBER_STATUS_LABELS[member.status] ?? member.status}
                    assignableRoles={(['owner', 'admin', 'client'] as const).filter((r) =>
                      ceilingAllows(ctx.effectiveRole, r),
                    )}
                  />
                ))}
              </TBody>
            </TableWrap>
          </CardBody>
        </Card>

        {mayInvite && (
          <Card>
            <CardHeader
              title="Invite someone"
              description="They will be asked to sign in with the address you enter here."
            />
            <CardBody>
              <InviteForm orgSlug={orgSlug} roles={invitableRoles} />
            </CardBody>
          </Card>
        )}

        {mayInvite && invitations.length > 0 && (
          <Card>
            <CardHeader title="Waiting to be accepted" />
            <CardBody>
              <TableWrap>
                <THead columns={['Email', 'Role', 'Expires', '']} />
                <TBody>
                  {invitations.map((invitation) => (
                    <InvitationRow key={invitation.invitationId} orgSlug={orgSlug} invitation={invitation} />
                  ))}
                </TBody>
              </TableWrap>
            </CardBody>
          </Card>
        )}

        {can(ctx, 'assignments.view') && (
          <Card>
            <CardHeader
              title="MOTION advisers"
              description="Staff assigned to help with this organisation. You can remove access at any time."
            />
            <CardBody>
              {advisers.length === 0 ? (
                <EmptyState title="No MOTION adviser is assigned">
                    If you ask MOTION for help with your figures, the person assigned will appear here by name.
                  </EmptyState>
              ) : (
                <TableWrap>
                  <THead columns={['Name', 'Assigned', 'Access ends', '']} />
                  <TBody>
                    {advisers.map((adviser) => (
                      <AdviserRow
                        key={adviser.assignmentId}
                        orgSlug={orgSlug}
                        adviser={adviser}
                        canRevoke={can(ctx, 'assignments.manage')}
                      />
                    ))}
                  </TBody>
                </TableWrap>
              )}
            </CardBody>
          </Card>
        )}
      </div>
      <p className="mt-6 text-sm text-ink-muted">
        <Badge tone="neutral">Note</Badge> An administrator can manage administrators and clients.
        Only an owner can change another owner.
      </p>
    </>
  );
}
