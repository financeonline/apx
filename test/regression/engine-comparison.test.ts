import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import { calculateAndAlert, seedAdr120Orgs } from '../fixtures/adr120-orgs';
import { seedAuditOrgs, type AuditKey } from '../fixtures/audit-orgs';
import { seedAudit2Orgs, type Audit2Key } from '../fixtures/audit2-orgs';
import { engineDump } from '../fixtures/engine-dump';
import { adminSql } from '../integration/setup';

/**
 * The engine regression record (ADR-124): the 27-organisation comparison set — the 7 ADR-120
 * fixtures, the first audit's 11, the second audit's 9 — seeded from nothing, computed through the
 * real queue (`calculation.run`, then `alerts.evaluate`) and dumped to
 * `$ENGINE_COMPARE_OUT/<label>.json`. Run it on two commits and compare the two files with
 * `npx tsx scripts/engine-compare.ts before.json after.json`.
 *
 *   ENGINE_COMPARE_LABEL=before npm run engine:compare
 *
 * It is a tool, not a gate: it asserts only that every organisation computed. What changed, and
 * why, is for the person reading the comparison.
 */

const AUDIT: readonly AuditKey[] = [
  'GAP', 'MIDSTART', 'LEDGER2', 'TBBS', 'MOVTB', 'CURRENT', 'CREDITHEAVY', 'PARTIALPD', 'LONG', 'BIGINV', 'BSREV',
];
const AUDIT2: readonly Audit2Key[] = [
  'GAPGL', 'PARTJUL', 'NEWACCT', 'BSLIST', 'LEDGER3', 'UNRECON', 'CNFUTURE', 'MIDTYPED', 'CYCLE',
];

it('seeds, computes and dumps the 27-organisation comparison set', async () => {
  const label = process.env.ENGINE_COMPARE_LABEL ?? ENGINE_VERSION;
  const out = process.env.ENGINE_COMPARE_OUT ?? path.resolve('test/regression/out');
  const tag = `cmp${Date.now().toString(36)}`;

  const orgs: Record<string, string> = {
    ...(await seedAdr120Orgs(tag)),
    ...(await seedAuditOrgs(tag, AUDIT)),
    ...(await seedAudit2Orgs(tag, AUDIT2)),
  } as Record<string, string>;
  expect(Object.keys(orgs)).toHaveLength(27);

  try {
    const dumps: Record<string, unknown> = {};
    for (const [key, id] of Object.entries(orgs)) {
      await calculateAndAlert(id);
      dumps[key] = engineDump(id);
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, `${label}.json`),
      `${JSON.stringify({ engineVersion: ENGINE_VERSION, label, organisations: dumps }, null, 1)}\n`);
  } finally {
    adminSql(`delete from public.organizations where id in (${Object.values(orgs).map((id) => `'${id}'`).join(',')});
      delete from auth.users where email like '%@${tag}.%';`);
  }
}, 3_600_000);
