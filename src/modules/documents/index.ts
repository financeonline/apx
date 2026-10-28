/**
 * Documents — upload, storage, scanning and text extraction (IMPORT_ENGINE.md §2–§4).
 *
 * The module sits upstream of `imports`: it decides whether a file is one MOTION will read at all,
 * and hands the parsers bytes that have already been sniffed, decoded and counted. Phase 5 delivers
 * file validation (§4); the upload route, storage write and extraction service follow.
 *
 * ADR-022: import this module through this barrel, never through a deep path.
 */
export {
  MAX_DATA_ROWS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  checkRowCap,
  validateFile,
  type DocumentValidation,
  type FileKind,
  type FileToValidate,
} from './domain/validate-file';

export {
  CSV_DELIMITERS,
  MIN_CONSISTENCY,
  SNIFF_RECORDS,
  countRecords,
  sniffDelimiter,
  type CsvDelimiter,
} from './domain/delimiter';

export { decodeCsvBytes, type CsvEncoding, type DecodeResult } from './domain/text-encoding';

export {
  checkDeclaredLength,
  MAX_UPLOAD_BODY_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  type DeclaredLengthVerdict,
} from './domain/upload-limits';

export { MAX_PDF_PAGES, probePdf, type PdfProbeResult } from './domain/pdf-probe';

export { readZipDirectory, type ZipEntry, type ZipReadResult } from './domain/zip';

export {
  suggestImportType,
  uploadDocument,
  type UploadContext,
  type UploadInput,
  type UploadResult,
} from './services/upload';
export { listDocuments, getDocument, getDocumentObject, deleteDocument, deletable, type DocumentSummary } from './services/library';
