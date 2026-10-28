import 'server-only';
import { raise } from '../raise';
import type { Db } from '../types';

/**
 * The `api_server` boundary (ADR-043, ADR-090).
 *
 * `requireServer`: an `api_server.*` function runs only for the server itself — the old
 * `app.role_claim() <> 'service_role'` refusal. A user handle reaching one is a bug or an attack.
 *
 * `requireScope(db, org)`: an organisation-scoped server WRITE must run inside `withOrgScope` for
 * exactly that organisation (`app.require_scope`).
 */
export function requireServer(db: Db): void {
  if (db.actor.kind !== 'service') raise.denied('api_server is callable only by the server');
}

export function requireScope(db: Db, orgId: string | null): void {
  requireServer(db);
  if (!orgId) raise.invalid('this function is organization-scoped and was given no organization');
  const scope = db.actor.kind === 'service' ? db.actor.scope : null;
  if (!scope) raise.denied('no organization scope was established for this request');
  if (scope !== orgId) raise.denied('the organization scope does not match the organization being written');
}
