import Link from 'next/link';
import { cookies } from 'next/headers';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { CornerBlob, Wordmark } from './brand';
import { SidebarNav, type SidebarGroup } from './sidebar';
import { NAV_COOKIE } from './nav-cookie';
import { ShellFrame } from './shell-frame';
import { SignOutButton } from './sign-out-button';

/**
 * The application shell (ADR-155; APX look, ADR-169): the wordmark, the sections, the signed-in
 * person and Sign out, in a sidebar that is hidden by default and shown on request from `lg`, and in
 * a hamburger drawer below `lg` (`ShellFrame`, owner 2026-10-14).
 */
export async function AppShell({
  homeHref,
  homeLabel = 'APX home',
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
  const sidebar = (
    <>
      <SidebarNav groups={groups} />
      <div className="mt-auto flex flex-col gap-2 pt-6 pb-6">
        {person}
        {footer ? <div className="px-3">{footer}</div> : null}
        <SignOutButton />
        <p className="mt-16 px-3 text-[0.6875rem] leading-relaxed font-semibold tracking-[0.24em] text-ink-muted uppercase">
          Analyse · Plan
          <br />
          Execute · Grow
        </p>
      </div>
      {/* The reference's corner shape behind the menu's last lines. */}
      <CornerBlob idPrefix="sidebar-blob" className="pointer-events-none absolute bottom-0 left-0 -z-10 w-full -scale-y-100 opacity-35" />
    </>
  );
  const brand = (
    <Link href={homeHref} className="px-2" aria-label={homeLabel}>
      <Wordmark idPrefix="sidebar-logo" />
      {area ? <span className="mt-3 block text-xs font-semibold tracking-[0.12em] text-ink-muted uppercase">{area}</span> : null}
    </Link>
  );
  const compactBrand = (
    <Link href={homeHref} aria-label={homeLabel}><Wordmark tagline={false} idPrefix="topbar-logo" /></Link>
  );
  // Hidden by default; shown while this browser session asked for it (`ShellFrame`).
  const docked = (await cookies()).get(NAV_COOKIE)?.value === 'shown';

  return (
    <ShellFrame initiallyDocked={docked} brand={brand} compactBrand={compactBrand} sidebar={sidebar}>
      <CornerBlob idPrefix="page-blob" className="fixed top-0 right-0 -z-10 hidden w-[26rem] max-w-[45vw] -scale-x-100 opacity-25 md:block" />
      <main className="mx-auto w-full min-w-0 max-w-[100rem] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </ShellFrame>
  );
}
