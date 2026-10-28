import 'server-only';
import type { Firestore } from 'firebase-admin/firestore';
import { globalRow, nowIso } from '../schema';

/**
 * `app.handle_new_auth_user` and `app.sync_auth_user_email` (TENANCY_MODEL.md §2): every sign-in
 * account has a `profiles` document keyed by its Firebase Auth uid.
 *
 * PostgreSQL created it with a trigger on `auth.users`; Firebase Auth has no such trigger, so the
 * server calls this whenever it opens a session (sign-in, sign-up, invitation acceptance) — it
 * creates the profile when missing and keeps the email in step with the account, and is a no-op
 * otherwise. `profiles_email_key` (one profile per email) holds because Firebase Auth already
 * refuses a second account with the same email.
 */
export async function ensureProfile(
  fs: Firestore, uid: string, email: string, fullName: string | null, emailConfirmedAt: string | null = null,
): Promise<void> {
  const ref = globalRow(fs, 'profiles', uid);
  await fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = nowIso();
    if (!snap.exists) {
      tx.set(ref, {
        id: uid, email: email.toLowerCase(), full_name: fullName?.trim() || null, avatar_url: null,
        last_active_org_id: null, timezone: 'Europe/London', onboarding_state: {}, disabled_at: null,
        email_confirmed_at: emailConfirmedAt ?? now, created_at: now, updated_at: now,
      });
    } else if (String(snap.get('email')) !== email.toLowerCase()) {
      tx.update(ref, { email: email.toLowerCase(), updated_at: now });
    }
  });
}
