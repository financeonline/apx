import 'server-only';
import { revokeUserSessions } from '@/core/db';
import { z } from 'zod';
import { assertCan, canInviteRole, canChangeRole, isSelfElevation, canRevokeAssignment, endsSessionsOnRemoval } from '@/core/permissions';
import { PermissionDenied, ValidationError } from '@/core/errors';
import { callApi } from '../data/rpc';
import type { AccessContext } from '../context';
import type { MembershipRole } from '../domain/types';

const Role = z.enum(['owner', 'admin', 'client']);
const Email = z.string().trim().toLowerCase().email('Enter a valid email address');
const Uuid = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new ValidationError(
      'Some details need fixing.',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export interface Member {
  userId: string;
  fullName: string | null;
  email: string;
  role: MembershipRole;
  status: 'active' | 'suspended';
  joinedAt: string;
}

export interface PendingInvitation {
  invitationId: string;
  email: string;
  role: MembershipRole;
  expiresAt: string;
}

export interface Adviser {
  assignmentId: string;
  employeeId: string;
  fullName: string | null;
  assignedAt: string;
  endsAt: string | null;
}

export async function listMembers(ctx: AccessContext): Promise<Member[]> {
  assertCan(ctx, 'users.view');
  const rows = await callApi<Array<Record<string, string>>>(ctx.db, 'org_members', { p_org: ctx.orgId }, ctx.requestId);
  return (rows ?? []).map((r) => ({
    userId: r.user_id!,
    fullName: r.full_name ?? null,
    email: r.email!,
    role: r.role as MembershipRole,
    status: r.status as Member['status'],
    joinedAt: r.joined_at!,
  }));
}

export async function listInvitations(ctx: AccessContext): Promise<PendingInvitation[]> {
  assertCan(ctx, 'users.view');
  const rows = await callApi<Array<Record<string, string>>>(ctx.db, 'org_invitations', { p_org: ctx.orgId }, ctx.requestId);
  return (rows ?? []).map((r) => ({
    invitationId: r.invitation_id!,
    email: r.email!,
    role: r.role as MembershipRole,
    expiresAt: r.expires_at!,
  }));
}

export async function listAdvisers(ctx: AccessContext): Promise<Adviser[]> {
  assertCan(ctx, 'assignments.view');
  const rows = await callApi<Array<Record<string, string>>>(ctx.db, 'org_advisers', { p_org: ctx.orgId }, ctx.requestId);
  return (rows ?? []).map((r) => ({
    assignmentId: r.assignment_id!,
    employeeId: r.employee_id!,
    fullName: r.full_name ?? null,
    assignedAt: r.assigned_at!,
    endsAt: r.ends_at ?? null,
  }));
}

/**
 * Invite someone. The ceiling is checked here for a fast, friendly error and again inside
 * api.invite_member, which is the authority (ADR-026).
 */
export async function inviteMember(
  ctx: AccessContext,
  input: { email: string; role: MembershipRole },
): Promise<{ invitationId: string; token: string }> {
  assertCan(ctx, 'users.invite');
  const email = parse(Email, input.email);
  const role = parse(Role, input.role);
  if (!canInviteRole(ctx.effectiveRole, role)) {
    throw new PermissionDenied(`invite as ${role}`);
  }
  const rows = await callApi<Array<{ invitation_id: string; token: string }>>(
    ctx.db,
    'invite_member_with_token',
    { p_org: ctx.orgId, p_email: email, p_role: role },
    ctx.requestId,
  );
  const row = rows?.[0];
  if (!row) throw new ValidationError('The invitation could not be created.');
  return { invitationId: row.invitation_id, token: row.token };
}

export async function revokeInvitation(ctx: AccessContext, invitationId: string): Promise<void> {
  assertCan(ctx, 'users.invite');
  await callApi(ctx.db, 'revoke_invitation', { p_invitation: parse(Uuid, invitationId) }, ctx.requestId);
}

/** Called from /invite/[token] by a signed-in user. Authority is api.accept_invitation. */
export async function acceptInvitation(
  db: AccessContext['db'],
  token: string,
  requestId?: string,
): Promise<string> {
  return callApi<string>(db, 'accept_invitation', { p_token: token }, requestId);
}

export async function changeMemberRole(
  ctx: AccessContext,
  input: { userId: string; fromRole: MembershipRole; toRole: MembershipRole },
): Promise<void> {
  assertCan(ctx, 'users.manage');
  const userId = parse(Uuid, input.userId);
  const from = parse(Role, input.fromRole);
  const to = parse(Role, input.toRole);
  if (!canChangeRole(ctx.effectiveRole, from, to)) throw new PermissionDenied('change that role');
  if (isSelfElevation(userId === ctx.userId, from, to)) {
    throw new PermissionDenied('raise your own role');
  }
  await callApi(ctx.db, 'change_member_role', { p_org: ctx.orgId, p_user: userId, p_role: to }, ctx.requestId);
}

export async function setMemberStatus(
  ctx: AccessContext,
  input: { userId: string; status: 'active' | 'suspended' },
): Promise<void> {
  assertCan(ctx, 'users.manage');
  await callApi(
    ctx.db,
    'set_member_status',
    { p_org: ctx.orgId, p_user: parse(Uuid, input.userId), p_status: input.status },
    ctx.requestId,
  );
}

/**
 * Remove a member. The RPC deletes the row (last-owner guard is a trigger). Access ends on the
 * next request regardless; when the remover is an owner, the removed member's sessions are ended
 * as well (SECURITY_MODEL.md §4; ADR-075) — the defence against a long-lived tab. It runs after
 * the removal committed, so a failure here leaves a removed member with a session that resolves
 * to nothing, never a member with none.
 */
export async function removeMember(ctx: AccessContext, userId: string): Promise<void> {
  assertCan(ctx, 'users.manage');
  const removed = parse(Uuid, userId);
  await callApi(ctx.db, 'remove_member', { p_org: ctx.orgId, p_user: removed }, ctx.requestId);
  if (endsSessionsOnRemoval(ctx.effectiveRole)) {
    await revokeUserSessions(removed);
  }
}

export async function leaveOrganization(ctx: AccessContext): Promise<void> {
  await callApi(ctx.db, 'leave_organization', { p_org: ctx.orgId }, ctx.requestId);
}

export async function initiateOwnershipTransfer(
  ctx: AccessContext,
  input: { nomineeUserId: string; demoteInitiator: boolean },
): Promise<string> {
  assertCan(ctx, 'users.manage');
  return callApi<string>(
    ctx.db,
    'initiate_ownership_transfer',
    { p_org: ctx.orgId, p_nominee: parse(Uuid, input.nomineeUserId), p_demote: input.demoteInitiator },
    ctx.requestId,
  );
}

export async function acceptOwnershipTransfer(ctx: AccessContext, transferId: string): Promise<void> {
  await callApi(ctx.db, 'accept_ownership_transfer', { p_transfer: parse(Uuid, transferId) }, ctx.requestId);
}

export async function cancelOwnershipTransfer(ctx: AccessContext, transferId: string): Promise<void> {
  await callApi(ctx.db, 'cancel_ownership_transfer', { p_transfer: parse(Uuid, transferId) }, ctx.requestId);
}

/** An owner of the organization may revoke adviser access; only a super admin may create it. */
export async function revokeAssignment(
  ctx: AccessContext,
  input: { assignmentId: string; reason?: string },
): Promise<void> {
  if (!canRevokeAssignment(ctx.effectiveRole)) throw new PermissionDenied('assignments.manage');
  await callApi(
    ctx.db,
    'revoke_assignment',
    { p_assignment: parse(Uuid, input.assignmentId), p_reason: input.reason ?? null },
    ctx.requestId,
  );
}
