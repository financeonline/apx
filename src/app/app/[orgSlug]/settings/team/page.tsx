import { Inbox, UserPlus, UsersRound } from 'lucide-react';
import {
  getAccessContext,
  listMembers,
  listAdvisers,
  listMemberPermissions,
  listAccessRequests,
  setsOwnerSwitches,
  listMemberDepartments,
  departmentsAvailable,
  mayCreateMembers,
  switchableDefaults,
  takesSwitches,
} from '@/modules/tenancy';
import { can, canInviteRole, ceilingAllows } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, Badge, Banner, EmptyState } from '@/components/ui/surfaces';
import { MEMBERSHIP_ROLE_LABELS, MEMBER_STATUS_LABELS, ROLE_LABELS, formatDate } from '@/components/labels';
import { MemberItem, AnalystItem, ListHeader } from './team-forms';
import { PendingRequest } from './request-forms';
import {
  accessPanel, createMemberView, departmentsPanel, departmentsSummary, ownRoleNote, requestView,
  roleOptions, splitRequests, type RequestView,
} from './access-view';
import { CreateMemberForm } from './create-member-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Team (ADR-172): who can see this company and what each person may do.
 *
 * - **People** — the members, then the Financial Analysts APX has assigned. An owner or admin can
 *   change another member's role and, under Access, switch individual permissions on or off — never
 *   for an owner, never for themselves, never beyond their own rights, and (for an admin) never a
 *   switch an owner set (the service says which; RBAC_MATRIX.md §3.15–18, rev 1.4). One's own row
 *   has no role selector. A Financial Analyst is the super admin's to manage: no role, no switches.
 * - **Create a team member** (ADR-173) — the company makes the person's login (email and password)
 *   and ticks the departments they can open and what they can do, as far as the viewer's own reach.
 *   Only the owner sees it (ADR-174): a team member who manages the team manages the people the owner
 *   created, but adds nobody, and is told so.
 *   Inviting by email was removed from the team page (owner, 2026-10-14: "remove this completely"):
 *   a company's team members are created here with a login, never invited. (The super admin still
 *   invites a new company's owner by link, ADR-158/160.)
 * - **Requests for more information** (`#requests`) — what members have asked to see, for an owner or
 *   admin to approve or decline. A member who is not a manager sees their own on their home page.
 */
export default async function TeamPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'users.view');

  const mayCreate = mayCreateMembers(ctx);
  const mayManage = can(ctx, 'users.manage');
  const seesAnalysts = can(ctx, 'assignments.view');

  const [members, analysts, access, requests, departments] = await Promise.all([
    listMembers(ctx),
    seesAnalysts ? listAdvisers(ctx) : Promise.resolve([]),
    mayManage ? listMemberPermissions(ctx) : Promise.resolve([]),
    mayManage ? listAccessRequests(ctx, { status: 'all' }) : Promise.resolve([]),
    listMemberDepartments(ctx),
  ]);
  const departmentsByUser = new Map(departments.map((d) => [d.userId, d]));
  const available = departmentsAvailable(ctx);
  const viewer = { isOwner: setsOwnerSwitches(ctx.effectiveRole), restricted: (ctx.departments ?? null) !== null };
  const createView = createMemberView({
    allowed: (role) => canInviteRole(ctx.effectiveRole, role),
    holds: (permission) => can(ctx, permission),
    available,
    defaults: (role) => switchableDefaults(role),
  });

  // The ceiling rules the page has always applied (RBAC_MATRIX.md §3.2): never above one's own
  // role, and an owner only by an owner. The service and the api.* function re-check them.
  const assignableRoles = roleOptions((role) => ceilingAllows(ctx.effectiveRole, role));

  const accessByUser = new Map(access.map((person) => [person.userId, person]));
  // Nobody changes their own role (RBAC_MATRIX.md §3.18, rev 1.4): one's own row shows the role as
  // text, and says who can change it — another owner for an owner, an owner for anyone else.
  const selfNote = ownRoleNote(setsOwnerSwitches(ctx.effectiveRole));
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
                    departmentsSummary={
                      takesSwitches(member.role) ? departmentsSummary(departmentsByUser.get(member.userId)?.departments ?? null) : null
                    }
                    departments={
                      permissions && permissions.editable && !isSelf
                        ? departmentsPanel(permissions.role, departmentsByUser.get(member.userId), available, viewer)
                        : null
                    }
                    ownRoleNote={isSelf && mayManage ? selfNote : null}
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
              description="When someone asks to see more, the owner or a team member who manages the team decides here. Approving switches on what you choose, and only what you have yourself."
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

        {mayCreate && createView.templates.length > 0 ? (
          <Card id="create" className="scroll-mt-6">
            <CardHeader
              icon={<UserPlus />}
              tint="violet"
              title="Create a team member"
              description="Make their login here — their email and a password — and tick what they can open and do. They can log in straight away."
            />
            <CardBody>
              <CreateMemberForm orgSlug={orgSlug} view={createView} />
            </CardBody>
          </Card>
        ) : mayManage ? (
          <p className="text-sm text-ink-muted">
            Only the company’s owner can create team members, accountants and 3rd parties. Ask the owner to
            add someone new.
          </p>
        ) : null}
      </div>

      {/* The rules in full, folded away: the page above already shows only what this viewer may do. */}
      <details className="mt-6 rounded-xl border border-line text-sm">
        <summary className="min-h-11 cursor-pointer px-4 py-3 font-medium">Who can change what</summary>
        <p className="border-t border-line px-4 py-3 text-ink-muted">
          Only an owner can create team members. A team member who manages the team can manage everyone
          except owners; only an owner can make or change an owner, or change what an owner set. Nobody can
          change their own access, or give a permission or department they do not have themselves.
        </p>
      </details>
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
