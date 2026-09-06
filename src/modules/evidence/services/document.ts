import 'server-only';
import { NotFound, toMotionError } from '@/core/errors';
import { assertCan, can } from '@/core/permissions';
import type { AccessContext } from '@/modules/tenancy';
import { ITEM_TYPE_TABLE, LIFECYCLE_TABLES, isPinnedItemType } from '../data/bundles';
import { requireOrgId } from './resolve';

/**
 * Level 4 of the drawer: the source document a record came from (EVIDENCE_MODEL.md §6, §9, §10).
 *
 * This resolves the reference — which file, which page or sheet, which line — and says whether the
 * caller may open it. It does **not** mint the signed URL. §9's sketch has `getDocumentReference`
 * returning `signedUrl?`, and doing that here would mean minting a 60-second URL at render time: by
 * the time a reader had finished level 3 and clicked, it would be dead, and isolation case 5
 * ("replayed signed URL after 60 s") would be describing normal use rather than an attack. The URL
 * is minted at the click instead, by `GET /api/documents/[documentId]/url`, which writes the
 * `document.downloaded` audit row the signer then verifies before it signs anything
 * (ROUTE_ARCHITECTURE.md §164, ADR-043.5).
 *
 * `locked` is CD-17 and §10: a client sees the reference — the file's name, the page, the line — and
 * not the file. Naming what exists is not the same as handing it over, and an empty panel would look
 * like missing data rather than a decision somebody made.
 */

export interface DocumentReference {
  /** `null` when the level is locked: a client is not told which file it is, only that there is one. */
  readonly documentId: string | null;
  readonly filename: string | null;
  readonly mimeType: string | null;
  readonly pageCount: number | null;
  /** The page of a PDF the row was read from, when the extractor recorded one. */
  readonly page: number | null;
  /** The sheet of a spreadsheet, from `import_rows.source_ref` ("xlsx:Sheet1:14"). */
  readonly sheet: string | null;
  /** The row or line within the file ("csv:row:7" → 7). */
  readonly row: number | null;
  /** The raw `source_ref`, shown verbatim so a reader can find the line themselves. */
  readonly sourceRef: string | null;
  /** §10: false for the client role (`documents.view`); the panel says so rather than emptying. */
  readonly locked: boolean;
}

/**
 * `import_rows.source_ref` is written by the parsers and is one of
 * `csv:row:N` · `xlsx:<sheet>:<row>` · `pdf:page:N:line:M` (IMPORT_ENGINE.md §5).
 *
 * Parsed rather than displayed alone so the drawer can say "page 3, line 12" in words; the raw
 * string travels with it, because a reference a reader cannot check against the file is decoration.
 */
export function parseSourceRef(sourceRef: string | null): {
  page: number | null; sheet: string | null; row: number | null;
} {
  if (sourceRef === null || sourceRef === '') return { page: null, sheet: null, row: null };
  const parts = sourceRef.split(':');

  if (parts[0] === 'csv' && parts[1] === 'row') {
    return { page: null, sheet: null, row: intOrNull(parts[2]) };
  }
  if (parts[0] === 'pdf' && parts[1] === 'page') {
    return { page: intOrNull(parts[2]), sheet: null, row: intOrNull(parts[4]) };
  }
  if (parts[0] === 'xlsx' && parts.length >= 3) {
    return { page: null, sheet: parts.slice(1, -1).join(':'), row: intOrNull(parts[parts.length - 1]) };
  }
  return { page: null, sheet: null, row: null };
}

function intOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * §9: `getDocumentReference(ctx, recordRef)`.
 *
 * `recordRef` is one of the four record tables and an id — the pinned item the reader descended
 * from, or a row of the level-3 table. Summary-level data resolves the same way: §5.1's chain is
 * `period_balance → import_rows.source_ref → source_documents`, which is why `period_balances` is
 * one of the tables here rather than a special case.
 */
export async function getDocumentReference(
  ctx: AccessContext,
  recordRef: { readonly table: string; readonly id: string },
): Promise<DocumentReference> {
  assertCan(ctx, 'financials.view');
  const orgId = requireOrgId(ctx);

  if (!LIFECYCLE_TABLES.has(recordRef.table)) {
    // Only a record has a source document. A snapshot, a run or an account does not, and returning
    // a reference for one would be inventing a provenance it never had.
    throw new NotFound();
  }

  const { data, error } = await ctx.db
    .from(recordRef.table)
    .select('id, source_document_id, source_ref, import_row_id')
    .eq('organization_id', orgId)
    .eq('id', recordRef.id)
    .maybeSingle();
  if (error) throw toMotionError(error);

  const record = data as {
    source_document_id?: string | null; source_ref?: string | null; import_row_id?: string | null;
  } | null;
  const documentId = record?.source_document_id ?? null;
  if (documentId === null) {
    /*
     * A record with no document is a real state, not a failure: rows created by a rollback restore,
     * by a merge, or typed in by hand have no file behind them. NotFound is what the drawer turns
     * into "there is no source document for this row", which is the truth.
     */
    throw new NotFound();
  }

  // The import row's reference is the precise one — it is what the parser recorded for THAT line.
  // The record's own `source_ref` is a copy, and copies are the thing that drifts.
  let sourceRef = record?.source_ref ?? null;
  let page: number | null = null;
  if (record?.import_row_id) {
    const { data: rowData, error: rowError } = await ctx.db
      .from('import_rows')
      .select('source_ref, source_page')
      .eq('organization_id', orgId)
      .eq('id', record.import_row_id)
      .maybeSingle();
    if (rowError) throw toMotionError(rowError);
    const importRow = rowData as { source_ref?: string | null; source_page?: number | null } | null;
    if (importRow?.source_ref) sourceRef = importRow.source_ref;
    page = importRow?.source_page ?? null;
  }

  const parsed = parseSourceRef(sourceRef);

  if (!can(ctx, 'documents.view')) {
    /*
     * §10 and CD-17: the client role stops here. The panel says "Source documents are available to
     * owners and admins" (UX_ARCHITECTURE.md §376), and nothing about the file travels with it —
     * `source_documents` is not readable to a client under RLS in any case, so naming the file here
     * would mean reaching past the boundary to render a caption.
     *
     * The line reference is kept. It comes from `import_rows`, which a client may read, and it is
     * what lets them ask an admin for the right thing.
     */
    return {
      documentId: null,
      filename: null,
      mimeType: null,
      pageCount: null,
      page: page ?? parsed.page,
      sheet: parsed.sheet,
      row: parsed.row,
      sourceRef,
      locked: true,
    };
  }

  const { data: docData, error: docError } = await ctx.db
    .from('source_documents')
    .select('id, original_filename, mime_type, page_count')
    .eq('organization_id', orgId)
    .eq('id', documentId)
    .maybeSingle();
  if (docError) throw toMotionError(docError);
  const document = docData as {
    id: string; original_filename: string; mime_type: string; page_count: number | null;
  } | null;
  if (document === null) throw new NotFound();

  return {
    documentId: document.id,
    filename: document.original_filename,
    mimeType: document.mime_type,
    pageCount: document.page_count,
    page: page ?? parsed.page,
    sheet: parsed.sheet,
    row: parsed.row,
    sourceRef,
    locked: false,
  };
}

/** Exported for the drawer: the item types that can descend to a document at all. */
export function itemCanReachDocument(itemType: string): boolean {
  return isPinnedItemType(itemType) && LIFECYCLE_TABLES.has(ITEM_TYPE_TABLE[itemType]);
}
