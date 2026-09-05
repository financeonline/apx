import { describe, it, expect } from 'vitest';

import {
  CATEGORY_LABELS,
  accountReference,
  agingBucket,
  categoryLabel,
  dimensionKeyOf,
  formatFigure,
  isUncategorised,
  previousPeriodOf,
  resolvePeriod,
  sortAccountsForMapping,
  toAccountRow,
  toCashAccount,
  toFigure,
  toInvoiceView,
  toTransactionView,
  type PeriodLabel,
  type SnapshotRow,
} from '@/modules/dashboard';
import { STANDARD_CATEGORIES, type Account, type Invoice, type StandardCategory } from '@/modules/financials';
import type { BankAccount, BankTransaction } from '@/modules/banking';

/**
 * The Money pages' decisions, without a database (TEST_STRATEGY.md §1).
 *
 * Everything asserted here is a decision a page makes before any figure is rendered: which month
 * it opens on, how a figure is formatted, how late an invoice is, which accounts a reader is shown
 * first. None of them computes a financial number — the figures themselves come from
 * `metric_current` and are asserted against it in the integration suite.
 */

// -----------------------------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------------------------

function period(id: string, label: string, start: string, isComplete: boolean): PeriodLabel {
  return { id, label, periodStart: start, periodEnd: `${start.slice(0, 8)}28`, isComplete };
}

const MARCH = period('p-03', 'March 2026', '2026-03-01', true);
const FEBRUARY = period('p-02', 'February 2026', '2026-02-01', true);
const JANUARY = period('p-01', 'January 2026', '2026-01-01', true);
/** Newest first, exactly as the repository orders them. */
const APRIL_PARTIAL = period('p-04', 'April 2026', '2026-04-01', false);
const PERIODS = [APRIL_PARTIAL, MARCH, FEBRUARY, JANUARY];
const ALL_WITH_DATA = new Set(PERIODS.map((p) => p.id));

function snapshot(over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    snapshotId: 's-1',
    metricKey: 'revenue',
    periodId: MARCH.id,
    dimensionType: 'none',
    dimensionId: null,
    value: '12400.50',
    unit: 'money',
    currency: 'GBP',
    basis: 'ledger',
    assurance: 'verified',
    dataQuality: { completeness: 1, proxy: false, warnings: [], missing: [] },
    components: {},
    ...over,
  };
}

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'a-1',
    code: '4000',
    name: 'Sales',
    accountType: 'income',
    standardCategory: 'revenue',
    isSystem: false,
    isActive: true,
    source: 'imported',
    mappingConfidence: 'confirmed',
    ...over,
  };
}

// -----------------------------------------------------------------------------------------------
// Which month the page opens on (§4, ADR-030)
// -----------------------------------------------------------------------------------------------

describe('the month a period-scoped page opens on', () => {
  it('opens on the latest COMPLETE month, not the newest one', () => {
    // April has data but is not finished. Opening on it would compare a part-month with a whole one.
    expect(resolvePeriod(PERIODS, ALL_WITH_DATA)?.id).toBe(MARCH.id);
  });

  it('honours ?period= when that month has figures', () => {
    expect(resolvePeriod(PERIODS, ALL_WITH_DATA, FEBRUARY.id)?.id).toBe(FEBRUARY.id);
  });

  it('ignores a requested month with no figures rather than showing an empty month', () => {
    const withData = new Set([MARCH.id, FEBRUARY.id]);
    expect(resolvePeriod(PERIODS, withData, JANUARY.id)?.id).toBe(MARCH.id);
  });

  it('ignores an id from another organisation', () => {
    expect(resolvePeriod(PERIODS, ALL_WITH_DATA, 'p-from-another-org')?.id).toBe(MARCH.id);
  });

  it('falls back to the latest month with data when no month is complete yet', () => {
    const onlyApril = new Set([APRIL_PARTIAL.id]);
    expect(resolvePeriod(PERIODS, onlyApril)?.id).toBe(APRIL_PARTIAL.id);
  });

  it('has no month at all when nothing has been computed', () => {
    expect(resolvePeriod(PERIODS, new Set())).toBeNull();
    expect(resolvePeriod([], ALL_WITH_DATA)).toBeNull();
  });
});

describe('the month the change column compares with', () => {
  it('is the nearest earlier month that carries figures', () => {
    expect(previousPeriodOf(PERIODS, ALL_WITH_DATA, MARCH)?.id).toBe(FEBRUARY.id);
  });

  it('skips a month the engine never computed, rather than comparing with nothing', () => {
    const withGap = new Set([MARCH.id, JANUARY.id]);
    expect(previousPeriodOf(PERIODS, withGap, MARCH)?.id).toBe(JANUARY.id);
  });

  it('is null for the earliest month', () => {
    expect(previousPeriodOf(PERIODS, ALL_WITH_DATA, JANUARY)).toBeNull();
  });
});

// -----------------------------------------------------------------------------------------------
// Formatting (§8.2)
// -----------------------------------------------------------------------------------------------

describe('figures on a Money sub-page', () => {
  it('shows pence, which Home does not (§8.2)', () => {
    expect(formatFigure(snapshot())).toBe('£12,400.50');
  });

  it('shows a true minus sign, never parentheses (§8.2)', () => {
    expect(formatFigure(snapshot({ value: '-1200.00' }))).toBe('−£1,200.00');
  });

  it('shows "—" for a figure that is not computable, never 0 and never blank (§4)', () => {
    expect(formatFigure(snapshot({ value: null }))).toBe('—');
  });

  it('shows a ratio as a percentage to one decimal place (§8.2)', () => {
    expect(formatFigure(snapshot({ value: '0.2534', unit: 'ratio', currency: null })))
      .toBe('25.3%');
  });

  it('uses the organisation currency it was given, never an assumed one', () => {
    expect(formatFigure(snapshot({ value: '900.00', currency: 'EUR' }))).toBe('€900.00');
  });

  it('keeps the one status badge and the "Why?" link the card carries (§4)', () => {
    const figure = toFigure(snapshot(), MARCH, null, {
      orgSlug: 'acme', comparisonLabel: 'February 2026',
    });
    expect(figure.value).toBe('£12,400.50');
    expect(figure.status.kind).toBe('none');
    expect(figure.whyHref).toContain('/app/acme/evidence?metric=revenue');
    expect(figure.whyHref).toContain(MARCH.id);
    // §8.1: the plain phrase is the headline, the accountant's term is the tooltip.
    expect(figure.label).toBe('Sales');
    expect(figure.technicalLabel).toBe('Revenue');
  });

  it('carries the reason a NULL is NULL into the badge tooltip (§4)', () => {
    const figure = toFigure(
      snapshot({ value: null, metricKey: 'closing_cash', dataQuality: {
        completeness: 0, proxy: false, warnings: [], missing: ['no_opening_cash'],
      } }),
      MARCH, null, { orgSlug: 'acme', comparisonLabel: 'February 2026' },
    );
    expect(figure.value).toBe('—');
    expect(figure.status.kind).toBe('not_available');
    expect(figure.status.tooltip).toBe(
      'We need the opening bank balance before we can show your cash.',
    );
  });

  it('formats the second line with pence too', () => {
    const figure = toFigure(snapshot({ metricKey: 'operating_profit' }), MARCH, null, {
      orgSlug: 'acme',
      comparisonLabel: 'February 2026',
      secondary: { label: 'Profit after interest and tax', row: snapshot({ value: '900.25' }) },
    });
    expect(figure.secondaryLine).toEqual({
      label: 'Profit after interest and tax', value: '£900.25',
    });
  });
});

// -----------------------------------------------------------------------------------------------
// Breakdown labels
// -----------------------------------------------------------------------------------------------

describe('what a dimensioned snapshot is a breakdown of', () => {
  it('reads a standard category from dimension_key, which is where it lives (ADR-053)', () => {
    const row = snapshot({
      metricKey: 'expense_by_category',
      dimensionType: 'standard_category',
      dimensionId: null,
      dimensionKey: 'marketing',
    });
    expect(dimensionKeyOf(row)).toBe('marketing');
    expect(categoryLabel(dimensionKeyOf(row))).toBe('Marketing');
  });

  it('still reads a snapshot written before that column existed', () => {
    // A report generated last month has to resolve to the numbers it saw, so an older snapshot
    // must stay readable rather than losing its breakdown.
    const row = snapshot({
      metricKey: 'expense_by_category',
      dimensionType: 'standard_category',
      dimensionId: null,
      components: { category: 'payroll' },
    });
    expect(dimensionKeyOf(row)).toBe('payroll');
  });

  it('prefers the column over the components when both are present', () => {
    const row = snapshot({
      metricKey: 'expense_by_category',
      dimensionType: 'standard_category',
      dimensionKey: 'marketing',
      components: { category: 'payroll' },
    });
    expect(dimensionKeyOf(row)).toBe('marketing');
  });

  it('falls back to dimension_id for a counterparty breakdown', () => {
    const row = snapshot({
      metricKey: 'customer_revenue',
      dimensionType: 'counterparty',
      dimensionId: 'c-9',
      components: {},
    });
    expect(dimensionKeyOf(row)).toBe('c-9');
  });

  it('calls a breakdown row with no dimension "Unattributed", never a blank', () => {
    expect(categoryLabel(null)).toBe('Unattributed');
  });

  it('has a plain label for every one of the 26 standard categories (§8.1)', () => {
    for (const category of STANDARD_CATEGORIES) {
      expect(CATEGORY_LABELS[category], category).toBeTruthy();
    }
    expect(Object.keys(CATEGORY_LABELS)).toHaveLength(STANDARD_CATEGORIES.length);
  });
});

// -----------------------------------------------------------------------------------------------
// Aging (Owed to you / You owe)
// -----------------------------------------------------------------------------------------------

describe('how late an invoice is', () => {
  const today = '2026-03-31';

  it('is "not due" on the due date itself', () => {
    expect(agingBucket('2026-03-31', today)).toBe('not_due');
    expect(agingBucket('2026-04-15', today)).toBe('not_due');
  });

  it('buckets by days late, on the boundary', () => {
    expect(agingBucket('2026-03-30', today)).toBe('days_1_30');
    expect(agingBucket('2026-03-01', today)).toBe('days_1_30');
    expect(agingBucket('2026-02-28', today)).toBe('days_31_60');
    expect(agingBucket('2026-01-30', today)).toBe('days_31_60');
    expect(agingBucket('2026-01-29', today)).toBe('days_61_90');
    expect(agingBucket('2025-12-31', today)).toBe('days_61_90');
    expect(agingBucket('2025-12-30', today)).toBe('days_90_plus');
  });

  it('says "no due date" rather than guessing one (the engine reports no_due_dates)', () => {
    expect(agingBucket(null, today)).toBe('unknown');
    expect(agingBucket('not-a-date', today)).toBe('unknown');
  });
});

describe('an invoice row', () => {
  const invoice: Invoice = {
    id: 'i-1',
    invoiceType: 'sales',
    counterpartyId: 'c-1',
    invoiceNumber: 'INV-014',
    issueDate: '2026-02-10',
    dueDate: '2026-03-12',
    periodId: MARCH.id,
    totalAmount: '1200.00',
    amountPaid: '200.00',
    balanceDue: '1000.00',
    currency: 'GBP',
    status: 'partially_paid',
    paidDate: null,
    recordStatus: 'accepted',
    assuranceLevel: 'verified',
    supersededBy: null,
  };

  it('shows the outstanding balance to the penny and how late it is', () => {
    const view = toInvoiceView(invoice, new Map([['c-1', 'Northwind Ltd']]), '2026-03-31');
    expect(view.balanceDue).toBe('£1,000.00');
    expect(view.counterpartyName).toBe('Northwind Ltd');
    expect(view.bucket).toBe('days_1_30');
    expect(view.bucketLabel).toBe('1–30 days late');
  });

  it('never renders a blank name for a counterparty it cannot resolve', () => {
    expect(toInvoiceView(invoice, new Map(), '2026-03-31').counterpartyName).toBe('Unknown');
  });
});

// -----------------------------------------------------------------------------------------------
// Bank activity
// -----------------------------------------------------------------------------------------------

describe('an uncategorised bank transaction', () => {
  const categories = new Map<string, StandardCategory>([
    ['acc-marketing', 'marketing'],
    ['acc-holding', 'uncategorised'],
  ]);

  it('is one with no category at all', () => {
    expect(isUncategorised({ categoryAccountId: null }, categories)).toBe(true);
  });

  it('is also one pointing at the holding account, which is the same thing to a reader', () => {
    expect(isUncategorised({ categoryAccountId: 'acc-holding' }, categories)).toBe(true);
  });

  it('is not one with a real category', () => {
    expect(isUncategorised({ categoryAccountId: 'acc-marketing' }, categories)).toBe(false);
  });
});

describe('a bank transaction row', () => {
  const transaction: BankTransaction = {
    id: 't-1',
    bankAccountId: 'b-1',
    transactionDate: '2026-03-14',
    periodId: MARCH.id,
    amount: '-420.75',
    currency: 'GBP',
    descriptionNormalized: 'CARD PAYMENT TO ACME ****1234',
    counterpartyId: null,
    categoryAccountId: null,
    categorySource: 'none',
    isTransfer: false,
    transferKind: 'none',
    transferPairId: null,
    recurringGroupId: null,
    recordStatus: 'accepted',
    assuranceLevel: 'verified',
    supersededBy: null,
  };

  const names = new Map([['b-1', 'Business current account']]);
  const categories = new Map<string, StandardCategory>([['acc-marketing', 'marketing']]);

  it('renders the normalised description — description_raw is not selectable at all (ADR-044.2)', () => {
    const view = toTransactionView(transaction, names, categories);
    expect(view.description).toBe('CARD PAYMENT TO ACME ****1234');
    // The view model has no field a raw description could travel in.
    expect(Object.keys(view)).not.toContain('descriptionRaw');
    expect(JSON.stringify(view)).not.toContain('description_raw');
  });

  it('flags one nobody has categorised, so the filter link has something to count', () => {
    const view = toTransactionView(transaction, names, categories);
    expect(view.uncategorised).toBe(true);
    expect(view.categoryLabel).toBe('Not yet categorised');
    expect(view.amount).toBe('−£420.75');
  });

  it('names a transfer in words rather than showing an enum value (§8.1)', () => {
    const view = toTransactionView(
      { ...transaction, isTransfer: true, transferKind: 'cash_transfer' }, names, categories,
    );
    expect(view.transferKind).toBe('Transfer between your accounts');
  });

  it('never shows a blank account name', () => {
    const view = toTransactionView(transaction, new Map(), categories);
    expect(view.accountName).toBe('Unknown account');
  });
});

// -----------------------------------------------------------------------------------------------
// Cash accounts and the opening balance (CD-06)
// -----------------------------------------------------------------------------------------------

describe('a bank account on the Cash page', () => {
  const bankAccount: BankAccount = {
    id: 'b-1',
    name: 'Business current account',
    bankName: 'Barclays',
    accountNumberMasked: '****1234',
    sortCodeMasked: '20-**-**',
    currency: 'GBP',
    accountType: 'current',
    ledgerAccountId: null,
    openingBalance: '5000.00',
    openingBalanceDate: '2026-01-01',
    isActive: true,
  };

  it('is recognised by its masked reference, never an unmasked number', () => {
    expect(accountReference(bankAccount)).toBe('20-**-** · ****1234');
    expect(accountReference({ ...bankAccount, accountNumberMasked: null, sortCodeMasked: null }))
      .toBe('Barclays');
  });

  it('shows a known opening balance to the penny', () => {
    const view = toCashAccount(bankAccount);
    expect(view.openingBalance).toBe('£5,000.00');
    expect(view.needsOpeningBalance).toBe(false);
  });

  it('shows "—" and asks for the balance when it is unknown — never £0 (§4, CD-06)', () => {
    const view = toCashAccount({
      ...bankAccount, openingBalance: null, openingBalanceDate: null,
    });
    expect(view.openingBalance).toBe('—');
    expect(view.needsOpeningBalance).toBe(true);
  });

  it('treats a balance with no date as unknown: an opening balance needs both', () => {
    const view = toCashAccount({ ...bankAccount, openingBalanceDate: null });
    expect(view.needsOpeningBalance).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// The chart of accounts (ADR-004)
// -----------------------------------------------------------------------------------------------

describe('the order of the chart of accounts', () => {
  it('puts the accounts that need a decision first', () => {
    const sorted = sortAccountsForMapping([
      account({ id: 'confirmed', name: 'Sales', mappingConfidence: 'confirmed' }),
      account({ id: 'unmapped', name: 'Zebra supplies', mappingConfidence: 'unmapped',
        standardCategory: 'uncategorised' }),
      account({ id: 'suggested', name: 'Adverts', mappingConfidence: 'suggested',
        standardCategory: 'marketing' }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(['unmapped', 'suggested', 'confirmed']);
  });

  it('is stable within a band, so the list does not reshuffle between visits', () => {
    const sorted = sortAccountsForMapping([
      account({ id: 'b', name: 'Bank charges', standardCategory: 'operating_expense' }),
      account({ id: 'a', name: 'Advertising', standardCategory: 'operating_expense' }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the list it was given', () => {
    const input = [
      account({ id: 'confirmed' }),
      account({ id: 'unmapped', mappingConfidence: 'unmapped' }),
    ];
    sortAccountsForMapping(input);
    expect(input.map((a) => a.id)).toEqual(['confirmed', 'unmapped']);
  });
});

describe('an account row', () => {
  it('never offers to re-map a system account (ADR-004: it IS its category)', () => {
    expect(toAccountRow(account({ isSystem: true })).remappable).toBe(false);
    expect(toAccountRow(account({ isSystem: false })).remappable).toBe(true);
  });

  it('marks an unmapped or merely suggested account as needing attention', () => {
    expect(toAccountRow(account({ mappingConfidence: 'unmapped' })).needsAttention).toBe(true);
    expect(toAccountRow(account({ mappingConfidence: 'suggested' })).needsAttention).toBe(true);
    expect(toAccountRow(account()).needsAttention).toBe(false);
  });

  it('marks a confirmed mapping onto the holding category as needing attention too', () => {
    // "Confirmed uncategorised" is still money outside the profit figures.
    const row = toAccountRow(account({ standardCategory: 'uncategorised' }));
    expect(row.needsAttention).toBe(true);
    expect(row.categoryLabel).toBe('Not yet categorised');
  });
});
