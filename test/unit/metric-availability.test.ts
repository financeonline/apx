import { describe, expect, it } from 'vitest';
import { AVAILABILITY_REASON_TEXT, metricAvailability } from '@/modules/financials';

/**
 * The one availability rule (ADR-106).
 *
 * Home, the monthly report and the analyst all have to answer "is profit after direct costs an
 * established figure for this organisation and this month?". Until ADR-106 Home answered it in
 * `buildHeadlineCards` and the analyst did not answer it at all, so the same organisation was told
 * the figure could not be shown on its own home page and given it as a calculated conclusion by the
 * analyst. The shapes below are the ones the ENGINE really writes — a value on gross profit, the
 * warning, and the absent-by-design code removed from gross profit's own `missing`.
 */

const q = (
  value: string | null,
  warnings: readonly string[] = [],
  missing: readonly string[] = [],
) => ({ value, warnings, missing });

describe('metricAvailability', () => {
  it('is available for a gross profit with a real cost of sales behind it', () => {
    expect(metricAvailability('gross_profit', q('7650.00'), q('900.00'))).toEqual({ state: 'available' });
  });

  it('is not applicable when the engine warns no_cost_of_sales, and names the cost figure’s reason', () => {
    // What the engine writes: gross profit = revenue, the warning, and an EMPTY `missing`.
    const out = metricAvailability(
      'gross_profit',
      q('9000.00', ['no_cost_of_sales'], []),
      q(null, [], ['no_cost_of_sales_accounts']),
    );
    expect(out).toEqual({ state: 'not_applicable', reason: 'no_cost_of_sales_accounts' });
  });

  it('prefers the cost figure’s reason over the generic one, so a ledger organisation is told the truth', () => {
    const out = metricAvailability(
      'gross_profit',
      q('9000.00', ['no_cost_of_sales'], []),
      q(null, [], ['cost_of_sales_in_other_source']),
    );
    expect(out).toEqual({ state: 'not_applicable', reason: 'cost_of_sales_in_other_source' });
  });

  it('fires on the warning alone when the caller has no cost-of-sales figure, e.g. a trend', () => {
    const out = metricAvailability('gross_profit', q('9000.00', ['no_cost_of_sales'], []));
    expect(out).toEqual({ state: 'not_applicable', reason: 'no_cost_of_sales' });
  });

  it('fires on gross profit’s own missing code, for any engine version that keeps it', () => {
    const out = metricAvailability('gross_profit', q(null, [], ['no_cost_of_sales_accounts']));
    expect(out).toEqual({ state: 'not_applicable', reason: 'no_cost_of_sales_accounts' });
  });

  it('governs gross margin too, since it is the same limitation expressed as a ratio', () => {
    expect(metricAvailability('gross_margin', q(null, [], ['no_cost_of_sales_accounts'])).state)
      .toBe('not_applicable');
  });

  it('leaves every other metric alone: a NULL cash figure is unavailable through its OWN reason', () => {
    // `no_bank_accounts` is not this rule's business — cash is already NULL with its reason, and
    // claiming `not_applicable` here would be a second answer to the same question (ADR-104).
    expect(metricAvailability('closing_cash', q(null, [], ['no_bank_accounts']))).toEqual({ state: 'available' });
    expect(metricAvailability('revenue', q('9000.00'))).toEqual({ state: 'available' });
  });

  it('has reader-facing words for every reason it can return', () => {
    for (const reason of ['no_cost_of_sales_accounts', 'cost_of_sales_in_other_source', 'no_cost_of_sales']) {
      expect(AVAILABILITY_REASON_TEXT[reason], reason).toBeTruthy();
    }
  });
});
