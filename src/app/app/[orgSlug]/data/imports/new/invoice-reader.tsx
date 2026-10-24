'use client';

import { useEffect, useState } from 'react';
import { Field, Input } from '@/components/ui/field';
import { readInvoiceText, type InvoiceReading, type InvoiceReadingSide } from '@/core/invoice-reading';

/**
 * Reads ONE invoice — a photo, a scan or a PDF — on this page, before anything is uploaded (ADR-175).
 *
 * A PDF's own text is used when it has some; a photo, or a scan without text, goes through Tesseract
 * OCR running in this browser tab (free, nothing sent anywhere; the files are served by APX from
 * /ocr). The rules in `readInvoiceText` turn the text into proposed fields. The reviewer sees the
 * invoice beside them, corrects what is wrong and ticks that every field matches — only then can
 * the form be sent, and the fields, not the reading, are what the import receives.
 */

type Status = { step: 'reading'; message: string } | { step: 'done'; method: 'text' | 'ocr' | 'none' } | { step: 'failed'; message: string };

const OCR_FILES = { workerPath: '/ocr/worker.min.js', corePath: '/ocr/core', langPath: '/ocr/lang' };
/** A one-invoice reader: pages after the third are almost never part of the totals. */
const MAX_PAGES = 3;

export function InvoiceReader({
  file,
  side,
  ownName,
  onIssueDate,
}: {
  file: File;
  side: InvoiceReadingSide;
  ownName: string;
  /** The invoice date once known, so the form can propose the month it covers. */
  onIssueDate: (iso: string) => void;
}) {
  const [status, setStatus] = useState<Status>({ step: 'reading', message: 'Opening the file…' });
  const [reading, setReading] = useState<InvoiceReading | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        let read: { text: string; method: 'text' | 'ocr' };
        if (isPdf) {
          read = await readPdf(file, (message) => !cancelled && setStatus({ step: 'reading', message }), (url) => !cancelled && setPreview(url));
        } else {
          objectUrl = URL.createObjectURL(file);
          setPreview(objectUrl);
          read = { text: await ocr(file, (message) => !cancelled && setStatus({ step: 'reading', message })), method: 'ocr' };
        }
        if (cancelled) return;
        const result = readInvoiceText(read.text, { side, ownName });
        setText(read.text);
        setReading(result);
        setStatus({ step: 'done', method: read.text.trim() === '' ? 'none' : read.method });
        if (result.issueDate) onIssueDate(result.issueDate);
      } catch (cause) {
        if (cancelled) return;
        setReading(readInvoiceText('', { side, ownName }));
        setStatus({ step: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    // The parent remounts this component for each new file or side; `onIssueDate` is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const party = side === 'sales' ? 'Customer' : 'Supplier';

  return (
    <section aria-labelledby="invoice-reader-title" className="space-y-4 rounded-lg border border-line bg-surface-sunken p-4">
      <div>
        <h3 id="invoice-reader-title" className="text-sm font-semibold text-ink">Check the invoice</h3>
        <p className="mt-1 text-xs text-ink-muted" aria-live="polite">
          {status.step === 'reading' ? status.message
            : status.step === 'failed' ? `APX could not read this file (${status.message}). Type the fields in from the invoice.`
              : status.method === 'text' ? 'Read from the text inside the PDF. Compare every field with the invoice and correct anything wrong.'
                : status.method === 'ocr' ? 'Read from the image with OCR on this device. OCR makes mistakes: compare every field with the invoice.'
                  : 'No text could be read. Type the fields in from the invoice.'}
        </p>
      </div>

      {status.step === 'reading' ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-label="Reading the invoice">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        </div>
      ) : null}

      {reading !== null ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="min-h-40 overflow-hidden rounded-md border border-line bg-white">
            {preview
              // eslint-disable-next-line @next/next/no-img-element -- a local object URL, never optimised
              ? <img src={preview} alt="The invoice being read" className="max-h-[640px] w-full object-contain object-top" />
              : <p className="p-4 text-xs text-ink-muted">No preview.</p>}
          </div>

          <div className="space-y-3">
            {reading.notes.length > 0 ? (
              <ul className="list-disc space-y-1 rounded-md border border-warn/40 bg-warn-soft py-2 pl-6 pr-3 text-xs text-ink">
                {reading.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            ) : null}

            <input type="hidden" name="invoice_read" value="1" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Invoice number" htmlFor="invoice_number">
                <Input id="invoice_number" name="invoice_number" defaultValue={reading.invoiceNumber ?? ''} required />
              </Field>
              <Field label={party} htmlFor="invoice_counterparty">
                <Input id="invoice_counterparty" name="invoice_counterparty" defaultValue={reading.counterparty ?? ''} required />
              </Field>
              <Field label="Invoice date" htmlFor="invoice_issue_date">
                <Input id="invoice_issue_date" type="date" name="invoice_issue_date" defaultValue={reading.issueDate ?? ''} required
                  onChange={(e) => e.target.value && onIssueDate(e.target.value)} />
              </Field>
              <Field label="Due date (optional)" htmlFor="invoice_due_date">
                <Input id="invoice_due_date" type="date" name="invoice_due_date" defaultValue={reading.dueDate ?? ''} />
              </Field>
              <Field label="Net amount (optional)" htmlFor="invoice_subtotal">
                <Input id="invoice_subtotal" name="invoice_subtotal" inputMode="decimal" defaultValue={reading.subtotal ?? ''} />
              </Field>
              <Field label="VAT (optional)" htmlFor="invoice_tax">
                <Input id="invoice_tax" name="invoice_tax" inputMode="decimal" defaultValue={reading.taxAmount ?? ''} />
              </Field>
              <Field label="Total" htmlFor="invoice_total">
                <Input id="invoice_total" name="invoice_total" inputMode="decimal" defaultValue={reading.total ?? ''} required />
              </Field>
              <Field label="Currency" htmlFor="invoice_currency" hint="Three letters, such as GBP.">
                <Input id="invoice_currency" name="invoice_currency" maxLength={3} defaultValue={reading.currency ?? 'GBP'} />
              </Field>
            </div>
            <Field label="Description (optional)" htmlFor="invoice_description">
              <Input id="invoice_description" name="invoice_description" maxLength={500} />
            </Field>

            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" name="invoice_checked" required className="mt-0.5 size-4 accent-accent" />
              <span>I have checked every field against the invoice.</span>
            </label>

            {text.trim() !== '' ? (
              <details className="text-xs text-ink-muted">
                <summary className="cursor-pointer">What APX read</summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface p-2 font-mono">{text}</pre>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** OCR of one image (a File, or a canvas of a rendered PDF page) with the self-hosted Tesseract files. */
async function ocr(image: File | HTMLCanvasElement, progress: (message: string) => void): Promise<string> {
  progress('Starting the reader on this device…');
  const { createWorker, OEM } = await import('tesseract.js');
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    ...OCR_FILES,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') progress(`Reading the text… ${Math.round(m.progress * 100)}%`);
      else if (m.status.startsWith('loading')) progress('Loading the reader (first time only)…');
    },
  });
  try {
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

/** A PDF's own text, page by page; a page without text is rendered and read with OCR. */
async function readPdf(
  file: File, progress: (message: string) => void, onPreview: (url: string) => void,
): Promise<{ text: string; method: 'text' | 'ocr' }> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/ocr/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  let usedOcr = false;
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    progress(`Reading page ${n} of ${Math.min(doc.numPages, MAX_PAGES)}…`);
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const own = linesFromItems(content.items as unknown as PdfTextItem[]);
    const needsOcr = own.replace(/\s/g, '').length < 40;
    if (n === 1 || needsOcr) {
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      if (n === 1) onPreview(canvas.toDataURL('image/png'));
      if (needsOcr) { pages.push(await ocr(canvas, progress)); usedOcr = true; continue; }
    }
    pages.push(own);
  }
  return { text: pages.join('\n'), method: usedOcr ? 'ocr' : 'text' };
}

interface PdfTextItem { str: string; transform: number[] }

/** Text items into lines: same baseline (within a couple of points) means same line, left to right. */
function linesFromItems(items: readonly PdfTextItem[]): string {
  const rows: Array<{ y: number; parts: Array<{ x: number; s: string }> }> = [];
  for (const item of items) {
    if (!item.str || !item.transform) continue;
    const x = item.transform[4]!;
    const y = item.transform[5]!;
    const row = rows.find((r) => Math.abs(r.y - y) < 2.5);
    if (row) row.parts.push({ x, s: item.str });
    else rows.push({ y, parts: [{ x, s: item.str }] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}
