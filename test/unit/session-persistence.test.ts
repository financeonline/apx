import { describe, expect, it } from 'vitest';
import { SESSION_ALIVE_COOKIE, SESSION_ONLY_COOKIE, sessionVisitEnded } from '@/core/routing';

/** "Keep me signed in" (ADR-169): which requests the middleware signs out. */
const jar = (...names: string[]) => ({ has: (name: string) => names.includes(name) });

describe('sessionVisitEnded', () => {
  it('keeps a session that asked to be kept (no marker)', () => {
    expect(sessionVisitEnded(jar())).toBe(false);
    expect(sessionVisitEnded(jar(SESSION_ALIVE_COOKIE))).toBe(false);
  });

  it('keeps a visit-only session while the browser is still open', () => {
    expect(sessionVisitEnded(jar(SESSION_ONLY_COOKIE, SESSION_ALIVE_COOKIE))).toBe(false);
  });

  it('ends a visit-only session once the browser has closed', () => {
    expect(sessionVisitEnded(jar(SESSION_ONLY_COOKIE))).toBe(true);
  });
});
