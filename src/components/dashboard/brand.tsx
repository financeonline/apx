import Image from 'next/image';

/**
 * APX's logo and brand shapes (ADR-169), from the client's reference.
 *
 * The logo is the client's own, recreated at high resolution in ChatGPT from their artwork (owner,
 * 2026-10-13), cropped and cut out of its black ground so it sits on any dark surface
 * (public/brand/apx-logo.png with the tagline, apx-letters.png without). The sign-in
 * background is the client's too, recreated the same way (public/brand/apx-background.webp; see
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
