import Link from 'next/link';
import type { ReactNode } from 'react';
import { Petals, Wordmark } from './brand';
import { SidebarNav, type SidebarGroup } from './sidebar';

/**
 * The application shell (ADR-155), as the owner's reference: a white sidebar with the mark, the
 * sections and the account links from `lg`; below it, a top bar with a menu. Both carry the same
 * links and the one not in use is display:none, so it is out of the accessibility tree.
 */
export function AppShell({
  homeHref,
  homeLabel = 'MOTION home',
  tagline = 'Financial intelligence',
  groups,
  footer,
  children,
}: {
  homeHref: string;
  homeLabel?: string;
  tagline?: string;
  groups: readonly SidebarGroup[];
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:flex">
      <aside className="isolate sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface/80 px-4 py-6 lg:flex">
        <Link href={homeHref} className="mb-8 px-2" aria-label={homeLabel}>
          <Wordmark tagline={tagline} />
        </Link>
        <SidebarNav groups={groups} />
        {footer ? <div className="mt-auto px-3 pt-6">{footer}</div> : null}
        <Petals className="absolute bottom-0 left-0 -z-10 w-40 opacity-40" />
      </aside>

      <header className="panel sticky top-0 z-20 flex items-center justify-between gap-3 border-x-0 border-t-0 px-4 py-3 lg:hidden">
        <Link href={homeHref} aria-label={homeLabel}><Wordmark tagline={null} /></Link>
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-xl border border-accent/45 px-3 py-1.5 text-sm font-medium text-accent">
            Menu
          </summary>
          <div className="panel absolute right-0 z-30 mt-2 max-h-[80dvh] w-64 overflow-y-auto rounded-card p-3">
            <SidebarNav groups={groups} />
            {footer ? <div className="mt-4 px-3">{footer}</div> : null}
          </div>
        </details>
      </header>

      <Petals className="fixed top-0 right-0 -z-10 hidden w-[26rem] max-w-[45vw] md:block" />

      <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:px-8 lg:px-10 lg:py-10">{children}</main>
    </div>
  );
}
