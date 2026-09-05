'use client';

import { useEffect, useState } from 'react';
import { SLOW_LOADING_TEXT } from './state-copy';

/**
 * "Taking longer than usual" (UX_ARCHITECTURE.md §7.1).
 *
 * A skeleton never sits on screen for more than three seconds without saying something. Past that
 * point a reader stops believing the page is loading and starts believing it is broken, and the
 * cheapest way to keep their trust is to admit that we agree it is slow.
 *
 * The only client component in the loading states, and it exists purely to hold a timer.
 */
export function SlowLoadingNotice({ delayMs = 3000 }: { delayMs?: number }) {
  const [show, setShow] = useState(delayMs <= 0);

  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  if (!show) return null;

  return (
    <p className="mt-2 text-sm text-ink-faint" role="status">
      {SLOW_LOADING_TEXT}
    </p>
  );
}
