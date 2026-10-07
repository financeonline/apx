import 'server-only';
import { forbidden, notFound } from 'next/navigation';
import { moduleOn, type AccessContext, type ModuleKey } from '@/modules/tenancy';
import { can, type AuthzContext, type Permission } from '@/core/permissions';

/**
 * The page-layer twin of `assertCan` (ROUTE_ARCHITECTURE.md §11, UX_ARCHITECTURE.md §7.4; ADR-091).
 *
 * `assertCan` throws `PermissionDenied`, which is right for a service and for an API route — the
 * route handlers map it to 403 with a plain message. On a PAGE it was wrong twice over: nothing
 * caught it, so the error boundary rendered "Something went wrong on our side" with a support
 * reference, telling a reader their permission boundary was a MOTION outage, and the response
 * carried a 500. Pages that instead wrote `if (!can(…)) notFound()` answered 404 where §11 asks for
 * 403.
 *
 * `forbidden()` renders `app/[orgSlug]/forbidden.tsx` — the §7.4 denied state — with HTTP 403.
 *
 * **403, not 404, and only here.** The caller has already resolved a role for this organisation, so
 * its existence is known to them and 403 discloses nothing (§11's own footnote). A caller with no
 * access never reaches this: the layout answers `notFound()` first, because a 403 there would
 * confirm the organisation exists (SECURITY_MODEL.md §14). The same goes for a resource id from
 * another organisation, which stays 404 wherever it is resolved.
 */
export function requirePermission(ctx: AuthzContext, permission: Permission): void {
  if (!can(ctx, permission)) forbidden();
}

/**
 * ADR-158: a page of a system the super admin has switched off for this organisation answers 404 —
 * the system is absent for this company, not forbidden to this person.
 */
export function requireModulePage(ctx: AccessContext, key: ModuleKey): void {
  if (!moduleOn(ctx, key)) notFound();
}
