import { ForbiddenView } from '@/components/dashboard/access-links';

/**
 * HTTP 403 inside a tenant (ROUTE_ARCHITECTURE.md §11, UX_ARCHITECTURE.md §7.4).
 *
 * Reached when a page calls `forbidden()` — the caller is a member of this organisation and may not
 * see this page. Its existence is already known to them, so 403 leaks nothing, and the words say who
 * to ask without saying what is on the page: "you cannot see the audit log" would confirm that this
 * organisation has one and that somebody is reading it.
 *
 * ADR-172: a member who may ask for more access (a 3rd party, a client, an accountant, an admin) is
 * offered "Request more information" here, and anyone holding the overview a way back to Home. The
 * two links come from the org layout (`AccessLinksProvider`), because this file receives no props.
 *
 * A caller with NO access to the organisation never gets here. That is `notFound()` from the layout,
 * because a 403 there would confirm the organisation exists (SECURITY_MODEL.md §14).
 */
export default function OrgForbidden() {
  return <ForbiddenView />;
}
