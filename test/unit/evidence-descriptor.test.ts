import { describe, it, expect } from 'vitest';
import { ValidationError } from '@/core/errors';
import {
  canonicalDescriptorJson,
  compileDescriptor,
  descriptorHash,
  descriptorHashLiteral,
  foldRecordStatusEvents,
  isVisibleAtInstant,
  minAssurance,
  parseQueryDescriptor,
  QueryDescriptorV1Schema,
  selectVisibleRecordIds,
  valueInForceAt,
  withTerminalOrder,
  type QueryDescriptorV1,
  type RecordStatusEvent,
} from '@/modules/evidence';

/**
 * Pure tests for the evidence descriptor (EVIDENCE_MODEL.md §3, §11; plan Phase 4 slice 5).
 * No database: the integration side (RLS, real rows, real events) is owned by the schema engineer.
 */

const RUN = '9f1d0c4e-1111-4a2b-8c3d-000000000001';
const PERIOD_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const PERIOD_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ACCOUNT_A = 'cccccccc-0000-4000-8000-000000000003';
const ACCOUNT_B = 'dddddddd-0000-4000-8000-000000000004';
const CATEGORY_A = 'eeeeeeee-0000-4000-8000-000000000005';
const BANK_A = 'ffffffff-0000-4000-8000-000000000006';
const AGGREGATED_AT = '2026-03-31T23:00:00.000Z';

function ledgerDescriptor(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    table: 'ledger_entries',
    filters: { period_ids: [PERIOD_B, PERIOD_A], account_ids: [ACCOUNT_B, ACCOUNT_A], direction: 'credit' },
    as_of: { calculation_run_id: RUN, aggregated_at: AGGREGATED_AT },
    order: [{ field: 'amount', dir: 'desc' }],
    limit: 500,
    ...overrides,
  };
}

describe('QueryDescriptorV1 validation (§3)', () => {
  it('accepts the documented shape and normalises the order', () => {
    const d = parseQueryDescriptor(ledgerDescriptor());
    expect(d.v).toBe(1);
    expect(d.table).toBe('ledger_entries');
    expect(d.order).toEqual([
      { field: 'amount', dir: 'desc' },
      { field: 'id', dir: 'asc' },
    ]);
  });

  it('rejects an unknown v', () => {
    expect(QueryDescriptorV1Schema.safeParse(ledgerDescriptor({ v: 2 })).success).toBe(false);
    expect(QueryDescriptorV1Schema.safeParse(ledgerDescriptor({ v: '1' })).success).toBe(false);
    expect(() => parseQueryDescriptor(ledgerDescriptor({ v: 2 }))).toThrow(ValidationError);
  });

  it('rejects unknown keys rather than making a best-effort query', () => {
    expect(QueryDescriptorV1Schema.safeParse(ledgerDescriptor({ sql: 'select 1' })).success).toBe(false);
    expect(
      QueryDescriptorV1Schema.safeParse(
        ledgerDescriptor({ filters: { period_ids: [PERIOD_A], organization_id: PERIOD_A } }),
      ).success,
    ).toBe(false);
    expect(
      QueryDescriptorV1Schema.safeParse(
        ledgerDescriptor({ as_of: { calculation_run_id: RUN, aggregated_at: AGGREGATED_AT, extra: 1 } }),
      ).success,
    ).toBe(false);
  });

  it('rejects standard_categories and says why (ADR-034)', () => {
    const input = ledgerDescriptor({ filters: { standard_categories: ['revenue'] } });
    expect(QueryDescriptorV1Schema.safeParse(input).success).toBe(false);
    try {
      parseQueryDescriptor(input);
      throw new Error('expected a ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).issues;
      expect(issues.some((i) => /ADR-034/.test(i.message))).toBe(true);
      expect(issues.some((i) => /mutable property of an account/.test(i.message))).toBe(true);
    }
  });

  it('caps limit at 1,000', () => {
    expect(QueryDescriptorV1Schema.safeParse(ledgerDescriptor({ limit: 1000 })).success).toBe(true);
    expect(QueryDescriptorV1Schema.safeParse(ledgerDescriptor({ limit: 1001 })).success).toBe(false);
    expect(QueryDescriptorV1Schema.safeParse(ledgerDescriptor({ limit: 0 })).success).toBe(false);
    expect(QueryDescriptorV1Schema.safeParse(ledgerDescriptor({ limit: 10.5 })).success).toBe(false);
  });

  it('rejects metric_snapshots without as_of so a selection cannot mix runs', () => {
    const withoutAsOf = {
      v: 1,
      table: 'metric_snapshots',
      filters: { metric_keys: ['revenue'], period_ids: [PERIOD_A] },
    };
    expect(QueryDescriptorV1Schema.safeParse(withoutAsOf).success).toBe(false);
    expect(
      QueryDescriptorV1Schema.safeParse({
        ...withoutAsOf,
        as_of: { calculation_run_id: RUN, aggregated_at: AGGREGATED_AT },
      }).success,
    ).toBe(true);
  });

  it('requires an unambiguous instant on as_of (ADR-047.7)', () => {
    expect(
      QueryDescriptorV1Schema.safeParse(
        ledgerDescriptor({ as_of: { calculation_run_id: RUN, aggregated_at: '2026-03-31' } }),
      ).success,
    ).toBe(false);
    expect(
      QueryDescriptorV1Schema.safeParse(
        ledgerDescriptor({ as_of: { calculation_run_id: RUN, aggregated_at: '2026-03-31T23:00:00' } }),
      ).success,
    ).toBe(false);
    expect(
      QueryDescriptorV1Schema.safeParse(
        ledgerDescriptor({ as_of: { calculation_run_id: RUN, aggregated_at: '2026-03-31T23:00:00+01:00' } }),
      ).success,
    ).toBe(true);
  });

  it('always ends the order with id asc', () => {
    expect(withTerminalOrder(undefined)).toEqual([{ field: 'id', dir: 'asc' }]);
    expect(withTerminalOrder([{ field: 'id', dir: 'asc' }])).toEqual([{ field: 'id', dir: 'asc' }]);
    expect(withTerminalOrder([{ field: 'id', dir: 'desc' }])).toEqual([
      { field: 'id', dir: 'desc' },
      { field: 'id', dir: 'asc' },
    ]);
    expect(parseQueryDescriptor(ledgerDescriptor({ order: undefined })).order).toEqual([
      { field: 'id', dir: 'asc' },
    ]);
  });
});

describe('descriptorHash (RFC 8785 + sorted ids, ADR-046.2)', () => {
  it('is deterministic: two runs over identical data produce identical hashes', () => {
    const a = parseQueryDescriptor(ledgerDescriptor());
    const b = parseQueryDescriptor(ledgerDescriptor());
    expect(descriptorHash(a)).toBe(descriptorHash(b));
    expect(descriptorHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the key order of the input object', () => {
    const straight = parseQueryDescriptor({
      v: 1,
      table: 'invoices',
      filters: { invoice_types: ['sales'], open_as_of: '2026-03-31' },
      as_of: { calculation_run_id: RUN, aggregated_at: AGGREGATED_AT },
      limit: 100,
    });
    const shuffled = parseQueryDescriptor({
      limit: 100,
      as_of: { aggregated_at: AGGREGATED_AT, calculation_run_id: RUN },
      filters: { open_as_of: '2026-03-31', invoice_types: ['sales'] },
      table: 'invoices',
      v: 1,
    });
    expect(canonicalDescriptorJson(straight)).toBe(canonicalDescriptorJson(shuffled));
    expect(descriptorHash(straight)).toBe(descriptorHash(shuffled));
  });

  it('does not depend on the order of any id array', () => {
    const forward = parseQueryDescriptor({
      v: 1,
      table: 'bank_transactions',
      filters: {
        period_ids: [PERIOD_A, PERIOD_B],
        bank_account_ids: [BANK_A],
        category_account_ids: [CATEGORY_A, ACCOUNT_A],
        counterparty_ids: [ACCOUNT_B, ACCOUNT_A],
      },
    });
    const reversed = parseQueryDescriptor({
      v: 1,
      table: 'bank_transactions',
      filters: {
        period_ids: [PERIOD_B, PERIOD_A],
        bank_account_ids: [BANK_A],
        category_account_ids: [ACCOUNT_A, CATEGORY_A],
        counterparty_ids: [ACCOUNT_A, ACCOUNT_B],
      },
    });
    expect(descriptorHash(forward)).toBe(descriptorHash(reversed));
  });

  it('sorts invoice_types too, and still separates different selections', () => {
    const one = parseQueryDescriptor({
      v: 1,
      table: 'invoices',
      filters: { invoice_types: ['sales_credit_note', 'sales'] },
    });
    const two = parseQueryDescriptor({
      v: 1,
      table: 'invoices',
      filters: { invoice_types: ['sales', 'sales_credit_note'] },
    });
    const three = parseQueryDescriptor({ v: 1, table: 'invoices', filters: { invoice_types: ['sales'] } });
    expect(descriptorHash(one)).toBe(descriptorHash(two));
    expect(descriptorHash(one)).not.toBe(descriptorHash(three));
  });

  it('produces JCS: sorted keys, no whitespace', () => {
    const d = parseQueryDescriptor({ v: 1, table: 'period_balances', filters: { account_ids: [ACCOUNT_A] } });
    const json = canonicalDescriptorJson(d);
    expect(json).toBe(
      `{"filters":{"account_ids":["${ACCOUNT_A}"]},"order":[{"dir":"asc","field":"id"}],"table":"period_balances","v":1}`,
    );
  });

  it('exposes the bytea literal form for the write path', () => {
    const d = parseQueryDescriptor(ledgerDescriptor());
    expect(descriptorHashLiteral(d)).toBe(`\\x${descriptorHash(d)}`);
  });
});

describe('descriptor compiler (§3.1)', () => {
  it('compiles a fixture descriptor to the expected column/filter pairs, twice identically', () => {
    const descriptor = parseQueryDescriptor(ledgerDescriptor());
    const first = compileDescriptor(descriptor);
    const second = compileDescriptor(parseQueryDescriptor(ledgerDescriptor()));

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    expect(first.table).toBe('ledger_entries');
    expect(first.filters).toEqual([
      { column: 'period_id', op: 'in', value: [PERIOD_A, PERIOD_B] },
      { column: 'account_id', op: 'in', value: [ACCOUNT_A, ACCOUNT_B] },
      { column: 'direction', op: 'eq', value: 'credit' },
    ]);
    expect(first.order).toEqual([
      { column: 'amount', ascending: false },
      { column: 'id', ascending: true },
    ]);
    expect(first.amountColumn).toBe('amount');
    expect(first.asOf).toEqual({ calculationRunId: RUN, aggregatedAt: AGGREGATED_AT });
    expect(first.limit).toBe(500);
    expect(first.columns).not.toContain('description_raw');
  });

  it('compiles the same filters whatever order the ids arrived in', () => {
    const a = compileDescriptor(parseQueryDescriptor(ledgerDescriptor()));
    const b = compileDescriptor(
      parseQueryDescriptor(
        ledgerDescriptor({
          filters: { period_ids: [PERIOD_A, PERIOD_B], account_ids: [ACCOUNT_A, ACCOUNT_B], direction: 'credit' },
        }),
      ),
    );
    expect(a.filters).toEqual(b.filters);
  });

  it('adds the current-state predicates only when there is no as_of', () => {
    const withAsOf = compileDescriptor(parseQueryDescriptor(ledgerDescriptor()));
    expect(withAsOf.filters.some((f) => f.column === 'record_status')).toBe(false);
    expect(withAsOf.filters.some((f) => f.column === 'superseded_by')).toBe(false);

    const live = compileDescriptor(parseQueryDescriptor(ledgerDescriptor({ as_of: undefined })));
    expect(live.filters.slice(0, 2)).toEqual([
      { column: 'record_status', op: 'eq', value: 'accepted' },
      { column: 'superseded_by', op: 'isNull', value: null },
    ]);
  });

  it('rejects a filter that is not available on the target table', () => {
    expect(() =>
      compileDescriptor(
        parseQueryDescriptor({
          v: 1,
          table: 'period_balances',
          filters: { counterparty_ids: [ACCOUNT_A] },
        }),
      ),
    ).toThrow(ValidationError);

    expect(() =>
      compileDescriptor(
        parseQueryDescriptor({ v: 1, table: 'ledger_entries', filters: { bank_account_ids: [BANK_A] } }),
      ),
    ).toThrow(ValidationError);
  });

  it('rejects a direction that belongs to the other kind of table', () => {
    expect(() =>
      compileDescriptor(
        parseQueryDescriptor({ v: 1, table: 'ledger_entries', filters: { direction: 'inflow' } }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      compileDescriptor(
        parseQueryDescriptor({ v: 1, table: 'bank_transactions', filters: { direction: 'debit' } }),
      ),
    ).toThrow(ValidationError);
  });

  it('turns a cash direction into a predicate on the sign of the amount', () => {
    const inflow = compileDescriptor(
      parseQueryDescriptor({ v: 1, table: 'bank_transactions', filters: { direction: 'inflow' } }),
    );
    expect(inflow.filters).toContainEqual({ column: 'amount', op: 'gt', value: 0 });
    const outflow = compileDescriptor(
      parseQueryDescriptor({ v: 1, table: 'bank_transactions', filters: { direction: 'outflow' } }),
    );
    expect(outflow.filters).toContainEqual({ column: 'amount', op: 'lt', value: 0 });
  });

  it('moves the category and transfer filters off the columns when as_of is set (ADR-034)', () => {
    const live = compileDescriptor(
      parseQueryDescriptor({
        v: 1,
        table: 'bank_transactions',
        filters: { category_account_ids: [CATEGORY_A], exclude_cash_transfers: true },
      }),
    );
    expect(live.filters).toContainEqual({ column: 'category_account_id', op: 'in', value: [CATEGORY_A] });
    expect(live.filters).toContainEqual({ column: 'transfer_kind', op: 'neq', value: 'cash_transfer' });
    expect(live.postFilters).toEqual([]);

    const historic = compileDescriptor(
      parseQueryDescriptor({
        v: 1,
        table: 'bank_transactions',
        filters: { category_account_ids: [CATEGORY_A], exclude_cash_transfers: true },
        as_of: { calculation_run_id: RUN, aggregated_at: AGGREGATED_AT },
      }),
    );
    expect(historic.filters.some((f) => f.column === 'category_account_id')).toBe(false);
    expect(historic.filters.some((f) => f.column === 'transfer_kind')).toBe(false);
    expect(historic.postFilters).toEqual([
      { kind: 'as_of_category_in', ids: [CATEGORY_A] },
      { kind: 'as_of_exclude_cash_transfers' },
    ]);
  });

  it('compiles the invoice open/overdue filters without any string interpolation', () => {
    const compiled = compileDescriptor(
      parseQueryDescriptor({
        v: 1,
        table: 'invoices',
        filters: { invoice_types: ['sales'], overdue_as_of: '2026-03-31' },
      }),
    );
    expect(compiled.filters).toContainEqual({ column: 'issue_date', op: 'lte', value: '2026-03-31' });
    expect(compiled.filters).toContainEqual({ column: 'status', op: 'neq', value: 'void' });
    expect(compiled.filters).toContainEqual({ column: 'due_date', op: 'lt', value: '2026-03-31' });
    expect(compiled.postFilters).toEqual([{ kind: 'open_at', date: '2026-03-31' }]);
    expect(compiled.amountColumn).toBe('balance_due');
    expect(compiled.amountBasis).toBe('column');
  });

  it('reads an invoice-basis P&L selection on the engine’s net-of-tax basis, never on balance_due (ADR-105)', () => {
    // No open/overdue filter: this is revenue, cost of sales or an expense category on the invoice basis.
    const pnl = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'invoices',
      filters: { period_ids: ['00000000-0000-4000-8000-000000000001'], invoice_types: ['purchase', 'purchase_credit_note'], counterparty_ids: ['00000000-0000-4000-8000-000000000002'] },
    }));
    expect(pnl.amountBasis).toBe('invoice_net');
    expect(pnl.amountColumn).toBeNull();
    // The net rule needs the three money columns the header carries.
    expect(pnl.columns).toEqual(expect.arrayContaining(['subtotal', 'tax_amount', 'total_amount', 'invoice_type', 'status']));
    // The supplier filter that scopes the figure is untouched.
    expect(pnl.filters).toContainEqual({ column: 'counterparty_id', op: 'in', value: ['00000000-0000-4000-8000-000000000002'] });
    // Receivables keep the balance still owed, which IS that figure.
    const ar = compileDescriptor(parseQueryDescriptor({ v: 1, table: 'invoices', filters: { invoice_types: ['sales'], open_as_of: '2026-03-31' } }));
    expect(ar.amountBasis).toBe('column');
    expect(ar.amountColumn).toBe('balance_due');
  });

  it('sums a directional bank selection as a magnitude, because the figure is one (ADR-109)', () => {
    // A bank amount is signed. `cash_outflows` of 4,200.00 had a drill-down totalling -4,200.00
    // while `cash_inflows` matched, so the two halves of one statement disagreed about sign.
    const out = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'bank_transactions',
      filters: { period_ids: [PERIOD_A], bank_account_ids: [BANK_A], direction: 'outflow' },
    }));
    expect(out.amountBasis).toBe('column_magnitude');
    expect(out.amountColumn).toBe('amount');
    // Inflows are already positive; the same basis is harmless and keeps one rule for the table.
    const inflow = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'bank_transactions', filters: { period_ids: [PERIOD_A], direction: 'inflow' },
    }));
    expect(inflow.amountBasis).toBe('column_magnitude');
    // Without a direction the selection can mix signs and must keep them.
    const mixed = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'bank_transactions', filters: { period_ids: [PERIOD_A] },
    }));
    expect(mixed.amountBasis).toBe('column');
    // Other tables are untouched.
    const ledger = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'ledger_entries', filters: { period_ids: [PERIOD_A], direction: 'debit' },
    }));
    expect(ledger.amountBasis).toBe('column');
  });

  it('totals a ledger selection over both sides in reporting sign (ADR-111)', () => {
    // `ledger_entries.amount` is positive with the side in `direction`, so a plain column sum added a
    // refund to the revenue it reduces: `revenue` 19,400.00 over a drill-down of 21,400.00 (HIGH-6).
    const both = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'ledger_entries', filters: { period_ids: [PERIOD_A] },
    }));
    expect(both.amountBasis).toBe('ledger_reporting');
    expect(both.columns).toEqual(expect.arrayContaining(['account_id', 'direction', 'amount']));
    // One side only: every line has the same sign, and the column is already that figure.
    const credit = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'ledger_entries', filters: { period_ids: [PERIOD_A], direction: 'credit' },
    }));
    expect(credit.amountBasis).toBe('column');
  });

  it('excludes voided invoices from EVERY invoice shape, as the engine does (ADR-107)', () => {
    const notVoid = { column: 'status', op: 'neq', value: 'void' };
    // The P&L shapes, which carried record_status and superseded_by but never this.
    for (const filters of [
      { period_ids: [PERIOD_A], invoice_types: ['sales', 'sales_credit_note'] },
      { period_ids: [PERIOD_A], invoice_types: ['purchase'], counterparty_ids: [ACCOUNT_A] },
      { period_ids: [PERIOD_A] },
    ] as const) {
      const compiled = compileDescriptor(parseQueryDescriptor({ v: 1, table: 'invoices', filters }));
      expect(compiled.filters, JSON.stringify(filters)).toContainEqual(notVoid);
      expect(compiled.filters).toContainEqual({ column: 'record_status', op: 'eq', value: 'accepted' });
      expect(compiled.filters).toContainEqual({ column: 'superseded_by', op: 'isNull', value: null });
    }
    // Pinned to a run: the lifecycle pair drops out because the events decide, but a void is the
    // invoice's own business status and has no event, so the predicate stays.
    const pinned = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'invoices', filters: { period_ids: [PERIOD_A] },
      as_of: { calculation_run_id: RUN, aggregated_at: '2026-04-01T00:00:00.000Z' },
    }));
    expect(pinned.filters).toContainEqual(notVoid);
    expect(pinned.filters).not.toContainEqual({ column: 'record_status', op: 'eq', value: 'accepted' });
    // Emitted once, not twice, where the receivables helper adds it as well.
    const ar = compileDescriptor(parseQueryDescriptor({
      v: 1, table: 'invoices', filters: { invoice_types: ['sales'], open_as_of: '2026-03-31' },
    }));
    expect(ar.filters.filter((f) => f.column === 'status')).toEqual([notVoid]);
    // Other tables have no such column and must not acquire the predicate.
    const ledger = compileDescriptor(parseQueryDescriptor({ v: 1, table: 'ledger_entries', filters: { period_ids: [PERIOD_A] } }));
    expect(ledger.filters.some((f) => f.column === 'status')).toBe(false);
  });

  it('pins the run for a metric_snapshots selection and refuses to sum mixed units', () => {
    const compiled = compileDescriptor(
      parseQueryDescriptor({
        v: 1,
        table: 'metric_snapshots',
        filters: { metric_keys: ['revenue'], dimension: { type: 'counterparty', id: ACCOUNT_A } },
        as_of: { calculation_run_id: RUN, aggregated_at: AGGREGATED_AT },
      }),
    );
    expect(compiled.filters[0]).toEqual({ column: 'calculation_run_id', op: 'eq', value: RUN });
    expect(compiled.filters).toContainEqual({ column: 'dimension_type', op: 'eq', value: 'counterparty' });
    expect(compiled.filters).toContainEqual({ column: 'dimension_id', op: 'eq', value: ACCOUNT_A });
    expect(compiled.amountColumn).toBeNull();
    expect(compiled.hasRecordLifecycle).toBe(false);
  });

  it('rejects an order field outside the table allow-list', () => {
    expect(() =>
      compileDescriptor(
        parseQueryDescriptor({
          v: 1,
          table: 'ledger_entries',
          order: [{ field: 'description', dir: 'asc' }],
        }),
      ),
    ).toThrow(ValidationError);
  });

  it('defaults the page size when the descriptor omits limit', () => {
    expect(compileDescriptor(parseQueryDescriptor({ v: 1, table: 'invoices' })).limit).toBe(500);
  });
});

describe('as-of row selection (§3, ADR-047.1)', () => {
  const at = (iso: string, event: RecordStatusEvent['event'], seq: number, recordId = 'r1'): RecordStatusEvent => ({
    recordId,
    event,
    at: iso,
    seq,
  });

  const T = '2026-03-31T23:00:00.000Z';

  it('a row accepted before the instant and never superseded is visible', () => {
    const state = foldRecordStatusEvents([at('2026-03-02T10:00:00.000Z', 'accepted', 1)], T);
    expect(state).toEqual({ accepted: true, superseded: false });
    expect(isVisibleAtInstant(state)).toBe(true);
  });

  it('a row that did not exist yet is not visible', () => {
    expect(foldRecordStatusEvents([at('2026-04-02T10:00:00.000Z', 'accepted', 1)], T)).toEqual({
      accepted: false,
      superseded: false,
    });
    expect(foldRecordStatusEvents([], T)).toEqual({ accepted: false, superseded: false });
  });

  it('a row superseded after the instant is still visible at the instant (R2-C-10)', () => {
    const events = [
      at('2026-03-02T10:00:00.000Z', 'accepted', 1),
      at('2026-04-05T10:00:00.000Z', 'superseded', 2),
    ];
    expect(isVisibleAtInstant(foldRecordStatusEvents(events, T))).toBe(true);
    expect(isVisibleAtInstant(foldRecordStatusEvents(events, '2026-04-30T00:00:00.000Z'))).toBe(false);
  });

  it('honours unsuperseded and restored identically (ADR-046.2)', () => {
    const base = at('2026-03-01T10:00:00.000Z', 'accepted', 1);
    const superseded = at('2026-03-10T10:00:00.000Z', 'superseded', 2);
    const unsuperseded = at('2026-03-20T10:00:00.000Z', 'unsuperseded', 3);
    const restored = at('2026-03-20T10:00:00.000Z', 'restored', 3);
    expect(foldRecordStatusEvents([base, superseded, unsuperseded], T)).toEqual(
      foldRecordStatusEvents([base, superseded, restored], T),
    );
    expect(isVisibleAtInstant(foldRecordStatusEvents([base, superseded, restored], T))).toBe(true);
  });

  it('a rejected row is out, and a later accepted event puts it back', () => {
    const base = at('2026-03-01T10:00:00.000Z', 'accepted', 1);
    const rejected = at('2026-03-05T10:00:00.000Z', 'rejected', 2);
    expect(isVisibleAtInstant(foldRecordStatusEvents([base, rejected], T))).toBe(false);
    const promoted = at('2026-03-06T10:00:00.000Z', 'accepted', 3);
    expect(isVisibleAtInstant(foldRecordStatusEvents([base, rejected, promoted], T))).toBe(true);
  });

  it('is order-independent: events are sorted by instant then by identity', () => {
    const shuffled = [
      at('2026-03-10T10:00:00.000Z', 'superseded', 2),
      at('2026-03-01T10:00:00.000Z', 'accepted', 1),
      at('2026-03-20T10:00:00.000Z', 'unsuperseded', 3),
    ];
    expect(foldRecordStatusEvents(shuffled, T)).toEqual({ accepted: true, superseded: false });
  });

  it('breaks a tie on the identity column, so one commit transaction folds deterministically', () => {
    const same = '2026-03-10T10:00:00.000Z';
    const forward = [at(same, 'accepted', 10), at(same, 'superseded', 11)];
    const backward = [at(same, 'superseded', 11), at(same, 'accepted', 10)];
    expect(foldRecordStatusEvents(forward, T)).toEqual({ accepted: true, superseded: true });
    expect(foldRecordStatusEvents(backward, T)).toEqual(foldRecordStatusEvents(forward, T));
  });

  it('includes an event landing exactly on the instant', () => {
    expect(isVisibleAtInstant(foldRecordStatusEvents([at(T, 'accepted', 1)], T))).toBe(true);
  });

  it('selects the visible ids and keeps the candidate order', () => {
    const events = [
      at('2026-03-01T10:00:00.000Z', 'accepted', 1, 'r1'),
      at('2026-03-01T10:00:00.000Z', 'accepted', 2, 'r2'),
      at('2026-03-04T10:00:00.000Z', 'superseded', 3, 'r2'),
      at('2026-03-01T10:00:00.000Z', 'accepted', 4, 'r3'),
      at('2026-04-09T10:00:00.000Z', 'accepted', 5, 'r4'),
    ];
    expect(selectVisibleRecordIds(['r3', 'r2', 'r1', 'r4'], events, T)).toEqual(['r3', 'r1']);
    // Resolving twice returns the identical ordered ids (§11 determinism case).
    expect(selectVisibleRecordIds(['r3', 'r2', 'r1', 'r4'], events, T)).toEqual(['r3', 'r1']);
  });
});

describe('history in force at an instant (category_history, account_category_history)', () => {
  it('picks the interval covering the instant, half-open at valid_to', () => {
    const intervals = [
      { validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-03-01T00:00:00.000Z', value: 'operating_expense' },
      { validFrom: '2026-03-01T00:00:00.000Z', validTo: null, value: 'marketing' },
    ];
    expect(valueInForceAt(intervals, '2026-02-15T00:00:00.000Z')).toBe('operating_expense');
    expect(valueInForceAt(intervals, '2026-03-01T00:00:00.000Z')).toBe('marketing');
    expect(valueInForceAt(intervals, '2026-06-01T00:00:00.000Z')).toBe('marketing');
  });

  it('returns null when nothing covers the instant, rather than guessing the nearest', () => {
    const intervals = [{ validFrom: '2026-03-01T00:00:00.000Z', validTo: null, value: 'marketing' }];
    expect(valueInForceAt(intervals, '2026-01-01T00:00:00.000Z')).toBeNull();
    expect(valueInForceAt([], '2026-01-01T00:00:00.000Z')).toBeNull();
  });
});

describe('assurance propagation (§7)', () => {
  it('takes the minimum in the order verified > calculated > estimated > inferred', () => {
    expect(minAssurance(['verified', 'calculated'])).toBe('calculated');
    expect(minAssurance(['calculated', 'inferred', 'estimated'])).toBe('inferred');
    expect(minAssurance(['verified'])).toBe('verified');
    expect(minAssurance([])).toBeNull();
  });
});

describe('the full descriptor pipeline is reproducible', () => {
  it('parses, hashes and compiles a descriptor identically on two passes', () => {
    const raw: unknown = {
      v: 1,
      table: 'bank_transactions',
      filters: {
        period_ids: [PERIOD_B, PERIOD_A],
        bank_account_ids: [BANK_A],
        category_account_ids: [CATEGORY_A, ACCOUNT_A],
        exclude_cash_transfers: true,
        direction: 'outflow',
      },
      as_of: { calculation_run_id: RUN, aggregated_at: AGGREGATED_AT },
      order: [{ field: 'transaction_date', dir: 'desc' }],
      limit: 250,
    };

    const passes = [1, 2].map(() => {
      const parsed: QueryDescriptorV1 = parseQueryDescriptor(raw);
      return {
        hash: descriptorHash(parsed),
        json: canonicalDescriptorJson(parsed),
        compiled: compileDescriptor(parsed),
      };
    });

    expect(passes[0]).toEqual(passes[1]);
    expect(passes[0]?.hash).toBe(passes[1]?.hash);
    expect(passes[0]?.compiled.filters).toEqual([
      { column: 'period_id', op: 'in', value: [PERIOD_A, PERIOD_B] },
      { column: 'bank_account_id', op: 'in', value: [BANK_A] },
      { column: 'amount', op: 'lt', value: 0 },
    ]);
    expect(passes[0]?.compiled.postFilters).toEqual([
      { kind: 'as_of_category_in', ids: [ACCOUNT_A, CATEGORY_A] },
      { kind: 'as_of_exclude_cash_transfers' },
    ]);
  });
});
