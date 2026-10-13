import { Hourglass, Inbox, MailPlus, UsersRound } from 'lucide-react';
import {
  getAccessContext,
  listMembers,
  listInvitations,
  listAdvisers,
  listMemberPermissions,
  listAccessRequests,
} from '@/modules/tenancy';
import { can, canInviteRole, ceilingAllows } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, Badge, Banner, EmptyState } from '@/components/ui/surfaces';
import { MEMBERSHIP_ROLE_LABELS, MEMBER_STATUS_LABELS, ROLE_LABELS, formatDate } from '@/components/labels';
import { InviteForm, MemberItem, InvitationItem, AnalystItem, ListHeader } from './team-forms';
import { PendingRequest } from './request-forms';
import { accessPanel, defaultInviteRole, requestView, roleOptions, splitRequests, type RequestView } from './access-view';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Team (ADR-172): who can see this company and what each person may do.
 *
 * - **People** — the members, then the Financial Analysts APX has assigned. An owner or admin can
 *   change a member's role and, under Access, switch individual permissions on or off — never for
 *   an owner, never for themselves, never beyond their own rights (the service says which). A
 *   Financial Analyst is the super admin's to manage: no role, no switches.
 * - **Invite someone** — the five company roles, as far as the viewer's ceiling reaches.
 * - **Requests for more information** (`#requests`) — what members have asked to see, for an owner or
 *   admin to approve or decline. A member who is not a manager sees their own on their home page.
 */
export default async function TeamPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'users.view');

  const mayInvite = can(ctx, 'users.invite');
  const mayManage = can(ctx, 'users.manage');
  const seesAnalysts = can(ctx, 'assignments.view');

  const [members, invitations, analysts, access, requests] = await Promise.all([
    listMembers(ctx),
    mayInvite ? listInvitations(ctx) : Promise.resolve([]),
    seesAnalysts ? listAdvisers(ctx) : Promise.resolve([]),
    mayManage ? listMemberPermissions(ctx) : Promise.resolve([]),
    mayManage ? listAccessRequests(ctx, { status: 'all' }) : Promise.resolve([]),
  ]);

  // The ceiling rules the page has always applied (RBAC_MATRIX.md §3.2): never above one's own
  // role, and an owner only by an owner. The service and the api.* function re-check them.
  const invitableRoles = roleOptions((role) => canInviteRole(ctx.effectiveRole, role));
  const assignableRoles = roleOptions((role) => ceilingAllows(ctx.effectiveRole, role));

  const accessByUser = new Map(access.map((person) => [person.userId, person]));
  const nameOf = (userId: string) => {
    const member = members.find((m) => m.userId === userId);
    return member ? (member.fullName ?? member.email) : null;
  };
  const { pending, decided } = splitRequests(requests);
  const toView = (request: (typeof requests)[number]): RequestView =>
    requestView(request, (permission) => can(ctx, permission), nameOf);
  const waiting = pending.map(toView);
  // The latest decisions only; the audit log keeps every one.
  const history = decided.slice(0, 50).map(toView);

  return (
    <>
      <PageHeader title="Team" description="Who can see this company, and what each person can do." />

      {waiting.length > 0 ? (
        <Banner
          tone="info"
          title={
            waiting.length === 1
              ? 'A request for more information is waiting'
              : `${waiting.length} requests for more information are waiting`
          }
        >
          <a href="#requests" className="underline underline-offset-2">Review the requests</a>
        </Banner>
      ) : null}

      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader
            icon={<UsersRound />}
            tint="violet"
            title="People"
            description={
              mayManage
                ? 'Change a role here, or open Access to switch a person’s permissions on or off.'
                : undefined
            }
          />
          <CardBody className="px-3 sm:px-6">
            <ListHeader columns={['Name', 'Role', 'Status']} />
            <ul className="flex flex-col gap-3 md:gap-0 md:divide-y md:divide-line">
              {members.map((member) => {
                const isSelf = member.userId === ctx.userId;
                const permissions = accessByUser.get(member.userId);
                return (
                  <MemberItem
                    key={member.userId}
                    orgSlug={orgSlug}
                    userId={member.userId}
                    name={member.fullName}
                    email={member.email}
                    role={member.role}
                    roleLabel={MEMBERSHIP_ROLE_LABELS[member.role] ?? member.role}
                    statusLabel={MEMBER_STATUS_LABELS[member.status] ?? member.status}
                    isSelf={isSelf}
                    canManage={mayManage && ceilingAllows(ctx.effectiveRole, member.role)}
                    assignableRoles={assignableRoles}
                    access={permissions && permissions.editable && !isSelf ? accessPanel(permissions) : null}
                  />
                );
              })}
              {analysts.map((analyst) => (
                <AnalystItem
                  key={analyst.assignmentId}
                  orgSlug={orgSlug}
                  assignmentId={analyst.assignmentId}
                  name={analyst.fullName ?? ROLE_LABELS.employee}
                  roleLabel={ROLE_LABELS.employee}
                  assigned={formatDate(analyst.assignedAt)}
                  ends={analyst.endsAt ? formatDate(analyst.endsAt) : null}
                  canRevoke={can(ctx, 'assignments.manage')}
                />
              ))}
            </ul>
            {seesAnalysts && analysts.length === 0 ? (
              <p className="mt-4 text-sm text-ink-muted">
                No Financial Analyst is assigned. If you ask APX for help with your figures, the person
                assigned will appear here by name.
              </p>
            ) : null}
          </CardBody>
        </Card>

        {mayManage ? (
          <Card id="requests" className="scroll-mt-6">
            <CardHeader
              icon={<Inbox />}
              tint="pink"
              title="Requests for more information"
              description="When someone asks to see more, an owner or admin decides here. Approving switches on what you choose, and only what you have yourself."
            />
            <CardBody className="px-3 sm:px-6">
              {waiting.length === 0 ? (
                <EmptyState title="No requests waiting">
                  When a 3rd party or another member asks for more information, their request appears here
                  for you to approve or decline.
                </EmptyState>
              ) : (
                <ul className="flex flex-col gap-3">
                  {waiting.map((request) => (
                    <PendingRequest key={request.id} orgSlug={orgSlug} request={request} />
                  ))}
                </ul>
              )}

              {history.length > 0 ? (
                <details className="mt-5 rounded-xl border border-line">
                  <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">
                    Decided requests ({history.length})
                  </summary>
                  <ul className="divide-y divide-line border-t border-line">
                    {history.map((request) => (
                      <DecidedRequest key={request.id} request={request} />
                    ))}
                  </ul>
                </details>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {mayInvite ? (
          <Card>
            <CardHeader
              icon={<MailPlus />}
              tint="pink"
              title="Invite someone"
              description="They will be asked to sign in with the address you enter here."
            />
            <CardBody>
              <InviteForm orgSlug={orgSlug} roles={invitableRoles} defaultRole={defaultInviteRole(invitableRoles)} />
            </CardBody>
          </Card>
        ) : null}

        {mayInvite && invitations.length > 0 ? (
          <Card>
            <CardHeader icon={<Hourglass />} tint="violet" title="Waiting to be accepted" />
            <CardBody className="px-3 sm:px-6">
              <ListHeader columns={['Email', 'Role', 'Expires']} />
              <ul className="flex flex-col gap-3 md:gap-0 md:divide-y md:divide-line">
                {invitations.map((invitation) => (
                  <InvitationItem
                    key={invitation.invitationId}
                    orgSlug={orgSlug}
                    invitationId={invitation.invitationId}
                    email={invitation.email}
                    roleLabel={MEMBERSHIP_ROLE_LABELS[invitation.role] ?? invitation.role}
                    expires={formatDate(invitation.expiresAt)}
                  />
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </div>

      <p className="mt-6 text-sm text-ink-muted">
        <Badge tone="neutral">Note</Badge> An admin can manage everyone except owners; only an owner can
        make or change an owner. Nobody can switch on a permission they do not have themselves.
      </p>
    </>
  );
}

/** A decided request, read only: what was asked, what was decided, and the note that went back. */
function DecidedRequest({ request }: { request: RequestView }) {
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0">
          <span className="font-medium">{request.who}</span>
          <span className="text-ink-muted"> · {request.roleName}</span>
        </p>
        <Badge tone={request.status === 'approved' ? 'accent' : 'neutral'}>{request.statusLabel}</Badge>
      </div>
      <p className="mt-1 text-ink-muted">
        Asked {request.askedOn}
        {request.asked.length > 0 ? ` for ${request.asked.map((a) => a.title).join(', ')}` : ''}
        {request.decidedOn ? ` · ${request.status === 'withdrawn' ? 'withdrawn' : 'decided'} ${request.decidedOn}` : ''}
        {request.decidedBy ? ` by ${request.decidedBy}` : ''}
      </p>
      {request.message ? <p className="mt-1 whitespace-pre-line">“{request.message}”</p> : null}
      {request.granted.length > 0 ? (
        <p className="mt-1">Switched on: {request.granted.join(', ')}</p>
      ) : null}
      {request.note ? <p className="mt-1 text-ink-muted">Note: {request.note}</p> : null}
    </li>
  );
}
