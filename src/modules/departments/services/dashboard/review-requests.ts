import 'server-only';
import { can } from '@/core/permissions';
import { listEngagementItems, type EngagementItemView } from '@/modules/engagement';
import type { AccessContext } from '@/modules/tenancy';

/**
 * The engagement items (ADR-144) the department dashboard reads: review requests
 * ("Review requested: <title>"), recorded client reviews ("Client review: <name>") and, for Client
 * Management, the requests themselves. Engagement is read under `actions.view`; a reader without
 * it gets no items, so nothing reads as requested (rather than an error).
 */
export async function engagementItemsFor(ctx: AccessContext): Promise<readonly EngagementItemView[] | null> {
  return can(ctx, 'actions.view') ? listEngagementItems(ctx) : null;
}

/** The titles of the items, for "is there already a request for this?". */
export function titleSet(items: readonly EngagementItemView[] | null): ReadonlySet<string> {
  return new Set((items ?? []).map((item) => item.title.trim()));
}

/** The engagement item title a dashboard review request is saved under. */
export const reviewRequestTitle = (title: string) => `Review requested: ${title}`;
/** The engagement item title a recorded client review is saved under. */
export const clientReviewTitle = (name: string) => `Client review: ${name}`;
