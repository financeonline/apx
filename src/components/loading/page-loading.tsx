import Image from 'next/image';
import { ApxLogo, LoaderMark } from '@/components/dashboard/brand';

/**
 * Loading screens for every page (owner, 2026-10-14: "a loading page background for the whole app,
 * for all the sections and all the pages"). Next shows them from each section's `loading.tsx` while
 * the page is fetched, so a slow page is never a blank screen.
 *
 * `FullScreenLoading`: outside the app shell (sign-in, choosing an organisation, Account…) — the
 * client's background, dimmed, with the logo and the moving mark.
 * `ShellLoading`: inside the app shell — the menu stays, and the page area shows the mark until the
 * page arrives.
 */

function Message() {
  return (
    <p role="status" aria-live="polite" className="text-sm font-medium tracking-[0.2em] text-ink-muted uppercase">
      Loading
    </p>
  );
}

export function FullScreenLoading() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-paper">
      <Image src="/brand/apx-background.webp" alt="" fill priority sizes="100vw" className="object-cover object-[32%_center] opacity-30 lg:object-center" />
      <div className="relative flex flex-col items-center gap-8 px-6 text-center">
        <ApxLogo className="h-16 w-auto sm:h-20" priority />
        <LoaderMark className="h-10 w-auto" />
        <Message />
      </div>
    </div>
  );
}

export function ShellLoading() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-6 px-4 text-center">
      <LoaderMark className="h-12 w-auto sm:h-14" />
      <Message />
    </div>
  );
}
