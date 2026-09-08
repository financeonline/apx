import { describe, expect, it } from 'vitest';
import {
  checkDeclaredLength, MAX_FILE_BYTES, MAX_UPLOAD_BODY_BYTES, MULTIPART_OVERHEAD_BYTES,
} from '@/modules/documents';

/**
 * The upload body limit is decided from the header, before the body is read (ADR-070;
 * PRODUCTION_AUDIT.md M1).
 */
describe('checkDeclaredLength', () => {
  it('derives the body limit from the file limit plus multipart headroom, not from a second number', () => {
    expect(MAX_UPLOAD_BODY_BYTES).toBe(MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES);
  });

  it('accepts a body at the limit and refuses one byte over it', () => {
    expect(checkDeclaredLength(String(MAX_UPLOAD_BODY_BYTES))).toBe('ok');
    expect(checkDeclaredLength(String(MAX_UPLOAD_BODY_BYTES + 1))).toBe('too_large');
    expect(checkDeclaredLength(String(2 * 1024 * 1024 * 1024))).toBe('too_large');
  });

  it('accepts a file exactly at the file limit with ordinary framing around it', () => {
    expect(checkDeclaredLength(String(MAX_FILE_BYTES + 512))).toBe('ok');
  });

  it('treats an absent, blank or non-numeric header as missing, never as small', () => {
    expect(checkDeclaredLength(null)).toBe('missing');
    expect(checkDeclaredLength(undefined)).toBe('missing');
    expect(checkDeclaredLength('')).toBe('missing');
    expect(checkDeclaredLength('abc')).toBe('missing');
    expect(checkDeclaredLength('-1')).toBe('missing');
    expect(checkDeclaredLength('1e9')).toBe('missing');
  });

  it('refuses a length too large to represent safely rather than overflowing into "ok"', () => {
    expect(checkDeclaredLength('99999999999999999999')).toBe('too_large');
  });

  it('tolerates surrounding whitespace, which proxies sometimes add', () => {
    expect(checkDeclaredLength(' 1024 ')).toBe('ok');
  });
});
