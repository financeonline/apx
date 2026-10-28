import 'server-only';
import type { Firestore } from 'firebase-admin/firestore';
import { raise } from '../raise';
import { globalRow, hashKey, nowIso } from '../schema';

/**
 * `app.throttle(actor, bucket, limit, window)`: a fixed-window counter shared by every server
 * instance (ROUTE_ARCHITECTURE.md §5). One document per actor, bucket and window start in
 * `api_rate_limits`; the increment is atomic, and a count past `limit` raises QUOTA.
 *
 * A null actor (a system call) is never throttled, as before.
 */
export async function throttle(
  fs: Firestore, actorId: string | null, bucket: string, limit: number, windowSeconds: number,
): Promise<void> {
  if (!actorId) return;
  const secs = Math.max(Math.floor(windowSeconds), 1);
  const windowStartMs = Math.floor(Date.now() / 1000 / secs) * secs * 1000;
  const windowStart = new Date(windowStartMs).toISOString();
  const ref = globalRow(fs, 'api_rate_limits', hashKey([actorId, bucket, windowStart]));

  const count = await fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = (snap.exists ? Number(snap.get('count')) : 0) + 1;
    tx.set(ref, {
      actor_user_id: actorId, bucket, window_start: windowStart, count: next, updated_at: nowIso(),
    });
    return next;
  });
  if (count > limit) raise.quota(`too many ${bucket} requests`, new Date(windowStartMs + secs * 1000));
}

/** Parses the SQL `interval` strings the callers still pass ('1 hour', '10 minutes', '1 day'). */
export function intervalSeconds(interval: string | number): number {
  if (typeof interval === 'number') return interval;
  const m = /^\s*(\d+)\s*(second|minute|hour|day)s?\s*$/i.exec(interval);
  if (!m) throw new Error(`unrecognised interval ${interval}`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return n * (unit === 'second' ? 1 : unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400);
}

/** `api_server.prune_rate_limits`: drops windows older than a day. */
export async function pruneRateLimits(fs: Firestore): Promise<number> {
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const old = await fs.collection('api_rate_limits').where('window_start', '<', cutoff).limit(5000).get();
  const writer = fs.bulkWriter();
  for (const d of old.docs) void writer.delete(d.ref);
  await writer.close();
  return old.size;
}
