import { describe, expect, it } from 'vitest';

import {
  alternateOrder, countRowsReadDifferently, defaultDateOrder, detectDateColumn, fromExcelSerial,
  parseDateValue, readsDifferentlyUnderAlternate,
} from '../../src/modules/imports/domain/transforms/dates';
import {
  creditDebitSign, detectNumberColumn, parseAmount, stripCurrency,
} from '../../src/modules/imports/domain/transforms/numbers';
import {
  applyBalanceSign, bankAmountFromInOut, bankAmountFromSigned, bankReconciliation,
  detectBalanceSign, glFromDebitCredit, glFromSigned, isLiabilityBankAccount, resolveBankSign,
} from '../../src/modules/imports/domain/transforms/signs';
import { maskDescription } from '../../src/modules/imports/domain/transforms/masking';

/** IMPORT_ENGINE.md §6.4. Imported by path; see the note in `import-mapping.test.ts`. */

describe('date detection (§6.4 Dates)', () => {
  it('reads a year-first column as ISO, with nothing to choose', () => {
    const detection = detectDateColumn(['2026-03-14', '2026-04-01', '2026/12/31']);
    expect(detection).toMatchObject({ order: 'iso', reason: 'iso', choiceRequired: false, parsed: 3 });
  });

  it('reads a month-name column without needing an ordering', () => {
    const detection = detectDateColumn(['14 Mar 2026', '1 April 2026', 'Mar 14, 2026']);
    expect(detection).toMatchObject({ order: 'iso', choiceRequired: false, parsed: 3 });
    expect(parseDateValue('14 Mar 2026', 'day_first')).toBe('2026-03-14');
    expect(parseDateValue('Mar 14, 2026', 'month_first')).toBe('2026-03-14');
  });

  it('applies the ordering a single unambiguous value proves, and marks it detected', () => {
    const detection = detectDateColumn(['14/03/2026', '01/02/2026', '05/05/2026']);
    expect(detection).toMatchObject({
      order: 'day_first', reason: 'disambiguated', choiceRequired: false, disambiguating: 1, ambiguous: 2,
    });
    // "01/02/2026" changes meaning under month-first; "05/05/2026" does not, and "14/03/2026"
    // cannot be read month-first at all.
    expect(detection.changedUnderAlternate).toBe(1);

    const usFile = detectDateColumn(['03/14/2026', '01/02/2026']);
    expect(usFile).toMatchObject({ order: 'month_first', reason: 'disambiguated', choiceRequired: false });
  });

  it('REFUSES to default when every value parses both ways', () => {
    const detection = detectDateColumn(['01/02/2026', '03/04/2026', '05/06/2026']);
    expect(detection.order).toBeNull();
    expect(detection.choiceRequired).toBe(true);
    expect(detection.reason).toBe('all_ambiguous');
    expect(detection.ambiguous).toBe(3);
    // The country only pre-selects the answer; it never becomes the answer.
    expect(detection.proposedOrder).toBe('day_first');
    expect(detection.countryDefault).toBe('day_first');
    expect(detectDateColumn(['01/02/2026'], { countryCode: 'US' })).toMatchObject({
      order: null, choiceRequired: true, proposedOrder: 'month_first',
    });
  });

  it('tells the mapping screen how many rows the other reading would change', () => {
    const detection = detectDateColumn(['01/02/2026', '03/04/2026', '05/05/2026']);
    expect(detection.changedUnderAlternate).toBe(2);
    expect(countRowsReadDifferently(['01/02/2026', '05/05/2026'], 'day_first')).toBe(1);
    expect(readsDifferentlyUnderAlternate('01/02/2026', 'day_first')).toBe(true);
    expect(readsDifferentlyUnderAlternate('05/05/2026', 'day_first')).toBe(false);
    expect(readsDifferentlyUnderAlternate('2026-03-14', 'day_first')).toBe(false);
    expect(countRowsReadDifferently(['01/02/2026'], 'iso')).toBe(0);
  });

  it('asks rather than choosing when the column contradicts itself', () => {
    expect(detectDateColumn(['14/03/2026', '03/14/2026'])).toMatchObject({
      order: null, reason: 'conflicting', choiceRequired: true,
    });
  });

  it('detects an Excel serial column but not a column of small whole numbers', () => {
    expect(detectDateColumn(['45000', '45001'])).toMatchObject({
      order: 'excel_serial', reason: 'excel_serial',
    });
    expect(detectDateColumn(['1', '2', '3'])).toMatchObject({ order: null, reason: 'unreadable' });
  });

  it('converts Excel serials, including the 1900 leap-year bug', () => {
    expect(fromExcelSerial(45_000)).toBe('2023-03-15');
    expect(fromExcelSerial(1)).toBe('1900-01-01');
    expect(fromExcelSerial(59)).toBe('1900-02-28');
    // Serial 60 is Excel's "29 February 1900", a day that never existed.
    expect(fromExcelSerial(60)).toBeNull();
    expect(fromExcelSerial(61)).toBe('1900-03-01');
    expect(fromExcelSerial(0)).toBeNull();
    expect(parseDateValue('45000', 'excel_serial')).toBe('2023-03-15');
    expect(parseDateValue('45000', 'day_first')).toBeNull();
  });

  it('parses each ordering, and refuses a date that does not exist', () => {
    expect(parseDateValue('14/03/2026', 'day_first')).toBe('2026-03-14');
    expect(parseDateValue('14/03/2026', 'month_first')).toBeNull();
    expect(parseDateValue('03/14/2026', 'month_first')).toBe('2026-03-14');
    expect(parseDateValue('14-03-26', 'day_first')).toBe('2026-03-14');
    expect(parseDateValue('14.03.2026', 'day_first')).toBe('2026-03-14');
    expect(parseDateValue('2026-03-14 00:00:00', 'iso')).toBe('2026-03-14');
    expect(parseDateValue('2026-02-30', 'iso')).toBeNull();
    expect(parseDateValue('31/02/2026', 'day_first')).toBeNull();
    expect(parseDateValue('not a date', 'day_first')).toBeNull();
    expect(parseDateValue('', 'day_first')).toBeNull();
  });

  it('knows which orderings have an alternative reading, and the country default', () => {
    expect(alternateOrder('day_first')).toBe('month_first');
    expect(alternateOrder('month_first')).toBe('day_first');
    expect(alternateOrder('iso')).toBeNull();
    expect(defaultDateOrder('GB')).toBe('day_first');
    expect(defaultDateOrder('AE')).toBe('day_first');
    expect(defaultDateOrder(undefined)).toBe('day_first');
    expect(defaultDateOrder('US')).toBe('month_first');
  });

  it('reports an empty column as empty rather than as a choice', () => {
    expect(detectDateColumn([null, undefined, '  '])).toMatchObject({
      order: null, reason: 'empty', choiceRequired: false, total: 0,
    });
  });
});

describe('separators and currency (§6.4 Numbers)', () => {
  it('tells 1.234,56 from 1,234.56', () => {
    expect(detectNumberColumn(['1.234,56', '2.000,00', '-45,10'])).toMatchObject({
      decimalSeparator: ',', thousandsSeparator: '.', evidence: 'both_separators',
    });
    expect(detectNumberColumn(['1,234.56', '2,000.00', '-45.10'])).toMatchObject({
      decimalSeparator: '.', thousandsSeparator: ',', evidence: 'both_separators',
    });
    expect(parseAmount('1.234,56', { format: { decimalSeparator: ',', thousandsSeparator: '.' } }).amount)
      .toBe('1234.56');
    expect(parseAmount('1,234.56', { format: { decimalSeparator: '.', thousandsSeparator: ',' } }).amount)
      .toBe('1234.56');
  });

  it('reads a column that only ever shows a decimal comma', () => {
    expect(detectNumberColumn(['45,10', '12,00'])).toMatchObject({
      decimalSeparator: ',', thousandsSeparator: '', evidence: 'decimal_comma',
    });
  });

  it('reads grouping alone as grouping', () => {
    expect(detectNumberColumn(['1,234', '12,000'])).toMatchObject({
      decimalSeparator: '.', thousandsSeparator: ',', evidence: 'comma_grouping',
    });
    expect(detectNumberColumn(['1.234', '12.000'])).toMatchObject({
      decimalSeparator: ',', thousandsSeparator: '.', evidence: 'point_grouping',
    });
  });

  it('accepts a space thousands separator', () => {
    const detection = detectNumberColumn(['1 234,56', '12 000,00']);
    expect(detection).toMatchObject({ decimalSeparator: ',', thousandsSeparator: ' ', spaceThousands: true });
    expect(parseAmount('1 234,56', { format: detection }).amount).toBe('1234.56');
    expect(parseAmount('1 234.56', { format: { decimalSeparator: '.', thousandsSeparator: ' ' } }).amount)
      .toBe('1234.56');
  });

  it('strips currency symbols and codes, and reports what it found (IMP-CUR-007)', () => {
    expect(stripCurrency('£1,234.56')).toEqual({ text: '1,234.56', currency: 'GBP' });
    expect(stripCurrency('1,234.56 EUR')).toEqual({ text: '1,234.56', currency: 'EUR' });
    expect(parseAmount('£1,234.56')).toMatchObject({ amount: '1234.56', currency: 'GBP' });
    expect(parseAmount('USD 500')).toMatchObject({ amount: '500.00', currency: 'USD' });
    expect(detectNumberColumn(['£10.00', '£20.00'])).toMatchObject({ currency: 'GBP', currencies: ['GBP'] });
    expect(detectNumberColumn(['£10.00', '$20.00'])).toMatchObject({ currency: null, currencies: ['GBP', 'USD'] });
  });

  it('rounds to storage precision and says so, rather than losing it silently', () => {
    expect(parseAmount('1.005')).toMatchObject({ amount: '1.01', rounded: true });
    expect(parseAmount('1.00')).toMatchObject({ amount: '1.00', rounded: false });
  });

  it('reports an unreadable amount instead of guessing at one', () => {
    expect(parseAmount('n/a')).toMatchObject({ ok: false, amount: null });
    expect(parseAmount('12.34.56')).toMatchObject({ ok: false, amount: null });
    expect(parseAmount('')).toMatchObject({ ok: true, amount: null, empty: true });
    expect(parseAmount(null)).toMatchObject({ ok: true, amount: null, empty: true });
  });
});

describe('negative styles (§6.4), all five of them', () => {
  it('normalises every spelling to a signed decimal string', () => {
    expect(parseAmount('-123.45')).toMatchObject({ amount: '-123.45', negativeStyle: 'leading_minus' });
    expect(parseAmount('(123.45)')).toMatchObject({ amount: '-123.45', negativeStyle: 'parentheses' });
    expect(parseAmount('123.45-')).toMatchObject({ amount: '-123.45', negativeStyle: 'trailing_minus' });
    expect(parseAmount('123.45 DR')).toMatchObject({ amount: '-123.45', negativeStyle: 'cr_dr_suffix' });
    expect(parseAmount('123.45', { creditDebitMarker: 'DR' }))
      .toMatchObject({ amount: '-123.45', negativeStyle: 'cr_dr_column' });
  });

  it('leaves a credit positive', () => {
    expect(parseAmount('123.45 CR')).toMatchObject({ amount: '123.45', negativeStyle: null });
    expect(parseAmount('123.45', { creditDebitMarker: 'CR' })).toMatchObject({ amount: '123.45' });
    expect(parseAmount('123.45')).toMatchObject({ amount: '123.45', negativeStyle: null });
  });

  it('peels the wrappers in the right order', () => {
    expect(parseAmount('(£1,234.56)')).toMatchObject({ amount: '-1234.56', currency: 'GBP' });
    expect(parseAmount('£1,234.56 DR')).toMatchObject({ amount: '-1234.56', currency: 'GBP' });
  });

  it('reads a CR/DR column value', () => {
    expect(creditDebitSign('CR')).toBe(1);
    expect(creditDebitSign(' dr ')).toBe(-1);
    expect(creditDebitSign('')).toBeNull();
    expect(creditDebitSign(null)).toBeNull();
  });

  it('collects the styles a column uses', () => {
    expect([...detectNumberColumn(['(1,234.56)', '2,000.00', '-45.10']).negativeStyles].sort())
      .toEqual(['leading_minus', 'parentheses']);
  });
});

describe('bank sign (§6.4, ADR-028)', () => {
  it('nets money_in − money_out', () => {
    expect(bankAmountFromInOut('100.00', null).amount).toBe('100.00');
    expect(bankAmountFromInOut(null, '40.00').amount).toBe('-40.00');
    expect(bankAmountFromInOut('100.00', '0.00').amount).toBe('100.00');
    expect(bankAmountFromInOut(null, null).amount).toBeNull();
  });

  it('refuses a row that is both a payment and a receipt (IMP-AMT-002)', () => {
    const result = bankAmountFromInOut('100.00', '40.00');
    expect(result.amount).toBeNull();
    expect(result.issue).toMatchObject({ code: 'IMP-AMT-002', severity: 'error' });
  });

  it('requires an answer for a single amount column on a current account', () => {
    expect(resolveBankSign(undefined, 'current')).toBeNull();
    expect(resolveBankSign(undefined, 'savings')).toBeNull();
    expect(resolveBankSign(undefined, 'other')).toBeNull();
    // Liability accounts have a stated default (§6.4, ADR-028).
    expect(resolveBankSign(undefined, 'credit_card')).toBe('positive_out');
    expect(resolveBankSign(undefined, 'loan')).toBe('positive_out');
    expect(resolveBankSign('negative_out', 'credit_card')).toBe('negative_out');
    expect(isLiabilityBankAccount('credit_card')).toBe(true);
    expect(isLiabilityBankAccount('current')).toBe(false);
  });

  it('negates the column only when payments out are shown positive', () => {
    expect(bankAmountFromSigned('-40.00', 'negative_out')).toBe('-40.00');
    expect(bankAmountFromSigned('40.00', 'positive_out')).toBe('-40.00');
    expect(bankAmountFromSigned('-40.00', 'positive_out')).toBe('40.00');
  });

  it('evaluates a liability reconciliation as −Σ amount (ADR-028)', () => {
    // A card that spent 200 in the period: the balance owed rises from 1,000 to 1,200.
    expect(bankReconciliation({
      sumAmount: '-200.00', openingBalance: '1000.00', closingBalance: '1200.00', accountType: 'credit_card',
    })).toMatchObject({ actual: '200.00', expected: '200.00', reconciled: true });

    // The same figures on a current account do not reconcile, which is the point of the rule.
    expect(bankReconciliation({
      sumAmount: '-200.00', openingBalance: '1000.00', closingBalance: '1200.00', accountType: 'current',
    })).toMatchObject({ actual: '-200.00', reconciled: false });

    expect(bankReconciliation({
      sumAmount: '150.00', openingBalance: '1000.00', closingBalance: '1150.005', accountType: 'current',
    }).reconciled).toBe(true);
  });
});

describe('GL direction (§6.4)', () => {
  it('turns debit/credit columns into a direction and a positive amount', () => {
    expect(glFromDebitCredit('100.00', null)).toMatchObject({ direction: 'debit', amount: '100.00' });
    expect(glFromDebitCredit(null, '100.00')).toMatchObject({ direction: 'credit', amount: '100.00' });
    expect(glFromDebitCredit(null, null)).toMatchObject({ direction: null, amount: null });
    expect(glFromDebitCredit('0.00', null)).toMatchObject({ direction: 'debit', amount: '0.00' });
  });

  it('refuses a row with both a debit and a credit', () => {
    expect(glFromDebitCredit('100.00', '60.00').issue).toMatchObject({ code: 'IMP-AMT-002', severity: 'error' });
  });

  it('maps a signed column by sign, positive = debit unless overridden', () => {
    expect(glFromSigned('100.00')).toMatchObject({ direction: 'debit', amount: '100.00' });
    expect(glFromSigned('-100.00')).toMatchObject({ direction: 'credit', amount: '100.00' });
    expect(glFromSigned('100.00', 'positive_credit')).toMatchObject({ direction: 'credit', amount: '100.00' });
    expect(glFromSigned('-100.00', 'positive_credit')).toMatchObject({ direction: 'debit', amount: '100.00' });
  });
});

describe('balance sign (§6.4, ADR-047.3)', () => {
  it('proposes reporting ONLY when both sums are positive', () => {
    const xero = detectBalanceSign([
      { amount: '10000.00', category: 'revenue', label: 'Sales' },
      { amount: '2000.00', category: 'operating_expense', label: 'Rent' },
      { amount: '3000.00', category: 'payroll', label: 'Wages' },
    ]);
    expect(xero).toMatchObject({
      proposed: 'reporting', incomeTotal: '10000.00', expenseTotal: '5000.00', incomeRows: 1, expenseRows: 2,
    });
    expect(xero.incomeSample).toEqual({ label: 'Sales', amount: '10000.00', category: 'revenue' });
    expect(xero.expenseSample).toEqual({ label: 'Rent', amount: '2000.00', category: 'operating_expense' });
  });

  it('leaves a natural-sign file alone', () => {
    expect(detectBalanceSign([
      { amount: '-10000.00', category: 'revenue' },
      { amount: '2000.00', category: 'operating_expense' },
    ]).proposed).toBe('natural');

    expect(detectBalanceSign([
      { amount: '10000.00', category: 'revenue' },
      { amount: '-2000.00', category: 'operating_expense' },
    ]).proposed).toBe('natural');
  });

  it('does not propose reporting from one side alone, or from a balance sheet with neither', () => {
    expect(detectBalanceSign([{ amount: '10000.00', category: 'revenue' }]).proposed).toBe('natural');
    expect(detectBalanceSign([{ amount: '2000.00', category: 'operating_expense' }]).proposed).toBe('natural');
    expect(detectBalanceSign([]).proposed).toBe('natural');
    expect(detectBalanceSign([
      { amount: '5000.00', category: 'cash' },
      { amount: '5000.00', category: 'payables' },
    ])).toMatchObject({ proposed: 'natural', incomeRows: 0, expenseRows: 0 });
  });

  it('negates income, liability and equity lines at commit, and nothing else', () => {
    expect(applyBalanceSign('10000.00', 'revenue', 'reporting')).toBe('-10000.00');
    expect(applyBalanceSign('500.00', 'other_income', 'reporting')).toBe('-500.00');
    expect(applyBalanceSign('5000.00', 'payables', 'reporting')).toBe('-5000.00');
    expect(applyBalanceSign('1000.00', 'equity', 'reporting')).toBe('-1000.00');
    expect(applyBalanceSign('2000.00', 'operating_expense', 'reporting')).toBe('2000.00');
    expect(applyBalanceSign('7000.00', 'cash', 'reporting')).toBe('7000.00');
  });

  it('changes nothing under natural sign', () => {
    for (const category of ['revenue', 'payables', 'equity', 'cash', 'operating_expense'] as const) {
      expect(applyBalanceSign('1000.00', category, 'natural')).toBe('1000.00');
    }
  });

  it('round-trips a Xero P&L to positive revenue (fixture 27, R2-B-03)', () => {
    const rows = [
      { amount: '10000.00', category: 'revenue' as const },
      { amount: '2000.00', category: 'operating_expense' as const },
    ];
    const { proposed } = detectBalanceSign(rows);
    // Stored natural, revenue is a credit balance; the P&L presents it positive again.
    expect(applyBalanceSign(rows[0]!.amount, rows[0]!.category, proposed)).toBe('-10000.00');
  });
});

describe('description masking (§6.4, ADR-038.4)', () => {
  /**
   * Every case here is also what `app.mask_description()` in
   * `supabase/migrations/20260905000018_triggers_financial.sql` produces. The trigger writes the
   * column; this function only shows the reviewer what the trigger will write, so the two must
   * agree — the integration parity test runs the same inputs through Postgres.
   */
  it('masks a 6 to 8 digit account number to **** plus the last four', () => {
    expect(maskDescription('PAYMENT 12345678 ACME')).toBe('PAYMENT ****5678 ACME');
    expect(maskDescription('INV 1234567')).toBe('INV ****4567');
    expect(maskDescription('INV 123456')).toBe('INV ****3456');
  });

  it('leaves a run of five or fewer, and of nine or more, alone', () => {
    expect(maskDescription('REF 12345')).toBe('REF 12345');
    expect(maskDescription('REF 123456789')).toBe('REF 123456789');
    expect(maskDescription('CARD 1234')).toBe('CARD 1234');
  });

  it('masks a sort code first, so the digit rule cannot eat half of it', () => {
    expect(maskDescription('SORT 12-34-56')).toBe('SORT ****3456');
    expect(maskDescription('SORT 12-34-56 ACC 87654321')).toBe('SORT ****3456 ACC ****4321');
  });

  it('only masks whole words, exactly as the word boundaries in the SQL do', () => {
    expect(maskDescription('ACC12345678')).toBe('ACC12345678');
    expect(maskDescription('12345678AB')).toBe('12345678AB');
    expect(maskDescription('12345678')).toBe('****5678');
    expect(maskDescription('(12345678)')).toBe('(****5678)');
  });

  it('collapses whitespace and returns null for an empty description', () => {
    expect(maskDescription('  DIRECT   DEBIT  ')).toBe('DIRECT DEBIT');
    expect(maskDescription('')).toBeNull();
    expect(maskDescription('   ')).toBeNull();
    expect(maskDescription(null)).toBeNull();
    expect(maskDescription(undefined)).toBeNull();
  });

  it('masks every occurrence in one description', () => {
    expect(maskDescription('FROM 12345678 TO 87654321')).toBe('FROM ****5678 TO ****4321');
  });
});
