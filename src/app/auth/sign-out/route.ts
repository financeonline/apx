import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/core/db/user-client';
import { recordAccessEvent, revokeUserSessions } from '@/core/db/server-rpc';
import { SESSION_ALIVE_COOKIE, SESSION_ONLY_COOKIE } from '@/core/routing';
import { newRequestId } from '@/core/logging';

/**
 * Sign out (owner, 2026-10-07: "I can't see logout options"). A POST from the sidebar's or Account's
 * Sign out button: the sign-out is recorded in the audit log (`auth.sign_out`), the `__session`
 * cookie is cleared, and the browser goes to the sign-in page. POST only, so a link or an image
 * cannot sign anyone out.
 *
 * This device only, unless the form sends `scope=global` ("Sign out everywhere"): then every session
 * of the account is ended too (`revokeRefreshTokens`, through `api_server.revoke_user_sessions`).
 */
export async function POST(request: NextRequest) {
  const actor = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (actor.kind === 'user') {
    try {
      await recordAccessEvent({ userId: actor.userId, requestId: newRequestId() }, { organizationId: null, action: 'auth.sign_out' });
    } catch {
      // The audit write must never trap someone in a session they asked to end.
    }
    const form = await request.formData().catch(() => null);
    if (form?.get('scope') === 'global') {
      try {
        await revokeUserSessions(actor.userId);
      } catch {
        // The cookie below is cleared regardless.
      }
    }
  }
  const response = NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
  for (const name of [SESSION_COOKIE, SESSION_ONLY_COOKIE, SESSION_ALIVE_COOKIE]) {
    response.cookies.set(name, '', { path: '/', maxAge: 0 });
  }
  return response;
}
