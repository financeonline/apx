/**
 * The one place a `next` target is judged (ROUTE_ARCHITECTURE.md §10; SECURITY_MODEL.md §3;
 * ADR-069; PRODUCTION_AUDIT.md H2).
 *
 * Three call sites — the PKCE callback, the sign-in form and the middleware — each used to decide
 * for themselves whether a `next` parameter was "a relative path": `startsWith('/') &&
 * !startsWith('//')`. WHATWG URL parsing treats a backslash as a slash in special schemes, so
 * `/\evil.com` passed the test and `new URL('/\\evil.com', origin)` resolved to `https://evil.com/`
 * — a redirect off the product's own domain, immediately after authentication.
 *
 * The rule here is the only defensible one: parse the candidate exactly as the browser will, and
 * keep it only if the result lives on OUR origin. Then re-check the shape of what comes back, because
 * a path that begins `//` (which `/./\evil.com` normalises to) would resolve off-origin again the
 * moment somebody passed it to `new URL()` a second time.
 *
 * Pure and dependency-free: it runs in the Edge middleware, in a route handler and in the browser.
 */

/** Where a rejected or absent target goes. */
export const DEFAULT_NEXT = '/';

/**
 * Returns `candidate` as a path on `origin`, or `/`.
 *
 * `origin` is the origin the redirect will be issued against (`request.nextUrl.origin`,
 * `url.origin`, `window.location.origin`), and the result is safe to pass to `new URL(result,
 * origin)`, `NextResponse.redirect` or `router.push` without further checks.
 */
export function safeNextPath(candidate: string | null | undefined, origin: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return DEFAULT_NEXT;
  // A target that does not begin with exactly one forward slash is not a relative path at all —
  // absolute URLs, protocol-relative `//host`, and the backslash forms are all refused here before
  // parsing has a chance to normalise them into something that looks acceptable.
  if (candidate.charAt(0) !== '/' || candidate.charAt(1) === '/' || candidate.charAt(1) === '\\') {
    return DEFAULT_NEXT;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate, origin);
  } catch {
    return DEFAULT_NEXT;
  }
  if (parsed.origin !== origin) return DEFAULT_NEXT;

  // What the parser handed back must itself be a single-slash path: `//x` would be read as an
  // authority by the next parser to see it.
  const path = `${parsed.pathname}${parsed.search}`;
  if (path.charAt(0) !== '/' || path.charAt(1) === '/') return DEFAULT_NEXT;
  // The `/auth/*` handlers are actions (sign out, open a session, email links), not places to go
  // back to after signing in: a GET there is refused or repeats the action (2026-11-03: HTTP 405).
  if (parsed.pathname === '/auth' || parsed.pathname.startsWith('/auth/')) return DEFAULT_NEXT;
  return path;
}
