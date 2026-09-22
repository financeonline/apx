import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';

/**
 * The Money section shell (UX_ARCHITECTURE.md §3.2, ROUTE_ARCHITECTURE.md §9).
 *
 * Five tabs in the fixed order §3.2 gives them. Banking is absent — not disabled — for a role
 * without `banking.view` (RBAC §5, §7.4).
 */
const TABS = [
  { slug: 'profit-and-loss', label: 'Profit & loss', permission: 'financials.view' },
  { slug: 'cash', label: 'Cash', permission: 'financials.view' },
  { slug: 'banking', label: 'Banking', permission: 'banking.view' },
  { slug: 'receivables', label: 'Owed to you', permission: 'financials.view' },
  { slug: 'payables', label: 'You owe', permission: 'financials.view' },
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
      <nav aria-label="Money" className="mb-8 flex flex-wrap gap-4 border-b border-line pb-3 text-sm">
        <Link href={`/app/${orgSlug}/money`} className="text-ink-muted hover:text-ink">
          Overview
        </Link>
        {visible.map((tab) => (
          <Link
            key={tab.slug}
            href={`/app/${orgSlug}/money/${tab.slug}`}
            className="text-ink-muted hover:text-ink"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
