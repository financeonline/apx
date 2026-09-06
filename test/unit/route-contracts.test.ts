import { readdirSync, statSync } from 'node:fs';
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
