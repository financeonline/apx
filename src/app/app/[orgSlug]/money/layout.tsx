import { SectionTabs } from '@/components/dashboard/section-tabs';
import { getAccessContext, moduleOn } from '@/modules/tenancy';
import { can } from '@/core/permissions';

/**
 * The Money section shell (UX_ARCHITECTURE.md §3.2, ROUTE_ARCHITECTURE.md §9).
 *
 * Five tabs in the fixed order §3.2 gives them, then Budget (ADR-142), Balance sheet and Tax (ADR-156). Banking is absent — not disabled — for a role
 * without `banking.view` (RBAC §5, §7.4).
 */
const TABS = [
  { slug: 'profit-and-loss', label: 'Profit & loss', permission: 'financials.view' },
  { slug: 'cash', label: 'Cash', permission: 'financials.view' },
  { slug: 'banking', label: 'Banking', permission: 'banking.view', module: 'banking' },
  { slug: 'receivables', label: 'Owed to you', permission: 'financials.view' },
  { slug: 'payables', label: 'You owe', permission: 'financials.view' },
  { slug: 'budget', label: 'Budget', permission: 'financials.view', module: 'planning' },
  // ADR-156: assets and loans from the balance statement; VAT and Corporation Tax.
  { slug: 'balance-sheet', label: 'Balance sheet', permission: 'financials.view', module: 'tax' },
  { slug: 'tax', label: 'Tax', permission: 'financials.view', module: 'tax' },
] as const;

export default async function MoneyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  // ADR-158: a tab of a switched-off system is absent.
  const visible = TABS.filter((tab) => can(ctx, tab.permission) && (!('module' in tab) || moduleOn(ctx, tab.module)));

  return (
    <>
      <SectionTabs
        label="Money"
        tabs={[
          { label: 'Overview', href: `/app/${orgSlug}/money` },
          ...visible.map((tab) => ({ label: tab.label, href: `/app/${orgSlug}/money/${tab.slug}` })),
        ]}
      />
      {children}
    </>
  );
}
