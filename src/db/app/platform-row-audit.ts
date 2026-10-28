import 'server-only';
import type { Transaction } from 'firebase-admin/firestore';
import type { Db } from '../types';
import { prepareAudit, type PreparedAudit } from './audit';

/**
 * The `audit_diff` trigger (`app.audit_diff()`), ported for the tables the platform area writes
 * (FIRESTORE_DATA_MODEL.md §4: a trigger's effect is done by the writing function itself).
 *
 * PostgreSQL wrote one `db.<table>.<insert|update|delete>` event for every row written to an
 * audited table — `organizations`, `platform_users`, `platform_settings`, `platform_org_settings`,
 * `organization_assignments`, `organization_memberships`, `invitations` among them — carrying the
 * whole row before and after, and `{source: 'trigger'}` as metadata. The organisation is the row's
 * own id for `organizations`, else its `organization_id`; the target is the row's `id`, else its
 * `user_id`, else its `organization_id` — exactly the trigger's `coalesce`.
 *
 * Like every `prepare*`, this does its reads (the audit guard's role check, the actor type) now and
 * returns a `write(tx)` that only writes, so a caller gathers it with its other reads.
 */
export type RowOp = 'insert' | 'update' | 'delete';

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export async function prepareRowAudit(
  db: Db,
  table: string,
  op: RowOp,
  before: Row | null,
  after: Row | null,
  tx?: Transaction,
  options: { bootstrap?: boolean } = {},
): Promise<PreparedAudit> {
  const row = after ?? before ?? {};
  const organizationId = table === 'organizations' ? str(row.id) : str(row.organization_id);
  const targetId = str(row.id) ?? str(row.user_id) ?? str(row.organization_id);
  return prepareAudit(db, {
    organizationId,
    action: `db.${table}.${op}`,
    targetTable: table,
    targetId,
    before: op === 'insert' ? null : before,
    after: op === 'delete' ? null : after,
    metadata: { source: 'trigger' },
    bootstrap: options.bootstrap,
  }, tx);
}
