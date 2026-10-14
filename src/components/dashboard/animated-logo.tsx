'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApxLogo } from './brand';

/**
 * The APX logo, animated (owner, 2026-10-14: "animate the logo"; build-in, then pulse; relaxed, "a
 * little slower"): a 2.8-second build-in (`apx-logo-intro.webm` — the A and P draw, the dots pop,
 * the arrows slide in, the tagline settles), then a seamless 2-second pulse on repeat
 * (`apx-logo-loop.webm`). Both are transparent VP9 WebM made with HyperFrames
 * (~/hyperframes-kit/video-projects/apx-logo-loader and apx-logo-loader-loop), 1200 × 480.
 *
 * The box is the LOGO's own (the videos' visible area, 944 × 256 at 132, 118), so the logo lines up
 * with whatever sits beside it; the video's transparent margin hangs outside the box. Reduced motion,
 * a browser that cannot play WebM/VP9 and a playback error all get the still logo instead.
 */

export const LOGO_INTRO = '/brand/apx-logo-intro.webm';
export const LOGO_LOOP = '/brand/apx-logo-loop.webm';

const noSubscription = () => () => undefined;

function canPlayAnimation(): boolean {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return document.createElement('video').canPlayType('video/webm; codecs="vp9"') !== '';
}

export function AnimatedLogo({
  className = 'w-80',
  label,
}: {
  /** Sets the logo's width. */
  className?: string;
  /** The accessible name; without it the logo is decorative. */
  label?: string;
}) {
  // Decided in the browser (null on the server, which cannot know the browser or its motion setting).
  const playable = useSyncExternalStore(noSubscription, canPlayAnimation, () => null);
  const [failed, setFailed] = useState(false);
  const [looping, setLooping] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const mode = playable === null ? 'pending' : playable && !failed ? 'video' : 'still';

  // Swapping the source needs an explicit play; autoplay only covers the first. A refused play (a
  // background tab) is not a fault: the pulse's first frame is the whole logo, and autoplay resumes
  // when the tab is shown again. Only a real playback error swaps in the still logo.
  useEffect(() => {
    if (looping) void video.current?.play().catch(() => undefined);
  }, [looping]);

  return (
    <div
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`relative aspect-[944/256] ${className}`}
    >
      {mode === 'still' ? (
        <ApxLogo className="absolute inset-0 size-full object-contain object-left" priority />
      ) : mode === 'video' ? (
        <video
          ref={video}
          src={looping ? LOGO_LOOP : LOGO_INTRO}
          autoPlay
          muted
          playsInline
          loop={looping}
          preload="auto"
          onEnded={() => setLooping(true)}
          onError={() => setFailed(true)}
          width={1200}
          height={480}
          className="absolute top-[-46.09%] left-[-13.98%] h-auto w-[127.12%] max-w-none"
        />
      ) : null}
    </div>
  );
}
