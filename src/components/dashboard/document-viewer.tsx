'use client';

import { useEffect, useState } from 'react';

/**
 * A stored document, shown by the browser from a short-lived signed URL fetched on demand
 * (`/api/documents/[id]/url`, ADR-043.5). MOTION never rasterises a page and never puts the URL in
 * the HTML: it is minted when the viewer opens, recorded as `document.downloaded`, and expires.
 * `height` is the most it takes; on a short screen (a phone) it is never more than 70% of the
 * screen, so the page around it can still be scrolled to.
 */
export function DocumentViewer({ orgSlug, documentId, filename, page, height = 640 }: {
  orgSlug: string; documentId: string; filename: string; page?: number; height?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents/${documentId}/url?org=${encodeURIComponent(orgSlug)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? 'The document could not be opened.');
        return (await response.json()) as { url: string };
      })
      .then((signed) => { if (!cancelled) setUrl(signed.url); })
      .catch((error: Error) => { if (!cancelled) setFailed(error.message); });
    return () => { cancelled = true; };
  }, [documentId, orgSlug]);
  if (failed) return <p className="text-sm text-ink-muted">{failed}</p>;
  if (!url) return <p className="text-sm text-ink-muted">Opening {filename}…</p>;
  const isPdf = /\.pdf$/i.test(filename);
  // ADR-150: a receipt photo is shown as itself, from the same short-lived signed URL.
  if (/\.(jpe?g|png)$/i.test(filename)) {
    // eslint-disable-next-line @next/next/no-img-element -- a signed, expiring URL; next/image would proxy and cache it
    return <img src={url} alt={filename} className="w-full rounded-md border border-line object-contain" style={{ maxHeight: `min(${height}px, 70dvh)` }} />;
  }
  if (!isPdf) {
    return <p className="text-sm"><a className="underline" href={url} target="_blank" rel="noreferrer">Download {filename}</a> — the link works for the next minute.</p>;
  }
  return (
    <object data={`${url}#page=${page ?? 1}&toolbar=0`} type="application/pdf" className="w-full rounded-md border border-line" style={{ height: `min(${height}px, 70dvh)` }} aria-label={`${filename}${page ? `, page ${page}` : ''}`}>
      <p className="p-3 text-sm text-ink-muted">
        Your browser cannot show the PDF here. <a className="underline" href={url} target="_blank" rel="noreferrer">Open it in a new tab</a>.
      </p>
    </object>
  );
}
