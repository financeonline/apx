import type { Permission } from '@/core/permissions';
import type { ModuleKey } from './modules';

/**
 * User roles and per-person permissions (ADR-172), from the client's revised SOW §"User Access":
 * Financial Analyst (summary of performance, % analysis), Accountant (basic summary of integrated or
 * uploaded data, including compliance), Client (limited overview, % analysis, indicators of concern,
 * suggestions), 3rd party (limited overview, "request access for additional information if
 * needed"), and "permissions must be allowable from administrator to user".
 *
 * The owner's choices (2026-10-14):
 * - **Financial Analyst** is the existing platform `employee` — the firm's staff the super admin
 *   assigns to companies — renamed wherever a person reads it. The internal key stays `employee`.
 * - **Accountant** is a NEW company role (`accountant`): the company's own or outside accountant,
 *   invited by the owner or an admin. Data capture and compliance; no AI, no team or settings.
 * - **3rd party** is a NEW company role (`third_party`): a lender, investor or partner. A read-only
 *   overview (headline figures, the Business Health Score, reports); no detail records, documents,
 *   AI or data entry; and "Request more information", which the owner or an admin can approve.
 * - **Per person**: each role has defaults; the owner or an admin switches individual permissions on
 *   or off for each member of their company — never beyond their own rights, never for an owner.
 *
 * This file is the CONTRACT between the agents building it. Implementations live elsewhere.
 */

/** Every company (tenant) role, in the order the team page lists them. */
export const TENANT_ROLES = ['owner', 'admin', 'accountant', 'client', 'third_party'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** What a person reads for each role, platform roles included. */
export const ROLE_NAMES: Readonly<Record<TenantRole | 'super_admin' | 'employee', string>> = {
  super_admin: 'Super admin',
  employee: 'Financial Analyst',
  owner: 'Owner',
  // ADR-173 (owner, 2026-10-14: "why are there an owner and an admin?"): a company is its owner and
  // its team members. The `admin` role is a team member who also manages the team and the company's
  // settings; `client` is a team member who sees and does what was ticked for them.
  admin: 'Team member (manages the team)',
  accountant: 'Accountant',
  client: 'Team member',
  third_party: '3rd party',
};

/**
 * The permissions that may be switched per person. Everything else is fixed by the role: platform
 * keys, deleting the company, billing, analyst assignments, and the team keys (`users.*`) — granting
 * someone the right to manage the team is done by changing their ROLE, not by a switch.
 */
export const SWITCHABLE_PERMISSIONS = [
  'dashboard.view',
  'financials.view',
  'financials.edit',
  'imports.create',
  'imports.review',
  'banking.view',
  'banking.reconcile',
  'customers.view',
  'customers.edit',
  'reports.view',
  'reports.generate',
  'ai.use',
  'actions.view',
  'actions.create',
  'actions.assign',
  'actions.update_own',
  'alerts.manage',
  'intelligence.recompute',
  'documents.view',
  'data.export',
  'audit.view',
] as const satisfies readonly Permission[];
export type SwitchablePermission = (typeof SWITCHABLE_PERMISSIONS)[number];

/** One person's permissions in one company, as the team page shows them. */
export interface MemberPermissions {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string;
  readonly role: TenantRole;
  /** What the role gives, among the switchable permissions. */
  readonly defaults: readonly SwitchablePermission[];
  /**
   * The switches set for this person: `true` added, `false` taken away. Absent = the default.
   * `setByOwner`: an owner (or the super admin) set it — an admin may not change or reset it, and it
   * survives a role change. `ceilingWithhold`: a switch-off a role change or an invitation stored
   * because whoever made it did not hold the permission (ADR-172 hardening, 2026-10-14). Both are
   * optional in the type only so older fixtures still compile; the service always sets them.
   */
  readonly overrides: readonly {
    readonly permission: SwitchablePermission;
    readonly granted: boolean;
    readonly setByOwner?: boolean;
    readonly ceilingWithhold?: boolean;
  }[];
  /** The result, among the switchable permissions. */
  readonly effective: readonly SwitchablePermission[];
  /** Whether the viewer may change this person's switches at all (never an owner; never oneself). */
  readonly editable: boolean;
  /**
   * The permissions the viewer may switch ON for this person: those the viewer holds, less any an
   * owner's switch locks (`ownerLocked`).
   */
  readonly grantable: readonly SwitchablePermission[];
  /**
   * The switches the viewer may NOT change or reset because an owner set them — always empty for an
   * owner or the super admin. The database refuses an admin's change to these
   * (`app.apply_member_permission`), so the page should draw them locked ("Set by the owner") and
   * "Reset all" should leave them alone (`resetMemberPermissions` does). Optional in the type only so
   * older fixtures still compile; the service always sets it.
   */
  readonly ownerLocked?: readonly SwitchablePermission[];
}

export type AccessRequestStatus = 'pending' | 'approved' | 'declined' | 'withdrawn';

/** "Request more information": a member asks for permissions they don't have. */
export interface AccessRequest {
  readonly id: string;
  readonly requesterId: string;
  readonly requesterName: string | null;
  readonly requesterEmail: string;
  readonly requesterRole: TenantRole;
  /** What they asked for (at least one, or a message, or both). */
  readonly permissions: readonly SwitchablePermission[];
  readonly message: string | null;
  readonly status: AccessRequestStatus;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  /** On approval: the permissions actually switched on (may be fewer than asked). */
  readonly granted: readonly SwitchablePermission[];
  /** The decider's note, shown to the requester. */
  readonly note: string | null;
}

/** Plain words for each switchable permission, for the switches and the request form. */
export const PERMISSION_WORDS: Readonly<Record<SwitchablePermission, { readonly title: string; readonly detail: string }>> = {
  'dashboard.view': { title: 'Overview', detail: 'Home, headline figures and the Business Health Score' },
  'financials.view': { title: 'Financial detail', detail: 'Profit and loss, cash, invoices and the records behind them' },
  'financials.edit': { title: 'Correct records', detail: 'Recategorise, correct and map accounts' },
  'imports.create': { title: 'Upload data', detail: 'Upload statements, ledgers and invoice lists' },
  'imports.review': { title: 'Review imports', detail: 'Check, import and remove uploads' },
  'banking.view': { title: 'Banking', detail: 'Bank accounts and transactions' },
  'banking.reconcile': { title: 'Categorise bank lines', detail: 'Categorise and pair bank transactions' },
  'customers.view': { title: 'Customers', detail: 'Customers, products, sales and marketing' },
  'customers.edit': { title: 'Edit customers and profile', detail: 'Customers, products, campaigns and the company profile' },
  'reports.view': { title: 'Reports', detail: 'Read reports, Marketing and Investment' },
  'reports.generate': { title: 'Create reports', detail: 'Create and refresh reports' },
  'ai.use': { title: 'AI Analyst', detail: 'Ask the AI Analyst; ChatGPT reports' },
  'actions.view': { title: 'Actions', detail: 'See the Action Centre' },
  'actions.create': { title: 'Create actions', detail: 'Create actions' },
  'actions.assign': { title: 'Assign actions', detail: 'Give actions to people' },
  'actions.update_own': { title: 'Update own actions', detail: 'Update actions given to them' },
  'alerts.manage': { title: 'Handle alerts', detail: 'Acknowledge, resolve and dismiss alerts' },
  'intelligence.recompute': { title: 'Recalculate', detail: 'Start a recalculation of the figures' },
  'documents.view': { title: 'Documents', detail: 'Open and download source documents' },
  'data.export': { title: 'Export data', detail: 'Download CSV and spreadsheet exports' },
  'audit.view': { title: 'Audit log', detail: 'See who did what in the company' },
};

/**
 * Departments (ADR-173): the parts of APX a team member may open, ticked per person. Each is one of
 * ADR-158's systems; a department that is not ticked is absent for that person exactly as a system
 * switched off is absent for the company. NULL (in the database) means all of the company's.
 * Home, Money (profit and loss, cash), Insights, Data, Activity and Settings are not departments:
 * what a person sees of those is their permissions' business.
 */
export const DEPARTMENT_KEYS = [
  'banking', 'planning', 'tax', 'analyst', 'actions', 'customers', 'marketing', 'investment', 'reports', 'funding',
] as const satisfies readonly ModuleKey[];
export type DepartmentKey = (typeof DEPARTMENT_KEYS)[number];

export const DEPARTMENT_WORDS: Readonly<Record<DepartmentKey, { readonly title: string; readonly detail: string }>> = {
  banking: { title: 'Banking', detail: 'Bank accounts, statements and transactions' },
  planning: { title: 'Planning', detail: 'Forecast, What if and Budget' },
  tax: { title: 'Tax & Balance sheet', detail: 'VAT, Corporation Tax, assets and loans' },
  analyst: { title: 'AI Financial Analyst', detail: 'Questions answered by the AI Analyst' },
  actions: { title: 'Action Centre', detail: 'Actions, requests and deliverables' },
  customers: { title: 'Customers', detail: 'Customers, products and sales' },
  marketing: { title: 'Marketing', detail: 'The marketing strategy report' },
  investment: { title: 'Investment', detail: 'The Investment Pack' },
  reports: { title: 'Reports', detail: 'Daily, weekly, monthly and custom reports' },
  funding: { title: 'Funding Readiness', detail: 'The funding readiness assessment' },
};

export function isDepartmentKey(value: unknown): value is DepartmentKey {
  return typeof value === 'string' && (DEPARTMENT_KEYS as readonly string[]).includes(value);
}

/** One member's departments, for the team page: NULL = all of the company's. */
export interface MemberDepartments {
  readonly userId: string;
  readonly departments: readonly DepartmentKey[] | null;
  /** An owner chose them: an admin may not change them. */
  readonly setByOwner: boolean;
}
