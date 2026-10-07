import type { EffectiveRole } from '@/core/permissions';

/**
 * Enum values are never rendered (UX_ARCHITECTURE.md §8.1). Every database value a user can see is
 * mapped here, once, to the plain UK-English phrase for it. Lookups only: code never branches on a
 * role name (ADR-003, R2-A-07) — it asks `can(ctx, permission)`.
 */
export const ROLE_LABELS: Record<EffectiveRole, string> = {
  super_admin: 'MOTION administrator',
  employee: 'MOTION adviser',
  owner: 'Owner',
  admin: 'Admin',
  client: 'Client',
  suspended_member: 'Read only',
  none: 'No access',
};

export const MEMBERSHIP_ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  client: 'Client',
};

export const MEMBERSHIP_ROLE_HINTS: Record<string, string> = {
  owner: 'Everything, including billing, the audit log and deleting the organisation.',
  admin: 'Everything except billing, ownership and deletion. Cannot invite or change owners.',
  client: 'Read the numbers, ask the analyst, update actions assigned to them.',
};

export const ORG_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  suspended: 'Deactivated',
  pending_deletion: 'Deletion requested',
  deleted: 'Deleted',
};

export const PLATFORM_ROLE_LABELS: Record<string, string> = {
  super_admin: 'MOTION administrator',
  employee: 'MOTION adviser',
};

export const MEMBER_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  suspended: 'Deactivated',
};

/**
 * Audit actions are `noun.verb` keys. Anything without an entry is shown with its key made
 * readable rather than hidden, so the log is never silently incomplete.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'org.created': 'Organisation created',
  'org.updated': 'Organisation details changed',
  'org.deletion_requested': 'Deletion requested',
  'org.deletion_cancelled': 'Deletion cancelled',
  'member.joined': 'Member joined',
  'member.invited': 'Invitation sent',
  'member.invitation_accepted': 'Invitation accepted',
  'member.invitation_revoked': 'Invitation withdrawn',
  'member.invitation_failed': 'Invitation attempt failed',
  'member.role_changed': 'Role changed',
  'member.status_changed': 'Member status changed',
  'member.removed': 'Member removed',
  'member.left': 'Member left',
  'ownership.transfer_initiated': 'Ownership transfer started',
  'ownership.transfer_accepted': 'Ownership transferred',
  'ownership.transfer_cancelled': 'Ownership transfer cancelled',
  'assignment.created': 'MOTION adviser given access',
  'assignment.revoked': 'MOTION adviser access removed',
  'platform.role_granted': 'Platform role granted',
  'platform.role_revoked': 'Platform role removed',
  'profile.updated': 'Profile updated',
  'auth.sign_in': 'Signed in',
  'auth.sign_out': 'Signed out',
  'user.disabled': 'Account disabled',
  'user.enabled': 'Account enabled',
};

export function auditActionLabel(action: string): string {
  const known = AUDIT_ACTION_LABELS[action];
  if (known) return known;
  const readable = action.replace(/[._]/g, ' ');
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

export const ACTOR_TYPE_LABELS: Record<string, string> = {
  user: 'Member',
  employee: 'MOTION adviser',
  platform_admin: 'MOTION administrator',
  system: 'MOTION',
  ai: 'AI analyst',
};

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "12 Mar 2026" (UX_ARCHITECTURE.md §8.2). Rendered in UTC so server and client agree. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** "12 Mar 2026, 14:05" for the audit log, where the time matters. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * A short, stable list of the timezones MOTION customers actually use. The database accepts any
 * IANA name; this keeps the form to one select rather than a search box in Phase 1.
 */
export const TIMEZONES = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Warsaw',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
] as const;

export const COUNTRIES = [
  { code: 'GB', name: 'United Kingdom' },
  { code: 'IE', name: 'Ireland' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'US', name: 'United States' },
  { code: 'IN', name: 'India' },
  { code: 'AU', name: 'Australia' },
  { code: 'CA', name: 'Canada' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'SG', name: 'Singapore' },
  { code: 'ZA', name: 'South Africa' },
] as const;

export const CURRENCIES = [
  { code: 'GBP', name: 'Pound sterling (£)' },
  { code: 'EUR', name: 'Euro (€)' },
  { code: 'USD', name: 'US dollar ($)' },
  { code: 'AED', name: 'UAE dirham (AED)' },
  { code: 'INR', name: 'Indian rupee (₹)' },
  { code: 'AUD', name: 'Australian dollar (A$)' },
  { code: 'CAD', name: 'Canadian dollar (C$)' },
  { code: 'NZD', name: 'New Zealand dollar (NZ$)' },
  { code: 'SGD', name: 'Singapore dollar (S$)' },
  { code: 'ZAR', name: 'South African rand (R)' },
] as const;
