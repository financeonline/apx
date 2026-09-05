/**
 * Just enough ZIP to answer the questions IMPORT_ENGINE.md §4 (`IMP-FILE-003`) asks of an XLSX:
 * is the container structurally sound, does it hold `[Content_Types].xml` and `xl/workbook.xml`,
 * does it hold `xl/vbaProject.bin`, does it hold external links, and does it claim to expand to
 * something absurd (SECURITY_MODEL.md §8 step 3).
 *
 * Every one of those is answered from the central directory alone — entry names and the two size
 * fields — so nothing is decompressed here. That is deliberate: a validator that inflates attacker
 * -controlled data before deciding whether to trust it has the order backwards, and it is also why
 * this needs no ZIP dependency at all.
 */

/** Little-endian signatures, as they appear in the byte stream. */
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const CENTRAL_ENTRY_FIXED_SIZE = 46;
/** The ZIP comment length field is 16-bit, so the EOCD cannot start further back than this. */
const MAX_EOCD_SEARCH = EOCD_FIXED_SIZE + 0xffff;
/** ZIP64 marks an overflowed field with all-ones. */
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface ZipDirectory {
  readonly ok: true;
  readonly entries: readonly ZipEntry[];
}

export interface ZipUnreadable {
  readonly ok: false;
  readonly detail: string;
}

export type ZipReadResult = ZipDirectory | ZipUnreadable;

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const earliest = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let offset = bytes.length - EOCD_FIXED_SIZE; offset >= earliest; offset -= 1) {
    if (readU32(bytes, offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

/** Entry names are UTF-8 when bit 11 of the flags is set and CP437 otherwise; OOXML always sets it. */
function decodeEntryName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Reads the central directory. Returns why it could not, never a partial or guessed listing. */
export function readZipDirectory(bytes: Uint8Array): ZipReadResult {
  if (bytes.length < EOCD_FIXED_SIZE) {
    return { ok: false, detail: 'The file is too short to be a ZIP container.' };
  }
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd === -1) {
    return { ok: false, detail: 'The ZIP end-of-central-directory record is missing.' };
  }

  const entryCount = readU16(bytes, eocd + 10);
  const directorySize = readU32(bytes, eocd + 12);
  const directoryOffset = readU32(bytes, eocd + 16);

  if (directoryOffset === ZIP64_SENTINEL || directorySize === ZIP64_SENTINEL) {
    // Unreachable under the 25 MB cap (`IMP-FILE-002`), which is checked first: ZIP64 only appears
    // past 4 GB or 65,535 entries. Refused rather than guessed at, so a future cap change surfaces
    // here instead of silently reading the wrong offsets.
    return { ok: false, detail: 'This ZIP uses ZIP64 extensions, which MOTION does not read.' };
  }
  if (directoryOffset + directorySize > bytes.length) {
    return { ok: false, detail: 'The ZIP central directory points outside the file.' };
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_ENTRY_FIXED_SIZE > bytes.length) {
      return { ok: false, detail: 'The ZIP central directory ends part way through an entry.' };
    }
    if (readU32(bytes, cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      return { ok: false, detail: `ZIP entry ${index + 1} has no central-directory signature.` };
    }
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const nameStart = cursor + CENTRAL_ENTRY_FIXED_SIZE;
    if (nameStart + nameLength > bytes.length) {
      return { ok: false, detail: 'A ZIP entry name runs past the end of the file.' };
    }
    entries.push({
      name: decodeEntryName(bytes.subarray(nameStart, nameStart + nameLength)),
      compressedSize,
      uncompressedSize,
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return { ok: true, entries };
}
