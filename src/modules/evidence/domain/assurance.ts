/**
 * Assurance propagation (EVIDENCE_MODEL.md §7).
 *
 * Bundle assurance is the minimum over its items in the order verified > calculated > estimated >
 * inferred, so a finding backed by one Claude-extracted PDF row is `inferred` however exact the
 * arithmetic on top of it was. The *labels* for these values live in one place only —
 * `UX_ARCHITECTURE.md §8.1` (ADR-037) — and are deliberately not restated here.
 */

import { weakestIn, type AssuranceLevel } from '@/core/assurance';

export {
  ASSURANCE_LEVELS, ASSURANCE_RANK, isAssuranceLevel, weakestOf, type AssuranceLevel,
} from '@/core/assurance';

/** The weakest level in the list, or `null` for an empty list. One ladder, in `core` (ADR-094). */
export function minAssurance(levels: readonly AssuranceLevel[]): AssuranceLevel | null {
  return weakestIn(levels);
}
