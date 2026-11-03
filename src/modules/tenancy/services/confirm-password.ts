import 'server-only';
import { cookies } from 'next/headers';
import { ValidationError } from '@/core/errors';
import { SESSION_COOKIE } from '@/core/db/user-client';
import type { Actor } from '@/db/types';
import { createSessionCookie, verifyIdToken } from '@/db/auth';
import { SESSION_ONLY_COOKIE } from '@/core/routing';
import { passwordSignIn, sessionCookieOptions, SESSION_MAX_SECONDS } from './session';
import type { AccessContext } from '../context';

/**
 * "Confirm it's you": a password sign-in for the person already signed in, so the recent-sign-in
 * check (`hasRecentAuth`, ten minutes) passes for the sensitive super-admin actions
 * (`requireSuperAdmin(db, true)`).
 *
 * The password is checked by Firebase Authentication itself (the Identity Toolkit password sign-in —
 * the Admin SDK cannot check a password), the `__session` cookie is replaced with a fresh one whose
 * `auth_time` is now, and `ctx.db` carries the new sign-in time for the rest of this request, as the
 * Supabase client carried its fresh session. Attempts are rate-limited by Firebase Auth. The password
 * is never stored or logged.
 */
/** The fresh session cookie, for a caller that sets it on a response of its own (`/auth/confirm`). */
export interface ConfirmedSession {
  readonly name: string;
  readonly value: string;
  readonly options: ReturnType<typeof sessionCookieOptions>;
}

export async function confirmPassword(ctx: AccessContext, password: string): Promise<ConfirmedSession> {
  if (!password) throw new ValidationError('Enter your password to confirm it is you.');
  const actor = ctx.db.actor;
  const email = actor.kind === 'user' ? actor.email : null;
  if (actor.kind !== 'user' || !email || actor.userId !== ctx.userId) {
    throw new ValidationError('Your session has ended. Sign in again.');
  }
  const signedIn = await passwordSignIn(email, password);
  if (!signedIn || signedIn.uid !== ctx.userId) throw new ValidationError('That password is not right.');

  const decoded = await verifyIdToken(signedIn.idToken);
  const jar = await cookies();
  // Keep the person's "keep me signed in" choice: a persistent cookie stays persistent.
  const persistent = !jar.has(SESSION_ONLY_COOKIE);
  const cookie = await createSessionCookie(signedIn.idToken, SESSION_MAX_SECONDS * 1000);
  const options = sessionCookieOptions(persistent);
  try {
    jar.set(SESSION_COOKIE, cookie, options);
  } catch {
    // A route handler sets the cookie on its own response instead (`/auth/confirm`).
  }

  const refreshed: Actor = { kind: 'user', userId: actor.userId, email, authTime: decoded.auth_time };
  // `Db.actor` is read-only to callers; this is the one place a request's handle learns of a new sign-in.
  (ctx.db as { actor: Actor }).actor = refreshed;
  return { name: SESSION_COOKIE, value: cookie, options };
}
