import { describe, it, expect } from 'vitest';
import { ValidationError } from '@/core/errors';
import {
  Decimal,
  abs,
  add,
  cashDirection,
  compare,
  divide,
  entryFromSigned,
  equals,
  formatCashAmount,
  formatChange,
  formatEntryAmount,
  formatMoney,
  formatPercent,
  isNegative,
  isZero,
  magnitude,
  multiply,
  negate,
  oppositeEntryDirection,
  parseDecimal,
  parseDecimalOrNull,
  parseMoney,
  roundMoney,
  roundRatio,
  signedFromCash,
  signedFromEntry,
  subtract,
  sum,
  toMoneyString,
  toMoneyStringOrNull,
  toRatioString,
} from '@/core/money';

/**
 * ADR-006 in executable form. The rounding-boundary cases are the reason the module exists: a JS
 * float rounds 0.005 to 0.00 (the double nearest 0.005 is below it), and every one of these
 * assertions would fail if money were ever parsed with parseFloat.
 */

const GBP = { currency: 'GBP' } as const;

describe('rounding boundaries (ADR-006: ROUND_HALF_UP at 2 dp)', () => {
  it('rounds 0.005 up, where a float rounds it down', () => {
    expect(toMoneyString('0.005')).toBe('0.01');
    // The proof that this is not the float answer.
    expect((0.005).toFixed(2)).toBe('0.01'); // toFixed happens to agree here…
    expect((1.005).toFixed(2)).toBe('1.00'); // …and here it does not.
    expect(toMoneyString('1.005')).toBe('1.01');
  });

  it('rounds half away from zero on the negative side too', () => {
    expect(toMoneyString('-0.005')).toBe('-0.01');
    expect(toMoneyString('-1.005')).toBe('-1.01');
    expect(toMoneyString('-2.675')).toBe('-2.68');
  });

  it('leaves values below the half boundary alone', () => {
    expect(toMoneyString('0.0049999')).toBe('0.00');
    expect(toMoneyString('2.674999')).toBe('2.67');
  });

  it('rounds the classic float-error cases exactly', () => {
    expect(toMoneyString('2.675')).toBe('2.68');
    expect(toMoneyString('8.475')).toBe('8.48');
    expect(toMoneyString('1.255')).toBe('1.26');
  });

  it('always writes the column scale, so 12.5 and 12.50 do not both exist', () => {
    expect(toMoneyString('12.5')).toBe('12.50');
    expect(toMoneyString(0)).toBe('0.00');
    expect(toMoneyString('7')).toBe('7.00');
  });

  it('holds NUMERIC(20,6) precision for ratios', () => {
    expect(toRatioString('0.2534')).toBe('0.253400');
    expect(toRatioString('0.1234565')).toBe('0.123457'); // half up at the 6th place
    expect(toRatioString('0.1234564')).toBe('0.123456');
    expect(roundRatio('0.0000005').toFixed(6)).toBe('0.000001');
  });

  it('keeps 20 significant digits through a chain and rounds once at the end', () => {
    // 1/3 of a penny, three times, is a penny — only if nothing rounds in between.
    const third = divide('0.01', 3);
    expect(third).not.toBeNull();
    const back = multiply(third as Decimal, 3);
    expect(toMoneyString(back)).toBe('0.01');
  });

  it('never serialises in exponential notation', () => {
    expect(toMoneyString('1000000000000000.55')).toBe('1000000000000000.55');
    expect(toRatioString('0.0000001')).toBe('0.000000');
  });

  it('roundMoney is idempotent', () => {
    expect(roundMoney(roundMoney('1.005')).toFixed(2)).toBe('1.01');
  });
});

describe('parsing at the data-access boundary', () => {
  it('parses the strings a NUMERIC column produces', () => {
    expect(parseMoney('1234.56').toFixed(2)).toBe('1234.56');
    expect(parseDecimal('-0.01').toFixed(2)).toBe('-0.01');
    expect(parseDecimal('+12.30').toFixed(2)).toBe('12.30');
    expect(parseDecimal(' 42.00 ').toFixed(2)).toBe('42.00');
    expect(parseDecimal('.5').toFixed(2)).toBe('0.50');
    expect(parseDecimal('1e3').toFixed(2)).toBe('1000.00');
  });

  it('rejects rubbish with a ValidationError rather than producing NaN', () => {
    for (const bad of ['', '   ', 'abc', '12abc', '1,234.56', '£12.00', '--1', '1.2.3', '0x1f']) {
      expect(() => parseDecimal(bad, 'amount'), bad).toThrow(ValidationError);
    }
  });

  it('rejects the non-finite spellings decimal.js would otherwise accept', () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
      expect(() => parseDecimal(bad), bad).toThrow(ValidationError);
    }
    expect(() => parseDecimal(Number.NaN)).toThrow(ValidationError);
    expect(() => parseDecimal(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });

  it('names the field in the error so a row can be pointed at', () => {
    try {
      parseDecimal('oops', 'total_amount');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0]?.path).toBe('total_amount');
    }
  });

  it('keeps NULL as null: missing is not zero (FINANCIAL_ENGINE.md §1.5)', () => {
    expect(parseDecimalOrNull(null)).toBeNull();
    expect(parseDecimalOrNull(undefined)).toBeNull();
    expect(parseDecimalOrNull('')).toBeNull();
    expect(toMoneyStringOrNull(null)).toBeNull();
    expect(parseDecimalOrNull('0')?.isZero()).toBe(true);
    expect(toMoneyStringOrNull('0')).toBe('0.00');
  });

  it('passes an already-parsed Decimal straight through', () => {
    const d = parseDecimal('5.55');
    expect(parseDecimal(d)).toBe(d);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly where floats do not', () => {
    expect(toMoneyString(add('0.1', '0.2'))).toBe('0.30');
    expect(add('0.1', '0.2').equals(new Decimal('0.3'))).toBe(true);
    expect(toMoneyString(subtract('1.00', '0.99'))).toBe('0.01');
    expect(toMoneyString(multiply('19.99', '3'))).toBe('59.97');
  });

  it('divide by zero returns null, not Infinity and not a throw', () => {
    expect(divide('100', '0')).toBeNull();
    expect(divide('0', '0')).toBeNull();
    expect(divide('-100', '0.00')).toBeNull();
    expect(divide('100', '4')?.toFixed(2)).toBe('25.00');
  });

  it('sums a list, with an empty list genuinely zero', () => {
    expect(toMoneyString(sum([]))).toBe('0.00');
    expect(toMoneyString(sum(['1.11', '2.22', '3.33']))).toBe('6.66');
    expect(toMoneyString(sum(Array.from({ length: 100 }, () => '0.01')))).toBe('1.00');
  });

  it('compares, negates and takes magnitudes', () => {
    expect(compare('1.00', '2.00')).toBe(-1);
    expect(compare('2.00', '1.00')).toBe(1);
    expect(compare('2.0', '2.00')).toBe(0);
    expect(equals('2.0', '2.00')).toBe(true);
    expect(negate('5.00').toFixed(2)).toBe('-5.00');
    expect(abs('-5.00').toFixed(2)).toBe('5.00');
    expect(isZero('-0')).toBe(true);
    expect(isNegative('-0')).toBe(false);
    expect(isNegative('-0.01')).toBe(true);
  });
});

describe('direction', () => {
  it('gives a ledger line its natural sign, debit − credit', () => {
    expect(signedFromEntry({ direction: 'debit', amount: '100.00' }).toFixed(2)).toBe('100.00');
    expect(signedFromEntry({ direction: 'credit', amount: '100.00' }).toFixed(2)).toBe('-100.00');
  });

  it('refuses a negative magnitude: the column CHECKs amount >= 0', () => {
    expect(() => signedFromEntry({ direction: 'debit', amount: '-1.00' })).toThrow(ValidationError);
    expect(() => signedFromCash('-1.00', 'inflow')).toThrow(ValidationError);
  });

  it('round-trips a signed value back to side and magnitude', () => {
    expect(entryFromSigned('-100.00')).toMatchObject({ direction: 'credit' });
    expect(entryFromSigned('-100.00').amount.toFixed(2)).toBe('100.00');
    expect(entryFromSigned('100.00')).toMatchObject({ direction: 'debit' });
    expect(entryFromSigned('0').direction).toBe('debit');
    expect(oppositeEntryDirection('debit')).toBe('credit');
  });

  it('classifies a bank movement, with zero in neither set (§3.3 uses strict inequalities)', () => {
    expect(cashDirection('250.00')).toBe('inflow');
    expect(cashDirection('-250.00')).toBe('outflow');
    expect(cashDirection('0.00')).toBeNull();
    expect(magnitude('-250.00').toFixed(2)).toBe('250.00');
    expect(signedFromCash('250.00', 'outflow').toFixed(2)).toBe('-250.00');
  });
});

describe('formatting (UX_ARCHITECTURE.md §8.2)', () => {
  it('shows whole units by default and pence on request', () => {
    expect(formatMoney('12400', GBP)).toBe('£12,400');
    expect(formatMoney('12400.50', { ...GBP, showMinorUnits: true })).toBe('£12,400.50');
    expect(formatMoney('12400.50', GBP)).toBe('£12,401'); // ROUND_HALF_UP at the display precision
  });

  it('uses a true minus sign, never a hyphen and never parentheses by default', () => {
    const formatted = formatMoney('-1200', GBP);
    expect(formatted).toBe('−£1,200');
    expect(formatted.startsWith('−')).toBe(true);
    expect(formatted).not.toContain('-');
    expect(formatted).not.toContain('(');
  });

  it('allows parentheses for report tables only', () => {
    expect(formatMoney('-1200', { ...GBP, parentheses: true })).toBe('(£1,200)');
  });

  it('prefixes + for changes, and never signs a zero', () => {
    expect(formatMoney('2100', { ...GBP, signDisplay: 'always' })).toBe('+£2,100');
    expect(formatMoney('0', { ...GBP, signDisplay: 'always' })).toBe('£0');
  });

  it('does not render a negative zero', () => {
    expect(formatMoney('-0.004', { ...GBP, showMinorUnits: true })).toBe('£0.00');
    expect(formatMoney('-0.4', GBP)).toBe('£0');
  });

  it('respects the organisation currency and locale', () => {
    expect(formatMoney('12400', { currency: 'USD' })).toBe('$12,400');
    // de-DE separates the amount from the symbol with a non-breaking space (U+00A0).
    expect(formatMoney('12400', { currency: 'EUR', locale: 'de-DE' })).toBe('12.400\u00A0€');
    expect(formatMoney('12400', { currency: 'JPY' })).toBe('¥12,400');
  });

  it('fails loudly on an unusable currency rather than mislabelling money', () => {
    expect(() => formatMoney('1', { currency: 'NOTACURRENCY' })).toThrow(ValidationError);
  });

  it('renders ratios as percentages to one decimal place', () => {
    expect(formatPercent('0.124')).toBe('12.4%');
    expect(formatPercent('0.2534')).toBe('25.3%');
    expect(formatPercent('0.1235')).toBe('12.4%'); // ROUND_HALF_UP, not half-even
    expect(formatPercent('-0.042')).toBe('−4.2%');
    expect(formatPercent('0.083', { signDisplay: 'always' })).toBe('+8.3%');
    expect(formatPercent('0', { signDisplay: 'always' })).toBe('0.0%');
  });

  it('renders a change the way a MetricCard needs it', () => {
    expect(formatChange('2100', '0.083', { ...GBP, comparisonLabel: 'February' })).toBe(
      '+£2,100 (+8.3%) vs February',
    );
    // §3.2: comparison of zero, or a sign change, writes the amount with no percentage.
    expect(formatChange('2100', null, GBP)).toBe('+£2,100');
    expect(formatChange('-500', '-0.12', GBP)).toBe('−£500 (−12.0%)');
    // §8.2: absent comparison.
    expect(formatChange(null, null, GBP)).toBe('no comparison yet');
  });

  it('formats amounts held as magnitude plus direction', () => {
    expect(formatEntryAmount({ direction: 'credit', amount: '100' }, GBP)).toBe('−£100');
    expect(formatEntryAmount({ direction: 'debit', amount: '100' }, GBP)).toBe('£100');
    expect(formatCashAmount('250', 'outflow', GBP)).toBe('−£250');
    expect(formatCashAmount('250', 'inflow', GBP)).toBe('£250');
  });
});
