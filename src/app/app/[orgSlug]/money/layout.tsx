import { SectionTabs } from '@/components/dashboard/section-tabs';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';

/**
 * The Money section shell (UX_ARCHITECTURE.md §3.2, ROUTE_ARCHITECTURE.md §9).
 *
 * Five tabs in the fixed order §3.2 gives them, then Budget (ADR-142). Banking is absent — not disabled — for a role
 * without `banking.view` (RBAC §5, §7.4).
 */
const TABS = [
  { slug: 'profit-and-loss', label: 'Profit & loss', permission: 'financials.view' },
  { slug: 'cash', label: 'Cash', permission: 'financials.view' },
  { slug: 'banking', label: 'Banking', permission: 'banking.view' },
  { slug: 'receivables', label: 'Owed to you', permission: 'financials.view' },
  { slug: 'payables', label: 'You owe', permission: 'financials.view' },
  { slug: 'budget', label: 'Budget', permission: 'financials.view' },
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
  const visible = TABS.filter((tab) => can(ctx, tab.permission));

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
