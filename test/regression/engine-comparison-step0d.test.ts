import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ENGINE_VERSION } from '@/modules/financial-engine';
import { calculateAndAlert } from '../fixtures/adr120-orgs';
import { engineDump } from '../fixtures/engine-dump';
import { identityDump, seedStep0dOrgs } from '../fixtures/step0d-orgs';
import { adminSql } from '../integration/setup';

/**
 * Step 0D's extension of the engine comparison: AI-read inputs, carried opening cash, mixed
 * assurance and Unicode customer identity. Dumped to `$ENGINE_COMPARE_OUT/<label>-step0d.json`
 * and compared like the 27-organisation set. The comparison job copies this file and its fixture
 * into the baseline worktree, so both engines compute the same data.
 */
it('seeds, computes and dumps the Step 0D comparison set', async () => {
  const label = process.env.ENGINE_COMPARE_LABEL ?? ENGINE_VERSION;
  const out = process.env.ENGINE_COMPARE_OUT ?? path.resolve('test/regression/out');
  const tag = `s0d${Date.now().toString(36)}`;
  const orgs = await seedStep0dOrgs(tag);
  expect(Object.keys(orgs)).toHaveLength(8);

  try {
    const dumps: Record<string, unknown> = {};
    for (const [key, id] of Object.entries(orgs)) {
      await calculateAndAlert(id);
      dumps[key] = { ...engineDump(id), identities: identityDump(id) };
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, `${label}-step0d.json`),
      `${JSON.stringify({ engineVersion: ENGINE_VERSION, label, organisations: dumps }, null, 1)}\n`);
  } finally {
    adminSql(`delete from public.organizations where id in (${Object.values(orgs).map((id) => `'${id}'`).join(',')});
      delete from auth.users where email like '%@${tag}.%';`);
  }
}, 1_800_000);
