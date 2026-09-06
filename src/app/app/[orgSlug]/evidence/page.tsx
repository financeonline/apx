import { notFound, redirect } from 'next/navigation';
import { can } from '@/core/permissions';
import { buildBundleForMetric, currentSnapshotId } from '@/modules/evidence';
import { getAccessContext } from '@/modules/tenancy';

export const dynamic = 'force-dynamic';

/**
 * The "Why?" link every figure carries (`UX_ARCHITECTURE.md` §4, EVIDENCE_MODEL.md §6).
 *
 * A card is rendered from `metric_current`, so its link says which METRIC and which MONTH, never a
 * snapshot id: a link with an id in it would go stale the next time the figures were recalculated,
 * and "Why?" would open last month's answer. This resolves the pointer at the moment the link is
 * followed, materialises the bundle if nobody has opened that figure before, and redirects to the
 * bundle's own deep-linkable page — so what lands in history and in a shared link is the immutable
 * bundle, which is the thing that must never change.
 */
export default async function EvidenceEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ metric?: string; period?: string; dimension?: string; snapshot?: string }>;
}) {
  const { orgSlug } = await params;
  const { metric, period, dimension, snapshot } = await searchParams;

  const ctx = await getAccessContext(orgSlug);
  if (!can(ctx, 'financials.view')) notFound();
  /*
   * `?snapshot=` is how the drawer descends into a component (§6 level 2, "a link to its own
   * snapshot"). It names an id because a component IS one specific figure — the one this
   * calculation used — and resolving it through the current pointer would open a different figure
   * from the one being explained.
   */
  if (snapshot) {
    redirect(`/app/${orgSlug}/evidence/${await buildBundleForMetric(ctx, snapshot)}`);
  }

  if (!metric || !period) notFound();

  const snapshotId = await currentSnapshotId(ctx, {
    metricKey: metric,
    periodId: period,
    ...(dimension ? { dimensionType: 'counterparty', dimensionId: dimension } : {}),
  });
  // No snapshot for that metric and month is NOT FOUND, not an empty drawer: there is no evidence
  // because there is no figure, and an empty panel would suggest the evidence had been lost.
  if (snapshotId === null) notFound();

  redirect(`/app/${orgSlug}/evidence/${await buildBundleForMetric(ctx, snapshotId)}`);
}
