import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/core/db/user-client';
import { recordAccessEvent } from '@/core/db/server-rpc';
import { newRequestId } from '@/core/logging';
import { openSession, sessionCookieOptions } from '@/modules/tenancy';
import { originOf } from '@/app/_lib/request-origin';

/**
 * Opens a session (SECURITY_MODEL.md §3). The sign-in and sign-up forms POST the Firebase ID token
 * the browser just received, with the "Keep me signed in" choice; this verifies it, makes sure the
 * account has its profile, refuses a disabled account, and sets the httpOnly `__session` cookie —
 * fourteen days when the person asked to stay signed in, otherwise a browser-session cookie (the
 * SESSION_ONLY_COOKIE rule in `core/routing` still ends it on a later visit). The sign-in is
 * recorded (`auth.sign_in`).
 *
 * Same-origin only: a cross-site form cannot plant a session (the body is JSON, and the Origin must
 * match).
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  const origin = request.headers.get('origin');
  // The public origin from the forwarded headers, not `nextUrl.origin`: behind Netlify's proxy the
  // latter is an internal address and every sign-in answered "Not found" (2026-11-02, ADR-183).
  if (origin && origin !== originOf(request.headers)) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found', requestId } }, { status: 404 });
  }
  let body: { idToken?: unknown; keepSignedIn?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  if (typeof body.idToken !== 'string' || body.idToken.length === 0) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Sign in again.', requestId } }, { status: 400 });
  }

  const session = await openSession(body.idToken);
  if (!session.ok) {
    if (session.uid) {
      try {
        await recordAccessEvent({ userId: session.uid, requestId }, { organizationId: null, action: 'auth.failed' });
      } catch {
        // The refusal stands whether or not it could be logged.
      }
    }
    const message = session.reason === 'disabled'
      ? 'This account has been switched off. Ask your administrator.'
      : session.reason === 'unverified'
        ? 'Confirm your email address first — check your inbox for the link we sent.'
        : 'Sign in again.';
    return NextResponse.json({ error: { code: session.reason === 'invalid' ? 'VALIDATION' : 'PERMISSION_DENIED', reason: session.reason, message, requestId } }, { status: session.reason === 'invalid' ? 401 : 403 });
  }

  try {
    await recordAccessEvent({ userId: session.uid, requestId }, { organizationId: null, action: 'auth.sign_in' });
  } catch {
    // A sign-in is never refused because the log could not be written.
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, session.cookie, sessionCookieOptions(body.keepSignedIn === true));
  response.headers.set('x-request-id', requestId);
  return response;
}
