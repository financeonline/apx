/**
 * The assurance ladder (EVIDENCE_MODEL.md §7, UX_ARCHITECTURE.md §8.1; ADR-094).
 *
 * `verified > calculated > estimated > inferred`, and a derived figure is never firmer than its
 * softest input — so a finding backed by one Claude-extracted PDF row is `inferred` however exact
 * the arithmetic on top of it was.
 *
 * It lives in `core` because two modules need the same vocabulary and neither owns it. Before this
 * it was written three times: the union type in `financial-engine/domain/types.ts` and again in
 * `evidence/domain/assurance.ts`, and the rank as two tables ordered AGAINST each other —
 * `verified: 0 … inferred: 3` in one, `verified: 3 … inferred: 0` in the other — under two functions
 * both called `minAssurance`. Both were correct; nothing held them together, and adding a level
 * meant editing two tables in opposite directions and hoping.
 *
 * The *labels* a reader sees are not here: those live in `UX_ARCHITECTURE.md §8.1` only (ADR-037).
 *
 * Pure.
 */

export const ASSURANCE_LEVELS = ['verified', 'calculated', 'estimated', 'inferred'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

/** Descending strength: a HIGHER rank is a WEAKER claim. */
export const ASSURANCE_RANK: Readonly<Record<AssuranceLevel, number>> = {
  verified: 0,
  calculated: 1,
  estimated: 2,
  inferred: 3,
};

export function isAssuranceLevel(value: unknown): value is AssuranceLevel {
  return typeof value === 'string' && value in ASSURANCE_RANK;
}

/** The weaker of two levels. */
export function weakestOf(a: AssuranceLevel, b: AssuranceLevel): AssuranceLevel {
  return ASSURANCE_RANK[a] >= ASSURANCE_RANK[b] ? a : b;
}

/**
 * The weakest level in a list, or `null` for an empty one.
 *
 * `null` rather than a default: EVIDENCE_MODEL.md §8.6 says a claim whose bundle would be empty is
 * downgraded and not shown at all, so inventing `verified` here would paper over exactly the case
 * the rule exists for.
 */
export function weakestIn(levels: readonly AssuranceLevel[]): AssuranceLevel | null {
  let weakest: AssuranceLevel | null = null;
  for (const level of levels) {
    if (weakest === null || ASSURANCE_RANK[level] > ASSURANCE_RANK[weakest]) weakest = level;
  }
  return weakest;
}
