import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, inMemoryPersistence, setPersistence, type Auth } from 'firebase/auth';

/**
 * The ONLY browser-side Firebase code in APX (SECURITY_MODEL.md §3; FIRESTORE_DATA_MODEL.md §2).
 *
 * It exists because proving who you are is the one thing the server cannot do on the user's behalf:
 * password sign-in, sign-up and password reset happen between the browser and Firebase
 * Authentication. The browser then hands the ID token to `/auth/session`, which sets the httpOnly
 * `__session` cookie — that cookie is the session. The browser keeps NO Firebase session of its own
 * (in-memory persistence, signed out again straight after), and it never talks to Firestore or
 * Storage: their rules refuse every client request.
 *
 * The web config is public by design (an API key identifies the project; it grants nothing).
 * Locally it points at the Auth emulator when NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST is set.
 */
let auth: Auth | null = null;
let ready: Promise<void> | null = null;

function app(): FirebaseApp {
  if (getApps().length > 0) return getApp();
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error('Missing NEXT_PUBLIC_FIREBASE_API_KEY or NEXT_PUBLIC_FIREBASE_PROJECT_ID. Check .env.local.');
  }
  return initializeApp({
    apiKey,
    projectId,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? `${projectId}.firebaseapp.com`,
  });
}

/** The browser's Firebase Auth, with no persisted session, on the emulator when configured. */
export async function firebaseAuth(): Promise<Auth> {
  if (!auth) {
    auth = getAuth(app());
    const emulator = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
    if (emulator) connectAuthEmulator(auth, `http://${emulator}`, { disableWarnings: true });
    ready = setPersistence(auth, inMemoryPersistence);
  }
  await ready;
  return auth;
}

/** True when the browser talks to the local Auth emulator (sign-up then needs no email check). */
export function usingAuthEmulator(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST);
}

export class SessionRefused extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/**
 * Hands a fresh ID token to the server, which sets the session cookie, then forgets the browser's
 * own Firebase sign-in. Throws `SessionRefused` with the server's sentence when it says no.
 */
export async function openServerSession(idToken: string, keepSignedIn: boolean): Promise<void> {
  const response = await fetch('/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken, keepSignedIn }),
    credentials: 'same-origin',
  });
  const a = await firebaseAuth();
  await a.signOut().catch(() => undefined);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string; reason?: string } } | null;
    throw new SessionRefused(body?.error?.message ?? 'Sign in again.', body?.error?.reason ?? 'invalid');
  }
}

/**
 * Firebase Auth errors arrive as codes aimed at developers. These are the ones a user can actually
 * hit; anything else falls back to a plain apology rather than leaking internals.
 */
export function authErrorMessage(error: unknown): string {
  if (error instanceof SessionRefused) return error.message;
  const code = (error as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'That email address and password do not match an account.';
    case 'auth/user-disabled':
      return 'This account has been switched off. Ask your administrator.';
    case 'auth/email-already-in-use':
      return 'There is already an account with that email address. Try signing in instead.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Choose a stronger password (at least 12 characters).';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'auth/expired-action-code':
    case 'auth/invalid-action-code':
      return 'That link is no longer valid. Please request a new one.';
    case 'auth/network-request-failed':
      return 'We could not reach the sign-in service. Check your connection and try again.';
    default:
      return 'Something went wrong on our side. Please try again.';
  }
}
