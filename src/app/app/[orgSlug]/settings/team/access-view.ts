import {
  PERMISSION_WORDS,
  ROLE_NAMES,
  SWITCHABLE_PERMISSIONS,
  TENANT_ROLES,
  withinOwnRights,
  type AccessRequest,
  type AccessRequestStatus,
  type MemberPermissions,
  type SwitchablePermission,
  type TenantRole,
} from '@/modules/tenancy';
import { ACCESS_REQUEST_STATUS_LABELS, MEMBERSHIP_ROLE_HINTS, formatDate } from '@/components/labels';

/**
 * The team page's view of roles, per-person access and "Request more information" (ADR-172).
 *
 * Pure: the page builds these from the services' answers and hands plain data to the client
 * components, which never import a module. Nothing here decides what anyone may do — the service
 * says whether a person is `editable` and what the viewer may `grantable`-switch on, and the
 * `api.*` function re-checks both. This only turns those answers into words and disabled switches,
 * so the page hides or explains what the service would refuse rather than drawing it and failing.
 */

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

export interface RoleOption {
  readonly role: TenantRole;
  readonly name: string;
  readonly description: string;
}

/** The company roles the viewer may give, in the contract's order, each with its one line. */
export function roleOptions(allowed: (role: TenantRole) => boolean): RoleOption[] {
  return TENANT_ROLES.filter(allowed).map((role) => ({
    role,
    name: ROLE_NAMES[role],
    description: MEMBERSHIP_ROLE_HINTS[role] ?? '',
  }));
}

/** The role the invitation form starts on: the least a new person can be given, never an owner. */
export function defaultInviteRole(options: readonly RoleOption[]): TenantRole | undefined {
  const order: readonly TenantRole[] = ['client', 'third_party', 'accountant', 'admin', 'owner'];
  return order.find((role) => options.some((option) => option.role === role));
}

// ---------------------------------------------------------------------------------------------
// Per-person switches
// ---------------------------------------------------------------------------------------------

/** The switches, grouped as a person thinks about them. Every switchable permission, once. */
export const PERMISSION_GROUPS: readonly { readonly title: string; readonly permissions: readonly SwitchablePermission[] }[] = [
  { title: 'Overview & figures', permissions: ['dashboard.view', 'financials.view', 'banking.view', 'intelligence.recompute'] },
  { title: 'Data', permissions: ['imports.create', 'imports.review', 'financials.edit', 'banking.reconcile'] },
  { title: 'Customers & reports', permissions: ['customers.view', 'customers.edit', 'reports.view', 'reports.generate'] },
  { title: 'AI', permissions: ['ai.use'] },
  {
    title: 'Actions & alerts',
    permissions: ['actions.view', 'actions.create', 'actions.assign', 'actions.update_own', 'alerts.manage'],
  },
  { title: 'Documents, export & audit', permissions: ['documents.view', 'data.export', 'audit.view'] },
];

/** `added` — on although the role leaves it off; `taken_away` — off although the role gives it. */
export type SwitchChange = 'added' | 'taken_away' | null;

/** What pressing a switch asks for: on, off, or back to the role's default when that is where it lands. */
export type NextGrant = 'on' | 'off' | 'default';

export const NOT_EDITABLE_REASON = 'You cannot change this person’s access.';
export const NOT_HELD_REASON = 'You do not have this permission yourself, so you cannot give it.';
/**
 * Why "Back to the role's default" is not offered: the role's default would switch this on again,
 * and the viewer does not hold it — the database refuses that reset (`app.apply_member_permission`),
 * exactly as it refuses switching it on.
 */
export const RESET_NOT_HELD_REASON =
  'Its role default would switch this back on, and you do not have this permission yourself, so only an owner can put it back.';
/**
 * Why an admin may not press a switch an OWNER set (RBAC_MATRIX.md §3.17, rev 1.4): the owner's
 * decision about this person is the owner's. The database refuses an admin's change or reset of it
 * (`app.apply_member_permission`); the service lists it in `MemberPermissions.ownerLocked`, which is
 * always empty for an owner or the super admin — so an owner sees the switch as any other.
 */
export const OWNER_LOCKED_REASON = 'Set by the owner — only an owner can change this.';
/**
 * Beside a switch-off stored by the CEILING (RBAC_MATRIX.md §3.15, rev 1.4): a role change or an
 * invitation switched off a default of the role that whoever made it did not hold. It is an
 * ordinary switch afterwards — an owner, or an admin who holds the permission, can switch it on.
 */
export const CEILING_WITHHOLD_NOTE =
  'Off: whoever set this role or sent the invitation didn’t have it to give.';

export interface SwitchView {
  readonly permission: SwitchablePermission;
  readonly title: string;
  readonly detail: string;
  readonly on: boolean;
  readonly byDefault: boolean;
  readonly change: SwitchChange;
  /** A switch is stored for this person, so "Back to the role's default" means something. */
  readonly overridden: boolean;
  readonly next: NextGrant;
  /** Null when the switch may be pressed; otherwise, in plain words, why it may not. */
  readonly lockedReason: string | null;
  /** "Back to the role's default" is drawn and will work. */
  readonly canReset: boolean;
  /**
   * A switch is stored but going back to the default would be refused (it would give the person
   * something the viewer lacks): the reason, shown where the reset would be. Null otherwise.
   */
  readonly resetLockedReason: string | null;
  /**
   * An owner set this switch and the viewer is not an owner: drawn disabled with
   * `OWNER_LOCKED_REASON`, with no "Back to the role's default" and no reset reason — the lock is the
   * reason. Always false for an owner or the super admin (the service's `ownerLocked` is empty).
   */
  readonly ownerLocked: boolean;
  /** `CEILING_WITHHOLD_NOTE` when this switch-off was stored by the ceiling; null otherwise. */
  readonly withheldNote: string | null;
}

export function switchView(member: MemberPermissions, permission: SwitchablePermission): SwitchView {
  const byDefault = member.defaults.includes(permission);
  const on = member.effective.includes(permission);
  const stored = member.overrides.find((o) => o.permission === permission);
  const overridden = stored !== undefined;
  const mayGive = member.grantable.includes(permission);
  const target = !on;
  // `ownerLocked` is optional in the contract only for older fixtures; the service always sets it.
  // A switch the viewer may not change at all is NOT_EDITABLE first, whatever set it.
  const ownerLocked = member.editable && (member.ownerLocked ?? []).includes(permission);

  // The change is read from the result, not the stored switch: a switch that repeats the role's
  // default changes nothing, and the person sees what they actually have.
  const change: SwitchChange = on === byDefault ? null : on ? 'added' : 'taken_away';

  // Switching ON needs the viewer to hold it (never beyond their own rights); switching OFF never
  // does. Landing on the role's default clears the stored switch instead of storing a copy of it.
  // An owner's switch is locked in BOTH directions for a viewer who is not an owner (rev 1.4 §3.17):
  // `grantable` already leaves it out, which alone would lock only switching it on.
  const lockedReason = !member.editable
    ? NOT_EDITABLE_REASON
    : ownerLocked
      ? OWNER_LOCKED_REASON
      : target && !mayGive ? NOT_HELD_REASON : null;

  /*
   * Going back to the default is judged by the same rule the database applies
   * (`withinOwnRights`, the TypeScript copy of `app.apply_member_permission`'s check): a reset that
   * leaves the person holding something they did not hold before needs the viewer to hold it. The
   * stored switch IS the current answer for an overridden permission, so `current` is `on`. An
   * owner's switch is never reset by anyone else, so it is neither offered nor explained here.
   */
  const reachable = member.editable && overridden && !ownerLocked;
  const resetAllowed = reachable && withinOwnRights({
    viewerHolds: mayGive,
    targetRole: member.role,
    current: on,
    next: null,
    permission,
  });

  return {
    permission,
    title: PERMISSION_WORDS[permission].title,
    detail: PERMISSION_WORDS[permission].detail,
    on,
    byDefault,
    change,
    overridden,
    next: target === byDefault ? 'default' : target ? 'on' : 'off',
    lockedReason,
    canReset: resetAllowed,
    resetLockedReason: reachable && !resetAllowed ? RESET_NOT_HELD_REASON : null,
    ownerLocked,
    // Only while it is still OFF: switched on since, the note would contradict the switch.
    withheldNote: stored?.ceilingWithhold === true && !on ? CEILING_WITHHOLD_NOTE : null,
  };
}

export interface AccessPanelView {
  readonly userId: string;
  readonly roleName: string;
  readonly changedCount: number;
  /** Switches "Reset all" would put back (those the viewer may put back). */
  readonly resettable: readonly SwitchablePermission[];
  /**
   * Stored switches the viewer may NOT put back because the default would give something the viewer
   * lacks, by title — "Reset all" leaves them as they are. Owner-locked ones are in `ownerLocked`.
   */
  readonly unresettable: readonly string[];
  /** Stored switches an owner set, by title, which "Reset all" leaves alone for a viewer who is not an owner. */
  readonly ownerLocked: readonly string[];
  /** Beside "Reset all": what it will leave alone and why; or, with nothing it may reset, why not. Null when it resets everything. */
  readonly resetAllNote: string | null;
  readonly groups: readonly { readonly title: string; readonly switches: readonly SwitchView[] }[];
}

const isAre = (n: number) => (n === 1 ? 'it is' : 'they are');
const itThem = (n: number) => (n === 1 ? 'it' : 'them');
const wasWere = (n: number) => (n === 1 ? 'it was' : 'they were');

/**
 * The note beside "Reset all" — or in its place, when every stored switch is out of the viewer's
 * reach: switches whose default the viewer could not give back (`unresettable`) and switches an owner
 * set (`ownerLocked`, rev 1.4 §3.17), each with its own reason.
 */
export function resetAllNote(
  resettable: number,
  unresettable: readonly string[],
  ownerLocked: readonly string[] = [],
): string | null {
  if (unresettable.length === 0 && ownerLocked.length === 0) return null;
  const notHeld = unresettable.join(', ');
  const locked = ownerLocked.join(', ');
  const lockedWhy = `the owner set ${locked}, and only an owner can change ${itThem(ownerLocked.length)}`;
  if (resettable === 0) {
    if (ownerLocked.length === 0) {
      return `Reset all is not available: putting ${notHeld} back to the role’s default would switch on something you do not have yourself. An owner can.`;
    }
    if (unresettable.length === 0) return `Reset all is not available: ${lockedWhy}.`;
    return `Reset all is not available: ${lockedWhy}; putting ${notHeld} back to the role’s default would switch on something you do not have yourself.`;
  }
  const notHeldPart = `${notHeld} as ${isAre(unresettable.length)}: the role’s default would switch on something you do not have yourself.`;
  const lockedPart = `${locked} as ${isAre(ownerLocked.length)}: the owner set ${itThem(ownerLocked.length)}, and only an owner can change ${itThem(ownerLocked.length)}.`;
  if (ownerLocked.length === 0) return `Reset all leaves ${notHeldPart}`;
  if (unresettable.length === 0) return `Reset all leaves ${lockedPart}`;
  return `Reset all leaves ${lockedPart} It also leaves ${notHeldPart}`;
}

export function accessPanel(member: MemberPermissions): AccessPanelView {
  const groups = PERMISSION_GROUPS.map((group) => ({
    title: group.title,
    switches: group.permissions.map((permission) => switchView(member, permission)),
  }));
  const all = groups.flatMap((group) => group.switches);
  const resettable = all.filter((s) => s.canReset).map((s) => s.permission);
  const unresettable = all.filter((s) => s.resetLockedReason !== null).map((s) => s.title);
  const ownerLocked = all.filter((s) => s.ownerLocked && s.overridden).map((s) => s.title);
  return {
    userId: member.userId,
    roleName: ROLE_NAMES[member.role],
    changedCount: all.filter((s) => s.change !== null).length,
    resettable,
    unresettable,
    ownerLocked,
    resetAllNote: resetAllNote(resettable.length, unresettable, ownerLocked),
    groups,
  };
}

/** What `resetMemberPermissions` reports: what it put back, and what it left and why. */
export interface ResetAllOutcome {
  readonly reset: readonly SwitchablePermission[];
  readonly lockedByOwner: readonly SwitchablePermission[];
  readonly notHeld: readonly SwitchablePermission[];
}

/**
 * The confirmation after "Reset all" (rev 1.4): how many switches went back to the role's defaults,
 * and — by name — those that stayed because an owner set them or because the default would give
 * something the viewer lacks. Read from the service's answer, not from the page the viewer saw, so a
 * switch the owner set a moment ago is named too.
 */
export function resetAllMessage(outcome: ResetAllOutcome): string {
  const titles = (list: readonly SwitchablePermission[]) => list.map((p) => PERMISSION_WORDS[p].title).join(', ');
  const parts: string[] = [];
  const n = outcome.reset.length;
  if (n > 0) parts.push(n === 1 ? '1 permission is back to the role’s default.' : `${n} permissions are back to the role’s defaults.`);
  else if (outcome.lockedByOwner.length > 0 || outcome.notHeld.length > 0) parts.push('Nothing was reset.');
  else return 'Nothing to reset.';
  if (outcome.lockedByOwner.length > 0) {
    const k = outcome.lockedByOwner.length;
    parts.push(`${titles(outcome.lockedByOwner)} stayed as ${wasWere(k)}: the owner set ${itThem(k)}, and only an owner can change ${itThem(k)}.`);
  }
  if (outcome.notHeld.length > 0) {
    const k = outcome.notHeld.length;
    parts.push(`${titles(outcome.notHeld)} stayed as ${wasWere(k)}: the role’s default would switch on something you do not have yourself.`);
  }
  return parts.join(' ');
}

/**
 * Beside one's own role on the team page, where the role selector would be (rev 1.4 §3.18): nobody
 * changes their own role, in either direction. An owner's role is changed by another owner; anyone
 * else's by an owner (an admin may not demote themselves — leaving is "Leave the company", and an
 * owner steps down through the ownership transfer).
 */
export function ownRoleNote(viewerIsOwner: boolean): string {
  return viewerIsOwner
    ? 'You can’t change your own role — ask another owner.'
    : 'You can’t change your own role — ask an owner.';
}

/** Read a form's permission key, refusing anything that is not a switchable permission. */
export function asSwitchable(value: string): SwitchablePermission | null {
  return (SWITCHABLE_PERMISSIONS as readonly string[]).includes(value) ? (value as SwitchablePermission) : null;
}

/** Read a switch form's `granted` field: true to switch on, false off, null back to the default. */
export function grantFrom(value: string): boolean | null | undefined {
  if (value === 'on') return true;
  if (value === 'off') return false;
  if (value === 'default') return null;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// "Request more information"
// ---------------------------------------------------------------------------------------------

export interface AskedPermission {
  readonly permission: SwitchablePermission;
  readonly title: string;
  readonly detail: string;
  /** The viewer holds it, so may switch it on in approving (never beyond their own rights). */
  readonly approvable: boolean;
}

export interface RequestView {
  readonly id: string;
  readonly who: string;
  readonly email: string;
  readonly roleName: string;
  readonly asked: readonly AskedPermission[];
  readonly message: string | null;
  readonly askedOn: string;
  readonly status: AccessRequestStatus;
  readonly statusLabel: string;
  readonly granted: readonly string[];
  readonly note: string | null;
  readonly decidedOn: string | null;
  readonly decidedBy: string | null;
  /** Approve may be pressed: something to switch on that the viewer holds, or a message-only request. */
  readonly canApprove: boolean;
}

export function requestView(
  request: AccessRequest,
  holds: (permission: SwitchablePermission) => boolean,
  nameOf: (userId: string) => string | null,
): RequestView {
  const asked = request.permissions.map((permission) => ({
    permission,
    title: PERMISSION_WORDS[permission].title,
    detail: PERMISSION_WORDS[permission].detail,
    approvable: holds(permission),
  }));
  return {
    id: request.id,
    who: request.requesterName ?? request.requesterEmail,
    email: request.requesterEmail,
    roleName: ROLE_NAMES[request.requesterRole],
    asked,
    message: request.message,
    askedOn: formatDate(request.createdAt),
    status: request.status,
    statusLabel: ACCESS_REQUEST_STATUS_LABELS[request.status] ?? request.status,
    granted: request.granted.map((permission) => PERMISSION_WORDS[permission].title),
    note: request.note,
    decidedOn: request.decidedAt ? formatDate(request.decidedAt) : null,
    decidedBy: request.decidedBy ? nameOf(request.decidedBy) : null,
    canApprove: asked.length === 0 || asked.some((a) => a.approvable),
  };
}

/** Waiting requests first in the order they arrived; decided ones newest first. */
export function splitRequests(requests: readonly AccessRequest[]): {
  pending: AccessRequest[];
  decided: AccessRequest[];
} {
  const byDate = (a: AccessRequest, b: AccessRequest) => a.createdAt.localeCompare(b.createdAt);
  return {
    pending: requests.filter((r) => r.status === 'pending').sort(byDate),
    decided: requests
      .filter((r) => r.status !== 'pending')
      .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)),
  };
}
