import Image from 'next/image';

/**
 * MOTION's mark, wordmark and leaf artwork (ADR-155), from the owner's reference: the logo image
 * (four rounded petals, violet above and pink below); "MOTION" in deep indigo with a violet
 * tagline; translucent lavender sprigs for the sidebar foot and the page's top corner. The images
 * are decorative, so hidden from assistive technology — the text beside the mark carries the name.
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

/**
 * The leaf artwork: the owner's ChatGPT-generated sprigs (same style as the reference), cut out onto
 * transparency and compressed (public/brand/*.webp). Decorative: empty alt.
 */

/** The sidebar's foot: a sprig rising from the bottom-left. */
export function SidebarSprig({ className = '' }: { className?: string }) {
  return (
    <Image
      src="/brand/sidebar-leaves.webp" alt="" width={560} height={840} sizes="256px"
      className={`pointer-events-none h-auto select-none ${className}`}
    />
  );
}

/** The page's top corner: a sprig fanning up and to the left, behind the header's buttons. */
export function CornerSprig({ className = '' }: { className?: string }) {
  return (
    <Image
      src="/brand/corner-leaves.webp" alt="" width={960} height={640} sizes="480px" priority
      className={`pointer-events-none h-auto select-none ${className}`}
    />
  );
}

/** Kept for the earlier corner artwork's callers; now the sprig. */
export const Petals = CornerSprig;
