import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { SESSION_ONLY_COOKIE, safeNextPath, sessionVisitEnded } from '@/core/routing';

/**
 * Route-family gatekeeper (ROUTE_ARCHITECTURE.md §8).
 *
 * What middleware does: refresh the session cookie, classify the path, and decide which of the
 * three families the request may enter. What it deliberately does NOT do: resolve organisation
 * access. That needs the database and must return a uniform 404, so it happens in
 * `app/[orgSlug]/layout.tsx` through `getAccessContext()` (§8.7). Middleware never widens access —
 * every rule below is also enforced by RLS and by the `api.*` functions.
 *
 * A user who may not enter a family gets 404, never 403: a 403 would confirm the family exists for
 * somebody (SECURITY_MODEL.md §14).
 */

const PUBLIC_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/legal',
  '/auth/callback',
  '/api/health',
  /*
   * The cron routes authenticate themselves — a constant-time compare of `CRON_SECRET`, 404
   * otherwise — and their caller is Vercel Cron, which has no session. Requiring one here sent
   * every scheduled drain to the sign-in page instead: the queue would never have run in
   * production (ADR-078).
   */
  '/api/jobs',
] as const;

type Family = 'public' | 'auth-noorg' | 'app' | 'portfolio' | 'platform';

function classify(pathname: string): Family {
  if (pathname === '/') return 'public';
  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return 'public';
  }
  if (pathname === '/platform' || pathname.startsWith('/platform/')) return 'platform';
  if (pathname === '/portfolio' || pathname.startsWith('/portfolio/')) return 'portfolio';
  if (pathname.startsWith('/app/')) return 'app';
  return 'auth-noorg';
}

/** Only same-origin relative paths survive as a `next` target (§10, ADR-069) — one rule, one place. */
function relativeTarget(request: NextRequest): string {
  const { pathname, search, origin } = request.nextUrl;
  return safeNextPath(`${pathname}${search}`, origin);
}

interface PlatformRoleRow {
  platform_role: string;
  status: string;
}

interface ProfileRow {
  disabled: boolean;
}

export async function middleware(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    // Without Supabase configured nothing can be authorised, so nothing is served: the comment here
    // used to say "fail closed" above a `return response` that let every request through to the
    // layouts (PRODUCTION_AUDIT.md L1; ADR-075). 503, and the request id, and nothing else.
    return new NextResponse('Service unavailable', {
      status: 503,
      headers: { 'x-request-id': requestId, 'retry-after': '60' },
    });
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  /** Every early return must carry the refreshed cookies and the request id forward. */
  const finish = (target?: URL, rewrite = false): NextResponse => {
    const outgoing = target
      ? rewrite
        ? NextResponse.rewrite(target, { request: { headers: requestHeaders } })
        : NextResponse.redirect(target)
      : response;
    if (target) {
      for (const cookie of response.cookies.getAll()) outgoing.cookies.set(cookie);
    }
    outgoing.headers.set('x-request-id', requestId);
    return outgoing;
  };

  const url = request.nextUrl;
  const family = classify(url.pathname);

  // The health check is public and must not depend on Auth being reachable.
  if (url.pathname === '/api/health') return finish();

  // 1. Refresh the session (this is what writes the rotated cookies through setAll above).
  let {
    data: { user },
  } = await supabase.auth.getUser();

  // 1a. "Keep me signed in" was left unticked and this is a later visit: end the session here,
  //     then treat the request as signed out (ADR-169).
  if (user && sessionVisitEnded(request.cookies)) {
    await supabase.auth.signOut({ scope: 'local' });
    response.cookies.set(SESSION_ONLY_COOKIE, '', { path: '/', maxAge: 0 });
    user = null;
  }

  // 2. No session: public passes, everything else goes to sign-in with a relative `next`.
  if (!user) {
    if (family === 'public') return finish();
    /*
     * An API route answers 401, never a redirect (ROUTE_ARCHITECTURE.md §237): its caller is a
     * fetch, not a person, and a redirect to the sign-in page would be followed into a 405 from a
     * page that has no POST. The cron routes keep their own 404 — they are matched as public and
     * decide for themselves.
     */
    if (url.pathname.startsWith('/api/')) {
      const denied = NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Sign in to continue.', requestId } },
        { status: 401 },
      );
      for (const cookie of response.cookies.getAll()) denied.cookies.set(cookie);
      denied.headers.set('x-request-id', requestId);
      return denied;
    }
    const signIn = new URL('/sign-in', url.origin);
    signIn.searchParams.set('next', relativeTarget(request));
    return finish(signIn);
  }

  // Signed-in users never see the sign-in and sign-up pages.
  if (url.pathname === '/sign-in' || url.pathname === '/sign-up') {
    return finish(new URL('/', url.origin));
  }

  // Public pages other than `/` need no further checks; skip the two round trips.
  if (family === 'public' && url.pathname !== '/') return finish();

  // 3. One pass for the two facts every later rule needs (§8.4, §8.5).
  const [profileResult, platformResult] = await Promise.all([
    supabase.schema('api').rpc('my_profile'),
    supabase.schema('api').rpc('my_platform_role'),
  ]);

  const profile = (profileResult.data as ProfileRow[] | null)?.[0];
  const platform = (platformResult.data as PlatformRoleRow[] | null)?.[0];

  // 4. A disabled account is signed out on its next request, whatever it was asking for.
  if (profile?.disabled) {
    await supabase.auth.signOut();
    const signIn = new URL('/sign-in', url.origin);
    signIn.searchParams.set('error', 'disabled');
    return finish(signIn);
  }

  const isPlatformAccount = Boolean(platform);
  const isActiveSuperAdmin =
    platform?.platform_role === 'super_admin' && platform.status === 'active';
  const isActivePlatformAccount = isPlatformAccount && platform?.status === 'active';

  // 5. Family membership. Anything not permitted renders the uniform 404 at the requested URL.
  const notFound = new URL('/404', url.origin);

  if (family === 'platform' && !isActiveSuperAdmin) return finish(notFound, true);
  /*
   * `/portfolio` is the Command Centre for every adviser-capable role, member or platform account
   * (ADR-112). Which organisations, if any, a session may advise needs the database, so the
   * portfolio layout decides and renders the uniform 404 for a caller with none — a client-only
   * member, a stranger, an unassigned employee. Middleware keeps only the session checks above.
   */

  // 6. `/` with a session goes to the family the account belongs to. A stale or foreign
  //    last_active_org_id is never resolved to a slug (§8.6) — /select-organization decides.
  if (url.pathname === '/') {
    if (isActiveSuperAdmin) return finish(new URL('/platform', url.origin));
    if (isActivePlatformAccount) return finish(new URL('/portfolio', url.origin));
    return finish(new URL('/select-organization', url.origin));
  }

  // Platform accounts are never members of a customer organisation, so the no-org pages that
  // exist to pick or create one belong to their own family instead (§8.5).
  if (isActivePlatformAccount && (url.pathname === '/select-organization' || url.pathname === '/onboarding')) {
    return finish(new URL(isActiveSuperAdmin ? '/platform' : '/portfolio', url.origin));
  }

  // 7. `/app/[orgSlug]/*` is resolved by the org layout, which owns the uniform 404.
  return finish();
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own static output and file requests. Middleware must see every
     * page and route handler so the session cookie is refreshed on each of them.
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
};
