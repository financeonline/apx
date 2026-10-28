import { getAccessContext } from '@/modules/tenancy';
import { loadLedgerBook, loadPeriodScope } from '@/modules/dashboard';
import { LedgerBookPage, LedgerBookEmpty } from '../_components/ledger-book';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

const TITLE = 'You owe';

/** ROUTE_ARCHITECTURE.md §4: aging, overdue and days for one month, with the invoices behind them. */
export default async function PayablesPage({
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
    ctx.db, ctx.orgId!, orgSlug, scope, 'payables',
    // Aging is measured against today, injected rather than read from an ambient clock (ADR-030.5).
    ctx.now().toISOString().slice(0, 10),
    ctx.requestId,
  );

  return (
    <LedgerBookPage
      orgSlug={orgSlug}
      title={TITLE}
      description="Who do you still need to pay, and is any of it late?"
      route="payables"
      view={view}
    />
  );
}
