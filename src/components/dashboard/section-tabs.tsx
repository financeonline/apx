'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * A section's tabs as a segmented control (ADR-155), as the owner's reference: a white rounded bar,
 * the current tab a solid violet pill. The layout decides which tabs exist (RBAC §5); this marks
 * the current one. A tab is current on its own page; the section's first tab (its overview) only
 * on exactly its page.
 */
export function SectionTabs({ label, tabs }: { label: string; tabs: readonly { label: string; href: string }[] }) {
  const pathname = usePathname() ?? '';
  const overview = tabs[0]?.href;
  const current = tabs
    .filter((t) => (t.href === overview ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;

  return (
    <nav aria-label={label} className="panel mb-8 inline-flex max-w-full flex-wrap gap-1 rounded-2xl p-1.5 text-sm">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === current ? 'page' : undefined}
          className={`rounded-xl px-4 py-2 font-medium transition-colors ${
            tab.href === current
              ? 'bg-accent bg-brand-gradient font-semibold text-on-accent shadow-[0_8px_20px_-10px_rgb(255_45_85/0.7)]'
              : 'text-ink hover:bg-accent-soft hover:text-accent'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
