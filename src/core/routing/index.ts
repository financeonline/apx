/**
 * Routing rules shared by the middleware, route handlers and the browser (ROUTE_ARCHITECTURE.md
 * §10). Pure: no I/O, no framework imports.
 */
export { safeNextPath, DEFAULT_NEXT } from './safe-next';
export { SESSION_COOKIE, SESSION_ONLY_COOKIE, SESSION_ALIVE_COOKIE, sessionVisitEnded } from './session-persistence';
