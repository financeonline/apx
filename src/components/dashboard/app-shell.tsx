import Link from 'next/link';
import { cookies } from 'next/headers';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { CornerBlob, LightLockup, RibbonArt, Wordmark } from './brand';
import { SidebarNav, type SidebarGroup } from './sidebar';
import { NAV_COOKIE } from './nav-cookie';
import { ShellFrame } from './shell-frame';
import { SignOutButton, SignOutHeaderButton } from './sign-out-button';
import { THEME_COOKIE, lookFromCookie } from './theme-cookie';
import { ThemeToggle } from './theme-toggle';

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
  look: defaultLook = 'dark',
  headerActions,
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
  /**
   * The area's DEFAULT look. `light` (ADR-179): the company pages' white masthead and light menu, the
   * owner's third reference; Command Centre and Platform default to the dark bar. A person's own
   * choice (the toggle's `apx_theme` cookie, ADR-184) wins over the default.
   */
  look?: 'dark' | 'light';
  /** Light masthead only: links before the signed-in person (the notifications bell). */
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  const cookieStore = await cookies();
  const look = lookFromCookie(cookieStore.get(THEME_COOKIE)?.value, defaultLook);
  const light = look === 'light';
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
      {/* The reference's corner shape behind the menu's last lines (the dark look only). */}
      {light ? null : <CornerBlob idPrefix="sidebar-blob" className="pointer-events-none absolute bottom-0 left-0 -z-10 w-full -scale-y-100 opacity-35" />}
    </>
  );
  // `min-w-0 flex-1`: the brand yields to the Hide menu button beside it instead of pushing it out of
  // the column (the light lockup did, and the button was invisible — owner, 2026-11-02).
  const brand = (
    <Link href={homeHref} className="min-w-0 flex-1 overflow-hidden px-2" aria-label={homeLabel}>
      {light ? <LightLockup idPrefix="sidebar-lockup" compact /> : <Wordmark idPrefix="sidebar-logo" />}
      {area ? <span className="mt-3 block text-xs font-semibold tracking-[0.12em] text-ink-muted uppercase">{area}</span> : null}
    </Link>
  );
  const compactBrand = light ? (
    <Link href={homeHref} aria-label={homeLabel} className="min-w-0"><LightLockup idPrefix="masthead-lockup" /></Link>
  ) : (
    <Link href={homeHref} aria-label={homeLabel}><Wordmark tagline={false} idPrefix="topbar-logo" /></Link>
  );
  // The reference's identity block: actions, then the person (avatar, name, role) behind a hairline,
  // then Log out — each a real link or form.
  const lightEnd = (
    <>
      {headerActions}
      {user ? (
        <Link href={user.href} className="flex min-w-0 items-center gap-2.5 border-l border-line-strong pl-4 hover:text-accent">
          <span aria-hidden="true" className="flex size-[2.0625rem] shrink-0 items-center justify-center rounded-full border border-[#e6c9dc] bg-[#faf0f6] text-xs font-semibold text-accent">
            {initials}
          </span>
          <span className="hidden min-w-0 leading-tight sm:block">
            <span className="block max-w-[11rem] truncate text-[0.8125rem] font-semibold">{user.name}</span>
            <span className="block max-w-[11rem] truncate text-[0.6875rem] text-ink-muted">{user.role}</span>
          </span>
        </Link>
      ) : null}
      <ThemeToggle look="light" />
      <SignOutHeaderButton look="light" />
    </>
  );
  const darkEnd = (
    <div className="ml-auto flex items-center gap-2">
      <ThemeToggle look="dark" />
      <SignOutHeaderButton />
    </div>
  );
  // Hidden by default; shown while this browser session asked for it (`ShellFrame`).
  const docked = cookieStore.get(NAV_COOKIE)?.value === 'shown';

  return (
    <ShellFrame
      initiallyDocked={docked}
      brand={brand}
      compactBrand={compactBrand}
      sidebar={sidebar}
      headerEnd={light ? lightEnd : darkEnd}
      look={look}
      ribbon={light ? <RibbonArt idPrefix="masthead-ribbon" className="absolute -top-[6.375rem] -left-[5.25rem] -z-10 w-[18.75rem] opacity-95" /> : undefined}
    >
      {light ? null : <CornerBlob idPrefix="page-blob" className="fixed top-0 right-0 -z-10 hidden w-[26rem] max-w-[45vw] -scale-x-100 opacity-25 md:block" />}
      <main className="mx-auto w-full min-w-0 max-w-[100rem] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </ShellFrame>
  );
}
