/**
 * The run fingerprint (FINANCIAL_ENGINE.md §2.4, ADR-047.8).
 *
 * Computed from aggregate METADATA before any write, and compared with the last succeeded run. An
 * equal fingerprint means nothing the engine reads has changed, so the run finishes immediately
 * instead of rewriting a year of identical snapshots.
 *
 * What goes in is the whole design. Everything that can change a number must be in it, or a real
 * change would be mistaken for no change and the dashboard would silently go stale. Equally,
 * nothing that cannot change a number may be in it, or every run would look different and the
 * optimisation would never fire. In particular `asOf` enters ONLY when the current period is in
 * range: that is what makes a daily scheduled run recompute aging and runway for this month and
 * nothing else.
 *
 * Pure and order-independent: every collection is sorted before hashing, so two runs over identical
 * data produce identical fingerprints regardless of the order the database returned rows in.
 */

import { createHash } from 'node:crypto';

export interface FingerprintInput {
  readonly organizationId: string;
  readonly engineVersion: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  /** The latest lifecycle event instant per source — the cheapest proxy for "did any record move". */
  readonly maxRecordEventAt: string | null;
  /** Row counts per source, so a deletion that leaves the max instant unchanged is still caught. */
  readonly rowCounts: Readonly<Record<string, number>>;
  /** account id → standard category. A remap changes every metric the account feeds. */
  readonly accountCategories: Readonly<Record<string, string>>;
  /** bank transaction id → the current category history head, for categorisation edits. */
  readonly categoryHistoryHeads: Readonly<Record<string, string>>;
  /** counterparty id → survivor, so a merge is caught. */
  readonly counterpartyMerges: Readonly<Record<string, string>>;
  /** Organization settings that change figures: currency, fiscal year, VAT. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** The banking detector version; changing the detector must change the fingerprint (§4.3). */
  readonly detectorVersion: string;
  /**
   * Today, included ONLY when the range reaches the current period. Including it always would make
   * every run look different; never including it would freeze aging and runway (ADR-047.8).
   */
  readonly asOfDate: string | null;
}

/** Deterministic serialisation: sorted keys, sorted arrays, no whitespace. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${[...value].map(canonical).sort().join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function computeFingerprint(input: FingerprintInput): string {
  return createHash('sha256').update(canonical(input), 'utf8').digest('hex');
}

/** Exported for tests: the serialisation is the fingerprint's whole behaviour. */
export const __canonical = canonical;
