import { canSetAlertStatus, type EffectiveRole } from '@/core/permissions';

/**
 * The alert status vocabulary a CLIENT component may import.
 *
 * Deliberately its own file with one dependency. `alert-presentation.ts` reaches into
 * `@/modules/alerts` for the copy templates, and that barrel carries `server-only` services — so a
 * client component importing from it drags the server bundle into the browser and the build fails.
 * The split is the boundary, made explicit rather than discovered again next time.
 */

export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

export const STATUS_LABELS: Readonly<Record<AlertStatus, string>> = {
  open: 'Open',
  acknowledged: 'Seen',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const STATUS_ACTION_LABELS: Readonly<Record<AlertStatus, string>> = {
  open: 'Re-open',
  acknowledged: 'Mark as seen',
  resolved: 'Resolve',
  dismissed: 'Dismiss',
};

/** UX §7.4: how long an undo stays available after a status change. */
export const UNDO_WINDOW_MS = 8_000;

/**
 * Which status changes a role may make (RBAC_MATRIX.md §2.1).
 *
 * Asked through `canSetAlertStatus`, never by comparing a role name here: a role-name branch in the
 * interface is how `suspended_member` quietly falls onto the wrong side of a test (ADR-003,
 * R2-A-07). The buttons a role may not use are ABSENT rather than disabled (§7.4), and
 * `api.set_alert_status` refuses them at the database regardless (ADR-026).
 */
export function allowedStatuses(role: EffectiveRole): readonly AlertStatus[] {
  return (['acknowledged', 'resolved', 'dismissed'] as const)
    .filter((status) => canSetAlertStatus(role, status));
}
