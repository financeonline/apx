import { z } from 'zod';
import { Decimal } from '@/core/money';

/**
 * The branded numeric envelope every tool output uses (AI_ARCHITECTURE.md §3, §7.1).
 *
 * "Every numeric field in a tool output schema is branded `Money | Ratio | Count | Days` and
 * serialised as `{ value: string, display: string, unit }`. **Only branded fields enter the
 * grounding allowed set.**"
 *
 * That last sentence is the whole design. A grounding check that scanned tool output for anything
 * number-shaped would happily match a figure inside a transaction description, an alert sentence or
 * an error hint — v1 did exactly that and was withdrawn (F-C-09, F-C-01). Making the envelope the
 * only way a number can be *stated* means a value is groundable if and only if a tool deliberately
 * published it as a number, with its unit and the precision it is displayed at.
 *
 * `value` is a string, never a JS number: these are money figures and they cross a JSON boundary
 * (ADR-006).
 */

export const NUMERIC_UNITS = ['money', 'ratio', 'count', 'days'] as const;
export type NumericUnit = (typeof NUMERIC_UNITS)[number];

export const NumericValueSchema = z.strictObject({
  /** The exact figure, as a decimal string. */
  value: z.string(),
  /** What the model is expected to quote, and what §7.3 derives its tolerance from. */
  display: z.string(),
  unit: z.enum(NUMERIC_UNITS),
});
export type NumericValue = z.infer<typeof NumericValueSchema>;

/** A numeric field that may legitimately be absent — "not computable" is never zero (§4). */
export const NullableNumericSchema = NumericValueSchema.nullable();

export function isNumericValue(value: unknown): value is NumericValue {
  return NumericValueSchema.safeParse(value).success;
}

/**
 * The number of decimals a display string commits to, which §7.3 turns into a tolerance.
 *
 * "£12,900" accepts 12,900.00–12,900.49 because it commits to whole pounds; "8.3%" accepts
 * 0.0825–0.0835 because it commits to one decimal place. Reading the precision off the DISPLAY
 * rather than off the value is deliberate: the display is what the model was shown and what a
 * reader sees, and grounding a claim against anything else would be grounding it against a figure
 * nobody wrote.
 */
export function displayPrecision(display: string): number {
  const match = /\.(\d+)/.exec(display);
  return match === null ? 0 : match[1]!.length;
}

export function toDecimal(value: NumericValue): Decimal {
  return new Decimal(value.value);
}

/**
 * Builds the envelope. Used by every tool, so the shape cannot drift between them.
 *
 * `display` is passed rather than derived because the canonical formatting lives in
 * `UX_ARCHITECTURE.md §8.1` and `core/money` — a second formatter here would eventually disagree
 * with the one the customer's screen uses, and the model would be quoting a number the product
 * never showed.
 */
export function numeric(value: string, display: string, unit: NumericUnit): NumericValue {
  return { value, display, unit };
}
