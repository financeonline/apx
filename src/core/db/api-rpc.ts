import 'server-only';
import { InternalError, isMotionError, toMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import { API_FUNCTIONS } from '@/db/api';
import type { Db } from '@/db/types';

/**
 * The only way application code mutates data: an `api.*` function, run for the caller in `db`
 * (ADR-026). The functions are the TypeScript ports in `src/db/api`, with the same names, arguments
 * and results the SQL functions had, so a service's `callApi(ctx.db, 'create_action', {...})` is
 * unchanged by the move to Firestore.
 *
 * Errors are normalised once, at this boundary, so nothing unexpected leaks into a service or a page.
 */
export async function callApi<T>(
  db: Db,
  fn: string,
  args: Record<string, unknown>,
  requestId?: string,
): Promise<T> {
  const impl = API_FUNCTIONS[fn];
  if (!impl) throw Object.assign(new InternalError(), { requestId, cause: `api.${fn} is not defined` });
  const call = requestId && !db.meta.requestId ? { ...db, meta: { ...db.meta, requestId } } : db;
  try {
    return (await impl(call, args)) as T;
  } catch (error) {
    // An unexpected throw becomes INTERNAL for the caller; its own message is kept in the log so the
    // cause can be found (2026-11-03: Edit login answered only "Something went wrong").
    if (!isMotionError(error)) {
      log.error('api function threw', { requestId, fn, detail: error instanceof Error ? error.message : String(error) });
    }
    throw toMotionError(error, requestId);
  }
}
