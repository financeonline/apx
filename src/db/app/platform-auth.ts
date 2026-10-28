import 'server-only';
import { auth, db as firestore } from '../firestore';
import { globalRow } from '../schema';
import { ensureProfile } from './profiles';

/**
 * The super admin's sign-in account operations (ADR-158, ADR-160, ADR-167) — what the platform
 * service did with Supabase's Auth admin API (`createUser`, `inviteUserByEmail`, `updateUserById`,
 * `deleteUser`, `listUsers`), on Firebase Authentication. Kept in `src/db` because only `src/db` may
 * hold the Admin SDK (the `motion/no-admin-sdk-outside-sanctioned-files` lint rule).
 *
 * Every account made here gets its `profiles` document at once, as signing up does
 * (`ensureProfile`, the port of `app.handle_new_auth_user`); an email change keeps the profile in
 * step (`app.sync_auth_user_email`). The AUTHORITY for each operation is checked by the `api.*`
 * function the caller runs around it, never here.
 */

/** Firebase Auth's refusal of an address that already has an account. */
export function isEmailTaken(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'auth/email-already-exists';
}

/** A login with a password the super admin set, email confirmed (the super admin vouches for it). */
export async function createConfirmedLogin(email: string, password: string): Promise<string> {
  const user = await auth().createUser({ email, password, emailVerified: true });
  await ensureProfile(firestore(), user.uid, email, null, new Date().toISOString());
  return user.uid;
}

/** Removes a login just made (and its profile) when what it was made for failed. */
export async function removeLogin(userId: string): Promise<void> {
  await auth().deleteUser(userId);
  await globalRow(firestore(), 'profiles', userId).delete();
}

/** An existing account's id, or null (Firebase Auth looks up by email directly). */
export async function loginIdByEmail(email: string): Promise<string | null> {
  try {
    return (await auth().getUserByEmail(email)).uid;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'auth/user-not-found') return null;
    throw error;
  }
}

/**
 * Supabase's `inviteUserByEmail`: the account is created without a password and Firebase Auth emails
 * the person a link to set one (`accounts:sendOobCode`, `PASSWORD_RESET`) that brings them back to
 * `redirectTo`. The Admin SDK can make the link but not send it, so the request goes to the Auth REST
 * API with the project's web key — on the emulators, to the emulator, which logs the link instead.
 * Returns the new account's id; throws when the email could not be sent.
 */
export async function inviteLogin(email: string, redirectTo: string): Promise<string> {
  const user = await auth().createUser({ email, emailVerified: false });
  await ensureProfile(firestore(), user.uid, email, null, null);
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const base = emulator ? `http://${emulator}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
  const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? (emulator ? 'emulator' : '');
  const response = await fetch(`${base}/v1/accounts:sendOobCode?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email, continueUrl: redirectTo }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok) throw new Error('the invitation email was not sent');
  return user.uid;
}

/** Changes a login's email (confirmed) and/or password; the profile follows the email. */
export async function updateLogin(userId: string, change: { email: string; password?: string | null }): Promise<void> {
  await auth().updateUser(userId, {
    email: change.email, emailVerified: true, ...(change.password ? { password: change.password } : {}),
  });
  await ensureProfile(firestore(), userId, change.email, null);
}
