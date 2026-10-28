import 'server-only';
import { raise } from '../raise';
import { arg, type DbFunction, type DbFunctions } from '../registry';
import { nowIso } from '../schema';
import { runTx } from '../tx';
import { uidOf } from '../types';
import { orgRoleOf, requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import { throttle } from '../app/throttle';
import { ALERT_STATUSES, enumValue, locateOrgRow } from '../app/actions-helpers';

/**
 * The alert lifecycle's one user write (ALERTS_MODEL.md §6; ADR-047), ported from PostgreSQL
 * (FIRESTORE_DATA_MODEL.md §8). The engine's writes are `api_server.persist_alerts`
 * (`src/db/api_server/reporting.ts`). `set_updated_at` is done here: the update stamps `updated_at`.
 */

/** Who may make the judgement calls (resolve, dismiss, re-open) rather than only acknowledge. */
const STAFF: ReadonlySet<string> = new Set(['owner', 'admin', 'employee', 'super_admin']);

/** `api.set_alert_status(alert, status, reason)`. */
const set_alert_status: DbFunction = async (db, args) => {
  await throttle(db.fs, uidOf(db), 'rpc', 120, 60);
  const alertId = arg.req(args, 'p_alert');
  const status = enumValue(ALERT_STATUSES, args.p_status, 'alert_status_enum');
  const reason = arg.str(args, 'p_reason');
  const found = await locateOrgRow(db.fs, 'alerts', alertId);
  if (!found || !(await orgRoleOf(db.fs, uidOf(db), found.orgId))) raise.notFound();
  const orgId = found.orgId;

  return runTx(db, async (tx) => {
    const snap = await tx.get(found.ref);
    if (!snap.exists) raise.notFound();
    const before = String(snap.get('status'));
    const role = await requirePermission(db, orgId, 'alerts.manage', tx);

    // RBAC_MATRIX §2.1: a client's alerts.manage is partial — they may acknowledge that they have seen
    // something, but resolving or dismissing it is a judgement the organization's staff make.
    // ADR-172: an allow-list, so the accountant and a switched-on 3rd party are partial too.
    if (!STAFF.has(role) && status !== 'acknowledged') {
      raise.denied('acknowledging is the only status change available to you');
    }

    const audit = await prepareAudit(db, {
      organizationId: orgId, action: 'alert.status_changed', targetTable: 'alerts', targetId: alertId,
      before: { status: before }, after: { status, reason }, metadata: {},
    }, tx);
    const now = nowIso();
    tx.update(found.ref, {
      status,
      status_changed_by: uidOf(db),
      status_changed_at: now,
      status_reason_code: 'user',
      status_reason: reason,
      // ADR-047.2: the dismissal instant starts the 90-day cooldown after which the alert may
      // re-open by itself.
      dismissed_at: status === 'dismissed' ? now : (snap.get('dismissed_at') ?? null),
      updated_at: now,
    });
    audit.write(tx);
    return alertId;
  });
};

/** `api.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = { set_alert_status };
