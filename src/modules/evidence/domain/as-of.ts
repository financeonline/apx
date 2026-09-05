/**
 * As-of row selection (EVIDENCE_MODEL.md §3 "As-of semantics", ADR-034, ADR-046.2, ADR-047.1).
 *
 * The rule this file implements, in one sentence: **a row belongs to an as-of selection when the
 * append-only `record_status_events` log says it was accepted and not superseded at the instant the
 * producing chunk aggregated** — never `updated_at`, and never the `superseded_by` column.
 *
 * Why not the column. `superseded_by` is *current state*: `api.rollback_import_batch` resets it to
 * NULL on restored rows so the engine's loaders and the partial unique index see the restored row
 * (ADR-047.1). The column therefore cannot answer "what did this look like in March?". The event log
 * can, because it only ever grows.
 *
 * Two independent axes, which is why the fold below keeps two booleans rather than one status:
 *   * acceptance  — `accepted` / `rejected`
 *   * supersession — `superseded` / `unsuperseded` | `restored`
 * §3 and ADR-046.2 say `unsuperseded` and `restored` are honoured identically, so a rolled-back-
 * then-restored batch resolves the same way under either event.
 *
 * Pure: no I/O, no clock. The caller fetches the events; this file decides.
 */

export const RECORD_STATUS_EVENTS = [
  'accepted',
  'superseded',
  'unsuperseded',
  'rejected',
  'restored',
] as const;
export type RecordStatusEventName = (typeof RECORD_STATUS_EVENTS)[number];

export interface RecordStatusEvent {
  readonly recordId: string;
  readonly event: RecordStatusEventName;
  /** ISO 8601 with offset — `record_status_events.at`. */
  readonly at: string;
  /** `record_status_events.id` (bigint identity). Breaks ties when two events share an instant. */
  readonly seq: number;
}

export interface AsOfRecordState {
  readonly accepted: boolean;
  readonly superseded: boolean;
}

/** A row with no event at or before the instant did not exist yet, so it is in neither state. */
export const UNKNOWN_AT_INSTANT: AsOfRecordState = { accepted: false, superseded: false };

function toMillis(instant: string, label: string): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new RangeError(`${label} is not a parseable ISO 8601 instant: ${instant}`);
  }
  return ms;
}

/**
 * Total order over events: instant first, then the identity column.
 *
 * The tiebreak matters. Commit writes several events inside one transaction, so `at` (a
 * `default now()`, i.e. transaction time) is *equal* across them; without a second key the fold
 * would be non-deterministic and the resolver's "same descriptor ⇒ same rows" guarantee (§3.1)
 * would not hold.
 */
function compareEvents(a: RecordStatusEvent, b: RecordStatusEvent): number {
  const at = toMillis(a.at, 'event.at') - toMillis(b.at, 'event.at');
  if (at !== 0) return at;
  return a.seq - b.seq;
}

/**
 * Fold one record's events into its state at `instant`.
 *
 * Events *at* the instant are included: `aggregated_at` is the aggregating transaction's snapshot
 * time, and that transaction sees everything committed up to and including it (ADR-047.7).
 */
export function foldRecordStatusEvents(
  events: readonly RecordStatusEvent[],
  instant: string,
): AsOfRecordState {
  const cutoff = toMillis(instant, 'as_of.aggregated_at');
  const ordered = [...events]
    .filter((e) => toMillis(e.at, 'event.at') <= cutoff)
    .sort(compareEvents);

  if (ordered.length === 0) return UNKNOWN_AT_INSTANT;

  let accepted = false;
  let superseded = false;
  for (const { event } of ordered) {
    switch (event) {
      case 'accepted':
        accepted = true;
        break;
      case 'rejected':
        accepted = false;
        break;
      case 'superseded':
        superseded = true;
        break;
      // ADR-046.2: honoured identically — the first is written by an unsupersede, the second by a
      // rollback that returns a superseded batch to service.
      case 'unsuperseded':
      case 'restored':
        superseded = false;
        break;
    }
  }
  return { accepted, superseded };
}

/** A row is in the selection when it was accepted and not superseded at the instant. */
export function isVisibleAtInstant(state: AsOfRecordState): boolean {
  return state.accepted && !state.superseded;
}

/**
 * The ids visible at `instant`, in the order the candidates were given.
 *
 * Input order is preserved rather than re-sorted because the candidates already arrive in the
 * descriptor's `order` (which ends in `id asc`), and that ordering is what makes pagination
 * deterministic (§3).
 */
export function selectVisibleRecordIds(
  candidateIds: readonly string[],
  events: readonly RecordStatusEvent[],
  instant: string,
): string[] {
  const byRecord = new Map<string, RecordStatusEvent[]>();
  for (const event of events) {
    const bucket = byRecord.get(event.recordId);
    if (bucket === undefined) byRecord.set(event.recordId, [event]);
    else bucket.push(event);
  }
  return candidateIds.filter((id) =>
    isVisibleAtInstant(foldRecordStatusEvents(byRecord.get(id) ?? [], instant)),
  );
}

/**
 * One row of an append-only history table (`category_history`, `account_category_history`).
 * `validTo === null` means "still in force".
 */
export interface HistoryInterval<T> {
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly value: T;
}

/**
 * The value in force at `instant`, or `null` when the history has no interval covering it.
 *
 * Half-open `[valid_from, valid_to)`: the row that starts exactly at the instant is the one in
 * force, matching the `<=` cutoff used for status events. `null` is returned rather than a
 * best-effort nearest interval — "the category then is unknown" is a real answer and the caller
 * decides what to do with it.
 */
export function valueInForceAt<T>(
  intervals: readonly HistoryInterval<T>[],
  instant: string,
): T | null {
  const at = toMillis(instant, 'as_of.aggregated_at');
  let best: HistoryInterval<T> | null = null;
  for (const interval of intervals) {
    const from = toMillis(interval.validFrom, 'valid_from');
    if (from > at) continue;
    if (interval.validTo !== null && toMillis(interval.validTo, 'valid_to') <= at) continue;
    // Overlapping intervals should not exist, but if two do the later start wins, which is the
    // same "last write in force" rule the status fold uses.
    if (best === null || from >= toMillis(best.validFrom, 'valid_from')) best = interval;
  }
  return best === null ? null : best.value;
}
