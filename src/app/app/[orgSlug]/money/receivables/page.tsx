import { getAccessContext } from '@/modules/tenancy';
import { loadLedgerBook, loadPeriodScope } from '@/modules/dashboard';
import { LedgerBookPage, LedgerBookEmpty } from '../_components/ledger-book';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

const TITLE = 'Owed to you';

/** ROUTE_ARCHITECTURE.md §4: aging, overdue and days for one month, with the invoices behind them. */
export default async function ReceivablesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);
  if (!scope) return <LedgerBookEmpty orgSlug={orgSlug} title={TITLE} />;

  const view = await loadLedgerBook(
    ctx.db, ctx.orgId!, orgSlug, scope, 'receivables',
    // Aging is measured against today, injected rather than read from an ambient clock (ADR-030.5).
    ctx.now().toISOString().slice(0, 10),
    ctx.requestId,
  );

  return (
    <LedgerBookPage
      orgSlug={orgSlug}
      title={TITLE}
      description="What your customers still owe you, and how much of it is late."
      route="receivables"
      view={view}
    />
  );
}
