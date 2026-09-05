/**
 * The PDF questions of IMPORT_ENGINE.md §4: `IMP-FILE-007` (header/xref, page count ≤ 200,
 * encrypted PDFs refused, text layer probed on the first three pages) and `IMP-FILE-008`
 * (embedded JavaScript, `/OpenAction`, `/Launch`, embedded files — SECURITY_MODEL.md §8 step 5).
 *
 * This is a probe, not a parser. It never builds the page tree and never resolves an indirect
 * reference; the positional parser of §5.3 does that, later, on a file this module has already
 * agreed to store. Keeping the two apart means the thing that decides whether a hostile file is
 * even allowed into the pipeline stays small enough to read in one sitting.
 *
 * `node:zlib` is the one import here that is not a language builtin. It is pure computation with no
 * I/O and no clock, so `domain/` purity (ADR-022) holds: the same bytes always give the same answer.
 */
import { inflateSync } from 'node:zlib';

/** §4: page count ≤ 200. */
export const MAX_PDF_PAGES = 200;
/** §4: "text layer probed on first 3 pages". */
const TEXT_LAYER_PROBE_PAGES = 3;
/** A cap on probe work; a statement's first pages are never further in than this. */
const MAX_PROBED_STREAMS = 64;
/** How far back from `stream` the object's dictionary is looked for. */
const DICTIONARY_LOOKBACK = 2048;

export interface PdfProbeResult {
  /** Populated when the container itself is not a readable PDF (`IMP-FILE-007`). */
  readonly structureError?: string;
  readonly encrypted: boolean;
  readonly pageCount: number;
  readonly hasTextLayer: boolean;
  /**
   * Active-content markers found, in the order of `ACTIVE_CONTENT_MARKERS` (`IMP-FILE-008`). A
   * non-empty list quarantines the file — it is still stored, so the reviewer and the platform can
   * see exactly what was refused (§4).
   */
  readonly activeContent: readonly string[];
}

/**
 * What a statement is never allowed to carry. `/JS` is matched only where it opens a value, because
 * `/JS` is also a legal prefix of an ordinary name and a false quarantine costs a customer their
 * upload.
 */
const ACTIVE_CONTENT_MARKERS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: '/JavaScript', pattern: /\/JavaScript\b/ },
  { label: '/JS', pattern: /\/JS\s*[(<[/]/ },
  { label: '/OpenAction', pattern: /\/OpenAction\b/ },
  { label: '/Launch', pattern: /\/Launch\b/ },
  { label: '/EmbeddedFile', pattern: /\/EmbeddedFiles?\b/ },
];

/** Byte-for-codepoint decoding. PDF syntax is ASCII; binary stream payloads must survive untouched. */
function toLatin1(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

interface RawStream {
  /** Offset of the `stream` keyword, used to keep document order. */
  readonly at: number;
  readonly dictionary: string;
  readonly body: Uint8Array;
}

function collectStreams(bytes: Uint8Array, raw: string): RawStream[] {
  const streams: RawStream[] = [];
  const opener = /stream\r\n|stream\n|stream\r/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(raw)) !== null) {
    const bodyStart = match.index + match[0].length;
    const end = raw.indexOf('endstream', bodyStart);
    if (end === -1) break;
    streams.push({
      at: match.index,
      dictionary: raw.slice(Math.max(0, match.index - DICTIONARY_LOOKBACK), match.index),
      body: bytes.subarray(bodyStart, end),
    });
    opener.lastIndex = end + 'endstream'.length;
  }
  return streams;
}

/** Inflates a FlateDecode stream, or returns null. A stream we cannot read tells us nothing. */
function inflate(stream: RawStream): string | null {
  if (!/\/Filter\s*(\[[^\]]*)?\/FlateDecode/.test(stream.dictionary)) {
    // Unfiltered content streams exist and are readable as they stand.
    return /\/Filter/.test(stream.dictionary) ? null : toLatin1(stream.body);
  }
  try {
    return toLatin1(new Uint8Array(inflateSync(Buffer.from(stream.body))));
  } catch {
    // A stream that does not inflate is not evidence of anything by itself — a cross-reference
    // stream of a linearised file often trails junk. It is skipped, never treated as a failure.
    return null;
  }
}

function countPages(text: string): number {
  // `/Type /Page` but not `/Type /Pages`: the page-tree node would double every count.
  const pageObjects = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  if (pageObjects && pageObjects.length > 0) return pageObjects.length;

  // Cross-reference-stream PDFs keep page objects inside object streams. When none were visible,
  // fall back to the largest `/Count` in the page tree rather than reporting a zero-page document.
  let largest = 0;
  const counts = /\/Count\s+(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = counts.exec(text)) !== null) {
    largest = Math.max(largest, Number(match[1]));
  }
  return largest;
}

/** Text-showing operators inside a content stream: `BT … Tj/TJ/'/"`. */
function looksLikeTextLayer(content: string): boolean {
  if (!/\bBT\b/.test(content)) return false;
  return /(\bTj\b|\bTJ\b|\)\s*'|\)\s*")/.test(content);
}

export function probePdf(bytes: Uint8Array): PdfProbeResult {
  const raw = toLatin1(bytes);
  const header = raw.slice(0, 1024);

  if (!/%PDF-[12]\.\d/.test(header)) {
    return {
      structureError: 'This file does not start with a PDF header.',
      encrypted: false,
      pageCount: 0,
      hasTextLayer: false,
      activeContent: [],
    };
  }
  if (!raw.includes('startxref') || !raw.includes('%%EOF')) {
    // A PDF without a cross-reference pointer or a terminator is truncated. Reading it would give
    // a plausible-looking half of a bank statement, which is worse than refusing it.
    return {
      structureError: 'This PDF is incomplete: its cross-reference table or end marker is missing.',
      encrypted: false,
      pageCount: 0,
      hasTextLayer: false,
      activeContent: [],
    };
  }

  const streams = collectStreams(bytes, raw);
  const inflated = streams.slice(0, MAX_PROBED_STREAMS).map(inflate);
  // Object streams hide dictionaries from a raw scan, so page objects and action dictionaries are
  // counted over the decompressed text as well as the raw file.
  const searchable = raw + inflated.filter((text): text is string => text !== null).join('\n');

  const pageCount = countPages(searchable);
  const activeContent = ACTIVE_CONTENT_MARKERS.filter((m) => m.pattern.test(searchable)).map(
    (m) => m.label,
  );

  // `/Encrypt` in the trailer: names are never encrypted, so this is visible even when every string
  // in the file is not.
  const encrypted = /\/Encrypt\b/.test(raw);

  // "The first 3 pages" without a page tree: streams are examined in document order and the budget
  // is scaled to the share of the document those pages represent. Exact page attribution belongs to
  // the §5.3 parser; all this decides is `has_text_layer`, and a statement's text starts on page 1.
  const perPage = pageCount > 0 ? Math.ceil(inflated.length / pageCount) : inflated.length;
  const budget = Math.max(TEXT_LAYER_PROBE_PAGES, perPage * TEXT_LAYER_PROBE_PAGES);
  const hasTextLayer = inflated
    .slice(0, budget)
    .some((content) => content !== null && looksLikeTextLayer(content));

  return { encrypted, pageCount, hasTextLayer, activeContent };
}
