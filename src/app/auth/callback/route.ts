import { NextResponse, type NextRequest } from 'next/server';
import { createCallbackClient } from '@/core/db/user-client';
import { safeNextPath } from '@/core/routing';

/**
 * PKCE code exchange (SECURITY_MODEL.md §3).
 *
 * ROUTE_ARCHITECTURE.md §8.4a: a magic-link exchange is REFUSED for a platform account. Platform
 * users sign in with their password, so the session carries the recent sign-in the sensitive
 * super-admin actions need (ADR-161).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  // Judged by the one rule (ADR-069): parsed as the browser will parse it, kept only on our origin.
  // `startsWith('/') && !startsWith('//')` let `/\evil.com` through (PRODUCTION_AUDIT.md H2).
  const next = safeNextPath(url.searchParams.get('next'), url.origin);

  if (!code) {
    return NextResponse.redirect(new URL('/sign-in?error=missing_code', url.origin));
  }

  const response = NextResponse.redirect(new URL(next, url.origin));
  const supabase = createCallbackClient(
    () => request.cookies.getAll(),
    (name, value, options) => response.cookies.set(name, value, options),
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/sign-in?error=exchange_failed', url.origin));
  }

  // Refuse the magic-link path for platform accounts.
  const { data } = await supabase.schema('api').rpc('my_platform_role');
  const platform = (data as Array<{ status: string }> | null)?.[0];
  const amr = url.searchParams.get('type');
  if (platform?.status === 'active' && amr === 'magiclink') {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/sign-in?error=platform_password_required', url.origin));
  }

  return response;
}
