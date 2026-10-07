import Image from 'next/image';
import { useId } from 'react';

/**
 * MOTION's mark, wordmark and leaf artwork (ADR-155), from the owner's reference: the logo image
 * (four rounded petals, violet above and pink below); "MOTION" in deep indigo with
 * a violet tagline; translucent lavender sprigs for the sidebar foot and the page's top corner.
 * Vector, so it is sharp at any size; decorative, so hidden from assistive technology — the text
 * beside the mark carries the name.
 */

/**
 * The mark: the owner's logo, generated in ChatGPT from the reference and cut out onto transparency
 * (public/brand/motion-logo.png, 256px; also the browser-tab icon, src/app/icon.png).
 */
export function BrandMark({ className = 'size-10' }: { className?: string }) {
  return <Image src="/brand/motion-logo.png" alt="" width={256} height={256} priority className={className} />;
}

export function Wordmark({ tagline = true }: { tagline?: boolean }) {
  return (
    <span className="flex items-start gap-3">
      <BrandMark className="mt-0.5 size-10 shrink-0" />
      <span className="flex flex-col">
        <span className="text-[1.65rem] leading-none font-medium tracking-[0.04em] text-brand-ink">MOTION</span>
        {tagline ? (
          <span className="mt-1.5 text-[0.8125rem] leading-snug text-accent">
            Financial intelligence
            <br />
            for a brighter tomorrow.
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** One leaf along its own axis, base at the origin, tip at (0, -length); slightly asymmetric. */
function leafPath(length: number, width: number): string {
  const l = length;
  const w = width;
  return `M0 0C${w * 0.95} ${-l * 0.22} ${w * 1.05} ${-l * 0.62} 0 ${-l}C${-w * 0.55} ${-l * 0.72} ${-w * 0.85} ${-l * 0.3} 0 0Z`;
}

interface Leaf { x: number; y: number; angle: number; length: number; width: number; tone: 'a' | 'b'; opacity: number }

function Sprig({ id, leaves, stems }: { id: string; leaves: readonly Leaf[]; stems: readonly string[] }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-a`} x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" stopColor="#a78bfa" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ede4ff" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" stopColor="#c4b5fd" stopOpacity="0.8" />
          <stop offset="1" stopColor="#fbcfe8" stopOpacity="0.6" />
        </linearGradient>
      </defs>
      {stems.map((d) => <path key={d} d={d} fill="none" stroke="#c4b5fd" strokeOpacity="0.7" strokeWidth="1.5" strokeLinecap="round" />)}
      {leaves.map((leaf) => (
        <g key={`${leaf.x}-${leaf.y}-${leaf.angle}`} transform={`translate(${leaf.x} ${leaf.y}) rotate(${leaf.angle})`} opacity={leaf.opacity}>
          <path d={leafPath(leaf.length, leaf.width)} fill={`url(#${id}-${leaf.tone})`} />
          <path d={`M0 0Q${leaf.width * 0.12} ${-leaf.length * 0.5} 0 ${-leaf.length * 0.96}`} fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1" />
        </g>
      ))}
    </>
  );
}

/** The sidebar's foot: a sprig rising from the bottom-left over a soft lavender glow. */
export function SidebarSprig({ className = '' }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 260 340" aria-hidden="true" className={`pointer-events-none select-none ${className}`}>
      <defs>
        <radialGradient id={`${id}-g`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ddd6fe" stopOpacity="0.7" />
          <stop offset="1" stopColor="#ddd6fe" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="150" cy="350" rx="190" ry="110" fill={`url(#${id}-g)`} />
      <Sprig
        id={id}
        stems={['M48 340Q60 220 150 70', 'M52 330Q30 250 20 170']}
        leaves={[
          { x: 50, y: 338, angle: -30, length: 200, width: 40, tone: 'a', opacity: 0.6 },
          { x: 58, y: 300, angle: 22, length: 230, width: 48, tone: 'b', opacity: 0.6 },
          { x: 62, y: 250, angle: -6, length: 170, width: 34, tone: 'a', opacity: 0.5 },
          { x: 84, y: 205, angle: 40, length: 140, width: 30, tone: 'b', opacity: 0.45 },
          { x: 46, y: 335, angle: -58, length: 120, width: 26, tone: 'b', opacity: 0.4 },
          { x: 115, y: 140, angle: 28, length: 100, width: 22, tone: 'a', opacity: 0.4 },
        ]}
      />
    </svg>
  );
}

/** The page's top corner: a sprig fanning up and to the left, behind the header's buttons. */
export function CornerSprig({ className = '' }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 440 320" aria-hidden="true" className={`pointer-events-none select-none ${className}`}>
      <defs>
        <radialGradient id={`${id}-g`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ede9fe" stopOpacity="0.8" />
          <stop offset="1" stopColor="#ede9fe" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="400" cy="300" rx="220" ry="120" fill={`url(#${id}-g)`} />
      <Sprig
        id={id}
        stems={['M250 320Q210 200 120 90', 'M255 315Q262 200 300 80']}
        leaves={[
          { x: 250, y: 318, angle: -62, length: 250, width: 46, tone: 'a', opacity: 0.75 },
          { x: 248, y: 300, angle: -38, length: 280, width: 50, tone: 'b', opacity: 0.75 },
          { x: 252, y: 290, angle: -16, length: 230, width: 42, tone: 'a', opacity: 0.65 },
          { x: 256, y: 300, angle: 6, length: 200, width: 36, tone: 'b', opacity: 0.55 },
          { x: 258, y: 312, angle: 28, length: 140, width: 28, tone: 'a', opacity: 0.5 },
        ]}
      />
    </svg>
  );
}

/** Kept for the earlier corner artwork's callers; now the sprig. */
export const Petals = CornerSprig;
