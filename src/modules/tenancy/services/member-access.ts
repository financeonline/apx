import 'server-only';
import { z } from 'zod';
import { assertCan, can, ceilingAllows } from '@/core/permissions';
import { NotFound, PermissionDenied, ValidationError } from '@/core/errors';
import { callApi } from '../data/rpc';
import type { AccessContext } from '../context';
import {
  SWITCHABLE_PERMISSIONS,
  TENANT_ROLES,
  type AccessRequest,
  type AccessRequestStatus,
  type MemberPermissions,
  type SwitchablePermission,
  type TenantRole,
} from '../domain/member-access';
import {
  isSwitchable,
  mayRequestAccess,
  parseOverrideDetails,
  setsOwnerSwitches,
  switchableDefaults,
  switchableEffective,
  takesSwitches,
  withinOwnRights,
} from '../domain/permissions';
import { isUserId } from '../domain/types';

/**
 * Per-person permissions and "Request more information" (ADR-172), against the contract in
 * `domain/member-access.ts`.
 *
 * Every service checks in TypeScript first — for a fast, plain refusal and so the page can hide what
 * would be refused — and the `api.*` function re-checks everything in SQL, which is the authority
 * (ADR-026): `users.manage`, the ceiling, never an owner, never oneself, only switchable permissions,
 * and never beyond the caller's own rights. Nothing here trusts the page that called it.
 */

const Uuid = z.string().uuid();
const MESSAGE_MAX = 1000;
const TENANT_ROLE_SET: ReadonlySet<string> = new Set(TENANT_ROLES);
const STATUSES = ['pending', 'approved', 'declined', 'withdrawn'] as const satisfies readonly AccessRequestStatus[];

function uuid(value: unknown, path: string): string {
  const r = Uuid.safeParse(value);
  if (!r.success) throw new ValidationError('Some details need fixing.', [{ path, message: 'Not a valid id.' }]);
  return r.data;
}

/** A person's Firebase Auth uid (`domain/types.ts`), not a uuid. */
function userIdOf(value: unknown, path: string): string {
  if (!isUserId(value)) throw new ValidationError('Some details need fixing.', [{ path, message: 'Not a valid id.' }]);
  return value;
}

function orgOf(ctx: AccessContext): string {
  if (!ctx.orgId) throw new NotFound();
  return ctx.orgId;
}

/** Switchable permissions only, each once, in the contract's order. Anything else is refused. */
function switchables(values: readonly unknown[], path: string): SwitchablePermission[] {
  const wanted = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !isSwitchable(value)) {
      throw new ValidationError('Some details need fixing.', [{ path, message: 'That permission cannot be switched.' }]);
    }
    wanted.add(value);
  }
  return SWITCHABLE_PERMISSIONS.filter((p) => wanted.has(p));
}

/** Trimmed free text, NULL when empty, refused over 1,000 characters. */
function optionalText(value: string | null | undefined, path: string, label: string): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MESSAGE_MAX) {
    throw new ValidationError('Some details need fixing.', [
      { path, message: `Keep the ${label} to ${MESSAGE_MAX.toLocaleString('en-GB')} characters.` },
    ]);
  }
  return trimmed;
}

function asTenantRole(value: unknown): TenantRole | null {
  return typeof value === 'string' && TENANT_ROLE_SET.has(value) ? (value as TenantRole) : null;
}

interface MemberPermissionRow {
  user_id: string;
  full_name: string | null;
  email: string;
  role: string;
  status: string;
  overrides: unknown;
}

/**
 * Every member of the organisation with their role's defaults, their switches and the result, and
 * what the viewer may do about it — the team page (`users.view`).
 *
 * `editable` is the TypeScript copy of the SQL refusals: the viewer manages the team, the member is
 * active, is not an owner, is not the viewer, and is within the viewer's ceiling. `grantable` is what
 * the viewer holds themselves, less what an owner's switch locks. `ownerLocked` is the switches an
 * owner set, which a viewer who is not an owner (or the super admin) may neither change nor reset
 * (ADR-172 hardening, 2026-10-14). A deactivated member is listed, not editable.
 */
export async function listMemberPermissions(ctx: AccessContext): Promise<MemberPermissions[]> {
  assertCan(ctx, 'users.view');
  const rows = await callApi<MemberPermissionRow[] | null>(
    ctx.db, 'org_member_permissions', { p_org: orgOf(ctx) }, ctx.requestId,
  );
  const mayManage = can(ctx, 'users.manage');
  const viewerHolds = SWITCHABLE_PERMISSIONS.filter((p) => can(ctx, p));
  const viewerIsOwner = setsOwnerSwitches(ctx.effectiveRole);

  return (rows ?? []).flatMap((row): MemberPermissions[] => {
    const role = asTenantRole(row.role);
    if (role === null) return [];
    const details = takesSwitches(role) ? parseOverrideDetails(row.overrides) : [];
    const overrides = details.map(({ permission, granted, setByOwner, ceilingWithhold }) => ({
      permission, granted, setByOwner, ceilingWithhold,
    }));
    const editable = mayManage
      && row.status === 'active'
      && takesSwitches(role)
      && row.user_id !== ctx.userId
      && ceilingAllows(ctx.effectiveRole, role);
    const ownerLocked = editable && !viewerIsOwner
      ? overrides.filter((o) => o.setByOwner).map((o) => o.permission)
      : [];
    return [{
      userId: row.user_id,
      name: row.full_name ?? null,
      email: row.email,
      role,
      defaults: switchableDefaults(role),
      overrides,
      effective: switchableEffective(role, overrides),
      editable,
      grantable: editable ? viewerHolds.filter((p) => !ownerLocked.includes(p)) : [],
      ownerLocked,
    }];
  });
}

/**
 * "Reset all": put back to the role's default every switch of one member that the viewer may reset
 * — never one an owner set (unless the viewer is an owner), and never a reset that would give the
 * person something the viewer does not hold (`withinOwnRights`, the copy of the SQL rule). Read fresh
 * from the database, so a switch another admin set a moment ago is included; each reset goes through
 * `setMemberPermission`, so the database re-checks every one. Returns what was reset and what was
 * left (and why), so the page can say so instead of stopping at the first refusal.
 */
export async function resetMemberPermissions(
  ctx: AccessContext,
  userId: string,
): Promise<{
  readonly reset: readonly SwitchablePermission[];
  readonly lockedByOwner: readonly SwitchablePermission[];
  readonly notHeld: readonly SwitchablePermission[];
}> {
  assertCan(ctx, 'users.manage');
  const member = (await listMemberPermissions(ctx)).find((m) => m.userId === userIdOf(userId, 'userId'));
  if (!member) throw new NotFound();
  if (!member.editable) throw new PermissionDenied('change this person’s access');

  const reset: SwitchablePermission[] = [];
  const lockedByOwner: SwitchablePermission[] = [];
  const notHeld: SwitchablePermission[] = [];
  for (const override of member.overrides) {
    if ((member.ownerLocked ?? []).includes(override.permission)) {
      lockedByOwner.push(override.permission);
      continue;
    }
    const allowed = withinOwnRights({
      viewerHolds: can(ctx, override.permission),
      targetRole: member.role,
      current: override.granted,
      next: null,
      permission: override.permission,
    });
    if (!allowed) {
      notHeld.push(override.permission);
      continue;
    }
    await setMemberPermission(ctx, { userId: member.userId, permission: override.permission, granted: null });
    reset.push(override.permission);
  }
  return { reset, lockedByOwner, notHeld };
}

/**
 * Switch one permission on (`true`) or off (`false`) for one member, or put it back to the role's
 * default (`null`). Audited `member.permission_changed` by the database.
 */
export async function setMemberPermission(
  ctx: AccessContext,
  input: { userId: string; permission: SwitchablePermission; granted: boolean | null },
): Promise<void> {
  assertCan(ctx, 'users.manage');
  const orgId = orgOf(ctx);
  const userId = userIdOf(input.userId, 'userId');
  const [permission] = switchables([input.permission], 'permission');
  if (!permission) throw new ValidationError('Choose a permission to change.');
  if (input.granted !== true && input.granted !== false && input.granted !== null) {
    throw new ValidationError('Choose on, off or the role’s default.');
  }
  if (userId === ctx.userId) throw new PermissionDenied('change your own access');
  // Never beyond the viewer's own rights. The database also refuses a reset that would give the
  // person something the viewer lacks; that case needs the member's current switch to judge.
  if (input.granted === true && !can(ctx, permission)) throw new PermissionDenied(permission);

  await callApi(
    ctx.db,
    'set_member_permission',
    { p_org: orgId, p_user: userId, p_permission: permission, p_granted: input.granted },
    ctx.requestId,
  );
}

/**
 * "Request more information": ask the owner and admins for permissions one lacks, with an optional
 * message (at least one of the two). Any company member except an owner — who holds everything — and
 * except APX staff and a suspended organisation. One waiting request at a time; five a day. Every
 * owner and admin is told in their inbox.
 */
export async function requestAccess(
  ctx: AccessContext,
  input: { permissions: SwitchablePermission[]; message: string | null },
): Promise<{ id: string }> {
  const orgId = orgOf(ctx);
  if (!mayRequestAccess(ctx.effectiveRole)) throw new PermissionDenied('ask for more access');
  const asked = switchables(Array.isArray(input.permissions) ? input.permissions : [], 'permissions');
  const message = optionalText(input.message, 'message', 'message');
  const lacking = asked.filter((p) => !can(ctx, p));
  if (lacking.length === 0 && message === null) {
    throw new ValidationError(
      asked.length > 0
        ? 'You already have the access you asked for.'
        : 'Choose what you need, or say what you need in a message.',
    );
  }

  const id = await callApi<string>(
    ctx.db,
    'request_access',
    { p_org: orgId, p_permissions: lacking, p_message: message },
    ctx.requestId,
  );
  return { id };
}

interface AccessRequestRow {
  id: string;
  requester_id: string;
  requester_name: string | null;
  requester_email: string;
  requester_role: string;
  permissions: string[] | null;
  message: string | null;
  status: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  granted: string[] | null;
  note: string | null;
}

function onlySwitchable(values: readonly string[] | null): SwitchablePermission[] {
  const set = new Set((values ?? []).filter(isSwitchable));
  return SWITCHABLE_PERMISSIONS.filter((p) => set.has(p));
}

/**
 * Requests, newest first. Whoever manages the team (`users.manage`) reads the organisation's; anyone
 * else reads only their own — the database decides which, and RLS on `access_requests` agrees.
 */
export async function listAccessRequests(
  ctx: AccessContext,
  input?: { status?: AccessRequestStatus | 'all' },
): Promise<AccessRequest[]> {
  const orgId = orgOf(ctx);
  const status = input?.status ?? 'all';
  if (status !== 'all' && !(STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError('Unknown request status.');
  }
  const rows = await callApi<AccessRequestRow[] | null>(
    ctx.db, 'access_requests_list', { p_org: orgId, p_status: status }, ctx.requestId,
  );
  return (rows ?? []).flatMap((row): AccessRequest[] => {
    const role = asTenantRole(row.requester_role);
    const rowStatus = (STATUSES as readonly string[]).includes(row.status) ? (row.status as AccessRequestStatus) : null;
    if (role === null || rowStatus === null) return [];
    return [{
      id: row.id,
      requesterId: row.requester_id,
      requesterName: row.requester_name ?? null,
      requesterEmail: row.requester_email,
      requesterRole: role,
      permissions: onlySwitchable(row.permissions),
      message: row.message ?? null,
      status: rowStatus,
      createdAt: row.created_at,
      decidedBy: row.decided_by ?? null,
      decidedAt: row.decided_at ?? null,
      granted: onlySwitchable(row.granted),
      note: row.note ?? null,
    }];
  });
}

/**
 * Approve or decline a waiting request. Approval switches on the chosen permissions — a subset of
 * those asked (all of them when none are named), each one the decider holds; a message-only request
 * is approved with none. The note goes to the requester.
 */
export async function decideAccessRequest(
  ctx: AccessContext,
  input: { id: string; approve: boolean; permissions?: SwitchablePermission[]; note?: string | null },
): Promise<void> {
  assertCan(ctx, 'users.manage');
  orgOf(ctx);
  const id = uuid(input.id, 'id');
  if (typeof input.approve !== 'boolean') throw new ValidationError('Choose approve or decline.');
  const permissions = input.permissions === undefined ? null : switchables(input.permissions, 'permissions');
  const note = optionalText(input.note ?? null, 'note', 'note');
  if (input.approve && permissions) {
    const missing = permissions.find((p) => !can(ctx, p));
    if (missing) throw new PermissionDenied(missing);
  }

  await callApi(
    ctx.db,
    'decide_access_request',
    { p_id: id, p_approve: input.approve, p_permissions: input.approve ? permissions : null, p_note: note },
    ctx.requestId,
  );
}

/** Take back one's own waiting request. Anybody else's request is NOT FOUND. */
export async function withdrawAccessRequest(ctx: AccessContext, id: string): Promise<void> {
  orgOf(ctx);
  await callApi(ctx.db, 'withdraw_access_request', { p_id: uuid(id, 'id') }, ctx.requestId);
}
