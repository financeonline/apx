import 'server-only';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { auth, db, usingEmulators } from './firestore';
import { ensureProfile } from './app/profiles';
import { globalRow } from './schema';

/**
 * Firebase Authentication as APX uses it (SECURITY_MODEL.md §3; FIRESTORE_DATA_MODEL.md §1–2).
 *
 * The Admin SDK skips every check in `src/db`, so modules never import it
 * (`motion/no-admin-sdk-outside-sanctioned-files`): signing in, "Confirm it's you" and team logins
 * reach Firebase Authentication — and the `profiles` document that goes with each account — only
 * through these few calls.
 */

export { usingEmulators };

/** Verifies an ID token the browser obtained from Firebase Authentication; throws when it is not valid. */
export function verifyIdToken(idToken: string, checkRevoked = false): Promise<DecodedIdToken> {
  return auth().verifyIdToken(idToken, checkRevoked);
}

/** Mints the `__session` cookie value for a freshly verified ID token. */
export function createSessionCookie(idToken: string, expiresInMs: number): Promise<string> {
  return auth().createSessionCookie(idToken, { expiresIn: expiresInMs });
}

/**
 * Makes sure a signing-in account has its profile (`ensureProfile`, the port of
 * `app.handle_new_auth_user`) and says whether the account has been disabled.
 */
export async function prepareProfile(
  uid: string, email: string, fullName: string | null,
): Promise<{ disabled: boolean }> {
  await ensureProfile(db(), uid, email, fullName);
  const profile = await globalRow(db(), 'profiles', uid).get();
  return { disabled: Boolean(profile.get('disabled_at')) };
}

/**
 * Creates a sign-in account whose email is already confirmed (a team login made by its owner) and
 * returns its uid. Firebase's own error (with its `code`, e.g. `auth/email-already-exists`) is
 * passed through for the caller to put into words.
 */
export async function createLogin(input: { email: string; password: string; fullName: string | null }): Promise<string> {
  const user = await auth().createUser({
    email: input.email,
    password: input.password,
    emailVerified: true,
    ...(input.fullName ? { displayName: input.fullName } : {}),
  });
  return user.uid;
}

/** Removes a sign-in account and its profile: the undo of `createLogin` when the rest failed. */
export async function deleteLogin(uid: string): Promise<void> {
  await auth().deleteUser(uid);
  await globalRow(db(), 'profiles', uid).delete();
}
