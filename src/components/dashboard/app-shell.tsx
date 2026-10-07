import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { CornerSprig, SidebarSprig, Wordmark } from './brand';
import { SidebarNav, type SidebarGroup } from './sidebar';

/**
 * The application shell (ADR-155), as the owner's reference: a white sidebar with the mark, the
 * sections and the account links from `lg`; below it, a top bar with a menu. Both carry the same
 * links and the one not in use is display:none, so it is out of the accessibility tree.
 */
export function AppShell({
  homeHref,
  homeLabel = 'MOTION home',
  area,
  groups,
  user,
  footer,
  children,
}: {
  homeHref: string;
  homeLabel?: string;
  /** The area's name under the wordmark when it is not the business app (Command Centre, Platform). */
  area?: string;
  groups: readonly SidebarGroup[];
  /** The signed-in person, as the reference's sidebar shows them. */
  user?: { name: string; role: string; href: string };
  footer?: ReactNode;
  children: ReactNode;
}) {
  // Initials: a name's first two words, or an email's first two letters before the @.
  const initials = !user ? ''
    : user.name.includes('@') ? user.name.slice(0, 2).toUpperCase()
      : user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  const person = user ? (
    <Link href={user.href} className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-accent-soft">
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-brand-ink">
        {initials}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium text-ink">{user.name}</span>
        <span className="block truncate text-xs text-ink-muted">{user.role}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
    </Link>
  ) : null;
  return (
    <div className="min-h-dvh lg:flex">
      <aside className="isolate sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface/80 px-4 pt-6 lg:flex">
        <Link href={homeHref} className="mb-8 px-2" aria-label={homeLabel}>
          <Wordmark />
          {area ? <span className="mt-2 block pl-[3.25rem] text-xs font-semibold tracking-[0.12em] text-ink-muted uppercase">{area}</span> : null}
        </Link>
        <SidebarNav groups={groups} />
        <div className="mt-auto flex flex-col gap-2 pt-6 pb-6">
          {person}
          {footer ? <div className="px-3">{footer}</div> : null}
          <p className="mt-16 px-3 text-sm leading-snug font-medium text-brand-ink/80">
            Smarter finance
            <br />
            brighter possibilities.
          </p>
        </div>
        {/* The reference's foot: a sprig behind the sidebar's last lines. */}
        <SidebarSprig className="absolute bottom-0 left-0 -z-10 w-full opacity-60" />
      </aside>

      <header className="panel sticky top-0 z-20 flex items-center justify-between gap-3 border-x-0 border-t-0 px-4 py-3 lg:hidden">
        <Link href={homeHref} aria-label={homeLabel}><Wordmark tagline={false} /></Link>
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-xl border border-accent/45 px-3 py-1.5 text-sm font-medium text-accent">
            Menu
          </summary>
          <div className="panel absolute right-0 z-30 mt-2 max-h-[80dvh] w-64 overflow-y-auto rounded-card p-3">
            <SidebarNav groups={groups} />
            {person ? <div className="mt-4">{person}</div> : null}
            {footer ? <div className="mt-2 px-3">{footer}</div> : null}
          </div>
        </details>
      </header>

      <CornerSprig className="fixed top-0 right-0 -z-10 hidden w-[34rem] max-w-[55vw] opacity-80 md:block xl:right-24" />

      <main className="mx-auto w-full min-w-0 max-w-[100rem] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
