import type { CounterpartyRef } from './types';

/**
 * The counterparty ids a figure's evidence must name once merges are taken into account (ADR-108).
 *
 * The fold attributes every row of a merged counterparty to its survivor
 * (`coalesce(c.merged_into_id, i.counterparty_id)` in `app.aggregate_periods`), so a survivor's
 * figure includes the absorbed party's rows. The rows themselves still carry the ORIGINAL id — a
 * merge is a pointer, never a rewrite (`api.merge_counterparties`), because rewriting would break
 * the evidence trail. A descriptor that names only the survivor therefore re-selects only the
 * survivor's own rows, and the drill-down behind a merged customer's revenue, a merged supplier's
 * spend, or a cost-of-sales figure fed by a merged supplier understates by exactly the absorbed
 * party's contribution. Measured before ADR-108: customer revenue 8,000 with evidence of 5,000;
 * supplier spend 3,750 with evidence of 1,500; the same on the ledger basis.
 *
 * This is the one place that closure is computed. Merges can chain (A merged into B, B later
 * merged into C), so it is taken to a fixed point. The result is sorted so two runs over one set of
 * data write byte-identical descriptors (ADR-046.2).
 */
export function withMergedCounterparties(
  counterparties: readonly CounterpartyRef[],
  ids: readonly string[],
): readonly string[] {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of counterparties) {
      if (c.mergedIntoId !== null && out.has(c.mergedIntoId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return [...out].sort();
}
