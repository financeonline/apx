/**
 * Description masking (IMPORT_ENGINE.md §6.4 "Masking", ADR-038.4, finding F-A-08).
 *
 * `description_raw` and `raw_data` keep the source text verbatim; `description_normalized` is the
 * only description a client role, an export or an AI tool output ever sees, so a third party's
 * account number must not survive into it.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THIS FUNCTION HAS A TWIN in the database layer: `maskDescription` in
 * `src/db/app/imports-records.ts` (the port of the `app.mask_description()` trigger on
 * `bank_transactions`). The two MUST agree character for character: the database layer is what
 * actually writes the column, and this copy is what the import preview and the row-validation
 * screen show the reviewer. A divergence would show a reviewer one string and store another.
 * A parity test (test/unit/import-transforms.test.ts) asserts they agree on the same inputs.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The SQL is, verbatim:
 *   v_text := regexp_replace(v_text, '\m(\d{2})-(\d{2})-(\d{2})\M', '****\2\3', 'g');
 *   v_text := regexp_replace(v_text, '\m\d{2,4}(\d{4})\M', '****\1', 'g');
 *   new.description_normalized := nullif(btrim(regexp_replace(v_text, '\s+', ' ', 'g')), '');
 */

/**
 * Postgres `\m` and `\M` are the beginning and end of a word, where a word character is an
 * alphanumeric or an underscore. JavaScript's `\b` uses ASCII `[A-Za-z0-9_]` only, so the boundary
 * is written out with Unicode property escapes instead — otherwise "Zahlung12345678" would be
 * masked here and left alone by Postgres.
 */
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}_])';

/**
 * Sort codes first. `12-34-56` would otherwise be partly eaten by the digit-run rule below, and
 * both patterns collapse to the same shape: `****` plus the last four digits (ADR-038.4).
 */
const SORT_CODE = new RegExp(`${NOT_WORD_BEFORE}(\\d{2})-(\\d{2})-(\\d{2})${NOT_WORD_AFTER}`, 'gu');

/**
 * Account numbers: a whole word of 6 to 8 digits keeps only its last four. A run of 5 or fewer is a
 * reference or an amount, not an account number, and a run of 9 or more is neither; both are left
 * alone, exactly as the SQL leaves them.
 */
const ACCOUNT_NUMBER = new RegExp(`${NOT_WORD_BEFORE}\\d{2,4}(\\d{4})${NOT_WORD_AFTER}`, 'gu');

/**
 * Build `description_normalized` from `description_raw`.
 *
 * Returns `null` for an empty result, matching the SQL's `nullif(btrim(...), '')`: an empty
 * description is "no description", not the empty string.
 */
export function maskDescription(raw: string | null | undefined): string | null {
  let text = raw ?? '';
  text = text.replace(SORT_CODE, '****$2$3');
  text = text.replace(ACCOUNT_NUMBER, '****$1');
  // Postgres `\s` is ASCII whitespace and `btrim(x)` with no second argument trims SPACES only.
  // JavaScript's `\s` also matches a no-break space, so an ASCII class is spelled out here: a
  // description beginning with U+00A0 must come out of both implementations identically.
  const collapsed = text.replace(/[ \t\n\r\f\v]+/gu, ' ').replace(/^ +/u, '').replace(/ +$/u, '');
  return collapsed === '' ? null : collapsed;
}
