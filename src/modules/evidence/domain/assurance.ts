/**
 * Assurance propagation (EVIDENCE_MODEL.md §7).
 *
 * Bundle assurance is the minimum over its items in the order verified > calculated > estimated >
 * inferred, so a finding backed by one Claude-extracted PDF row is `inferred` however exact the
 * arithmetic on top of it was. The *labels* for these values live in one place only —
 * `UX_ARCHITECTURE.md §8.1` (ADR-037) — and are deliberately not restated here.
 */

export const ASSURANCE_LEVELS = ['verified', 'calculated', 'estimated', 'inferred'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

/** Descending strength; the index is the rank used by `minAssurance`. */
const RANK: Record<AssuranceLevel, number> = {
  verified: 0,
  calculated: 1,
  estimated: 2,
  inferred: 3,
};

export function isAssuranceLevel(value: unknown): value is AssuranceLevel {
  return typeof value === 'string' && value in RANK;
}

/**
 * The weakest level in the list, or `null` for an empty list.
 *
 * `null` rather than a default: §8.6 says a claim whose bundle would be empty is downgraded and not
 * shown at all, so inventing `verified` here would paper over exactly the case the rule exists for.
 */
export function minAssurance(levels: readonly AssuranceLevel[]): AssuranceLevel | null {
  let weakest: AssuranceLevel | null = null;
  for (const level of levels) {
    if (weakest === null || RANK[level] > RANK[weakest]) weakest = level;
  }
  return weakest;
}
