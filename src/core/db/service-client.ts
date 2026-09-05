import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role access — sanctioned use #1 of 3: job workers (ADR-013, ADR-043).
 * The other two are core/db/server-rpc.ts and core/storage/signer.ts.
 *
 * The service role bypasses RLS by attribute, so every use is wrapped in withOrgScope, the
 * organization comes from the `jobs` row (never from a payload), and the
 * `motion/no-unscoped-service-query` lint rule fails any query that omits organization_id.
 */
let cached: SupabaseClient | null = null;

export function createServiceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Service-role client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export interface OrgScope {
  readonly organizationId: string;
  readonly db: SupabaseClient;
}

/**
 * Run work as the service role, scoped to exactly one organization.
 * `app.current_org` is set for the connection so app.audit() can verify that a server-asserted
 * audit row belongs to the scoped organization (ADR-043).
 */
export async function withOrgScope<T>(
  organizationId: string,
  fn: (scope: OrgScope) => Promise<T>,
): Promise<T> {
  if (!organizationId) throw new Error('withOrgScope requires an organization id');
  const db = createServiceClient();
  await db.rpc('set_config', {
    setting_name: 'app.current_org',
    new_value: organizationId,
    is_local: false,
  });
  try {
    return await fn({ organizationId, db });
  } finally {
    await db.rpc('set_config', { setting_name: 'app.current_org', new_value: '', is_local: false });
  }
}
