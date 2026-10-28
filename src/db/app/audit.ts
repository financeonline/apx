import 'server-only';
import type { Transaction } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { globalRow, newId, nowIso } from '../schema';
import { readerOf, type Db } from '../types';
import { actorTypeOf, orgRoleOf } from './access';

/**
 * `app.audit` (SECURITY_MODEL.md §9, ADR-043, ADR-090): one append-only row in `audit_events`.
 *
 * The checks are the SQL function's, made explicit:
 *
 *  - a USER event must name an organisation the user can reach — except in the two bootstrap
 *    flows (creating an organisation, accepting an invitation), which pass `bootstrap: true`;
 *  - a SERVICE event inside a job scope must name the scoped organisation, so a worker draining
 *    organisation A cannot write an audit row for organisation B whatever the handler believes.
 *
 * The actor of a service event is whoever the caller names (`actorId`); null is a system event.
 *
 * Inside a transaction, call `prepareAudit` with the reads and `write` with the writes (Firestore
 * needs every read first); outside one, `audit` does both.
 */
export interface AuditInput {
  readonly organizationId: string | null;
  readonly action: string;
  readonly targetTable?: string | null;
  readonly targetId?: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly metadata?: Record<string, unknown> | null;
  /** Service events only: the human the server acted for. */
  readonly actorId?: string | null;
  /** The two bootstrap flows audit an organisation the caller is not yet a member of. */
  readonly bootstrap?: boolean;
}

export interface PreparedAudit {
  readonly id: string;
  write(tx: Transaction): void;
}

export async function prepareAudit(db: Db, input: AuditInput, tx?: Transaction): Promise<PreparedAudit> {
  const r = readerOf(tx);
  let actor: string | null;
  if (db.actor.kind === 'user') {
    actor = db.actor.userId;
    if (input.organizationId && !input.bootstrap) {
      const role = await orgRoleOf(db.fs, actor, input.organizationId, r);
      if (!role) raise.notFound();
    }
  } else {
    if (db.actor.kind === 'service' && db.actor.scope && input.organizationId !== db.actor.scope) {
      raise.invalid('audit organization does not match the scoped organization');
    }
    actor = input.actorId ?? null;
  }
  const actorType = await actorTypeOf(db.fs, actor, r);
  const id = newId();
  const row = {
    id,
    organization_id: input.organizationId,
    actor_user_id: actor,
    actor_type: actorType,
    action: input.action,
    target_table: input.targetTable ?? null,
    target_id: input.targetId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: input.metadata ?? {},
    ip: db.meta.ip ?? null,
    user_agent: db.meta.userAgent ? db.meta.userAgent.slice(0, 256) : null,
    request_id: db.meta.requestId ?? newId(),
    created_at: nowIso(),
  };
  const ref = globalRow(db.fs, 'audit_events', id);
  return { id, write: (t) => { t.set(ref, row); } };
}

/** Writes one audit event outside a transaction; returns its id (the Storage signer verifies it). */
export async function audit(db: Db, input: AuditInput): Promise<string> {
  const prepared = await prepareAudit(db, input);
  await db.fs.runTransaction(async (tx) => { prepared.write(tx); });
  return prepared.id;
}

/** `app.audit_diff`: only the keys whose values changed, before and after. */
export function auditDiff(
  before: Record<string, unknown>, after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updated_at') continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return Object.keys(a).length === 0 ? null : { before: b, after: a };
}
