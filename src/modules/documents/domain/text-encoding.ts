/**
 * CSV text decoding (IMPORT_ENGINE.md §4 `IMP-FILE-005`, SECURITY_MODEL.md §8 step 2).
 *
 * The order is fixed and stated identically in both documents: BOM → strict UTF-8 → Windows-1252,
 * and a file with NUL bytes or with sequences undecodable in both encodings is refused. It matters
 * because a UK bank export containing `£` is Windows-1252 far more often than it is UTF-8, and
 * decoding it as UTF-8 with replacement characters would put `Â£` into a description that a
 * reviewer then has to correct row by row — a silent corruption, which SOW §23 forbids as surely as
 * a dropped line.
 *
 * Windows-1252 is decoded by an explicit table rather than by `TextDecoder('windows-1252')`:
 *
 *   1. The WHATWG decoder never fails — it maps the five unassigned bytes (0x81, 0x8D, 0x8F, 0x90,
 *      0x9D) onto C1 control characters — so "undecodable in both encodings" would have no trigger
 *      at all and arbitrary binary would sail through as text.
 *   2. Legacy single-byte encodings are only present in a full-ICU Node build. A validator that
 *      behaves differently on two deployments is not a validator.
 */

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  readonly ok: true;
  readonly encoding: CsvEncoding;
  readonly text: string;
  /** True when a byte-order mark was present and stripped. */
  readonly hadBom: boolean;
}

export interface UndecodableText {
  readonly ok: false;
  /** `nul_byte`: a NUL survived decoding. `undecodable`: neither UTF-8 nor Windows-1252 accepted it. */
  readonly reason: 'nul_byte' | 'undecodable';
  readonly detail: string;
}

export type DecodeResult = DecodedText | UndecodableText;

/**
 * Windows-1252 differs from Latin-1 only in 0x80–0x9F. `null` marks the five byte values the
 * encoding does not define; they are treated as undecodable rather than mapped to a control
 * character, so a JPEG renamed `.csv` cannot masquerade as text.
 */
const CP1252_HIGH: readonly (number | null)[] = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** Decodes Windows-1252, or returns the offset of the first byte the encoding does not define. */
function decodeWindows1252(bytes: Uint8Array): { text: string } | { badOffset: number } {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    if (byte < 0x80 || byte > 0x9f) {
      out.push(byte);
      continue;
    }
    const mapped = CP1252_HIGH[byte - 0x80];
    if (mapped === null || mapped === undefined) return { badOffset: i };
    out.push(mapped);
  }
  // Chunked so a 25 MB file does not blow the argument limit of String.fromCharCode.
  const CHUNK = 8192;
  let text = '';
  for (let i = 0; i < out.length; i += CHUNK) {
    text += String.fromCharCode(...out.slice(i, i + CHUNK));
  }
  return { text };
}

/** UTF-16BE by byte-swapping into UTF-16LE: `TextDecoder('utf-16be')` needs full ICU, this does not. */
function decodeUtf16Be(bytes: Uint8Array): string {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1] as number;
    swapped[i + 1] = bytes[i] as number;
  }
  return new TextDecoder('utf-16le').decode(swapped);
}

function decodedOrNul(encoding: CsvEncoding, text: string, hadBom: boolean): DecodeResult {
  const nul = text.indexOf('\u0000');
  if (nul !== -1) {
    // Checked on the DECODED text, not the raw bytes: every second byte of a UTF-16 file is NUL and
    // that file is perfectly legitimate. What is never legitimate is a NUL character in a CSV cell.
    return {
      ok: false,
      reason: 'nul_byte',
      detail: `A NUL character appears at position ${nul} of the decoded text.`,
    };
  }
  return { ok: true, encoding, text, hadBom };
}

/**
 * Decodes CSV bytes under the §4 detection order and reports the encoding it settled on, which the
 * caller records in `transforms.encoding` so a re-import of the same export decodes identically.
 */
export function decodeCsvBytes(bytes: Uint8Array): DecodeResult {
  if (startsWith(bytes, [...UTF8_BOM])) {
    const strict = new TextDecoder('utf-8', { fatal: true });
    try {
      return decodedOrNul('utf-8', strict.decode(bytes.subarray(3)), true);
    } catch {
      // A UTF-8 BOM followed by bytes that are not UTF-8 is a corrupt export, not a Windows-1252
      // one. Falling back here would "fix" it into mojibake instead of telling the user.
      return {
        ok: false,
        reason: 'undecodable',
        detail: 'The file starts with a UTF-8 byte-order mark but the bytes after it are not UTF-8.',
      };
    }
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return decodedOrNul('utf-16le', new TextDecoder('utf-16le').decode(bytes.subarray(2)), true);
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return decodedOrNul('utf-16be', decodeUtf16Be(bytes.subarray(2)), true);
  }

  try {
    return decodedOrNul('utf-8', new TextDecoder('utf-8', { fatal: true }).decode(bytes), false);
  } catch {
    // Not UTF-8 — the ordinary case for a UK export with `£`, `–` or a smart quote in it.
  }

  const fallback = decodeWindows1252(bytes);
  if ('badOffset' in fallback) {
    return {
      ok: false,
      reason: 'undecodable',
      detail:
        `Byte ${fallback.badOffset} is not valid in UTF-8 and is undefined in Windows-1252, ` +
        'so this file is not text.',
    };
  }
  return decodedOrNul('windows-1252', fallback.text, false);
}
