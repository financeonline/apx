import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { hasScenario, loadScenario } from '@/modules/scenarios';
import { PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { ScenarioComparison } from '../comparison';
import { ArchiveControl } from '../archive-control';

export const dynamic = 'force-dynamic';

/**
 * One saved scenario, reopened (§13).
 *
 * What it shows is what it showed when it was saved: both figures of every cell are stored rows, so
 * regenerating the forecast underneath cannot rewrite the answer. If the forecast HAS moved on, the
 * comparison says so at the top and offers a new one — it never silently updates.
 *
 * An id from another organisation is `notFound()`, not a denial: confirming that a scenario exists
 * elsewhere would be a leak in itself (SECURITY_MODEL.md §14).
 */
export default async function SavedScenarioPage({
  params,
}: {
  params: Promise<{ orgSlug: string; scenarioId: string }>;
}) {
  const { orgSlug, scenarioId } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'dashboard.view');

  const scenario = await loadScenario(ctx, scenarioId);
  if (!hasScenario(scenario)) notFound();

  return (
    <>
      <PageHeader
        eyebrow="What if"
        title={scenario.name}
        description={scenario.archivedAt === null ? undefined : 'Put away'}
      />
      <p className="mt-2 text-sm">
        <Link href={`/app/${orgSlug}/what-if`} className="text-accent underline underline-offset-2">
          Back to what-if
        </Link>
      </p>

      <ScenarioComparison scenario={scenario} orgSlug={orgSlug} />

      {can(ctx, 'intelligence.recompute') ? (
        <div className="mt-6">
          <ArchiveControl
            orgSlug={orgSlug}
            scenarioId={scenario.runId}
            archived={scenario.archivedAt !== null}
          />
        </div>
      ) : null}
    </>
  );
}
