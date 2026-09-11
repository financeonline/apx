import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role access — sanctioned use #1 of 3: job workers (ADR-013, ADR-043, ADR-090).
 * The other two are core/db/server-rpc.ts and core/storage/signer.ts.
 *
 * The service role bypasses RLS by attribute, so every use is wrapped in withOrgScope, the
 * organization comes from the `jobs` row (never from a payload), and the
 * `motion/no-unscoped-service-query` lint rule fails any query that omits organization_id.
 *
 * **How the scope reaches the database (ADR-090).** A scoped client carries the organization as the
 * `x-motion-org` request header, and PostgREST places every request header into `request.headers`,
 * which is transaction-local to that one request. The header therefore cannot be missing from a
 * call that carried it, cannot leak to the next request on the same pooled connection, and cannot
 * be read by a different client. The previous mechanism — `set_config('app.current_org', …,
 * is_local => false)` — failed on both counts and silently: `set_config` is not in an exposed
 * schema, and a session GUC cannot scope a series of independent HTTP requests (audit H1).
 */
const SCOPE_HEADER = 'x-motion-org';

/**
 * The organization the current asynchronous call tree is scoped to.
 *
 * Ambient rather than threaded through every signature, because the point is that EVERY server path
 * inside a job picks it up — including `core/db/server-rpc.ts`, which holds its own client and
 * would otherwise call `api_server.*` with no scope at all, which is exactly what happened before.
 */
const scopeStore = new AsyncLocalStorage<string>();

/** The organization id this call is scoped to, or null outside a scope. */
export function currentOrgScope(): string | null {
  return scopeStore.getStore() ?? null;
}

function credentials(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Service-role client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  return { url, key };
}

let cached: SupabaseClient | null = null;
/** One client per organization: supabase-js fixes headers at construction, not per call. */
const scopedClients = new Map<string, SupabaseClient>();

export function createServiceClient(): SupabaseClient {
  if (cached) return cached;
  const { url, key } = credentials();
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * A service-role client whose every request announces the organization it is scoped to.
 *
 * Exported for `core/db/server-rpc.ts`, which must build its `api_server.*` calls on the same
 * scope. Nothing else needs it: inside a job, `scope.db` already is one of these.
 */
export function scopedServiceClient(organizationId: string): SupabaseClient {
  const existing = scopedClients.get(organizationId);
  if (existing) return existing;
  const { url, key } = credentials();
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { [SCOPE_HEADER]: organizationId } },
  });
  scopedClients.set(organizationId, client);
  return client;
}

export interface OrgScope {
  readonly organizationId: string;
  readonly db: SupabaseClient;
}

/**
 * Run work as the service role, scoped to exactly one organization.
 *
 * The scope is established two ways at once, and both are checked in SQL: the client passed to the
 * handler carries the header, and the ambient scope makes every `api_server.*` call made anywhere
 * underneath carry it too. `app.require_scope` refuses a scoped write with no scope or the wrong
 * one, and `app.audit` refuses an event whose organization is not the scoped one — so a handler
 * that names the wrong organization is stopped by the database rather than trusted (ADR-090).
 */
export async function withOrgScope<T>(
  organizationId: string,
  fn: (scope: OrgScope) => Promise<T>,
): Promise<T> {
  if (!organizationId) throw new Error('withOrgScope requires an organization id');
  const db = scopedServiceClient(organizationId);
  return scopeStore.run(organizationId, () => fn({ organizationId, db }));
}
