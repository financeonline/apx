import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@/core/db/user-client';
import { recordAccessEvent } from '@/core/db/server-rpc';
import { newRequestId } from '@/core/logging';

/**
 * Sign out (owner, 2026-10-07: "I can't see logout options"). A POST from the sidebar's or Account's
 * Sign out button: the sign-out is recorded in the audit log (`auth.sign_out`), the session ends, and
 * the browser goes to the sign-in page. POST only, so a link or an image cannot sign anyone out.
 */
export async function POST(request: NextRequest) {
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (data.user) {
    try {
      await recordAccessEvent({ userId: data.user.id, requestId: newRequestId() }, { organizationId: null, action: 'auth.sign_out' });
    } catch {
      // The audit write must never trap someone in a session they asked to end.
    }
    // This device only; signing out everywhere is a separate decision.
    await db.auth.signOut({ scope: 'local' });
  }
  return NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
}
