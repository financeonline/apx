import {
  PERMISSION_WORDS,
  ROLE_NAMES,
  SWITCHABLE_PERMISSIONS,
  TENANT_ROLES,
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
  readonly canReset: boolean;
}

export function switchView(member: MemberPermissions, permission: SwitchablePermission): SwitchView {
  const byDefault = member.defaults.includes(permission);
  const on = member.effective.includes(permission);
  const overridden = member.overrides.some((o) => o.permission === permission);
  const mayGive = member.grantable.includes(permission);
  const target = !on;

  // The change is read from the result, not the stored switch: a switch that repeats the role's
  // default changes nothing, and the person sees what they actually have.
  const change: SwitchChange = on === byDefault ? null : on ? 'added' : 'taken_away';

  // Switching ON needs the viewer to hold it (never beyond their own rights); switching OFF never
  // does. Landing on the role's default clears the stored switch instead of storing a copy of it.
  const lockedReason = !member.editable ? NOT_EDITABLE_REASON : target && !mayGive ? NOT_HELD_REASON : null;

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
    // Going back to a default that is ON switches it on, so it needs the same right as the switch.
    canReset: member.editable && overridden && (!byDefault || on || mayGive),
  };
}

export interface AccessPanelView {
  readonly userId: string;
  readonly roleName: string;
  readonly changedCount: number;
  /** Switches "Reset all" would put back (those the viewer may put back). */
  readonly resettable: readonly SwitchablePermission[];
  readonly groups: readonly { readonly title: string; readonly switches: readonly SwitchView[] }[];
}

export function accessPanel(member: MemberPermissions): AccessPanelView {
  const groups = PERMISSION_GROUPS.map((group) => ({
    title: group.title,
    switches: group.permissions.map((permission) => switchView(member, permission)),
  }));
  const all = groups.flatMap((group) => group.switches);
  return {
    userId: member.userId,
    roleName: ROLE_NAMES[member.role],
    changedCount: all.filter((s) => s.change !== null).length,
    resettable: all.filter((s) => s.canReset).map((s) => s.permission),
    groups,
  };
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
