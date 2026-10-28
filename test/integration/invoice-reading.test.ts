import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startImport } from '@/modules/imports';
import { clientFor, createAuthUser, deleteOrg, rpc } from './setup';
import { makeOrg, rowOf, rowsOf } from './f-fixtures';

/**
 * ADR-175 on a real database: ONE invoice as a photo, with the fields the reviewer checked on the
 * upload page, goes through the wizard, becomes a one-row `ocr` batch dated to the invoice alone,
 * and commits as an ordinary purchase invoice whose document is the photo.
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.invoicereading.itest.motion`;
let owner: string;
let orgId: string;
const ownerDb = () => clientFor(owner, { email: `owner@${DOMAIN}` });

/** The smallest valid PNG: a 1×1 pixel. The wizard checks the magic bytes, not the picture. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const checked = {
  invoiceNumber: 'CPS-4471', counterparty: 'Coastal Packaging Supplies Ltd', issueDate: '2026-09-18', dueDate: '2026-10-18',
  subtotal: '640.00', taxAmount: '128.00', total: '768.00', currency: 'GBP', description: '', checked: true as const,
};

beforeAll(async () => {
  owner = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await makeOrg(owner, `ITest Docs InvoiceReading ${RUN}`);
});

afterAll(async () => {
  await deleteOrg(orgId);
});


describe('one invoice read on the upload page (ADR-175)', () => {
  it('refuses an invoice photo without checked fields', async () => {
    await expect(startImport({
      organizationId: orgId, userId: owner, requestId: `itest-${RUN}`, db: ownerDb(),
      file: new File([PNG], 'bare.png', { type: 'image/png' }),
      importType: 'purchase_invoices', periodStart: '2026-09-01', periodEnd: '2026-09-30', bankAccountId: null,
    })).rejects.toThrow(/reads an invoice photo on this page/);
  });

  it('refuses checked fields on a type that is not an invoice', async () => {
    await expect(startImport({
      organizationId: orgId, userId: owner, requestId: `itest-${RUN}`, db: ownerDb(),
      file: new File([PNG], 'gl.png', { type: 'image/png' }),
      importType: 'general_ledger', periodStart: '2026-09-01', periodEnd: '2026-09-30', bankAccountId: null,
      checkedInvoice: checked,
    })).rejects.toThrow(/sales or purchase invoice/);
  });

  it('imports the checked fields as one purchase invoice dated to itself', async () => {
    const result = await startImport({
      organizationId: orgId, userId: owner, requestId: `itest-${RUN}`, db: ownerDb(),
      file: new File([PNG], 'invoice.png', { type: 'image/png' }),
      // The form said September; one invoice covers its own date only.
      importType: 'purchase_invoices', periodStart: '2026-09-01', periodEnd: '2026-09-30', bankAccountId: null,
      checkedInvoice: checked,
    });
    expect(result.counts).toMatchObject({ valid: 1 });
    expect(result.counterpartiesCreated).toBe(1);

    const b = (await rowOf(orgId, 'import_batches', result.batchId))!;
    const opening = ((b.confirmations as Record<string, { value?: { opening?: string } }>)['IMP-INV-013'])?.value?.opening;
    expect([b.extraction_method, b.period_start, b.period_end, opening, (b.required_confirmations as string[]).join(',')].join('|'))
      .toBe('ocr|2026-09-18|2026-09-18|partial|IMP-RANGE-015,IMP-INV-013');

    const { error: rangeError } = await rpc(ownerDb(), 'record_batch_confirmation', {
      p_batch: result.batchId, p_code: 'IMP-RANGE-015', p_value: { period_start: '2026-09-18', period_end: '2026-09-18' },
    });
    expect(rangeError, rangeError?.message).toBeNull();
    const { error } = await rpc(ownerDb(), 'commit_import_batch', { p_batch: result.batchId });
    expect(error, error?.message).toBeNull();

    const [i] = await rowsOf(orgId, 'invoices', { invoice_number: 'CPS-4471' });
    const c = await rowOf(orgId, 'counterparties', String(i!.counterparty_id));
    expect([i!.invoice_type, c?.name, i!.issue_date, i!.due_date, i!.subtotal, i!.tax_amount, i!.total_amount,
      i!.assurance_level, i!.source_document_id === result.documentId].join('|'))
      .toBe('purchase|Coastal Packaging Supplies Ltd|2026-09-18|2026-10-18|640.00|128.00|768.00|verified|true');
  });

  it('refuses the ocr method in SQL for anything but an invoice', async () => {
    const [doc] = (await rowsOf(orgId, 'source_documents')).map((d) => String(d.id));
    const { error } = await rpc(ownerDb(), 'start_import_batch', {
      p_document: doc, p_import_type: 'general_ledger', p_opts: { extraction_method: 'ocr' },
    });
    expect(error?.message).toMatch(/only a sales or purchase invoice/);
  });
});
