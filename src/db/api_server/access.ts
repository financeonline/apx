import 'server-only';
import type { Permission } from '@/core/permissions';
import { auth } from '../firestore';
import { arg, type DbFunction, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { globalRow, orgRow } from '../schema';
import { runTx } from '../tx';
import type { Db } from '../types';
import { hasPermissionOf, orgRoleOf } from '../app/access';
import { prepareAudit } from '../app/audit';
import { requireServer } from '../app/scope';
import { intervalSeconds, throttle as appThrottle } from '../app/throttle';

/**
 * `api_server.*` functions of the access area: read-side audit events, the shared rate-limit
 * counter, its retention, and ending a person's sessions (ADR-043, ADR-074, ADR-075). Each runs only
 * for the server (`requireServer`, the old `role_claim() <> 'service_role'` refusal).
 */

const ACCESS_EVENTS = [
  'document.downloaded', 'report.downloaded', 'export.created', 'evidence.viewed', 'org.data_viewed',
  'document.quarantined', 'document.sent_to_ai', 'auth.sign_in', 'auth.sign_out', 'auth.failed',
  'member.invitation_failed',
] as const;

/** metadata keys are ids only: never emails, filenames or free text (ADR-038.9). */
const METADATA_KEYS = [
  'document_id', 'report_id', 'batch_id', 'bundle_id', 'period_id', 'surface', 'route', 'pages', 'export_kind',
  'invitation_id', 'job_id',
];

async function requirePermissionOf(db: Db, actor: string, orgId: string | null, perm: string): Promise<void> {
  if (!orgId || !(await hasPermissionOf(db.fs, actor, orgId, perm as Permission))) raise.denied(`${perm} required`);
}

/**
 * The file must be one the ACTOR may read: `report_files_select` and `reports_select`'s rule per kind,
 * word for word (ADR-172 hardening, 2026-10-14). A report they cannot read does not exist for them.
 */
async function reportFileReadable(db: Db, actor: string, orgId: string, fileId: string): Promise<boolean> {
  const file = await orgRow(db.fs, orgId, 'report_files', fileId).get();
  if (!file.exists || (file.get('deleted_at') ?? null) !== null) return false;
  const financials = () => hasPermissionOf(db.fs, actor, orgId, 'financials.view');
  const reportId = (file.get('report_id') as string | null) ?? null;
  if (reportId === null) return financials();
  const report = await orgRow(db.fs, orgId, 'reports', reportId).get();
  if (!report.exists) return false;
  const kind = String(report.get('report_kind'));
  if (kind === 'custom_ai' && report.get('requested_by') !== actor) return false;
  if (kind === 'funding_readiness') {
    const org = await globalRow(db.fs, 'organizations', orgId).get();
    const features = (org.get('features') as Record<string, unknown> | undefined) ?? {};
    if (String(features.funding_readiness ?? '') !== 'true') return false;
  }
  return kind === 'monthly_management' || kind === 'funding_readiness' || financials();
}

/**
 * `api_server.record_access_event`: a read-side audit event, authorised per action for the ACTOR
 * (not the session), DATABASE_ARCHITECTURE.md §14.2. Returns the audit event's id, which the Storage
 * signer later verifies.
 */
const record_access_event: DbFunction = async (db, args) => {
  requireServer(db);
  const actor = arg.str(args, 'p_actor');
  if (!actor) raise.invalid('an actor is required');
  const orgId = arg.str(args, 'p_org');
  const action = arg.str(args, 'p_action');
  const targetTable = arg.str(args, 'p_target_table');
  const targetId = arg.str(args, 'p_target_id');
  const metadata = arg.obj(args, 'p_metadata');
  if (!action || !(ACCESS_EVENTS as readonly string[]).includes(action)) raise.invalid(`${action} is not an access event`);

  switch (action) {
    case 'document.downloaded':
      await requirePermissionOf(db, actor, orgId, 'documents.view');
      // NOT_FOUND, never PERMISSION_DENIED: a 403 would confirm the document exists for somebody.
      if (targetId && !(await orgRow(db.fs, orgId!, 'source_documents', targetId).get()).exists) raise.notFound();
      break;
    case 'report.downloaded':
      await requirePermissionOf(db, actor, orgId, 'reports.view');
      if (targetId === null) {
        // A report rendered on request with no month to name (Marketing, Investment).
      } else if (targetTable === 'fiscal_periods') {
        // The Monthly Management Report's summary edition names a COMPLETE month (ADR-030.4).
        const period = await orgRow(db.fs, orgId!, 'fiscal_periods', targetId).get();
        if (!period.exists || period.get('is_complete') !== true) raise.notFound();
      } else if (targetTable === 'report_files') {
        if (!(await reportFileReadable(db, actor, orgId!, targetId))) raise.notFound();
      } else {
        // Deny by default: a download names a stored file or a month, nothing else.
        raise.invalid('report.downloaded names a report file or a month');
      }
      break;
    case 'export.created':
      await requirePermissionOf(db, actor, orgId, 'data.export');
      break;
    case 'evidence.viewed':
      await requirePermissionOf(db, actor, orgId, 'financials.view');
      break;
    case 'org.data_viewed':
      // CD-13: only a super admin generates this event, and the organisation's owner sees it.
      if ((await orgRoleOf(db.fs, actor, orgId)) !== 'super_admin') raise.denied('org.data_viewed is a super-admin event');
      break;
    default:
      // document.quarantined, document.sent_to_ai, auth.*, member.invitation_failed are system
      // events written by server code with no per-actor permission of their own.
      break;
  }

  if (Object.keys(metadata).some((k) => !METADATA_KEYS.includes(k))) raise.invalid('metadata key not in the allow-list');

  const requestId = arg.str(args, 'p_request_id');
  const call: Db = { ...db, meta: { ...db.meta, requestId: requestId ?? db.meta.requestId ?? null } };
  return runTx(call, async (tx) => {
    const prepared = await prepareAudit(call, {
      organizationId: orgId, action, targetTable, targetId, metadata, actorId: actor,
    }, tx);
    prepared.write(tx);
    return prepared.id;
  });
};

/** `api_server.throttle`: the shared counter, for routes (ROUTE_ARCHITECTURE.md §5). */
const throttle: DbFunction = async (db, args) => {
  requireServer(db);
  const window = args.p_window as string | number | undefined;
  await appThrottle(
    db.fs, arg.str(args, 'p_actor'), arg.req(args, 'p_bucket'), arg.num(args, 'p_limit') ?? 0,
    intervalSeconds(window ?? '1 minute'),
  );
  return null;
};

/** `api_server.prune_rate_limits(keep = 2 days)`: drops counter windows older than `keep`. */
const prune_rate_limits: DbFunction = async (db, args) => {
  requireServer(db);
  const keep = intervalSeconds((args.p_keep as string | number | undefined) ?? '2 days');
  // The longest live window is a day; pruning inside it would reset somebody's counter.
  if (keep < 86_400) raise.invalid('rate-limit rows must be kept for at least one day');
  const cutoff = new Date(Date.now() - keep * 1000).toISOString();
  let removed = 0;
  for (;;) {
    const old = await db.fs.collection('api_rate_limits').where('window_start', '<', cutoff).limit(500).get();
    if (old.empty) break;
    const writer = db.fs.bulkWriter();
    for (const d of old.docs) void writer.delete(d.ref);
    await writer.close();
    removed += old.size;
    if (old.size < 500) break;
  }
  return removed;
};

/**
 * `api_server.revoke_user_sessions`: ends every session of one person (SECURITY_MODEL.md §4;
 * ADR-075). Firebase revokes the refresh tokens; every session cookie issued before now then fails
 * `verifySessionCookie(…, true)` on its next request. Returns 1 when the account existed, 0 when not
 * (Firebase does not count sessions; PostgreSQL returned how many it deleted).
 */
const revoke_user_sessions: DbFunction = async (db, args) => {
  requireServer(db);
  const userId = arg.str(args, 'p_user');
  if (!userId) raise.invalid('a user is required');
  try {
    await auth().revokeRefreshTokens(userId);
    return 1;
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found') return 0;
    throw error;
  }
};

export const functions: DbFunctions = { record_access_event, throttle, prune_rate_limits, revoke_user_sessions };

