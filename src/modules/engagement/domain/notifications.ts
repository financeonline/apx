import type { Permission } from '@/core/permissions';

/**
 * Which notifications a person may read, by kind (ADR-144; ADR-172 follow-up).
 *
 * Notifications are personal — RLS (`notifications_select`) gives each person their own rows and no
 * one else's — and `app.notify` already skips anybody who cannot open what a notification points at.
 * That check happens ONCE, when the row is written. Access changes afterwards: a 3rd party switched
 * off from the Action Centre, a client whose figures switch was turned off, a member whose role
 * changed. Their old rows still carry action titles, comment text and file periods — detail they may
 * no longer read anywhere else.
 *
 * So the inbox asks again at READ time, with the same permission the writer asked for. A kind not in
 * this list is not shown (an allow-list: a kind added to the database without a line here stays
 * hidden rather than leaking), and the unread count uses the same list, so the number in the sidebar
 * always matches the rows on the page.
 *
 * `access_decision` needs only `dashboard.view`: it is the answer to the person's own request, and
 * its note is addressed to them.
 */
export const NOTIFICATION_KIND_PERMISSION: Readonly<Record<string, Permission>> = {
  // Written by `app.notify_data_added` with `financials.view`; the link is an import or Home.
  data_added: 'financials.view',
  // Weekly, adviser, marketing and investment reports: `reports.view` (the weekly and adviser kinds
  // also check `financials.view` at write time, ADR-172).
  report_ready: 'reports.view',
  // Requests, deliverables and comments: the Action Centre's `actions.view`.
  engagement_created: 'actions.view',
  engagement_status: 'actions.view',
  engagement_comment: 'actions.view',
  action_comment: 'actions.view',
  // "Request more information": the owner's and admins' inbox, and the requester's answer.
  access_request: 'users.manage',
  access_decision: 'dashboard.view',
};

/** The kinds this person may read now, for `.in('kind', …)` on the list and the unread count. */
export function readableNotificationKinds(holds: (permission: Permission) => boolean): string[] {
  return Object.entries(NOTIFICATION_KIND_PERMISSION)
    .filter(([, permission]) => holds(permission))
    .map(([kind]) => kind);
}

/**
 * Where a notification opens. Each row carries the link its writer chose, with one exception: the
 * answer to "Request more information" (`access_decision`) is written by `api.decide_access_request`
 * pointing at Home, from before the requester had a page of their own. It opens "Your access"
 * (`/app/<slug>/access`), where the decision, the note and what was switched on are shown in full —
 * decided here, at read time, so rows already written open the right page too.
 */
export function notificationHref(kind: string, href: string | null, orgSlug: string | null): string | null {
  if (kind === 'access_decision' && orgSlug) return `/app/${orgSlug}/access`;
  return href;
}
