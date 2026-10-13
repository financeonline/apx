/**
 * "Keep me signed in" (ADR-169). Supabase keeps a session in long-lived cookies, so by default a
 * sign-in survives closing the browser. When the box is NOT ticked, the sign-in form sets two
 * cookies: a lasting marker that this session is for this visit only, and a session cookie (no
 * expiry) that the browser drops when it closes. A request that carries the marker without the
 * session cookie is from a later visit, and the middleware signs it out.
 *
 * Browsers that restore the previous session on start-up also restore session cookies, so there the
 * session survives a restart; that is the browser's choice, as for every site.
 */
export const SESSION_ONLY_COOKIE = 'apx_session_only';
export const SESSION_ALIVE_COOKIE = 'apx_alive';

/** True when the sign-in asked to end with the visit and this request is from a later visit. */
export function sessionVisitEnded(cookies: { has(name: string): boolean }): boolean {
  return cookies.has(SESSION_ONLY_COOKIE) && !cookies.has(SESSION_ALIVE_COOKIE);
}
