/**
 * Filename sanitisation — pure, so a `domain/` module can use it without dragging `server-only` and
 * the Firebase Admin SDK into its import graph.
 *
 * It lives here rather than in `signer.ts` because two callers need the same rule: the signer, which
 * builds the object key, and `api_server.register_document`'s TypeScript-side twin in document
 * validation. A second copy of this rule is a second place for a traversal to slip through.
 */

/**
 * Reduces a user-supplied filename to one safe path segment.
 *
 * Replacing the disallowed characters is not enough on its own: `.` is a legal filename character,
 * so `../../etc/passwd` becomes `.._.._etc_passwd`, and a filename of exactly `..` would become a
 * traversal segment. Runs of dots are therefore collapsed and leading dots stripped, which also
 * removes the dotfile case. A name that sanitises away entirely falls back rather than producing an
 * empty segment. A SQL twin in migration ..._22 must agree; a test asserts it does.
 */
export function sanitiseFilename(filename: string): string {
  const collapsed = filename
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '');
  const trimmed = collapsed.slice(0, 120).replace(/[._-]+$/, '');
  return trimmed === '' ? 'upload' : trimmed;
}
