import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';

/**
 * The Commercial section shell (Phase 14, ADR-102; UX_ARCHITECTURE.md §3.2).
 *
 * Four tabs under the primary "Customers" item — the seven-item primary navigation is not widened.
 * Every tab needs only `customers.view`, which every role holds, so nothing here is hidden per role;
 * what a role may CHANGE is decided on each page (`customers.edit`).
 */
const TABS = [
  { slug: '', label: 'Customers' },
  { slug: 'products', label: 'Products' },
  { slug: 'sales', label: 'Sales' },
  { slug: 'marketing', label: 'Marketing' },
  // D-5: names held for a decision after the Unicode identity change.
  { slug: 'held', label: 'Name decisions' },
] as const;

export default async function CommercialLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  await getAccessContext(orgSlug);
  return (
    <>
      <nav aria-label="Commercial" className="mb-8 flex flex-wrap gap-4 border-b border-line pb-3 text-sm">
        {TABS.map((tab) => (
          <Link key={tab.slug} href={`/app/${orgSlug}/customers${tab.slug ? `/${tab.slug}` : ''}`} className="text-ink-muted hover:text-ink">
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
