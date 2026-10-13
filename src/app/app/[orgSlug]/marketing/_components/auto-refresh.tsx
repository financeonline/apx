'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * While the report is being written, the page asks the server again every few seconds (ADR-170), so
 * the report appears without anybody pressing anything. `router.refresh()` re-renders the server
 * components and keeps the scroll position; when the report is ready the page no longer renders this
 * component, and the polling stops with it.
 *
 * Not while the tab is hidden — nobody is looking — and not for ever: a job that has not finished in
 * ten minutes is stuck, not slow, and the page says so rather than polling a stuck job all afternoon.
 */
const EVERY_MS = 5_000;
const MAX_REFRESHES = 120;

export function AutoRefresh() {
  const router = useRouter();
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    let refreshes = 0;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      refreshes += 1;
      if (refreshes > MAX_REFRESHES) {
        window.clearInterval(timer);
        setStopped(true);
        return;
      }
      router.refresh();
    }, EVERY_MS);
    // Coming back to the tab asks at once, rather than up to five seconds later.
    const onVisible = () => {
      if (!document.hidden) router.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  return stopped ? (
    <p role="status" className="mt-2 text-sm text-warn">
      This is taking longer than usual. Reload the page in a few minutes to see whether it has finished.
    </p>
  ) : (
    <p className="mt-2 text-xs text-ink-faint">This page updates by itself.</p>
  );
}
