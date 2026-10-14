import type { SerialisedError } from '@/core/errors';
import {
  PERMISSION_WORDS,
  SWITCHABLE_PERMISSIONS,
  type AccessRequest,
  type AccessRequestStatus,
  type SwitchablePermission,
} from '@/modules/tenancy';
import { ACCESS_REQUEST_STATUS_LABELS, formatDate } from '@/components/labels';

/**
 * "Your access" — the requester's side of "Request more information" (ADR-172).
 *
 * Pure: the page builds these from the access context and `listAccessRequests` and hands plain data
 * to the form, which never imports a module. Nothing here decides what anyone may do — `requestAccess`
 * drops what the person already holds and the database refuses a second waiting request or a sixth in
 * a day — this only turns those answers into the words a lender or an accountant reads.
 */

/** The longest message a request may carry; the service and `api.request_access` refuse more. */
export const MESSAGE_MAX = 1000;

export interface PermissionLine {
  readonly permission: SwitchablePermission;
  readonly title: string;
  readonly detail: string;
}

function line(permission: SwitchablePermission): PermissionLine {
  return { permission, title: PERMISSION_WORDS[permission].title, detail: PERMISSION_WORDS[permission].detail };
}

/** What the person can see now: the switchable permissions they hold, in the contract's order. */
export function heldPermissions(holds: (permission: SwitchablePermission) => boolean): PermissionLine[] {
  return SWITCHABLE_PERMISSIONS.filter((p) => holds(p)).map(line);
}

/** What they may ask for: every switchable permission they do not hold. */
export function askablePermissions(holds: (permission: SwitchablePermission) => boolean): PermissionLine[] {
  return SWITCHABLE_PERMISSIONS.filter((p) => !holds(p)).map(line);
}

export interface MyRequestView {
  readonly id: string;
  readonly status: AccessRequestStatus;
  readonly statusLabel: string;
  readonly tone: 'neutral' | 'good' | 'warn';
  readonly askedOn: string;
  /** The titles of what was asked for, in the contract's order. */
  readonly asked: readonly string[];
  readonly message: string | null;
  /** On approval, what was switched on (may be fewer than asked; none for a message-only request). */
  readonly granted: readonly string[];
  /** Asked for but not switched on, on an approval. */
  readonly notGranted: readonly string[];
  readonly note: string | null;
  readonly answeredOn: string | null;
  /** One sentence on where the request stands, in the requester's words. */
  readonly outcome: string;
  readonly canWithdraw: boolean;
}

function outcomeOf(request: AccessRequest, granted: readonly string[]): string {
  switch (request.status) {
    case 'pending':
      return 'Waiting for the company’s owner or an admin to answer.';
    case 'approved':
      return granted.length === 0
        ? 'Approved. Nothing new was switched on — read the note for what happens next.'
        : `Approved: ${granted.join(', ')} ${granted.length === 1 ? 'is' : 'are'} now switched on for you.`;
    case 'declined':
      return 'Declined.';
    case 'withdrawn':
      return 'You withdrew this request.';
  }
}

export function myRequestView(request: AccessRequest): MyRequestView {
  const granted = request.status === 'approved' ? request.granted.map((p) => PERMISSION_WORDS[p].title) : [];
  const notGranted = request.status === 'approved'
    ? request.permissions.filter((p) => !request.granted.includes(p)).map((p) => PERMISSION_WORDS[p].title)
    : [];
  return {
    id: request.id,
    status: request.status,
    statusLabel: ACCESS_REQUEST_STATUS_LABELS[request.status] ?? request.status,
    tone: request.status === 'approved' ? 'good' : request.status === 'declined' ? 'warn' : 'neutral',
    askedOn: formatDate(request.createdAt),
    asked: request.permissions.map((p) => PERMISSION_WORDS[p].title),
    message: request.message,
    granted,
    notGranted,
    note: request.note,
    // Withdrawing is the requester's own act, not an answer.
    answeredOn: request.status === 'approved' || request.status === 'declined'
      ? (request.decidedAt === null ? null : formatDate(request.decidedAt))
      : null,
    outcome: outcomeOf(request, granted),
    canWithdraw: request.status === 'pending',
  };
}

/** The waiting request, if any — the database allows one per person per company. */
export function pendingRequest(requests: readonly AccessRequest[]): AccessRequest | null {
  return requests.find((r) => r.status === 'pending') ?? null;
}

/**
 * The database's refusals of a request, in plain words. `api.request_access` throttles the
 * `access_request` bucket at five a day (its message, "too many access_request requests", names an
 * internal key) and refuses a second waiting request with a unique violation. Every other refusal
 * already reads plainly and is passed through unchanged.
 */
export function plainRequestRefusal(error: SerialisedError): SerialisedError {
  if (error.code === 'QUOTA') {
    return {
      ...error,
      message: /access_request/.test(error.message)
        ? 'You can ask for more access five times a day. Please try again tomorrow.'
        : 'That was a lot of requests in a short time. Please wait a minute and try again.',
    };
  }
  if (error.code === 'CONFLICT' && /waiting/i.test(error.message)) {
    return {
      ...error,
      message: 'You already have a request waiting. Withdraw it, or wait for the owner or an admin to answer it.',
    };
  }
  if (error.code === 'CONFLICT' && /answered/i.test(error.message)) {
    return { ...error, message: 'That request has already been answered, so it cannot be withdrawn.' };
  }
  return error;
}
