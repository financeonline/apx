import { afterAll, describe, expect, it } from 'vitest';
import { revokeUserSessions } from '@/core/db';
import { verifySession } from '@/core/db/user-client';
import { auth } from '@/db/firestore';
import { openSession, passwordSignIn } from '@/modules/tenancy';
import { createAuthUser, fs, rpc, anonClient } from './setup';

/**
 * Session revocation exists (SECURITY_MODEL.md §4; ADR-075; PRODUCTION_AUDIT.md L3).
 *
 * A session is the `__session` cookie: a Firebase session cookie, verified with revocation checked
 * on every request. Two real sessions are opened the way the sign-in form opens them (password
 * sign-in, then `/auth/session`'s `openSession`); revoking one person's ends theirs on the next
 * check, and another person's keeps working.
 */

const RUN = `sr${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.sessions.itest.motion`;
const PASSWORD = 'itest-password-1';
const made: string[] = [];

async function signedInCookie(email: string): Promise<{ uid: string; cookie: string }> {
  const uid = await createAuthUser(email, PASSWORD);
  made.push(uid);
  const signedIn = await passwordSignIn(email, PASSWORD);
  if (!signedIn) throw new Error(`could not sign ${email} in`);
  const session = await openSession(signedIn.idToken);
  if (!session.ok) throw new Error(`no session for ${email}: ${session.reason}`);
  return { uid, cookie: session.cookie };
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

afterAll(async () => {
  for (const uid of made) {
    await auth().deleteUser(uid).catch(() => undefined);
    await fs().collection('profiles').doc(uid).delete();
  }
});

describe('revokeUserSessions', () => {
  it('ends every session of the user, and nobody else’s', async () => {
    const target = await signedInCookie(`target@${DOMAIN}`);
    const bystander = await signedInCookie(`bystander@${DOMAIN}`);
    expect(await verifySession(target.cookie)).toMatchObject({ kind: 'user', userId: target.uid });

    // Firebase compares revocation in whole seconds: a session from the same second would survive.
    await sleep(1100);
    expect(await revokeUserSessions(target.uid)).toBe(1);
    expect(await verifySession(target.cookie), 'the revoked session is anon').toEqual({ kind: 'anon' });
    expect(await verifySession(bystander.cookie), 'another user keeps their session')
      .toMatchObject({ kind: 'user', userId: bystander.uid });
  });

  it('is idempotent: an account with no sessions, or none at all, is not an error', async () => {
    const uid = await createAuthUser(`empty@${DOMAIN}`, PASSWORD);
    made.push(uid);
    expect(await revokeUserSessions(uid)).toBe(1);
    expect(await revokeUserSessions(`no-such-user-${RUN}`)).toBe(0);
  });

  it('is the server’s alone', async () => {
    const { error } = await rpc(anonClient(), 'revoke_user_sessions', { p_user: made[0] }, { server: true });
    expect(error?.code).toBe('PERMISSION_DENIED');
  });
});
