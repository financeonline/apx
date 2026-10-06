import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startImport, storedNameKey } from '@/modules/imports';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * Unicode identity for names (ADR-136), on a real database.
 *
 * 1. The TypeScript key the import path matches with IS the database's `app.normalize_name`, for
 *    every code point Postgres has assigned.
 * 2. The read-only collision report computes the migration's key, character for character.
 * 3. Customers in Japanese, Arabic, Greek, Cyrillic and accented Latin go through the real wizard
 *    and commit: distinct names stay distinct, the same name in another case is one customer, and
 *    every display name is stored exactly as the file had it.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.unicodenames.itest`;

let ownerId: string;
let orgId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);
const ownerDb = () => clientFor(ownerId, { email: `owner@${DOMAIN}` });

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest UnicodeNames ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest UnicodeNames%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('the TypeScript key is the database key', () => {
  it('for every code point Postgres has assigned, between two letters', () => {
    const mismatches: string[] = [];
    let compared = 0;
    // Chunked: each psql call returns a few hundred kilobytes.
    for (let from = 1; from <= 0x10ffff; from += 0x8000) {
      const to = Math.min(from + 0x7fff, 0x10ffff);
      const out = adminSql(`
        select cp || '|' || app.normalize_name('a' || chr(cp) || 'b')
          from generate_series(${from}, ${to}) cp
         where (cp < 55296 or cp > 57343) and unicode_assigned(chr(cp))
         order by cp`);
      if (out === '') continue;
      for (const line of out.split('\n')) {
        const bar = line.indexOf('|');
        const cp = Number(line.slice(0, bar));
        const dbKey = line.slice(bar + 1);
        compared += 1;
        const tsKey = storedNameKey(`a${String.fromCodePoint(cp)}b`);
        if (tsKey !== dbKey && mismatches.length < 20) mismatches.push(`U+${cp.toString(16).toUpperCase()} db="${dbKey}" ts="${tsKey}"`);
      }
    }
    expect(compared, 'Postgres 17 assigns well over 100,000 code points').toBeGreaterThan(100_000);
    expect(mismatches).toEqual([]);
  });

  it('for whole names in five scripts', () => {
    const names = ['Müller GmbH', 'Müller GmbH', 'Möller GmbH', '株式会社トヨタ', 'ｶﾌﾞｼｷｶﾞｲｼｬ', 'شركة الأمل', 'متجر ٣',
      'ΟΔΟΣ Α.Ε.', 'οδος α.ε.', 'ООО «Ромашка»', 'İzmir Ltd', 'Ａｃｍｅ & Co.', 'Straße', 'q̃x'];
    const literal = names.map((n) => `(${names.indexOf(n)}, '${n.replace(/'/g, "''")}')`).join(', ');
    const out = adminSql(`select app.normalize_name(n) from (values ${literal}) v(i, n) order by i`).split('\n');
    expect(out).toEqual(names.map(storedNameKey));
  });
});

describe('the read-only collision report', () => {
  it('computes the key with the migration\'s own function body', () => {
    const report = readFileSync('scripts/sql/unicode-names-dry-run.sql', 'utf8');
    const reportBody = /create function pg_temp\.name_key[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(report)?.[1];
    const deployed = adminSql(`
      select prosrc from pg_proc where proname = 'normalize_name' and pronamespace = 'app'::regnamespace`);
    const squash = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    expect(squash(reportBody)).not.toBe('');
    expect(squash(reportBody)).toBe(squash(deployed));
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
    const required = adminSql(`
      select coalesce(string_agg(c, ','), '') from public.import_batches b, unnest(b.required_confirmations) c
       where b.organization_id = '${orgId}' and b.id = '${batchId}'`).split(',').filter(Boolean);
    for (const code of required) {
      const value = code === 'IMP-RANGE-015' ? { period_start: '2026-08-01', period_end: '2026-08-31' }
        : code === 'IMP-INV-013' ? { opening: 'complete' } // R-2: the list holds every invoice unpaid at its start
        : { answer: 'yes' };
      const { error } = await ownerDb().schema('api').rpc('record_batch_confirmation', { p_batch: batchId, p_code: code, p_value: value });
      expect(error, `${code}: ${error?.message}`).toBeNull();
    }
    const { data, error } = await ownerDb().schema('api').rpc('commit_import_batch', { p_batch: batchId });
    expect(error, error?.message).toBeNull();
    return data as { committed: number };
  };

  const customers = () => adminSql(`
    select name || '=' || normalized_name from public.counterparties
     where organization_id = '${orgId}' order by name collate "C"`).split('\n').filter(Boolean);
  const bookedTo = (batchId: string) => adminSql(`
    select i.invoice_number || '>' || c.name from public.invoices i join public.counterparties c on c.id = i.counterparty_id
     where i.organization_id = '${orgId}' and i.import_batch_id = '${batchId}' order by i.invoice_number`).split('\n');

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

    expect(customers()).toEqual([
      'Muller GmbH=muller gmbh',
      'Möller GmbH=möller gmbh',
      'Müller GmbH=müller gmbh',
      'ΟΔΟΣ Α.Ε.=οδοσ α ε',
      'ООО «Ромашка»=ооо ромашка',
      'شركة الأمل=شركة الأمل',
      '株式会社トヨタ=株式会社トヨタ',
    ]);
    expect(bookedTo(result.batchId)).toEqual([
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
    expect(customers()).toHaveLength(7);
    expect(bookedTo(result.batchId)).toEqual(['V-01>Müller GmbH', 'V-02>ООО «Ромашка»', 'V-03>株式会社トヨタ']);
  });

  it('a name whose records are held for a decision is refused, and nothing is booked to either', async () => {
    adminSql(`
      insert into public.counterparties (organization_id, name, kind) values ('${orgId}', 'İzmir Ltd', 'customer');
      update public.counterparties set normalized_name = app.held_name_key('izmir ltd', id)
       where organization_id = '${orgId}' and name = 'İzmir Ltd';
      insert into public.counterparties (organization_id, name, kind) values ('${orgId}', 'Izmir Holding', 'customer');
      update public.counterparties set normalized_name = app.held_name_key('izmir ltd', id)
       where organization_id = '${orgId}' and name = 'Izmir Holding';`);
    const result = await upload('unicode-3.csv', ['W-01,IZMIR LTD,2026-08-14,2026-09-13,40.00', 'W-02,Müller GmbH,2026-08-14,2026-09-13,50.00']);
    const rows = adminSql(`
      select row_number || ':' || status || ':' || coalesce((select string_agg(i ->> 'code', ',') from jsonb_array_elements(issues) i), '')
        from public.import_rows where batch_id = '${result.batchId}' and row_number > 1 order by row_number`).split('\n');
    expect(rows[0]).toMatch(/:error:.*IMP-CP-019/);
    expect(rows[1]).not.toMatch(/:error:/);
    expect(one(`select count(*) from public.counterparties where organization_id = '${orgId}' and normalized_name = 'izmir ltd'`)).toBe('0');
  });
});

/**
 * D-5 (owner decision): the decisions the "Name decisions" screen makes, through the same audited
 * `api.*` functions. Two records held under one name (as the migration leaves a collision).
 */
describe('D-5 · resolving a held name', () => {
  const held = (a: string, b: string, key: string): [string, string] => {
    const ids = adminSql(`
      insert into public.counterparties (organization_id, name, kind) values ('${orgId}', '${a}', 'customer'), ('${orgId}', '${b}', 'customer');
      update public.counterparties set normalized_name = app.held_name_key('${key}', id)
       where organization_id = '${orgId}' and name in ('${a}', '${b}');
      select string_agg(id::text, ',' order by name) from public.counterparties where organization_id = '${orgId}' and name in ('${a}', '${b}');`)
      .split('\n').pop()!.trim().split(',');
    return [ids[0]!, ids[1]!];
  };
  const keyOf = (id: string) => one(`select normalized_name from public.counterparties where id = '${id}'`).trim();

  it('"the same business": merge one into the other, re-save it — it takes the plain key, the other is merged, both audited', async () => {
    const [keep, other] = held('Cafe Rouge', 'CAFE ROUGE.', 'cafe rouge');
    const merge = await ownerDb().schema('api').rpc('merge_counterparties', { p_from: other, p_into: keep });
    expect(merge.error, merge.error?.message).toBeNull();
    const resave = await ownerDb().schema('api').rpc('update_counterparty', { p_counterparty: keep, p_patch: { name: 'Cafe Rouge' } });
    expect(resave.error, resave.error?.message).toBeNull();
    expect(keyOf(keep)).toBe('cafe rouge');
    expect(one(`select merged_into_id::text from public.counterparties where id = '${other}'`).trim()).toBe(keep);
    expect(Number(one(`select count(*) from public.audit_events where organization_id = '${orgId}' and target_id in ('${keep}', '${other}')`).trim()))
      .toBeGreaterThanOrEqual(2);
  });

  it('"different businesses": rename one, re-save the other — two names, nothing held', async () => {
    const [a, b] = held('Nord Ltd', 'NORD LTD', 'nord ltd');
    // While another held record of the name remains, the name cannot be taken: refused, not decided.
    expect((await ownerDb().schema('api').rpc('update_counterparty', { p_counterparty: a, p_patch: { name: 'Nord Ltd' } })).error).not.toBeNull();
    expect((await ownerDb().schema('api').rpc('update_counterparty', { p_counterparty: b, p_patch: { name: 'Nord Ltd (Leeds)' } })).error).toBeNull();
    expect((await ownerDb().schema('api').rpc('update_counterparty', { p_counterparty: a, p_patch: { name: 'Nord Ltd' } })).error).toBeNull();
    expect([keyOf(a), keyOf(b)]).toEqual(['nord ltd', 'nord ltd leeds']);
  });
});
