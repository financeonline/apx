import Image from 'next/image';

/**
 * APX's logo and brand shapes (ADR-169), from the client's reference.
 *
 * The logo is the client's own, recreated at high resolution in ChatGPT from their artwork (owner,
 * 2026-10-13), cropped and cut out of its black ground so it sits on any dark surface
 * (public/brand/apx-logo.png with the tagline, apx-letters.png without). The sign-in
 * background is the client's too, recreated the same way (public/brand/apx-background-v8.webp, the owner's ribbon design, 2026-10-14; see
 * BrandedScreen). Decorative parts are hidden from assistive technology; the logo carries
 * the name "APX".
 */

/** The reference's colours, sampled from the client's image. */
const RED = '#f0143c';
const RED_DOT = '#ff2445';
const ORANGE = '#ff6a35';

function XGradient({ id }: { id: string }) {
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="597" y1="0" x2="1013" y2="0">
      <stop offset="0" stopColor={RED} />
      <stop offset="0.5" stopColor={RED_DOT} />
      <stop offset="1" stopColor={ORANGE} />
    </linearGradient>
  );
}

/** The client's logo: "APX" and, by default, "FINANCE IN MOTION" beneath. Height sets the size. */
export function ApxLogo({
  className = 'h-16 w-auto',
  tagline = true,
  priority = false,
}: {
  className?: string;
  tagline?: boolean;
  priority?: boolean;
}) {
  return tagline ? (
    <Image src="/brand/apx-logo.png" alt="APX, finance in motion" width={1200} height={353} priority={priority} className={className} />
  ) : (
    <Image src="/brand/apx-letters.png" alt="APX" width={1200} height={248} priority={priority} className={className} />
  );
}

/** The small mark: the X alone (">", dot, "<"). */
export function BrandMark({ className = 'size-10' }: { className?: string }) {
  return (
    <svg viewBox="590 40 430 200" className={className} aria-hidden="true">
      <defs>
        <XGradient id="apx-mark-x" />
      </defs>
      <g fill="none" stroke="url(#apx-mark-x)" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round">
        <path d="M625 75 L715 140 L625 205" />
        <path d="M985 75 L893 140 L985 205" />
      </g>
      <circle cx="804" cy="140" r="29" fill={RED_DOT} />
    </svg>
  );
}

export function Wordmark({
  tagline = true,
  size = 'md',
}: {
  tagline?: boolean;
  size?: 'md' | 'lg';
  /** Kept for callers from the drawn logo; unused. */
  idPrefix?: string;
}) {
  const height = size === 'lg' ? (tagline ? 'h-[4.25rem] sm:h-[4.75rem]' : 'h-12') : tagline ? 'h-10' : 'h-6';
  return <ApxLogo className={`${height} w-auto`} tagline={tagline} priority />;
}

/**
 * The light masthead's brand (ADR-179, the owner's third reference, 2026-11-01): the magenta ribbon
 * in the top-left corner, the X mark in magenta, and "APX / FINANCIAL SYSTEM" set as text in ink —
 * the reference draws its logo this way on a white ground, where the dark-ground PNG cannot sit.
 */
export function RibbonArt({ className = '', idPrefix = 'apx-ribbon' }: { className?: string; idPrefix?: string }) {
  const outer = `${idPrefix}-outer`;
  const inner = `${idPrefix}-inner`;
  return (
    <svg viewBox="0 0 500 440" fill="none" aria-hidden="true" focusable="false" className={`pointer-events-none select-none ${className}`}>
      <defs>
        <linearGradient id={outer} x1="20" y1="20" x2="450" y2="400" gradientUnits="userSpaceOnUse">
          <stop stopColor="#811d5e" />
          <stop offset=".53" stopColor="#c63192" />
          <stop offset="1" stopColor="#f145b5" />
        </linearGradient>
        <linearGradient id={inner} x1="150" y1="0" x2="330" y2="320" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ed50b6" />
          <stop offset="1" stopColor="#92216a" />
        </linearGradient>
      </defs>
      <path d="M-95-70C80-76 117 29 218 48C350 73 481-15 483 96C486 191 344 206 301 250C232 323 321 365 395 395C222 420 142 333 172 249C210 144 399 161 384 107C370 51 283 152 155 118C42 88 25 0-95 28Z" fill={`url(#${outer})`} />
      <path d="M-90 67C54 53 49 142 163 152C262 162 309 103 363 111C341 146 248 161 213 202C161 263 183 305 226 342C110 310 115 250 138 207C157 174 183 180 198 172C77 200 28 97-90 127Z" fill={`url(#${inner})`} />
      <path d="M-62 151C63 125 83 204 114 247C146 292 113 333 157 390C49 347 68 282 40 241C12 198-23 200-62 209Z" fill="#d940a3" />
      <path d="M-44-35C104-21 110 69 219 84C306 96 373 46 416 68" stroke="#ff80d3" strokeOpacity=".45" strokeWidth="2" />
      <path d="M-70 85C67 68 64 157 171 169" stroke="#f98ed4" strokeOpacity=".48" strokeWidth="2" />
    </svg>
  );
}

/** The X mark in magenta, for a light ground. */
export function LightMark({ className = 'h-10 w-auto', idPrefix = 'apx-light-mark' }: { className?: string; idPrefix?: string }) {
  const fill = `${idPrefix}-fill`;
  return (
    <svg viewBox="0 0 204 104" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="200" y2="100" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b2066" />
          <stop offset="1" stopColor="#ee45b3" />
        </linearGradient>
      </defs>
      <g fill={`url(#${fill})`}>
        <path d="M12 12 70 52 12 92V65l22-13-22-13Z" />
        <circle cx="102" cy="52" r="15" />
        <path d="M192 12 134 52l58 40V65l-22-13 22-13Z" />
      </g>
    </svg>
  );
}

/**
 * The light masthead's lockup: the mark, "APX" over "FINANCIAL SYSTEM", and — from `xl`, as the
 * reference hides it on narrower screens — a hairline and "Finance in motion." in italic serif.
 */
export function LightLockup({ idPrefix = 'apx-lockup', compact = false }: { idPrefix?: string; compact?: boolean }) {
  return (
    <span className={`flex items-center ${compact ? 'gap-3' : 'gap-4 sm:gap-5'}`}>
      <LightMark idPrefix={idPrefix} className={compact ? 'h-7 w-auto' : 'h-9 w-auto sm:h-11'} />
      <span className="leading-none text-ink">
        {/* Compact: the menu column is 14rem of content; the lockup must leave room for the Hide menu button beside it. */}
        <span className={`block font-bold tracking-[0.2em] ${compact ? 'text-xl' : 'text-[1.625rem] sm:text-[2rem]'}`}>APX</span>
        <span className="mt-2 block text-[0.5rem] font-medium tracking-[0.24em] whitespace-nowrap uppercase">Financial system</span>
      </span>
      {compact ? null : (
        <>
          <span aria-hidden="true" className="hidden h-11 w-px bg-[#d3c5ce] xl:block" />
          <span className="hidden font-[family-name:var(--lobby-serif)] text-[1.3125rem] whitespace-nowrap text-[#7d4d6c] italic xl:block">
            Finance in motion.
          </span>
        </>
      )}
    </span>
  );
}

/** A coral/orange blob for a page corner, as the reference's top-left and bottom-left. */
export function CornerBlob({ className = '', idPrefix = 'apx-blob' }: { className?: string; idPrefix?: string }) {
  const fill = `${idPrefix}-fill`;
  const shade = `${idPrefix}-shade`;
  return (
    <svg viewBox="0 0 400 400" aria-hidden="true" focusable="false" className={`pointer-events-none select-none ${className}`}>
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff2a5c" />
          <stop offset="0.6" stopColor="#ff3d48" />
          <stop offset="1" stopColor="#ff6a35" />
        </linearGradient>
        <radialGradient id={shade} cx="0.9" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#7a0016" stopOpacity="0.55" />
          <stop offset="1" stopColor="#7a0016" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        fill={`url(#${fill})`}
        d="M0 0 H300 C 340 30, 280 90, 200 115 C 130 137, 110 185, 55 205 C 28 215, 10 210, 0 205 Z"
      />
      <path
        fill={`url(#${shade})`}
        d="M0 0 H300 C 340 30, 280 90, 200 115 C 130 137, 110 185, 55 205 C 28 215, 10 210, 0 205 Z"
      />
    </svg>
  );
}

/**
 * The loading mark (owner, 2026-10-14: a loading screen for every page): the X — ">", the dot, "<" —
 * with the chevrons closing in on the dot and the dot pulsing (`.apx-loader-*` in globals.css; still
 * under reduced motion). Decorative: the "Loading" text beside it carries the meaning.
 */
export function LoaderMark({ className = 'h-12 w-auto' }: { className?: string }) {
  return (
    <svg viewBox="590 40 430 200" className={className} aria-hidden="true" focusable="false">
      <defs>
        <XGradient id="apx-loader-x" />
      </defs>
      <g fill="none" stroke="url(#apx-loader-x)" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round">
        <path className="apx-loader-left" d="M625 75 L715 140 L625 205" />
        <path className="apx-loader-right" d="M985 75 L893 140 L985 205" />
      </g>
      <circle className="apx-loader-dot" cx="804" cy="140" r="29" fill={RED_DOT} />
    </svg>
  );
}
