import { DeniedState } from '@/components/dashboard';

/**
 * HTTP 403 inside a tenant (ROUTE_ARCHITECTURE.md §11, UX_ARCHITECTURE.md §7.4).
 *
 * Reached when a page calls `forbidden()` — the caller is a member of this organisation and may not
 * see this page. Its existence is already known to them, so 403 leaks nothing, and the words say who
 * to ask without saying what is on the page: "you cannot see the audit log" would confirm that this
 * organisation has one and that somebody is reading it.
 *
 * A caller with NO access to the organisation never gets here. That is `notFound()` from the layout,
 * because a 403 there would confirm the organisation exists (SECURITY_MODEL.md §14).
 */
export default function OrgForbidden() {
  return <DeniedState />;
}
