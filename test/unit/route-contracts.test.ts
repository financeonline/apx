import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural contracts of the route tree that no amount of reading a page can enforce.
 *
 * A file's mere EXISTENCE is the defect here, which is why this is a filesystem test rather than a
 * lint rule: there is nothing in any source file to flag.
 */

const TENANT_SHELL = 'src/app/app/[orgSlug]';

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

describe('the tenant shell answers 404 with a 404 (ROUTE_ARCHITECTURE.md §230)', () => {
  /*
   * A segment-level `loading.tsx` wraps that segment's page in a Suspense boundary, so Next commits
   * the response — headers and status — before the page runs. A page that then calls `notFound()`
   * can swap the body and not the status, and every route under `/app/[orgSlug]` answered 200 with
   * the not-found page: correct to a reader, wrong to a monitor, a crawler, a link checker and an
   * error budget, none of which read the body (ADR-059.8).
   *
   * Nearly every page in this family calls `notFound()` — for a resource that is not there, for one
   * that belongs to somebody else, or for a permission the caller lacks — so there is no segment
   * here where a `loading.tsx` would be safe. A page that needs a loading state puts `<Suspense>`
   * inside itself, BELOW its not-found decisions, where the status has already been settled.
   */
  it('has no segment-level loading.tsx anywhere in it', () => {
    const offenders = walk(TENANT_SHELL)
      .filter((path) => path.endsWith('loading.tsx'))
      .map((path) => path.replace(`${TENANT_SHELL}/`, ''));

    expect(
      offenders,
      'a loading.tsx here commits the response before a page can call notFound(); '
      + 'put <Suspense> inside the page instead, below its not-found decisions',
    ).toEqual([]);
  });

  it('still has the uniform not-found page the shell renders', () => {
    const files = walk(TENANT_SHELL);
    expect(files).toContain(join(TENANT_SHELL, 'not-found.tsx'));
    expect(files).toContain(join(TENANT_SHELL, 'error.tsx'));
  });
});

describe('every consumer of a `next` target judges it with the one rule (ROUTE_ARCHITECTURE.md §10, ADR-069)', () => {
  /*
   * Three call sites each wrote their own "is this a relative path?" test, and all three accepted
   * `/\evil.com`, which the URL parser reads as `https://evil.com/` (PRODUCTION_AUDIT.md H2). The
   * rule now lives in `core/routing`; this asserts that nothing reads a `next` parameter without
   * going through it — a fourth call site written the old way would fail here, not in production.
   */
  it('imports safeNextPath wherever a next parameter is read', () => {
    const readers = walk('src')
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .filter((path) => /\.get\('next'\)|searchParams\.next\b/.test(readFileSync(path, 'utf8')));

    // Two READ a next target (the callback and the sign-in form); the proxy (src/proxy.ts) only PRODUCES one,
    // and it builds that from the request path through the same function.
    expect(readers.length, 'the callback and the sign-in form read next').toBeGreaterThanOrEqual(2);
    expect(readFileSync('src/proxy.ts', 'utf8')).toMatch(/safeNextPath\(/);
    for (const path of readers) {
      expect(readFileSync(path, 'utf8'), `${path} reads a next target without safeNextPath`)
        .toMatch(/from '@\/core\/routing'/);
    }
  });
});

describe('the nightly sweep is scheduled (SERVICE_ARCHITECTURE.md §7, ADR-074)', () => {
  it('vercel.json names both cron routes, and both exist', () => {
    const crons = (JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Array<{ path: string; schedule: string }> }).crons;
    const paths = crons.map((c) => c.path);
    expect(paths).toContain('/api/jobs/run');
    expect(paths).toContain('/api/jobs/nightly');
    // ADR-135: the daily recalculation is enqueued hourly so each organisation is due just after ITS
    // midnight; the database keeps it to one per organisation and local date.
    expect(crons.find((c) => c.path === '/api/jobs/scheduled')?.schedule, 'hourly').toMatch(/^\d+ \* \* \* \*$/);
    expect(crons.find((c) => c.path === '/api/jobs/nightly')?.schedule, 'once a day, not once a minute').toMatch(/^\d+ \d+ \* \* \*$/);
    for (const path of paths) {
      expect(statSync(join('src/app', path, 'route.ts')).isFile(), `${path} has a handler`).toBe(true);
    }
  });
});
