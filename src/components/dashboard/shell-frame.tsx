'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, PanelLeftClose, X } from 'lucide-react';
import { NAV_COOKIE } from './nav-cookie';

/**
 * The shell's moving parts (owner, 2026-10-14: "hide and unhide, hidden by default"; "hamburger
 * style for mobile").
 *
 * - From `lg` the sidebar is HIDDEN by default. A top bar with a menu button shows it; "Hide menu"
 *   in the sidebar hides it again. The choice is a browser-session cookie (`apx_nav=shown`), so a
 *   new sign-in starts hidden again (the sign-in form clears it), and the server renders the same
 *   state the browser will — no flash.
 * - Below `lg` the menu button opens a slide-in drawer: a modal dialog with the same links, closed
 *   by its close button, the backdrop, Escape, or following a link.
 *
 * The sidebar's contents are rendered once on the server and passed in, so the dialog and the
 * docked sidebar show exactly the same links.
 */
const DESKTOP = '(min-width: 64rem)';

function rememberDocked(docked: boolean) {
  document.cookie = docked
    ? `${NAV_COOKIE}=shown; path=/; samesite=lax`
    : `${NAV_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function ShellFrame({
  initiallyDocked,
  brand,
  compactBrand,
  sidebar,
  children,
}: {
  initiallyDocked: boolean;
  /** The wordmark link for the sidebar and the drawer. */
  brand: ReactNode;
  /** The smaller wordmark link for the top bar. */
  compactBrand: ReactNode;
  /** The links, the person and Sign out. */
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [docked, setDocked] = useState(initiallyDocked);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // Following a link closes the drawer.
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  // The drawer is a modal: Escape closes it, the page behind does not scroll, focus moves into it
  // and back to the menu button when it closes.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const opener = openButton.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [drawerOpen]);

  // A drawer left open while the window grows past `lg` would sit over a page with its own menu.
  useEffect(() => {
    const query = window.matchMedia(DESKTOP);
    const onChange = () => {
      if (query.matches) setDrawerOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const openMenu = () => {
    if (window.matchMedia(DESKTOP).matches) {
      setDocked(true);
      rememberDocked(true);
    } else {
      setDrawerOpen(true);
    }
  };
  const hideMenu = () => {
    setDocked(false);
    rememberDocked(false);
  };

  return (
    <div data-nav={docked ? 'shown' : 'hidden'} className="group/shell min-h-dvh lg:data-[nav=shown]:flex">
      {/* The docked sidebar, from `lg`, while shown. */}
      <aside
        aria-label="Main menu"
        className="isolate sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface/80 px-4 pt-5 lg:group-data-[nav=shown]/shell:flex"
      >
        <div className="mb-8 flex items-start justify-between gap-2">
          {brand}
          <button
            type="button"
            onClick={hideMenu}
            aria-label="Hide menu"
            title="Hide menu"
            className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
          >
            <PanelLeftClose aria-hidden="true" className="size-5" strokeWidth={1.75} />
          </button>
        </div>
        {sidebar}
      </aside>

      {/* The top bar: always below `lg`; from `lg` only while the sidebar is hidden. */}
      <header className="panel sticky top-0 z-20 flex items-center gap-3 border-x-0 border-t-0 px-4 py-2.5 sm:px-6 lg:group-data-[nav=shown]/shell:hidden">
        <button
          ref={openButton}
          type="button"
          onClick={openMenu}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls="apx-drawer"
          className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line text-ink transition-colors hover:border-accent/60 hover:text-accent"
        >
          <Menu aria-hidden="true" className="size-5" strokeWidth={1.75} />
        </button>
        {compactBrand}
      </header>

      {/* The drawer, below `lg`. */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/70"
          />
          <div
            id="apx-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Main menu"
            className="absolute inset-y-0 left-0 isolate flex w-[min(20rem,85vw)] flex-col overflow-y-auto border-r border-line bg-surface px-4 pt-4 shadow-2xl"
          >
            <div className="mb-6 flex items-start justify-between gap-2">
              {brand}
              <button
                ref={closeButton}
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="-mr-1 flex size-10 shrink-0 items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
              >
                <X aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </button>
            </div>
            {sidebar}
          </div>
        </div>
      ) : null}

      {children}
    </div>
  );
}
