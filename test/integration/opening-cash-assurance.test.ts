import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateAndAlert } from '../fixtures/adr120-orgs';
import { bankAccount, statement } from '../fixtures/step0d-orgs';
import { Decimal } from '@/core/money';
import { currentSnapshots } from '../fixtures/adr120-orgs';
import { clientFor, createAuthUser, deleteOrg, fs, rpc } from './setup';
import { makeOrg } from './f-fixtures';

/**
 * Opening cash carried out of an AI-read month, through the real queue, on a real database
 * (Step 0D; engine 8.0.0). The pure cases are test/unit/opening-cash-assurance.test.ts; this proves
 * the run stores what they compute, and that a real ROLLBACK of the AI-read statement takes its
 * weakness with it.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.openingcash.itest.motion`;
const made: string[] = [];
let ownerId: string;

async function org(name: string): Promise<string> {
  const id = await makeOrg(ownerId, `ITest OpeningCash ${name} ${RUN}`);
  made.push(id);
  return id;
}

/** `value|assurance|rests_on_statements` of the current snapshot of `key` in the month starting `start`. */
async function cash(orgId: string, start: string, key: 'opening_cash' | 'closing_cash' | 'net_cash_movement'): Promise<string> {
  const [s] = await currentSnapshots(orgId, start, key);
  if (!s) return '';
  const value = s.value === null || s.value === undefined ? 'NULL' : new Decimal(String(s.value)).toFixed(2);
  const rests = ((s.components as { rests_on_statements?: string[] } | null)?.rests_on_statements ?? []).map(String).sort();
  return `${value}|${s.assurance_level}|${rests.join(',')}`;
}

let carry: string;
let attest: string;
let julyAi: string;

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);

  // June CSV (printed 10,000 → 9,000) · July READ BY AI · August CSV with no printed balance.
  carry = await org('carry');
  const main = await bankAccount(carry, 'Main');
  await statement(carry, main, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '10000', closing: '9000', moves: [['2026-06-10', '-1000']], tag: 'oc-jun' });
  julyAi = await statement(carry, main, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-03', '2000'], ['2026-07-18', '-2500']], tag: 'oc-jul' });
  await statement(carry, main, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: [['2026-08-05', '3000'], ['2026-08-20', '-2800']], tag: 'oc-aug' });

  // The same, with August's CSV printing an opening that agrees with the chain (8,500).
  attest = await org('attest');
  const mainB = await bankAccount(attest, 'Main');
  await statement(attest, mainB, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '10000', closing: '9000', moves: [['2026-06-10', '-1000']], tag: 'ot-jun' });
  await statement(attest, mainB, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-03', '2000'], ['2026-07-18', '-2500']], tag: 'ot-jul' });
  await statement(attest, mainB, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', opening: '8500', moves: [['2026-08-05', '3000'], ['2026-08-20', '-2800']], tag: 'ot-aug' });

  await calculateAndAlert(carry);
  await calculateAndAlert(attest);
}, 600_000);

afterAll(async () => {
  for (const id of made) {
    const jobs = await fs().collection('jobs').where('organization_id', '==', id).get();
    await Promise.all(jobs.docs.map((d) => d.ref.delete()));
    await deleteOrg(id);
  }
});

describe('cash carried out of an AI-read month', () => {
  it('July: the opening is June\'s printed close (verified); the close and the movement rest on the AI read', async () => {
    expect(await cash(carry, '2026-07-01', 'opening_cash')).toBe('9000.00|verified|');
    expect(await cash(carry, '2026-07-01', 'closing_cash')).toBe(`8500.00|inferred|${julyAi}`);
    expect((await cash(carry, '2026-07-01', 'net_cash_movement')).split('|').slice(0, 2)).toEqual(['-500.00', 'inferred']);
  });

  it('August: its own rows are CSV, but its balances are carried through July and say so', async () => {
    expect(await cash(carry, '2026-08-01', 'opening_cash')).toBe(`8500.00|inferred|${julyAi}`);
    expect(await cash(carry, '2026-08-01', 'closing_cash')).toBe(`8700.00|inferred|${julyAi}`);
    expect((await cash(carry, '2026-08-01', 'net_cash_movement')).split('|').slice(0, 2)).toEqual(['200.00', 'verified']);
  });

  it('a later verified statement whose printed opening agrees attests August and July\'s close', async () => {
    expect(await cash(attest, '2026-07-01', 'closing_cash')).toBe('8500.00|verified|');
    expect(await cash(attest, '2026-08-01', 'opening_cash')).toBe('8500.00|verified|');
    expect(await cash(attest, '2026-08-01', 'closing_cash')).toBe('8700.00|verified|');
    // July's own movement is still the AI's reading.
    expect((await cash(attest, '2026-07-01', 'net_cash_movement')).split('|')[1]).toBe('inferred');
  });

  it('rolling back the AI-read July statement takes its weakness with it: July and August are unknown, never verified guesses', async () => {
    const { error } = await rpc(clientFor(ownerId, { email: `owner@${DOMAIN}` }),
      'rollback_import_batch', { p_batch: julyAi, p_reason: 'Step 0D integration: AI read rolled back' });
    expect(error, error?.message).toBeNull();
    await calculateAndAlert(carry);
    expect((await cash(carry, '2026-07-01', 'closing_cash')).split('|')[0]).toBe('NULL');
    expect((await cash(carry, '2026-08-01', 'opening_cash')).split('|')[0]).toBe('NULL');
    expect((await cash(carry, '2026-08-01', 'closing_cash')).split('|')[0]).toBe('NULL');
    // June, which never rested on July, is unchanged.
    expect(await cash(carry, '2026-06-01', 'closing_cash')).toBe('9000.00|verified|');
  }, 600_000);
});
