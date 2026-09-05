import { NextResponse, type NextRequest } from 'next/server';
import { createCallbackClient } from '@/core/db/user-client';

/**
 * PKCE code exchange (SECURITY_MODEL.md §3).
 *
 * ROUTE_ARCHITECTURE.md §8.4a: a magic-link exchange is REFUSED for a platform account. Platform
 * users sign in with a password and an authenticator code, because their session must be able to
 * reach aal2 — and app.is_platform_user() grants nothing below it (ADR-044.1).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const nextParam = url.searchParams.get('next');
  const next = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

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
