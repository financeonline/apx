import { useId } from 'react';

/**
 * MOTION's mark and the page's petal artwork (ADR-155), as in the owner's reference: a four-petal
 * flower in violet and pink. Pure SVG, decorative — the wordmark beside it carries the name.
 */

export function BrandMark({ className = 'size-8' }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f9a8d4" />
          <stop offset="1" stopColor="#db2777" />
        </linearGradient>
      </defs>
      <path d="M16 15C11 15 6 12 6 7c0-2 1.5-3 3.5-3C13 4 16 9 16 15Z" fill={`url(#${id}-a)`} />
      <path d="M17 16c0-5 3-10 8-10 2 0 3 1.5 3 3.5C28 13 23 16 17 16Z" fill={`url(#${id}-b)`} />
      <path d="M16 17c5 0 10 3 10 8 0 2-1.5 3-3.5 3C19 28 16 23 16 17Z" fill={`url(#${id}-a)`} />
      <path d="M15 16c0 5-3 10-8 10-2 0-3-1.5-3-3.5C4 19 9 16 15 16Z" fill={`url(#${id}-b)`} />
    </svg>
  );
}

export function Wordmark({ tagline = 'Financial intelligence' }: { tagline?: string | null }) {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark />
      <span className="flex flex-col leading-tight">
        <span className="text-xl font-bold tracking-tight text-ink">MOTION</span>
        {tagline ? <span className="text-xs text-ink-muted">{tagline}</span> : null}
      </span>
    </span>
  );
}

/** Soft translucent petals, for a corner of the page. */
export function Petals({ className = '' }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 400 400" aria-hidden="true" className={`pointer-events-none select-none ${className}`}>
      <defs>
        <linearGradient id={`${id}-p`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ddd6fe" stopOpacity="0.9" />
          <stop offset="1" stopColor="#a78bfa" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id={`${id}-q`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#fbcfe8" stopOpacity="0.8" />
          <stop offset="1" stopColor="#c4b5fd" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      <g opacity="0.55">
        <path d="M200 210C150 140 150 60 210 10c40 60 40 140-10 200Z" fill={`url(#${id}-p)`} />
        <path d="M205 215c10-90 70-150 150-160-10 80-70 140-150 160Z" fill={`url(#${id}-q)`} />
        <path d="M195 215c-80-30-130-100-125-180 70 20 120 90 125 180Z" fill={`url(#${id}-q)`} />
        <path d="M210 225c80-20 150 10 185 70-80 20-150-10-185-70Z" fill={`url(#${id}-p)`} />
      </g>
    </svg>
  );
}
