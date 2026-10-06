import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, validateFile } from '@/modules/documents';
import { SUBMIT_RECEIPTS_TOOL, extractReceipts, type ModelResponse, type ModelTransport } from '@/modules/ai';

/** Receipt photos (ADR-150): what is accepted, and what the reader will and will not take back. */

const jpeg = (size = 64) => { const b = new Uint8Array(size); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const gif = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);

describe('a receipt photo at the door', () => {
  it('accepts JPEG and PNG by their bytes, as one page with no text layer', () => {
    expect(validateFile({ filename: 'till.jpg', declaredMimeType: 'image/jpeg', bytes: jpeg() })).toMatchObject({ ok: true, detectedKind: 'image', pageCount: 1, hasTextLayer: false });
    expect(validateFile({ filename: 'till.png', declaredMimeType: 'image/png', bytes: png() })).toMatchObject({ ok: true, detectedKind: 'image' });
  });
  it('refuses a GIF, a CSV wearing a .jpg name, and a photo over 5 MB', () => {
    expect(validateFile({ filename: 'till.png', bytes: gif() }).findings[0]?.message).toMatch(/not a JPEG or PNG/);
    expect(validateFile({ filename: 'till.jpg', bytes: new TextEncoder().encode('date,amount\n2026-01-01,4.00\n') }).findings[0]?.code).toBe('IMP-FILE-001');
    expect(validateFile({ filename: 'huge.jpg', bytes: jpeg(MAX_IMAGE_BYTES + 1) }).findings[0]?.code).toBe('IMP-FILE-009');
  });
});

const answer = (input: unknown): ModelTransport => async () => ({
  content: [{ type: 'tool_use', id: 't', name: SUBMIT_RECEIPTS_TOOL, caller: { type: 'direct' }, input } as ModelResponse['content'][number]],
  stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 }, model: 'scripted',
});
const read = (input: unknown, pages = 1) => extractReceipts({ mediaType: 'image/jpeg', bytes: jpeg(), pages, transport: answer(input) });
const ok = { page: 1, index: 1, date: '2026-03-04', supplier: 'Ryman', total: '24.99' };

describe('what the reader takes back', () => {
  it('a receipt with a date, who was paid and a positive total', async () => {
    expect(await read({ receipts: [ok], confidence: 'high', notes: [] })).toMatchObject({ ok: true, read: { receipts: [ok] } });
  });
  it('nothing outside the contract: a negative total, a made-up field, a page the file lacks', async () => {
    expect((await read({ receipts: [{ ...ok, total: '-24.99' }], confidence: 'high', notes: [] })).ok).toBe(false);
    expect((await read({ receipts: [{ ...ok, account: 'Office costs' }], confidence: 'high', notes: [] })).ok).toBe(false);
    expect(await read({ receipts: [{ ...ok, page: 2 }], confidence: 'high', notes: [] })).toMatchObject({ ok: false, reason: 'the model answered for page 2 of 1' });
  });
});
