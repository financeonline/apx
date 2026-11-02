import 'server-only';
import { globalRow } from '@/db/schema';
import type { Db } from '@/db/types';

/**
 * Where a signed-in account belongs (ROUTE_ARCHITECTURE.md §8.5, §8.6) — decided by the proxy until
 * it became edge-only (ADR-183), now by the pages. Null for a visitor without a session.
 */
export async function homePathFor(db: Db): Promise<string | null> {
  if (db.actor.kind !== 'user') return null;
  return (await platformHomeFor(db)) ?? '/select-organization';
}

/**
 * The family a PLATFORM account belongs to — `/platform` for the active super admin, `/portfolio`
 * for other active staff — or null for a member of customer organisations. Platform accounts are
 * never members of a customer organisation, so the no-org pages send them here instead.
 */
export async function platformHomeFor(db: Db): Promise<string | null> {
  if (db.actor.kind !== 'user') return null;
  const snap = await globalRow(db.fs, 'platform_users', db.actor.userId).get();
  if (!snap.exists || snap.get('status') !== 'active') return null;
  return snap.get('platform_role') === 'super_admin' ? '/platform' : '/portfolio';
}
