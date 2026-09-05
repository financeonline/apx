import { describe, expect, it } from 'vitest';

import {
  __testing, extractedTextKey, reportKey, sourceDocumentKey,
} from '@/core/storage/signer';

/**
 * The signer holds the service role, which bypasses RLS, so its key assertion is the tenant boundary
 * for object storage (TENANCY_MODEL.md §8, ADR-038.1). There is no database policy behind it to
 * catch a mistake, which is why it is tested directly rather than only through the routes.
 */

const { assertKeyBelongsTo, SIGNED_URL_TTL_SECONDS, AUDIT_MAX_AGE_SECONDS } = __testing;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('the object key must belong to the caller', () => {
  it('accepts a key under the caller own prefix', () => {
    expect(() => assertKeyBelongsTo(ORG, `${ORG}/doc-1/statement.pdf`)).not.toThrow();
  });

  it('refuses another organization prefix', () => {
    expect(() => assertKeyBelongsTo(ORG, `${OTHER}/doc-1/statement.pdf`)).toThrow();
  });

  it('refuses traversal out of the prefix', () => {
    expect(() => assertKeyBelongsTo(ORG, `${ORG}/../${OTHER}/doc-1/statement.pdf`)).toThrow();
  });

  it('refuses an absolute key and an empty key', () => {
    expect(() => assertKeyBelongsTo(ORG, `/${ORG}/doc-1/f.pdf`)).toThrow();
    expect(() => assertKeyBelongsTo(ORG, '')).toThrow();
  });

  it('refuses a prefix that merely starts with the same characters', () => {
    // `${ORG}extra/...` shares a prefix with the organization id but is a different tenant's space.
    // The trailing slash in the check is what makes this safe.
    expect(() => assertKeyBelongsTo(ORG, `${ORG}extra/doc-1/f.pdf`)).toThrow();
  });

  it('reports a foreign key as not-found rather than forbidden', () => {
    // A 403 would confirm the object exists for somebody (SECURITY_MODEL.md §14).
    try {
      assertKeyBelongsTo(ORG, `${OTHER}/doc-1/f.pdf`);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).constructor.name).toBe('NotFound');
    }
  });
});

describe('keys are built only from server-generated parts', () => {
  it('sanitises a hostile filename rather than trusting it', () => {
    const key = sourceDocumentKey(ORG, 'doc-1', '../../etc/passwd');
    expect(key.startsWith(`${ORG}/doc-1/`)).toBe(true);
    expect(key).not.toContain('..');
    expect(() => assertKeyBelongsTo(ORG, key)).not.toThrow();
  });

  it('survives a filename that sanitises to nothing', () => {
    const key = sourceDocumentKey(ORG, 'doc-1', '///');
    expect(key).toBe(`${ORG}/doc-1/upload`);
  });

  it('caps a very long filename', () => {
    const key = sourceDocumentKey(ORG, 'doc-1', `${'a'.repeat(500)}.csv`);
    expect(key.length).toBeLessThan(ORG.length + 'doc-1'.length + 130);
  });

  it('places the text sidecar and reports under the same tenant prefix', () => {
    expect(extractedTextKey(ORG, 'doc-1')).toBe(`${ORG}/doc-1/text.json`);
    expect(reportKey(ORG, '2026-03', 'job-1')).toBe(`${ORG}/2026-03/job-1.pdf`);
    expect(() => assertKeyBelongsTo(ORG, reportKey(ORG, '2026-03', 'job-1'))).not.toThrow();
  });
});

describe('the signing window', () => {
  it('is short enough not to be shareable and long enough to follow', () => {
    expect(SIGNED_URL_TTL_SECONDS).toBe(60);
  });

  it('accepts only an audit event from this request', () => {
    expect(AUDIT_MAX_AGE_SECONDS).toBe(30);
  });
});
