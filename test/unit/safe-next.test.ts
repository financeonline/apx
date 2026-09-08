import { describe, expect, it } from 'vitest';
import { safeNextPath } from '@/core/routing';

/**
 * The `next` target (ROUTE_ARCHITECTURE.md §10; ADR-069; PRODUCTION_AUDIT.md H2).
 *
 * The finding, verbatim: `new URL('/\\evil.com', 'https://motion.example').href` is
 * `https://evil.com/`. Every case below is either a way of writing an off-origin target that a
 * leading-slash test accepts, or a legitimate path that must survive untouched — because a check
 * that is too strict sends every deep link to `/`, and people stop trusting the links.
 */

const ORIGIN = 'https://motion.example';

describe('safeNextPath refuses every way of leaving the origin', () => {
  it.each([
    ['/\\evil.com', 'backslash, which the URL parser reads as a slash'],
    ['/\\\\evil.com', 'two backslashes'],
    ['//evil.com', 'protocol-relative'],
    ['//evil.com/path', 'protocol-relative with a path'],
    ['/./\\evil.com', 'a dot segment that normalises to //evil.com'],
    ['/a/../\\evil.com', 'a parent segment that normalises to //evil.com'],
    ['https://evil.com/x', 'an absolute URL'],
    ['http://motion.example/x', 'the same host on a different scheme'],
    ['javascript:alert(1)', 'a javascript: URL'],
    ['\\evil.com', 'a backslash with no leading slash'],
    ['evil.com', 'a bare host'],
    ['', 'empty'],
  ])('%s → / (%s)', (candidate) => {
    expect(safeNextPath(candidate, ORIGIN)).toBe('/');
    // And what comes back can never resolve off-origin, whoever parses it next.
    expect(new URL(safeNextPath(candidate, ORIGIN), ORIGIN).origin).toBe(ORIGIN);
  });

  it('treats null and undefined as absent', () => {
    expect(safeNextPath(null, ORIGIN)).toBe('/');
    expect(safeNextPath(undefined, ORIGIN)).toBe('/');
  });
});

describe('safeNextPath keeps a legitimate deep link', () => {
  it.each([
    ['/app/acme/home', '/app/acme/home'],
    ['/app/acme/evidence/abc?block=x&from=20', '/app/acme/evidence/abc?block=x&from=20'],
    ['/invite/deadbeef', '/invite/deadbeef'],
    ['/%5Cevil.com', '/%5Cevil.com'],
    ['/@evil.com', '/@evil.com'],
    ['/a b', '/a%20b'],
  ])('%s → %s', (candidate, expected) => {
    expect(safeNextPath(candidate, ORIGIN)).toBe(expected);
    expect(new URL(safeNextPath(candidate, ORIGIN), ORIGIN).origin).toBe(ORIGIN);
  });

  it('drops a fragment: the server never sees one, and the browser has no use for it after a 302', () => {
    expect(safeNextPath('/app/acme/home#x', ORIGIN)).toBe('/app/acme/home');
  });
});
