import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toMotionError } from '@/core/errors';

/**
 * The only way application code mutates data: an `api.*` SECURITY DEFINER function called with the
 * user's own session (ADR-026). There is no table-write path — `authenticated` holds no
 * insert/update/delete privilege on any table — so every module's write layer funnels through here.
 *
 * Errors are translated once, at this boundary, so a SQLSTATE never leaks into a service or a page.
 */
export async function callApi<T>(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  requestId?: string,
): Promise<T> {
  const { data, error } = await db.schema('api').rpc(fn, args);
  if (error) throw toMotionError(error, requestId);
  return data as T;
}
