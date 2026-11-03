import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_ALIVE_COOKIE, SESSION_COOKIE, SESSION_ONLY_COOKIE, safeNextPath, sessionVisitEnded,
} from '@/core/routing';

/**
 * Route-family gatekeeper (ROUTE_ARCHITECTURE.md §8), edge-safe (ADR-183).
 *
 * Netlify runs Next's proxy (formerly middleware) at its edge, where Firebase's server library
 * cannot load, so this file imports nothing but `next/server` and the pure routing rules. It does
 * what a cookie alone can tell it: give the request an id, end a session whose cookie has expired or
 * whose visit is over, send a signed-out visitor to sign-in (an API caller gets 401), and let the
 * public paths through. Everything that needs the database happened here once and now happens in
 * the pages that already re-check it, with the session verified properly there (revocation
 * included): `/` sends an account to its own home (`src/app/page.tsx`), sign-in and sign-up bounce
 * a signed-in visitor, the platform and company layouts answer the uniform 404, the no-org pages
 * send platform accounts away, and `createUserClient` treats a disabled account as signed out.
 *
 * The proxy never widens access — every rule is also enforced by `src/db/rls.ts` and the `api.*`
 * functions. A user who may not enter a family gets 404, never 403 (SECURITY_MODEL.md §14).
 */

const PUBLIC_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/legal',
  // Firebase's email-action handler (password reset, email confirmation).
  '/auth/callback',
  // Where the sign-in form hands over the ID token; it verifies the token itself.
  '/auth/session',
  // Sign out must always run (it clears the cookies whatever their state) and must never become a
  // sign-in's "go back to" target: that sent an analyst to GET /auth/sign-out → HTTP 405 after
  // logging in (owner, 2026-11-03).
  '/auth/sign-out',
  '/api/health',
  /*
   * The cron routes authenticate themselves — a constant-time compare of `CRON_SECRET`, 404
   * otherwise — and their caller is a scheduler, which has no session. Requiring one here sent
   * every scheduled drain to the sign-in page instead: the queue would never have run in
   * production (ADR-078).
   */
  '/api/jobs',
] as const;

function isPublic(pathname: string): boolean {
  if (pathname === '/') return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Only same-origin relative paths survive as a `next` target (§10, ADR-069) — one rule, one place. */
function relativeTarget(request: NextRequest): string {
  const { pathname, search, origin } = request.nextUrl;
  return safeNextPath(`${pathname}${search}`, origin);
}

/**
 * Whether the session cookie is a token that has not expired. This reads the token's own `exp`
 * claim and checks NO signature: the server verifies the cookie, with revocation, on every page
 * and route (`createUserClient`). A forged or revoked cookie passes here and is `anon` there, so
 * it buys nothing; an expired or malformed one is cleared here instead of being re-verified forever.
 */
function tokenUnexpired(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as { exp?: unknown };
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

/** Clears every cookie a session consists of. */
function clearSession(response: NextResponse): void {
  for (const name of [SESSION_COOKIE, SESSION_ONLY_COOKIE, SESSION_ALIVE_COOKIE]) {
    response.cookies.set(name, '', { path: '/', maxAge: 0 });
  }
}

export function proxy(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);
  const url = request.nextUrl;

  /** Set when this request ends the session: every response below then clears its cookies. */
  let endSession = false;
  const finish = (response: NextResponse): NextResponse => {
    if (endSession) clearSession(response);
    response.headers.set('x-request-id', requestId);
    return response;
  };
  const pass = () => finish(NextResponse.next({ request: { headers: requestHeaders } }));

  // The health check is public and must not depend on anything.
  if (url.pathname === '/api/health') return pass();

  // 1. The session cookie: present and unexpired, or no session. A stale cookie is cleared.
  //    (Not on `/auth/session`, which is about to set a new one.)
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  let signedIn = tokenUnexpired(token);
  if (token && !signedIn && url.pathname !== '/auth/session') endSession = true;

  // 1a. "Keep me signed in" was left unticked and this is a later visit: end the session here,
  //     then treat the request as signed out (ADR-169).
  if (signedIn && sessionVisitEnded(request.cookies)) {
    endSession = true;
    signedIn = false;
  }

  // 2. No session: public passes, everything else goes to sign-in with a relative `next`.
  if (!signedIn) {
    if (isPublic(url.pathname)) return pass();
    /*
     * An API route answers 401, never a redirect (ROUTE_ARCHITECTURE.md §237): its caller is a
     * fetch, not a person, and a redirect to the sign-in page would be followed into a 405 from a
     * page that has no POST. The cron routes keep their own 404 — they are matched as public and
     * decide for themselves.
     */
    if (url.pathname.startsWith('/api/')) {
      return finish(NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Sign in to continue.', requestId } },
        { status: 401 },
      ));
    }
    const signIn = new URL('/sign-in', url.origin);
    signIn.searchParams.set('next', relativeTarget(request));
    return finish(NextResponse.redirect(signIn));
  }

  // 3. A session: the page decides the rest, with the cookie verified properly there.
  return pass();
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own static output, file requests and Netlify's own function paths.
     * The proxy must see every page and route handler so an ended session is cleared on each of
     * them. `ocr/` is the in-browser OCR engine and language file (ADR-175): static, public, and
     * several MB each. `.netlify/` is where the host serves the job worker and its timers (ADR-183):
     * matched here, the worker's call was sent to the sign-in page and the queue never drained.
     */
    '/((?!_next/static|_next/image|\\.netlify/|ocr/|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|webm|ico|woff2?)$).*)',
  ],
};
