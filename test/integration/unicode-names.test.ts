import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startImport, storedNameKey } from '@/modules/imports';
import { heldNameKey, normalizeName } from '@/db/app/shared';
import { newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc } from './setup';
import { dropOrg } from './tenancy-fixtures';
import { removeSeeded } from '../fixtures/seed';

/**
 * Unicode identity for names (ADR-136), on the Firestore emulator.
 *
 * 1. The key the import path matches with (`storedNameKey`, proven equal to PostgreSQL's
 *    `app.normalize_name` for every assigned code point while PostgreSQL ran) IS the key the data
 *    layer stores and guards with (`normalizeName`, `src/db/app/shared.ts`), for every code point
 *    the runtime has assigned.
 * 2. Customers in Japanese, Arabic, Greek, Cyrillic and accented Latin go through the real wizard
 *    and commit: distinct names stay distinct, the same name in another case is one customer, and
 *    every display name is stored exactly as the file had it.
 * 3. A held name (a collision the migration left) is refused, and the "Name decisions" screen's two
 *    decisions resolve it through the audited `api.*` functions.
 *
 * The read-only collision report's check (its SQL key function equals the deployed
 * `app.normalize_name`, read from `pg_proc`) was about the PostgreSQL catalog and is gone with it.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.unicodenames.itest.motion`;

let ownerId: string;
let orgId: string;

const ownerDb = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  const created = await rpc<string>(clientFor(ownerId), 'create_organization', { p_name: `ITest UnicodeNames ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data!;
});

afterAll(async () => {
  if (orgId) await dropOrg(orgId);
  await removeSeeded([], DOMAIN);
});

describe('the import key is the stored key', () => {
  it('for every code point the runtime has assigned, between two letters', () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (let cp = 1; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (/\p{Cn}/u.test(ch)) continue;
      compared += 1;
      const name = `a${ch}b`;
      const stored = normalizeName(name);
      const imported = storedNameKey(name);
      if (stored !== imported && mismatches.length < 20) {
        mismatches.push(`U+${cp.toString(16).toUpperCase()} stored="${stored}" import="${imported}"`);
      }
    }
    expect(compared, 'well over 100,000 assigned code points').toBeGreaterThan(100_000);
    expect(mismatches).toEqual([]);
  });

  it('for whole names in five scripts', () => {
    const names = ['Müller GmbH', 'Müller GmbH', 'Möller GmbH', '株式会社トヨタ', 'ｶﾌﾞｼｷｶﾞｲｼｬ', 'شركة الأمل', 'متجر ٣',
      'ΟΔΟΣ Α.Ε.', 'οδος α.ε.', 'ООО «Ромашка»', 'İzmir Ltd', 'Ａｃｍｅ & Co.', 'Straße', 'q̃x'];
    expect(names.map(normalizeName)).toEqual(names.map(storedNameKey));
  });
});

describe('customers in five scripts, through the wizard and commit', () => {
  const upload = (name: string, rows: string[]) => startImport({
    organizationId: orgId,
    userId: ownerId,
    requestId: `itest-${RUN}`,
    db: ownerDb(),
    file: new File([['Invoice Number,Customer,Invoice Date,Due Date,Total', ...rows].join('\n')], name, { type: 'text/csv' }),
    importType: 'sales_invoices',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    bankAccountId: null,
  });

  const commit = async (batchId: string) => {
    const batch = await orgRow(fs(), orgId, 'import_batches', batchId).get();
    const required = ((batch.get('required_confirmations') as string[] | undefined) ?? []).filter(Boolean);
    for (const code of required) {
      const value = code === 'IMP-RANGE-015' ? { period_start: '2026-08-01', period_end: '2026-08-31' }
        : code === 'IMP-INV-013' ? { opening: 'complete' } // R-2: the list holds every invoice unpaid at its start
        : { answer: 'yes' };
      const { error } = await rpc(ownerDb(), 'record_batch_confirmation', { p_batch: batchId, p_code: code, p_value: value });
      expect(error, `${code}: ${error?.message}`).toBeNull();
    }
    const { data, error } = await rpc(ownerDb(), 'commit_import_batch', { p_batch: batchId });
    expect(error, error?.message).toBeNull();
    return data as { committed: number };
  };

  const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const customers = async () => (await orgCollection(fs(), orgId, 'counterparties').get()).docs
    .map((d) => `${String(d.get('name'))}=${String(d.get('normalized_name'))}`).sort(byteOrder);
  const bookedTo = async (batchId: string) => {
    const invoices = (await orgCollection(fs(), orgId, 'invoices').where('import_batch_id', '==', batchId).get()).docs.map((d) => d.data());
    const parties = await fs().getAll(...invoices.map((i) => orgRow(fs(), orgId, 'counterparties', String(i.counterparty_id))));
    const nameOf = new Map(parties.map((p) => [p.id, String(p.get('name'))]));
    return invoices.map((i) => `${String(i.invoice_number)}>${nameOf.get(String(i.counterparty_id))}`).sort(byteOrder);
  };

  it('creates one customer per name, keeps every display name, and books each invoice to its own', async () => {
    const result = await upload('unicode-1.csv', [
      'U-01,株式会社トヨタ,2026-08-03,2026-09-02,100.00',
      'U-02,شركة الأمل,2026-08-04,2026-09-03,200.00',
      'U-03,ΟΔΟΣ Α.Ε.,2026-08-05,2026-09-04,300.00',
      'U-04,οδος α.ε.,2026-08-06,2026-09-05,400.00',
      'U-05,ООО «Ромашка»,2026-08-07,2026-09-06,500.00',
      'U-06,Müller GmbH,2026-08-08,2026-09-07,600.00',
      'U-07,Möller GmbH,2026-08-09,2026-09-08,700.00',
      'U-08,Muller GmbH,2026-08-10,2026-09-09,800.00',
    ]);
    expect((await commit(result.batchId)).committed).toBe(8);

    expect(await customers()).toEqual([
      'Muller GmbH=muller gmbh',
      'Möller GmbH=möller gmbh',
      'Müller GmbH=müller gmbh',
      'ΟΔΟΣ Α.Ε.=οδοσ α ε',
      'ООО «Ромашка»=ооо ромашка',
      'شركة الأمل=شركة الأمل',
      '株式会社トヨタ=株式会社トヨタ',
    ]);
    expect(await bookedTo(result.batchId)).toEqual([
      'U-01>株式会社トヨタ', 'U-02>شركة الأمل', 'U-03>ΟΔΟΣ Α.Ε.', 'U-04>ΟΔΟΣ Α.Ε.',
      'U-05>ООО «Ромашка»', 'U-06>Müller GmbH', 'U-07>Möller GmbH', 'U-08>Muller GmbH',
    ]);
  });

  it('a later file matches the same customers in any case, and adds no duplicate', async () => {
    const result = await upload('unicode-2.csv', [
      'V-01,MÜLLER GMBH,2026-08-11,2026-09-10,10.00',
      'V-02,ооо «ромашка»,2026-08-12,2026-09-11,20.00',
      'V-03,株式会社トヨタ,2026-08-13,2026-09-12,30.00',
    ]);
    expect((await commit(result.batchId)).committed).toBe(3);
    expect(await customers()).toHaveLength(7);
    expect(await bookedTo(result.batchId)).toEqual(['V-01>Müller GmbH', 'V-02>ООО «Ромашка»', 'V-03>株式会社トヨタ']);
  });

  it('a name whose records are held for a decision is refused, and nothing is booked to either', async () => {
    await heldPair('İzmir Ltd', 'Izmir Holding', 'izmir ltd');
    const result = await upload('unicode-3.csv', ['W-01,IZMIR LTD,2026-08-14,2026-09-13,40.00', 'W-02,Müller GmbH,2026-08-14,2026-09-13,50.00']);
    const rows = (await orgCollection(fs(), orgId, 'import_rows').where('batch_id', '==', result.batchId).get()).docs
      .map((d) => d.data()).filter((r) => Number(r.row_number) > 1).sort((a, b) => Number(a.row_number) - Number(b.row_number))
      .map((r) => `${String(r.row_number)}:${String(r.status)}:${((r.issues ?? []) as Array<{ code: string }>).map((i) => i.code).join(',')}`);
    expect(rows[0]).toMatch(/:error:.*IMP-CP-019/);
    expect(rows[1]).not.toMatch(/:error:/);
    const plain = await orgCollection(fs(), orgId, 'counterparties').where('normalized_name', '==', 'izmir ltd').get();
    expect(plain.size).toBe(0);
  });
});

/**
 * Two counterparties held under one name, as the migration leaves a collision: both rows on held
 * keys (`app.held_name_key`). Seeded directly — no writing function would create a collision.
 */
async function heldPair(a: string, b: string, key: string): Promise<[string, string]> {
  const now = nowIso();
  const ids: Array<[string, string]> = [];
  for (const name of [a, b]) {
    const id = newId();
    await orgRow(fs(), orgId, 'counterparties', id).set({
      id, organization_id: orgId, name, normalized_name: heldNameKey(key, id), kind: 'customer',
      default_expense_category: null, external_ref: null, email: null, notes: null, is_active: true,
      merged_into_id: null, created_at: now, updated_at: now,
    });
    ids.push([name, id]);
  }
  ids.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return [ids[0]![1], ids[1]![1]];
}

/**
 * D-5 (owner decision): the decisions the "Name decisions" screen makes, through the same audited
 * `api.*` functions.
 */
describe('D-5 · resolving a held name', () => {
  const keyOf = async (id: string) => String((await orgRow(fs(), orgId, 'counterparties', id).get()).get('normalized_name'));

  it('"the same business": merge one into the other, re-save it — it takes the plain key, the other is merged, both audited', async () => {
    const [keep, other] = await heldPair('Cafe Rouge', 'CAFE ROUGE.', 'cafe rouge');
    const merge = await rpc(ownerDb(), 'merge_counterparties', { p_from: other, p_into: keep });
    expect(merge.error, merge.error?.message).toBeNull();
    const resave = await rpc(ownerDb(), 'update_counterparty', { p_counterparty: keep, p_patch: { name: 'Cafe Rouge' } });
    expect(resave.error, resave.error?.message).toBeNull();
    expect(await keyOf(keep)).toBe('cafe rouge');
    expect((await orgRow(fs(), orgId, 'counterparties', other).get()).get('merged_into_id')).toBe(keep);
    const events = await fs().collection('audit_events').where('organization_id', '==', orgId).get();
    expect(events.docs.filter((e) => [keep, other].includes(String(e.get('target_id')))).length).toBeGreaterThanOrEqual(2);
  });

  it('"different businesses": rename one, re-save the other — two names, nothing held', async () => {
    const [a, b] = await heldPair('Nord Ltd', 'NORD LTD', 'nord ltd');
    // While another held record of the name remains, the name cannot be taken: refused, not decided.
    expect((await rpc(ownerDb(), 'update_counterparty', { p_counterparty: a, p_patch: { name: 'Nord Ltd' } })).error).not.toBeNull();
    expect((await rpc(ownerDb(), 'update_counterparty', { p_counterparty: b, p_patch: { name: 'Nord Ltd (Leeds)' } })).error).toBeNull();
    expect((await rpc(ownerDb(), 'update_counterparty', { p_counterparty: a, p_patch: { name: 'Nord Ltd' } })).error).toBeNull();
    expect([await keyOf(a), await keyOf(b)]).toEqual(['nord ltd', 'nord ltd leeds']);
  });
});
