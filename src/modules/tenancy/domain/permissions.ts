import { isPermission, permissionsFor, type EffectiveRole, type Permission } from '@/core/permissions';
import { SWITCHABLE_PERMISSIONS, type SwitchablePermission, type TenantRole } from './member-access';

/**
 * Effective permissions: the role's defaults, then the person's switches (ADR-172).
 *
 * This is the TypeScript twin of `app.effective_permission` (migration 20261018000019), and the
 * rule is short enough to state in full:
 *
 *   - a switch counts only for the four company roles that take switches — admin, accountant,
 *     client, 3rd party. Never for an owner (an owner holds everything), never for APX staff
 *     (super admin, Financial Analyst), never for `suspended_member` (a suspended organisation
 *     freezes everyone to the Home page whatever their switches say), never for `none`;
 *   - only a SWITCHABLE permission can be switched; a switch on anything else is ignored (the
 *     database refuses to store one);
 *   - `true` adds the permission, `false` takes it away, no switch leaves the role's default.
 *
 * The access resolver computes this from the switches `api.my_access` returns AND keeps only what the
 * database's own answer (computed by the SQL twin) agrees with, so a disagreement can only ever take
 * access away. `test/integration/member-access.test.ts` drives both from the same fixtures.
 */

const SWITCHABLE: ReadonlySet<string> = new Set(SWITCHABLE_PERMISSIONS);

/** The company roles a switch applies to. An allow-list (R2-A-07): an unknown role gets none. */
const OVERRIDABLE_ROLES: ReadonlySet<string> = new Set<TenantRole>(['admin', 'accountant', 'client', 'third_party']);

export interface PermissionOverride {
  readonly permission: SwitchablePermission;
  readonly granted: boolean;
}

export function isSwitchable(value: string): value is SwitchablePermission {
  return SWITCHABLE.has(value);
}

/** Whether a person in this role may have per-person switches at all. */
export function takesSwitches(role: EffectiveRole | string): boolean {
  return OVERRIDABLE_ROLES.has(role);
}

/**
 * Whether stored switches change this role's permissions: the four company roles, and a Financial
 * Analyst — whose switches only the super admin sets, per company (ADR-187). Kept apart from
 * `takesSwitches`, which also decides who may "Request more information" and whose switches appear
 * on a company's Team page.
 */
export function appliesSwitches(role: EffectiveRole | string): boolean {
  return OVERRIDABLE_ROLES.has(role) || role === 'employee';
}

/**
 * Whether this person may "Request more information": a company member whose role takes switches.
 * An owner already holds everything; APX staff are given access by the super admin; a suspended
 * organisation is frozen.
 */
export function mayRequestAccess(role: EffectiveRole): boolean {
  return takesSwitches(role);
}

/**
 * Whether a person in this role sets OWNER switches: an owner's (or the super admin's) switch may not
 * be changed or reset by an admin, and is carried through a role change (ADR-172 hardening,
 * 2026-10-14; `app.apply_member_permission` and `app.member_role_changed` are the authority). An
 * allow-list (R2-A-07).
 */
const OWNER_SWITCH_ROLES: ReadonlySet<string> = new Set<EffectiveRole>(['owner', 'employee', 'super_admin']);

export function setsOwnerSwitches(role: EffectiveRole | string): boolean {
  return OWNER_SWITCH_ROLES.has(role);
}

/** A switch with who set it, as the team page reads it (`api.org_member_permissions`). */
export interface PermissionOverrideDetail extends PermissionOverride {
  readonly setByOwner: boolean;
  readonly ceilingWithhold: boolean;
}

/**
 * `parseOverrides`, keeping who set each switch. A missing or malformed flag reads as `true` for
 * `setByOwner` — the LOCKED answer: the database refuses an admin's change to an owner's switch, and
 * guessing "not the owner's" would only draw a button the database then refuses.
 */
export function parseOverrideDetails(raw: unknown): PermissionOverrideDetail[] {
  if (!Array.isArray(raw)) return [];
  const flags = new Map<string, { setByOwner: boolean; ceilingWithhold: boolean }>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { permission, set_by_owner: byOwner, ceiling_withhold: withhold } =
      item as { permission?: unknown; set_by_owner?: unknown; ceiling_withhold?: unknown };
    if (typeof permission !== 'string' || flags.has(permission)) continue;
    flags.set(permission, { setByOwner: byOwner !== false, ceilingWithhold: withhold === true });
  }
  return parseOverrides(raw).map((o) => ({
    ...o,
    setByOwner: flags.get(o.permission)?.setByOwner ?? true,
    ceilingWithhold: flags.get(o.permission)?.ceilingWithhold ?? false,
  }));
}

/**
 * Keep only well-formed switches for switchable permissions. Input arrives from the database as JSON;
 * anything unexpected is dropped rather than trusted — dropping a switch can only fall back to the
 * role's default, which the database computes the same way.
 */
export function parseOverrides(raw: unknown): PermissionOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionOverride[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { permission, granted } = item as { permission?: unknown; granted?: unknown };
    if (typeof permission !== 'string' || typeof granted !== 'boolean') continue;
    if (!isSwitchable(permission) || seen.has(permission)) continue;
    seen.add(permission);
    out.push({ permission, granted });
  }
  return out;
}

/** The role's defaults with the person's switches applied. Deny by default; `none` holds nothing. */
export function resolvePermissions(
  role: EffectiveRole,
  overrides: readonly PermissionOverride[],
): ReadonlySet<Permission> {
  const result = new Set<Permission>(permissionsFor(role));
  if (role === 'none' || !appliesSwitches(role)) return result;
  for (const { permission, granted } of overrides) {
    if (!isSwitchable(permission)) continue;
    if (granted) result.add(permission);
    else result.delete(permission);
  }
  return result;
}

/** What the role gives, among the switchable permissions, in the contract's order. */
export function switchableDefaults(role: EffectiveRole): SwitchablePermission[] {
  const defaults = permissionsFor(role);
  return SWITCHABLE_PERMISSIONS.filter((p) => defaults.has(p));
}

/** The switchable permissions a person effectively holds, in the contract's order. */
export function switchableEffective(
  role: EffectiveRole,
  overrides: readonly PermissionOverride[],
): SwitchablePermission[] {
  const effective = resolvePermissions(role, overrides);
  return SWITCHABLE_PERMISSIONS.filter((p) => effective.has(p));
}

/**
 * Whether a change of one switch would be within the viewer's own rights — the TypeScript copy of
 * the check `app.apply_member_permission` makes, so the page can draw only the switches that will
 * work. Switching ON needs the viewer to hold the permission; so does any change (a reset to a
 * default that grants it) that leaves the person holding something they did not hold before.
 */
export function withinOwnRights(input: {
  readonly viewerHolds: boolean;
  readonly targetRole: EffectiveRole;
  readonly current: boolean | null;
  readonly next: boolean | null;
  readonly permission: SwitchablePermission;
}): boolean {
  if (input.viewerHolds) return true;
  if (input.next === true) return false;
  const byDefault = permissionsFor(input.targetRole).has(input.permission);
  const before = input.current ?? byDefault;
  const after = input.next ?? byDefault;
  return !(after && !before);
}

/**
 * The caller's effective permissions as the access resolver builds them: this module's answer from
 * the switches the database returned, kept only where the DATABASE's own answer
 * (`api.my_access.permissions`, the SQL twin every policy and api.* function uses) agrees.
 *
 * The intersection is deliberate. The two are the same rule over the same rows and should never
 * differ; if they ever do — a matrix edited on one side only, a deploy half done — the page shows
 * less, never more, than the database will allow, and the resolver logs the difference.
 */
export function agreedPermissions(
  role: EffectiveRole,
  rawOverrides: unknown,
  databasePermissions: readonly string[] | null,
): { agreed: ReadonlySet<Permission>; onlyComputed: Permission[]; onlyDatabase: Permission[] } {
  const computed = resolvePermissions(role, parseOverrides(rawOverrides));
  const fromDatabase = new Set((databasePermissions ?? []).filter(isPermission));
  return {
    agreed: new Set<Permission>([...computed].filter((p) => fromDatabase.has(p))),
    onlyComputed: [...computed].filter((p) => !fromDatabase.has(p)),
    onlyDatabase: [...fromDatabase].filter((p) => !computed.has(p)),
  };
}

/**
 * Whether a person in this role creates the company's team members: an owner (ADR-174), the
 * company's Financial Analyst and the super admin (ADR-187, owner 2026-11-05) — never an admin.
 * `app.check_member_login_role` is the authority. An allow-list (R2-A-07).
 */
const MEMBER_CREATOR_ROLES: ReadonlySet<string> = new Set<EffectiveRole>(['owner', 'employee', 'super_admin']);

export function createsMembers(role: EffectiveRole | string): boolean {
  return MEMBER_CREATOR_ROLES.has(role);
}
