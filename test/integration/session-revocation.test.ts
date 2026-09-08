import { afterAll, describe, expect, it } from 'vitest';
import { revokeUserSessions } from '@/core/db';
import { adminSql, createAuthUser } from './setup';

/**
 * Session revocation exists (SECURITY_MODEL.md §4; ADR-075; PRODUCTION_AUDIT.md L3).
 *
 * GoTrue has no admin endpoint that ends another user's sessions, so MOTION ends them where they
 * live. A session row and its refresh token are seeded the way GoTrue writes them, and both are
 * gone afterwards; another user's are not.
 */

const RUN = `sr${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.sessions.itest`;

function seedSession(userId: string): string {
  const sessionId = adminSql(`select gen_random_uuid()`);
  adminSql(`
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
    values ('${sessionId}', '${userId}', now(), now(), 'aal1');
    insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
    values ('00000000-0000-0000-0000-000000000000', 'tok-${sessionId}', '${userId}', false, now(), now(), '${sessionId}')`);
  return sessionId;
}

const sessionsOf = (userId: string) => Number(adminSql(`select count(*) from auth.sessions where user_id = '${userId}'`));
const tokensOf = (userId: string) => Number(adminSql(`select count(*) from auth.refresh_tokens where user_id = '${userId}'`));

afterAll(() => {
  adminSql(`delete from auth.users where email like '%@${DOMAIN}'`);
});

describe('revokeUserSessions', () => {
  it('ends every session and refresh token of the user, and nobody else’s', async () => {
    const target = createAuthUser(`target@${DOMAIN}`);
    const bystander = createAuthUser(`bystander@${DOMAIN}`);
    seedSession(target);
    seedSession(target);
    seedSession(bystander);
    expect(sessionsOf(target)).toBe(2);

    const ended = await revokeUserSessions(target);
    expect(ended).toBe(2);
    expect(sessionsOf(target)).toBe(0);
    expect(tokensOf(target)).toBe(0);
    expect(sessionsOf(bystander), 'another user keeps their session').toBe(1);
    expect(tokensOf(bystander)).toBe(1);
  });

  it('is idempotent: nothing to end is not an error', async () => {
    const target = createAuthUser(`empty@${DOMAIN}`);
    expect(await revokeUserSessions(target)).toBe(0);
  });
});
