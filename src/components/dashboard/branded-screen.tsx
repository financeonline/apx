import Link from 'next/link';
import type { ReactNode } from 'react';
import { CornerSprig, SidebarSprig, Wordmark } from './brand';

/**
 * A page outside the app shell — sign-in, choosing an organisation, an invitation, Account, the
 * legal pages — in the owner's reference design (ADR-155): the wordmark, the leaf artwork in two
 * corners, and the content on a white panel.
 */
export function BrandedScreen({
  children,
  width = 'md',
  panel = true,
  homeHref = '/',
}: {
  children: ReactNode;
  width?: 'md' | 'lg' | '2xl' | '6xl';
  /** Put the content on a white panel (forms); off for pages that bring their own cards. */
  panel?: boolean;
  homeHref?: string;
}) {
  const max = width === 'md' ? 'max-w-md' : width === 'lg' ? 'max-w-lg' : width === '6xl' ? 'max-w-6xl' : 'max-w-2xl';
  return (
    <div className="relative isolate min-h-dvh overflow-x-clip">
      <CornerSprig className="absolute top-0 right-0 -z-10 w-[34rem] max-w-[70vw] opacity-80" />
      <SidebarSprig className="absolute bottom-0 left-0 -z-10 hidden w-64 opacity-60 sm:block" />
      <main className={`mx-auto flex min-h-dvh w-full ${max} flex-col justify-center gap-8 px-4 py-12 sm:px-6`}>
        <Link href={homeHref} aria-label="MOTION home" className="self-start">
          <Wordmark />
        </Link>
        {panel ? <div className="panel rounded-card p-6 sm:p-8">{children}</div> : children}
      </main>
    </div>
  );
}
