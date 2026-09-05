import { ValidationError } from '@/core/errors';

/**
 * The only source of "now" in MOTION (ADR-030.5: "all 'today' derivations go through
 * `core/periods/clock.ts`").
 *
 * FINANCIAL_ENGINE.md §1.1 requires the engine to be deterministic: "No clocks, no randomness …
 * 'Today' is an explicit input (`asOf`)". A module that called `new Date()` for business logic
 * would produce a different answer on every run and could not be tested at a month boundary, so
 * every function that needs the current instant takes a `Clock`.
 */
export interface Clock {
  now(): Date;
}

/** Production. The only place in business code that may call `new Date()` with no argument. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at one instant, for tests and for pinning an `asOf` across a calculation run. */
export function fixedClock(instant: Date | string): Clock {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(at.getTime())) {
    throw new ValidationError('That is not a valid instant.', [
      { path: 'instant', message: String(instant) },
    ]);
  }
  const frozen = new Date(at.getTime());
  return { now: () => new Date(frozen.getTime()) };
}
