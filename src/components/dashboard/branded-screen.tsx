import Link from 'next/link';
import type { ReactNode } from 'react';
import { CornerBlob, Wordmark } from './brand';

/**
 * "Analyse, Plan, Execute, Grow" (ADR-169), one word on each turn of the background's four-turn
 * spiral, reading upwards like growth: Analyse on the crimson bottom turn, Plan on the coral, Execute
 * on the orange, Grow on the top (owner, 2026-10-14). In the image's own 1280 × 720 coordinates,
 * drawn in an SVG that crops exactly as the image does (`slice` = `cover`, both centred), so each
 * word stays on its turn at every screen size. White with a soft shadow: they sit on colour.
 */
const WORDS = [
  { word: 'GROW', x: 990, y: 74 },
  { word: 'EXECUTE', x: 925, y: 212 },
  { word: 'PLAN', x: 915, y: 380 },
  { word: 'ANALYSE', x: 905, y: 552 },
] as const;

/**
 * A page outside the app shell, in the client's APX reference (ADR-169).
 *
 * `auth` (sign-in, sign-up, password pages): the reference's screen — the client's full-bleed
 * background (black, with a four-turn red-to-orange spiral at the right), the wordmark and the
 * form over its black left-centre, and "Analyse, Plan, Execute, Grow" on the spiral's turns from
 * `lg`. Below `lg` the image shifts to its black middle, so the form sits on black.
 *
 * Otherwise (choosing an organisation, an invitation, Account, the legal pages): the wordmark and the
 * content on a dark panel, with the corner shapes.
 */
export function BrandedScreen({
  children,
  width = 'md',
  panel = true,
  homeHref = '/',
  auth = false,
}: {
  children: ReactNode;
  width?: 'md' | 'lg' | '2xl' | '6xl';
  /** Put the content on a panel (forms); off for pages that bring their own cards. */
  panel?: boolean;
  homeHref?: string;
  /** The sign-in split screen. */
  auth?: boolean;
}) {
  const home = (
    <Link href={homeHref} aria-label="APX home" className="self-start">
      <Wordmark size={auth ? 'lg' : 'md'} idPrefix="screen-logo" />
    </Link>
  );

  if (auth) {
    return (
      <div className="relative isolate min-h-dvh overflow-hidden bg-black">
        {/* The owner's background (2026-10-14): a four-turn matte spiral in the APX red → orange,
            with a soft data core (charts, nodes) inside, generated in ChatGPT and cleaned here
            ("neat and clean, high resolution with proper pixels"): the dark block-grid faded to pure black,
            flat and glowing areas smoothed edge-aware, upscaled to 2880 × 1620 without sharpening,
            a fine dither against banding, near-lossless WebP. Served as prepared — never through
            the image optimiser, which re-encodes at quality 75 and brings the blocks back — with a
            1600 px copy for screens up to 1023 px. */}
        <picture>
          <source media="(max-width: 1023px)" srcSet="/brand/apx-background-v7-1600.webp" type="image/webp" />
          <img
            src="/brand/apx-background-v7.webp" alt="" fetchPriority="high" decoding="async"
            className="absolute inset-0 -z-10 size-full object-cover object-[32%_center] lg:object-center"
          />
        </picture>
        <svg
          aria-hidden="true" focusable="false" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice"
          className="pointer-events-none absolute inset-0 -z-10 hidden size-full select-none lg:block"
        >
          <defs>
            <filter id="apx-word-shadow" x="-20%" y="-50%" width="140%" height="200%">
              <feDropShadow dx="0" dy="1" stdDeviation="2.5" floodColor="#000000" floodOpacity="0.55" />
            </filter>
          </defs>
          {WORDS.map(({ word, x, y }) => (
            <g key={word} filter="url(#apx-word-shadow)">
              <text x={x} y={y} textAnchor="middle" fill="#ffffff" fontSize="15" fontWeight="600" letterSpacing="4" className="font-sans">
                {word}
              </text>
              <rect x={x - 23} y={y + 16} width="46" height="4" rx="2" fill="#ffffff" fillOpacity="0.9" />
            </g>
          ))}
        </svg>
        <main className="flex min-h-dvh w-full flex-col justify-center gap-10 px-6 py-16 sm:px-12 lg:pl-[17.5vw]">
          <div className="w-full max-w-sm">{home}</div>
          <div className="w-full max-w-sm">{children}</div>
        </main>
      </div>
    );
  }

  const max = width === 'md' ? 'max-w-md' : width === 'lg' ? 'max-w-lg' : width === '6xl' ? 'max-w-6xl' : 'max-w-2xl';
  return (
    <div className="relative isolate min-h-dvh overflow-x-clip">
      <CornerBlob idPrefix="screen-blob-top" className="absolute top-0 right-0 -z-10 w-56 -scale-x-100 opacity-90 sm:w-80" />
      <CornerBlob idPrefix="screen-blob-foot" className="absolute bottom-0 left-0 -z-10 hidden w-72 -scale-y-100 opacity-80 sm:block" />
      <main className={`mx-auto flex min-h-dvh w-full ${max} flex-col justify-center gap-8 px-4 py-12 sm:px-6`}>
        {home}
        {panel ? <div className="panel rounded-card p-6 sm:p-8">{children}</div> : children}
      </main>
    </div>
  );
}
