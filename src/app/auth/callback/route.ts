import { NextResponse, type NextRequest } from 'next/server';
import { safeNextPath } from '@/core/routing';
import { applyEmailVerification } from '@/modules/tenancy';

/**
 * Firebase Authentication's email-action handler (SECURITY_MODEL.md §3). The Firebase project's
 * "Customize action URL" points here, so every emailed link lands on APX rather than on Firebase's
 * hosted page:
 *
 *  - `mode=resetPassword`: on to `/reset-password` with the one-time code, where the person chooses
 *    the new password (`confirmPasswordReset` in the browser);
 *  - `mode=verifyEmail`: the code is applied here, then on to sign in;
 *  - anything else, or no code: sign in, with the error the page explains.
 *
 * There is no session exchange any more: email and password sign-in hands the ID token to
 * `/auth/session` directly (the Supabase PKCE exchange this route did is gone).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  const code = url.searchParams.get('oobCode');
  if (!code) return NextResponse.redirect(new URL('/sign-in?error=missing_code', url.origin));

  if (mode === 'resetPassword') {
    const target = new URL('/reset-password', url.origin);
    target.searchParams.set('oobCode', code);
    return NextResponse.redirect(target);
  }
  if (mode === 'verifyEmail') {
    const ok = await applyEmailVerification(code);
    const target = new URL(ok ? '/sign-in?verified=1' : '/sign-in?error=exchange_failed', url.origin);
    // The sign-up form asked for `/sign-in?next=…` as the continue URL; the target is judged by the
    // one rule (ADR-069) before it is passed on.
    const continueUrl = url.searchParams.get('continueUrl');
    let wanted: string | null = null;
    try {
      wanted = continueUrl ? new URL(continueUrl).searchParams.get('next') : null;
    } catch {
      wanted = null;
    }
    if (ok && wanted) target.searchParams.set('next', safeNextPath(wanted, url.origin));
    return NextResponse.redirect(target);
  }
  return NextResponse.redirect(new URL('/sign-in?error=exchange_failed', url.origin));
}
