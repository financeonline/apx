import { describe, expect, it } from 'vitest';
import { runTriggerRef } from '@/modules/jobs';
import { TRIGGER_TABLES } from '@/db/app/engine-runs';

/**
 * ADR-132: a run records only a reference `calculation_runs`' `same_org_ref` trigger accepts.
 * The mapping is the database layer's own (`TRIGGER_TABLES`, the port of that trigger), so the two
 * cannot drift.
 */

const MAPPING = new Map<string, string>(Object.entries(TRIGGER_TABLES));

describe('runTriggerRef', () => {
  it('reads all nine triggers from the database layer', () => {
    expect(MAPPING.size).toBe(9);
  });

  it('records nothing for every trigger whose rule names no table', () => {
    for (const [trigger, table] of MAPPING) {
      if (table !== '-') continue;
      // A bank transaction behind a banking_edit, a record behind record_superseded: refused before.
      expect(runTriggerRef(trigger as never, 'some-row-id', false), trigger).toBeNull();
    }
  });

  it('records an import batch for an import trigger, and nothing when the ref is another row', () => {
    expect(runTriggerRef('import_commit', 'batch-id', true)).toBe('batch-id');
    expect(runTriggerRef('import_rollback', 'batch-id', true)).toBe('batch-id');
    // The opening-balance flag enqueues import_commit with a LEDGER ENTRY.
    expect(runTriggerRef('import_commit', 'ledger-entry-id', false)).toBeNull();
  });

  it('records the account or counterparty those triggers name', () => {
    expect(MAPPING.get('account_remapped')).toBe('accounts');
    expect(runTriggerRef('account_remapped', 'account-id', false)).toBe('account-id');
    expect(runTriggerRef('counterparty_merged', 'cp-id', false)).toBe('cp-id');
  });
});
