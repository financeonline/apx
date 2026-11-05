import 'server-only';
import { z } from 'zod';
import { createLogin, deleteLogin, prepareProfile } from '@/db/auth';
import { assertCan, can, canInviteRole, ceilingAllows } from '@/core/permissions';
import { ConflictError, NotFound, PermissionDenied, ValidationError } from '@/core/errors';
import { log } from '@/core/logging';
import { callApi } from '../data/rpc';
import type { AccessContext } from '../context';
import { moduleOn } from './modules';
import {
  DEPARTMENT_KEYS,
  SWITCHABLE_PERMISSIONS,
  isDepartmentKey,
  type DepartmentKey,
  type MemberDepartments,
  type SwitchablePermission,
} from '../domain/member-access';
import { createsMembers, isSwitchable, takesSwitches } from '../domain/permissions';
import { USER_ID_PATTERN } from '../domain/types';

/**
 * A company creates its team members' logins, and chooses their departments (ADR-173; owner,
 * 2026-10-14: "the organization can create their employees' ID and password directly").
 *
 * Creating a login is three steps, so the database decides who may be added and an existing account
 * can never be pulled in: `api.begin_member_login` checks the creator's rights and records a claim;
 * the server creates the login through Firebase Auth's Admin SDK (email confirmed — the company vouches for it — with the
 * password the creator chose, which stays the person's password); `api.finish_member_login` makes
 * that login a member, only if it was made after the claim, for the claim's email. Auth refuses an
 * email that already has a login, so nobody's existing password is ever set; that person is invited
 * by email instead. If the last step fails, the login just made is removed again.
 *
 * Only the company's owner creates team members (ADR-174; owner, 2026-10-14: "none of the other
 * members can create any team member, accountant, or third-party users"): an admin manages the people
 * the owner created, but adds nobody.
 *
 * Every check is made here first for a plain message, and again in SQL, which is the authority.
 */

/** The roles a login can be created with: never an owner (ownership is a transfer). */
export const LOGIN_ROLES = ['admin', 'accountant', 'client', 'third_party'] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

const CreateMemberLoginInput = z.object({
  fullName: z.string().trim().min(1, 'Enter their name').max(200, 'Keep the name under 200 characters'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  // Never trimmed: spaces are characters. The same rule as a company owner's password (ADR-160).
  password: z.string().min(8, 'Use at least 8 characters for the password').max(72, 'Keep the password under 72 characters'),
  role: z.enum(LOGIN_ROLES, 'Choose what kind of team member they are'),
  permissions: z.array(z.string()).max(SWITCHABLE_PERMISSIONS.length * 2),
  departments: z.array(z.string()).max(DEPARTMENT_KEYS.length * 2),
});

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

function orgOf(ctx: AccessContext): string {
  if (!ctx.orgId) throw new NotFound();
  return ctx.orgId;
}

/** The departments the caller can see, and so may hand on: the company's, narrowed to their own. */
export function departmentsAvailable(ctx: AccessContext): DepartmentKey[] {
  return DEPARTMENT_KEYS.filter((key) => moduleOn(ctx, key));
}

/**
 * What the database stores for a choice: NULL (all, including systems switched on later) when the
 * caller has every department and ticked every one available; else the ticked list. Anything ticked
 * that the caller cannot see is refused.
 */
export function departmentsToStore(ctx: AccessContext, ticked: readonly string[]): DepartmentKey[] | null {
  const available = departmentsAvailable(ctx);
  const wanted = new Set<DepartmentKey>();
  for (const value of ticked) {
    if (!isDepartmentKey(value) || !available.includes(value)) {
      throw new ValidationError('Some details need fixing.', [
        { path: 'departments', message: 'You can only give the departments you have yourself.' },
      ]);
    }
    wanted.add(value);
  }
  const callerHasAll = (ctx.departments ?? null) === null;
  if (callerHasAll && available.every((key) => wanted.has(key))) return null;
  return DEPARTMENT_KEYS.filter((key) => wanted.has(key));
}

function switchables(values: readonly string[]): SwitchablePermission[] {
  const wanted = new Set<string>();
  for (const value of values) {
    if (!isSwitchable(value)) {
      throw new ValidationError('Some details need fixing.', [{ path: 'permissions', message: 'That permission cannot be given.' }]);
    }
    wanted.add(value);
  }
  return SWITCHABLE_PERMISSIONS.filter((p) => wanted.has(p));
}

/** The owner, the company's Financial Analyst or the super admin create team members (ADR-174, ADR-187); the database refuses anyone else. */
export function mayCreateMembers(ctx: AccessContext): boolean {
  return createsMembers(ctx.effectiveRole) && can(ctx, 'users.invite');
}

export async function createMemberLogin(ctx: AccessContext, input: unknown): Promise<{ userId: string }> {
  if (!mayCreateMembers(ctx)) throw new PermissionDenied('create team members — only the owner or the company\'s Financial Analyst can');
  const org = orgOf(ctx);
  const value = parse(CreateMemberLoginInput, input);
  if (!canInviteRole(ctx.effectiveRole, value.role)) throw new PermissionDenied(`create a ${value.role} login`);
  const permissions = switchables(value.permissions);
  const notHeld = permissions.filter((p) => !can(ctx, p));
  if (notHeld.length > 0) {
    throw new PermissionDenied('give a permission you do not hold yourself');
  }
  const departments = departmentsToStore(ctx, value.departments);

  const claim = await callApi<string>(ctx.db, 'begin_member_login', {
    p_org: org,
    p_email: value.email,
    p_role: value.role,
    p_permissions: permissions,
    p_departments: departments,
  }, ctx.requestId);

  let uid: string;
  try {
    uid = await createLogin({ email: value.email, password: value.password, fullName: value.fullName });
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code === 'auth/email-already-exists') {
      throw new ConflictError('That email already has an APX login. Use a different email for this team member.');
    }
    if (code === 'auth/invalid-password') {
      throw new ValidationError('Some details need fixing.', [{ path: 'password', message: 'Choose a stronger password.' }]);
    }
    const message = (error as { message?: string }).message;
    throw new ValidationError(message ? `The login was not created: ${message}` : 'The login was not created.');
  }

  try {
    // What `app.handle_new_auth_user` did on PostgreSQL: every login has its profile.
    await prepareProfile(uid, value.email, value.fullName);
    await callApi(ctx.db, 'finish_member_login', { p_claim: claim, p_user: uid }, ctx.requestId);
  } catch (failure) {
    try {
      await deleteLogin(uid);
    } catch {
      log.error('tenancy.member_login_cleanup_failed', { requestId: ctx.requestId, userId: uid });
    }
    throw failure;
  }
  return { userId: uid };
}

interface DepartmentRow {
  user_id: string;
  departments: string[] | null;
  set_by_owner: boolean;
}

export async function listMemberDepartments(ctx: AccessContext): Promise<MemberDepartments[]> {
  assertCan(ctx, 'users.view');
  const rows = await callApi<DepartmentRow[] | null>(ctx.db, 'org_member_departments', { p_org: orgOf(ctx) }, ctx.requestId);
  return (rows ?? []).map((row) => ({
    userId: row.user_id,
    departments: Array.isArray(row.departments) ? DEPARTMENT_KEYS.filter((key) => row.departments!.includes(key)) : null,
    setByOwner: row.set_by_owner === true,
  }));
}

export async function setMemberDepartments(
  ctx: AccessContext,
  input: { userId: string; role: string; departments: readonly string[] },
): Promise<void> {
  assertCan(ctx, 'users.manage');
  const org = orgOf(ctx);
  const userId = z.string().regex(USER_ID_PATTERN).safeParse(input.userId);
  if (!userId.success) throw new ValidationError('Some details need fixing.', [{ path: 'userId', message: 'Not a valid id.' }]);
  if (userId.data === ctx.userId) throw new PermissionDenied('change your own departments');
  // An owner sees every department: only a role that takes switches has departments.
  if (!ceilingAllows(ctx.effectiveRole, input.role) || !takesSwitches(input.role)) throw new PermissionDenied('change those departments');
  const departments = departmentsToStore(ctx, input.departments);
  await callApi(ctx.db, 'set_member_departments', { p_org: org, p_user: userId.data, p_departments: departments }, ctx.requestId);
}
