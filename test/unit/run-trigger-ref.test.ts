import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTriggerRef } from '@/modules/jobs';

/**
 * ADR-132: a run records only a reference `calculation_runs`' `same_org_ref` trigger accepts.
 * The mapping is read from the migration itself, so the two cannot drift.
 */

const sql = readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20260911000002_polymorphic_refs.sql'), 'utf8');
const block = /same_org_ref_trigger_ref[\s\S]*?app\.same_org_ref\(([\s\S]*?)\);/.exec(sql)![1]!;
const pairs = [...block.matchAll(/'([a-z_-]+)'/g)].map((m) => m[1]!).slice(2);
const MAPPING = new Map<string, string>();
for (let i = 0; i < pairs.length; i += 2) MAPPING.set(pairs[i]!, pairs[i + 1]!);

describe('runTriggerRef', () => {
  it('reads all nine triggers from the migration', () => {
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
