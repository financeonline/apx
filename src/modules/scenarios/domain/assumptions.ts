import { z } from 'zod';
import { HORIZON_MONTHS } from '@/modules/forecast';
import { parseDecimalOrNull } from '@/core/money';
import { ValidationError } from '@/core/errors';
import {
  ASSUMPTION_KINDS, CASH_EFFECTS, CASH_ONLY_KINDS, CHANGE_MODES, DEFAULT_CASH_EFFECT,
  MAX_AMOUNT, MAX_ASSUMPTIONS, MAX_HEADCOUNT, MAX_PERCENT, MIN_ASSUMPTIONS, MIN_PERCENT,
  type AssumptionKind, type CashEffect,
} from './config';
import type { Assumption } from './types';

/**
 * What a user may assume, and what MOTION refuses to accept (REQ-SC-02…08, §4; ADR-100).
 *
 * Three rules shape everything below, and all three come from §4:
 *
 *   1. **Nothing bad becomes zero.** A money field is a STRING matched against a fixed grammar, not
 *      a `Number()` call — `Number('12,00')` is `NaN`, `parseFloat('12abc')` is `12`, and
 *      `z.coerce.number()` would turn either into a figure the user never typed. A field that does
 *      not parse is a named error against that field, never a silent default.
 *   2. **Nothing is silently ignored.** Two assumptions that both move sales, or two of the same
 *      kind, are a CONFLICT rather than a last-one-wins merge: a scenario that quietly dropped one
 *      of the two things somebody asked about would answer a question they did not ask.
 *   3. **Every objection at once.** A form that reveals its objections one at a time makes a person
 *      guess how many more there are (`UX_ARCHITECTURE.md §7.3`).
 *
 * Pure: no clock, no I/O. The same input always produces the same verdict.
 */

/**
 * A decimal string as a person types money: optional sign, digits, at most two decimal places.
 *
 * Deliberately narrow. Thousands separators, currency symbols and exponent notation are rejected
 * rather than stripped, because stripping is a guess about what somebody meant and `1,50` means one
 * and a half in half of Europe and one hundred and fifty in the other half.
 */
const DECIMAL = /^-?\d{1,12}(\.\d{1,2})?$/;

const decimalString = z.string().trim().min(1).regex(DECIMAL);

const startsInMonth = z.number().int().min(1).max(HORIZON_MONTHS);
const cashEffect = z.enum(CASH_EFFECTS);

const BASE = { startsInMonth, cashEffect } as const;
const SIZED = { mode: z.enum(CHANGE_MODES), value: decimalString, ...BASE } as const;

/**
 * The shape of each kind. Bounds that depend on `mode` are checked afterwards, in `boundIssues`,
 * so every member here stays a plain object and the union can discriminate on `kind` alone.
 */
export const AssumptionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revenue_change'), directCostsFollow: z.boolean(), ...SIZED }),
  z.object({ kind: z.literal('payroll_change'), ...SIZED }),
  z.object({ kind: z.literal('supplier_cost_change'), ...SIZED }),
  z.object({ kind: z.literal('marketing_change'), ...SIZED }),
  z.object({
    kind: z.literal('hiring'),
    headcount: z.number().int().min(1).max(MAX_HEADCOUNT),
    // §8: no payroll cost is ever assumed. Without this the scenario is not worked out at all.
    monthlyCostPerPerson: decimalString,
    ...BASE,
  }),
  z.object({
    kind: z.literal('pricing_change'),
    pricePercent: decimalString,
    // §9: required, and zero is a real answer. A price rise is not a revenue rise on its own.
    volumePercent: decimalString,
    directCostsFollow: z.boolean(),
    ...BASE,
  }),
  z.object({ kind: z.literal('debt_drawdown'), amount: decimalString, ...BASE }),
  z.object({
    kind: z.literal('debt_repayment'),
    monthlyAmount: decimalString,
    // §11: null means the user gave none, and the scenario says interest is not included.
    monthlyInterest: decimalString.nullable(),
    ...BASE,
  }),
]);

export interface AssumptionIssue {
  readonly path: string;
  readonly message: string;
}

const LABEL: Readonly<Record<AssumptionKind, string>> = {
  revenue_change: 'The change in sales',
  payroll_change: 'The change in wages',
  supplier_cost_change: 'The change in direct costs',
  marketing_change: 'The change in marketing',
  hiring: 'Hiring',
  pricing_change: 'The price change',
  debt_drawdown: 'The amount borrowed',
  debt_repayment: 'The monthly repayment',
};

const isNumeric = (value: string): boolean => DECIMAL.test(value.trim());

/*
 * Bounds are compared as Decimals, never as floats (ADR-006). A bound check that drifts by an
 * ulp is a bound check that lets the wrong number through, and these strings are money and
 * percentages of money.
 */
function percentIssue(path: string, label: string, value: string): AssumptionIssue | null {
  const parsed = isNumeric(value) ? parseDecimalOrNull(value.trim()) : null;
  if (parsed === null) return { path, message: `${label} must be a number, for example 10 or 7.5.` };
  if (parsed.lessThan(MIN_PERCENT) || parsed.greaterThan(MAX_PERCENT)) {
    return { path, message: `${label} must be between ${MIN_PERCENT}% and ${MAX_PERCENT}%.` };
  }
  return null;
}

function amountIssue(
  path: string, label: string, value: string, { positiveOnly = false } = {},
): AssumptionIssue | null {
  const parsed = isNumeric(value) ? parseDecimalOrNull(value.trim()) : null;
  if (parsed === null) {
    return { path, message: `${label} must be an amount, for example 2500 or 2500.50.` };
  }
  if (positiveOnly && !parsed.greaterThan(0)) {
    return { path, message: `${label} must be more than zero.` };
  }
  if (parsed.abs().greaterThan(MAX_AMOUNT)) {
    return { path, message: `${label} is larger than MOTION can model.` };
  }
  return null;
}

/**
 * The bounds that depend on what the field MEANS.
 *
 * `+500` is a plausible marketing budget and an implausible percentage; the same string is fine in
 * one mode and wrong in the other, so the mode has to be known before the number can be judged.
 */
export function boundIssues(assumption: Assumption): AssumptionIssue[] {
  const label = LABEL[assumption.kind];
  const out: AssumptionIssue[] = [];
  const push = (issue: AssumptionIssue | null) => { if (issue) out.push(issue); };

  switch (assumption.kind) {
    case 'revenue_change':
    case 'payroll_change':
    case 'supplier_cost_change':
    case 'marketing_change':
      push(assumption.mode === 'percent'
        ? percentIssue(`${assumption.kind}.value`, label, assumption.value)
        : amountIssue(`${assumption.kind}.value`, label, assumption.value));
      break;
    case 'hiring':
      push(amountIssue('hiring.monthlyCostPerPerson', 'The monthly cost of each new person',
        assumption.monthlyCostPerPerson, { positiveOnly: true }));
      break;
    case 'pricing_change':
      push(percentIssue('pricing_change.pricePercent', 'The price change', assumption.pricePercent));
      push(percentIssue('pricing_change.volumePercent', 'The change in the number of sales',
        assumption.volumePercent));
      break;
    case 'debt_drawdown':
      push(amountIssue('debt_drawdown.amount', label, assumption.amount, { positiveOnly: true }));
      break;
    case 'debt_repayment':
      push(amountIssue('debt_repayment.monthlyAmount', label, assumption.monthlyAmount,
        { positiveOnly: true }));
      if (assumption.monthlyInterest !== null) {
        push(amountIssue('debt_repayment.monthlyInterest', 'The monthly interest',
          assumption.monthlyInterest, { positiveOnly: true }));
      }
      break;
  }
  return out;
}

/**
 * The rules that are about the SET of assumptions rather than any one of them (§4).
 *
 * Both of the first two are about double counting. Two assumptions of the same kind would be
 * applied one after the other and the reader would see a change twice the size of either; a sales
 * change beside a price change would move sales through two different stories at once, and the
 * answer would be defensible under neither.
 */
export function conflictIssues(assumptions: readonly Assumption[]): AssumptionIssue[] {
  const issues: AssumptionIssue[] = [];

  if (assumptions.length < MIN_ASSUMPTIONS) {
    issues.push({ path: 'assumptions', message: 'Choose at least one thing to change.' });
  }
  if (assumptions.length > MAX_ASSUMPTIONS) {
    issues.push({
      path: 'assumptions',
      message: `A scenario can change at most ${MAX_ASSUMPTIONS} things at once.`,
    });
  }

  const seen = new Set<AssumptionKind>();
  for (const assumption of assumptions) {
    if (seen.has(assumption.kind)) {
      issues.push({
        path: assumption.kind,
        message: 'This has been changed twice. Combine the two into one change.',
      });
    }
    seen.add(assumption.kind);
  }

  if (seen.has('revenue_change') && seen.has('pricing_change')) {
    issues.push({
      path: 'pricing_change',
      message: 'A sales change and a price change both move sales. Choose one of the two.',
    });
  }

  for (const assumption of assumptions) {
    if (CASH_ONLY_KINDS.has(assumption.kind) && assumption.cashEffect !== 'same_month') {
      issues.push({
        path: assumption.kind,
        message: 'Borrowing and repayments are cash: they always move cash in the month they happen.',
      });
    }
  }

  return issues;
}

/** Parse and check a whole set of assumptions, or throw `ValidationError` carrying every issue. */
export function parseAssumptions(input: unknown): Assumption[] {
  const list = z.array(AssumptionSchema).max(MAX_ASSUMPTIONS * 2).safeParse(input);
  if (!list.success) {
    throw new ValidationError('Some of these changes need fixing.', list.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: 'This change is not one MOTION can read. Check the numbers and try again.',
    })));
  }

  const assumptions = list.data as Assumption[];
  const issues = [...assumptions.flatMap(boundIssues), ...conflictIssues(assumptions)];
  if (issues.length > 0) throw new ValidationError('Some of these changes need fixing.', [...issues]);
  return assumptions;
}

/** The cash answer the form offers for a kind. Always shown; never silently applied. */
export function defaultCashEffect(kind: AssumptionKind): CashEffect {
  return DEFAULT_CASH_EFFECT[kind];
}

export function isAssumptionKind(value: string): value is AssumptionKind {
  return (ASSUMPTION_KINDS as readonly string[]).includes(value);
}
