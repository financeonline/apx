'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ApxLogo } from '@/components/dashboard/brand';

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
 * The veil (owner, 2026-10-14: "animate the logo for the loading page"; build-in, then pulse; solid
 * black, logo centred; relaxed; "a little slower") is solid black with the logo in the middle: a 2.8-second
 * build-in (`apx-logo-intro.webm`), then a seamless 2-second pulse on repeat (`apx-logo-loop.webm`).
 * Both are transparent VP9 WebM made with HyperFrames (~/hyperframes-kit/video-projects/
 * apx-logo-loader and apx-logo-loader-loop). The veil is pure black so a browser that drops the
 * transparency still shows no box. A browser that cannot play WebM/VP9, a video that fails, and a
 * person who asked for reduced motion all get the still logo instead.
 */

const SHOW_AFTER_MS = 120;
const GIVE_UP_AFTER_MS = 20_000;
const EVENT = 'apx:navigate';
const INTRO = '/brand/apx-logo-intro.webm';
const LOOP = '/brand/apx-logo-loop.webm';

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
      for (const src of [INTRO, LOOP]) void fetch(src).catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(warm);
  }, []);

  if (!visible) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black">
      <LogoAnimation />
      <p role="status" aria-live="polite" className="sr-only">
        Loading
      </p>
    </div>
  );
}

function canPlayAnimation(): boolean {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return document.createElement('video').canPlayType('video/webm; codecs="vp9"') !== '';
}

/** The build-in, then the pulse on repeat; the still logo where video won't do. */
function LogoAnimation() {
  const [still, setStill] = useState(() => !canPlayAnimation());
  const [looping, setLooping] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  // Swapping the source needs an explicit play; autoplay only covers the first. A refused play (a
  // background tab) is not a fault: the pulse's first frame is the whole logo, and autoplay resumes
  // when the tab is shown again. Only a real playback error swaps in the still logo.
  useEffect(() => {
    if (looping) void video.current?.play().catch(() => undefined);
  }, [looping]);

  if (still) return <ApxLogo className="h-auto w-[min(22rem,70vw)]" priority />;
  return (
    <video
      ref={video}
      src={looping ? LOOP : INTRO}
      autoPlay
      muted
      playsInline
      loop={looping}
      preload="auto"
      aria-hidden="true"
      onEnded={() => setLooping(true)}
      onError={() => setStill(true)}
      width={1200}
      height={480}
      className="h-auto w-[min(26rem,80vw)]"
    />
  );
}
