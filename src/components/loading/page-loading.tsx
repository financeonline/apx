'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatedLogo, LOGO_INTRO, LOGO_LOOP } from '@/components/dashboard/animated-logo';

/**
 * The loading screen for every page (owner, 2026-10-14: "a loading page background for the whole
 * app, for all the sections and all the pages").
 *
 * Not `loading.tsx`: a route-level loading boundary makes Next commit the response's status before
 * the page runs, so a page that answers `notFound()` — another company's page, a permission the
 * caller lacks — would answer 200 with the not-found body (ADR-059.8; `route-contracts.test.ts`).
 * The uniform 404 is part of the access model, so loading is shown on the CLIENT instead: when a
 * person follows a link inside APX (or the sign-in form navigates, `startNavigationLoading`), a
 * full-screen veil with the moving logo appears after a short delay — so a fast page never flashes
 * it — and lifts as soon as the new page is on screen.
 *
 * The veil (owner, 2026-10-14: "animate the logo for the loading page"; solid black, logo centred)
 * is solid black with the animated logo (`AnimatedLogo`) in the middle — pure black, so a browser
 * that drops the video's transparency still shows no box.
 */

const SHOW_AFTER_MS = 120;
const GIVE_UP_AFTER_MS = 20_000;
const EVENT = 'apx:navigate';

/** For code that navigates without a link (the sign-in form's router.push). */
export function startNavigationLoading() {
  window.dispatchEvent(new Event(EVENT));
}

function isInternalNavigation(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = (event.target as Element | null)?.closest?.('a');
  if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return false;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  // A download route or an API answer is not a page.
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('/download')) return false;
  // The same page (only the hash or nothing changed) does not navigate.
  return url.pathname !== window.location.pathname || url.search !== window.location.search;
}

export function NavigationLoader() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(false);

  // A new page is on screen: lift the veil.
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setPending(false);
    setVisible(false);
  }

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (isInternalNavigation(event)) setPending(true);
    };
    const onStart = () => setPending(true);
    // Back/forward restores a page from the router cache; nothing to wait for.
    const onPop = () => { setPending(false); setVisible(false); };
    document.addEventListener('click', onClick);
    window.addEventListener(EVENT, onStart);
    window.addEventListener('popstate', onPop);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener(EVENT, onStart);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const show = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    // Never trap anyone behind the veil: a navigation that goes nowhere (a refused link, a search
    // that only changed the query) lets go on its own.
    const giveUp = window.setTimeout(() => { setPending(false); setVisible(false); }, GIVE_UP_AFTER_MS);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(giveUp);
    };
  }, [pending]);

  // The query string can change without the path (a filter, a period): lift the veil then too.
  useEffect(() => {
    if (!pending) return;
    const search = window.location.search;
    const check = window.setInterval(() => {
      if (window.location.search !== search) { setPending(false); setVisible(false); }
    }, 150);
    return () => window.clearInterval(check);
  }, [pending]);

  // Fetch both videos once the app is idle, so the first veil plays at once.
  useEffect(() => {
    const warm = window.setTimeout(() => {
      for (const src of [LOGO_INTRO, LOGO_LOOP]) void fetch(src).catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(warm);
  }, []);

  if (!visible) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black">
      <AnimatedLogo className="w-[min(20rem,72vw)]" />
      <p role="status" aria-live="polite" className="sr-only">
        Loading
      </p>
    </div>
  );
}
