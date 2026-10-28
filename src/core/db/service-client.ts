import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db as firestore } from '@/db/firestore';
import type { Db } from '@/db/types';

/**
 * Server access — job workers and server-observed facts (ADR-013, ADR-043, ADR-090).
 *
 * A service handle acts as the server itself (`actor.kind === 'service'`), which every `src/db`
 * function treats as trusted but SCOPED: inside `withOrgScope` the actor carries the organisation,
 * the organisation comes from the `jobs` row (never from a payload), and `requireScope` /
 * `prepareAudit` refuse a write or an audit event for any other organisation — so a handler that
 * names the wrong organisation is stopped rather than trusted, as the `x-motion-org` header made
 * PostgreSQL stop it.
 */

/**
 * The organisation the current asynchronous call tree is scoped to.
 *
 * Ambient rather than threaded through every signature, because the point is that EVERY server path
 * inside a job picks it up — including `core/db/server-rpc.ts`.
 */
const scopeStore = new AsyncLocalStorage<string>();

/** The organization id this call is scoped to, or null outside a scope. */
export function currentOrgScope(): string | null {
  return scopeStore.getStore() ?? null;
}

/** An unscoped service handle: the queue itself, sweeps, platform-wide facts. */
export function createServiceClient(): Db {
  return { fs: firestore(), actor: { kind: 'service', scope: currentOrgScope() }, meta: {} };
}

/** A service handle scoped to one organisation. */
export function scopedServiceClient(organizationId: string): Db {
  return { fs: firestore(), actor: { kind: 'service', scope: organizationId }, meta: {} };
}

export interface OrgScope {
  readonly organizationId: string;
  readonly db: Db;
}

/**
 * Run work as the server, scoped to exactly one organisation: the handle passed to `fn` carries the
 * scope, and so does every `api_server.*` call made anywhere underneath (through `currentOrgScope`).
 */
export async function withOrgScope<T>(
  organizationId: string,
  fn: (scope: OrgScope) => Promise<T>,
): Promise<T> {
  if (!organizationId) throw new Error('withOrgScope requires an organization id');
  const db = scopedServiceClient(organizationId);
  return scopeStore.run(organizationId, () => fn({ organizationId, db }));
}
