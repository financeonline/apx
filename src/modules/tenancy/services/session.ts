import 'server-only';
import { createSessionCookie, prepareProfile, usingEmulators, verifyIdToken } from '@/db/auth';

/**
 * The server side of signing in (SECURITY_MODEL.md §3; FIRESTORE_DATA_MODEL.md §1).
 *
 * The browser proves who it is to Firebase Authentication with email and password and receives an
 * ID token; it keeps no Firebase session of its own (in-memory persistence). It hands the ID token
 * to `/auth/session` once, and the server turns it into the ONLY session APX recognises: the
 * httpOnly `__session` cookie, a Firebase session cookie verified — with revocation checked — on
 * every request (`verifySession` in `core/db/user-client.ts`).
 */

/** The longest session Firebase issues, and what "Keep me signed in" asks for. */
export const SESSION_MAX_SECONDS = 14 * 24 * 60 * 60;

/** The `__session` cookie's attributes. Without `persistent` it is a browser-session cookie. */
export function sessionCookieOptions(persistent: boolean) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    ...(persistent ? { maxAge: SESSION_MAX_SECONDS } : {}),
  };
}

export type OpenedSession =
  | { readonly ok: true; readonly uid: string; readonly email: string; readonly cookie: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'unverified' | 'disabled'; readonly uid?: string };

/**
 * Verifies a fresh ID token, makes sure the account has its profile (`ensureProfile`, the port of
 * `app.handle_new_auth_user`), refuses a disabled account, and mints the session cookie.
 *
 * An unconfirmed email address is refused against a real Firebase project ("Confirm your email
 * address first"), as Supabase Auth refused it; on the local emulators it is accepted, as the local
 * Supabase stack (`enable_confirmations = false`) accepted it.
 */
export async function openSession(idToken: string): Promise<OpenedSession> {
  let decoded;
  try {
    decoded = await verifyIdToken(idToken, true);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const email = decoded.email;
  if (!email) return { ok: false, reason: 'invalid', uid: decoded.uid };
  if (!decoded.email_verified && !usingEmulators()) return { ok: false, reason: 'unverified', uid: decoded.uid };

  const fullName = typeof decoded.name === 'string' ? decoded.name : null;
  const { disabled } = await prepareProfile(decoded.uid, email, fullName);
  if (disabled) return { ok: false, reason: 'disabled', uid: decoded.uid };

  const cookie = await createSessionCookie(idToken, SESSION_MAX_SECONDS * 1000);
  return { ok: true, uid: decoded.uid, email, cookie };
}

/** Where the Identity Toolkit REST API lives: the Auth emulator locally, Google otherwise. */
function identityToolkit(path: string): string {
  const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-api-key';
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const base = emulator ? `http://${emulator}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
  return `${base}/v1/${path}?key=${encodeURIComponent(key)}`;
}

/**
 * Checks a password for an email with Firebase Authentication (the Admin SDK cannot), for "Confirm
 * it's you". Returns the fresh ID token, or null when the password is wrong. Free: it is the same
 * call the browser SDK makes.
 */
export async function passwordSignIn(email: string, password: string): Promise<{ uid: string; idToken: string } | null> {
  const response = await fetch(identityToolkit('accounts:signInWithPassword'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { localId?: string; idToken?: string };
  return body.localId && body.idToken ? { uid: body.localId, idToken: body.idToken } : null;
}

/** Applies an email-verification link's one-time code (`mode=verifyEmail`). True when it took. */
export async function applyEmailVerification(oobCode: string): Promise<boolean> {
  const response = await fetch(identityToolkit('accounts:update'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oobCode }),
    cache: 'no-store',
  });
  return response.ok;
}
