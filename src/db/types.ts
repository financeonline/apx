import type {
  DocumentReference, DocumentSnapshot, Firestore, Query, QuerySnapshot, Transaction,
} from 'firebase-admin/firestore';

/**
 * Who is making a database call (FIRESTORE_DATA_MODEL.md §2).
 *
 * On PostgreSQL this was the JWT the request carried (`app.uid()`, `app.role_claim()`) or the
 * service role. Here it is explicit, and every `src/db` function decides from it:
 *
 *  - `user`: a signed-in person, from a verified Firebase session cookie. `authTime` is when they
 *    last proved who they are (seconds), the old `amr` timestamp `app.has_recent_auth` read.
 *  - `anon`: nobody signed in. Only functions that say so accept it.
 *  - `service`: the server itself — a job worker or a server-observed fact (`api_server.*`).
 *    `scope` is the organisation a job is scoped to (the old `x-motion-org` header), or null.
 */
export type Actor =
  | { readonly kind: 'user'; readonly userId: string; readonly email: string | null; readonly authTime: number | null }
  | { readonly kind: 'anon' }
  | { readonly kind: 'service'; readonly scope: string | null };

/** Request facts the audit log records (the old `request.headers`). */
export interface RequestMeta {
  readonly requestId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * The handle the application passes around in place of a SupabaseClient: the Firestore instance and
 * the caller. `AccessContext.db` and `OrgScope.db` are one of these.
 */
export interface Db {
  readonly fs: Firestore;
  readonly actor: Actor;
  readonly meta: RequestMeta;
}

/** Either a transaction or a plain read; permission checks run inside and outside transactions. */
export interface Reader {
  get(ref: DocumentReference): Promise<DocumentSnapshot>;
  query(q: Query): Promise<QuerySnapshot>;
}

export function readerOf(tx?: Transaction): Reader {
  if (tx) {
    return { get: (ref) => tx.get(ref), query: (q) => tx.get(q) };
  }
  return { get: (ref) => ref.get(), query: (q) => q.get() };
}

/** The signed-in user's id, or null for anon and service callers. */
export function uidOf(db: Db): string | null {
  return db.actor.kind === 'user' ? db.actor.userId : null;
}
