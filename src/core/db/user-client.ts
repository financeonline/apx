import 'server-only';
import { cookies, headers } from 'next/headers';
import { auth, db as firestore } from '@/db/firestore';
import { globalRow } from '@/db/schema';
import { SESSION_COOKIE } from '@/core/routing';
import type { Db, RequestMeta } from '@/db/types';

/**
 * The user-session handle: Firestore plus the caller, from the Firebase session cookie.
 *
 * It replaces the anon-key Supabase client. It carries no privilege of its own — every read goes
 * through `src/db/rls.ts` and every write through an `api.*` function, both of which decide from
 * `actor` — so a request without a valid session is simply `anon`.
 *
 * The session cookie is verified with revocation checked, so signing a person out everywhere
 * (`revokeRefreshTokens`, `api_server.revoke_user_sessions`) ends this session on its next request.
 */
export { SESSION_COOKIE };

export async function createUserClient(): Promise<Db> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const meta: RequestMeta = {
    requestId: headerStore.get('x-request-id'),
    ip: headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    userAgent: headerStore.get('user-agent'),
  };
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const fs = firestore();
  const actor = await verifySession(token);
  // A disabled account is signed out on its next request, whatever it asked for (ROUTE_ARCHITECTURE.md
  // §8.4). This check lived in the proxy; it moved here when the proxy became edge-only (ADR-183).
  if (actor.kind === 'user' && await accountDisabled(fs, actor.userId)) return { fs, actor: { kind: 'anon' }, meta };
  return { fs, actor, meta };
}

async function accountDisabled(fs: ReturnType<typeof firestore>, uid: string): Promise<boolean> {
  const profile = await globalRow(fs, 'profiles', uid).get();
  return profile.exists && Boolean(profile.get('disabled_at'));
}

/** Verifies a session cookie; anything invalid, expired or revoked is `anon`. */
export async function verifySession(token: string | undefined): Promise<Db['actor']> {
  if (!token) return { kind: 'anon' };
  try {
    const claims = await auth().verifySessionCookie(token, true);
    return {
      kind: 'user',
      userId: claims.uid,
      email: claims.email ?? null,
      authTime: typeof claims.auth_time === 'number' ? claims.auth_time : null,
    };
  } catch {
    return { kind: 'anon' };
  }
}

/** A handle for a known user, outside a request (job workers acting for a person, tests). */
export function userDb(userId: string, email: string | null = null, meta: RequestMeta = {}): Db {
  return { fs: firestore(), actor: { kind: 'user', userId, email, authTime: null }, meta };
}
