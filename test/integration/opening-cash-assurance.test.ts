import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateAndAlert } from '../fixtures/adr120-orgs';
import { bankAccount, statement } from '../fixtures/step0d-orgs';
import { adminSql, clientFor, createAuthUser } from './setup';

/**
 * Opening cash carried out of an AI-read month, through the real queue, on a real database
 * (Step 0D; engine 8.0.0). The pure cases are test/unit/opening-cash-assurance.test.ts; this proves
 * the run stores what they compute, and that a real ROLLBACK of the AI-read statement takes its
 * weakness with it.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.openingcash.itest`;
let ownerId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

async function org(name: string): Promise<string> {
  const r = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest OpeningCash ${name} ${RUN}` });
  if (r.error) throw new Error(r.error.message);
  return r.data as unknown as string;
}

/** `value|assurance|rests_on_statements` of the current snapshot of `key` in the month starting `start`. */
function cash(orgId: string, start: string, key: 'opening_cash' | 'closing_cash' | 'net_cash_movement'): string {
  return one(`select coalesce(s.value::numeric(14, 2)::text, 'NULL') || '|' || s.assurance_level || '|'
      || coalesce((select string_agg(x, ',' order by x) from jsonb_array_elements_text(s.components -> 'rests_on_statements') x), '')
    from public.metric_current c join public.metric_snapshots s on s.id = c.snapshot_id and s.organization_id = c.organization_id
    join public.fiscal_periods p on p.id = c.period_id and p.organization_id = c.organization_id
   where c.organization_id = '${orgId}' and c.metric_key = '${key}' and c.dimension_type = 'none' and p.period_start = '${start}'`);
}

let carry: string;
let attest: string;
let julyAi: string;

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);

  // June CSV (printed 10,000 → 9,000) · July READ BY AI · August CSV with no printed balance.
  carry = await org('carry');
  const main = bankAccount(carry, 'Main');
  statement(carry, main, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '10000', closing: '9000', moves: [['2026-06-10', '-1000']], tag: 'oc-jun' });
  julyAi = statement(carry, main, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-03', '2000'], ['2026-07-18', '-2500']], tag: 'oc-jul' });
  statement(carry, main, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', moves: [['2026-08-05', '3000'], ['2026-08-20', '-2800']], tag: 'oc-aug' });

  // The same, with August's CSV printing an opening that agrees with the chain (8,500).
  attest = await org('attest');
  const mainB = bankAccount(attest, 'Main');
  statement(attest, mainB, { start: '2026-06-01', end: '2026-06-30', extraction: 'csv', opening: '10000', closing: '9000', moves: [['2026-06-10', '-1000']], tag: 'ot-jun' });
  statement(attest, mainB, { start: '2026-07-01', end: '2026-07-31', extraction: 'pdf_claude', moves: [['2026-07-03', '2000'], ['2026-07-18', '-2500']], tag: 'ot-jul' });
  statement(attest, mainB, { start: '2026-08-01', end: '2026-08-31', extraction: 'csv', opening: '8500', moves: [['2026-08-05', '3000'], ['2026-08-20', '-2800']], tag: 'ot-aug' });

  await calculateAndAlert(carry);
  await calculateAndAlert(attest);
}, 600_000);

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest OpeningCash%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('cash carried out of an AI-read month', () => {
  it('July: the opening is June\'s printed close (verified); the close and the movement rest on the AI read', () => {
    expect(cash(carry, '2026-07-01', 'opening_cash')).toBe('9000.00|verified|');
    expect(cash(carry, '2026-07-01', 'closing_cash')).toBe(`8500.00|inferred|${julyAi}`);
    expect(cash(carry, '2026-07-01', 'net_cash_movement').split('|').slice(0, 2)).toEqual(['-500.00', 'inferred']);
  });

  it('August: its own rows are CSV, but its balances are carried through July and say so', () => {
    expect(cash(carry, '2026-08-01', 'opening_cash')).toBe(`8500.00|inferred|${julyAi}`);
    expect(cash(carry, '2026-08-01', 'closing_cash')).toBe(`8700.00|inferred|${julyAi}`);
    expect(cash(carry, '2026-08-01', 'net_cash_movement').split('|').slice(0, 2)).toEqual(['200.00', 'verified']);
  });

  it('a later verified statement whose printed opening agrees attests August and July\'s close', () => {
    expect(cash(attest, '2026-07-01', 'closing_cash')).toBe('8500.00|verified|');
    expect(cash(attest, '2026-08-01', 'opening_cash')).toBe('8500.00|verified|');
    expect(cash(attest, '2026-08-01', 'closing_cash')).toBe('8700.00|verified|');
    // July's own movement is still the AI's reading.
    expect(cash(attest, '2026-07-01', 'net_cash_movement').split('|')[1]).toBe('inferred');
  });

  it('rolling back the AI-read July statement takes its weakness with it: July and August are unknown, never verified guesses', async () => {
    const { error } = await clientFor(ownerId, { email: `owner@${DOMAIN}` }).schema('api')
      .rpc('rollback_import_batch', { p_batch: julyAi, p_reason: 'Step 0D integration: AI read rolled back' });
    expect(error, error?.message).toBeNull();
    await calculateAndAlert(carry);
    expect(cash(carry, '2026-07-01', 'closing_cash').split('|')[0]).toBe('NULL');
    expect(cash(carry, '2026-08-01', 'opening_cash').split('|')[0]).toBe('NULL');
    expect(cash(carry, '2026-08-01', 'closing_cash').split('|')[0]).toBe('NULL');
    // June, which never rested on July, is unchanged.
    expect(cash(carry, '2026-06-01', 'closing_cash')).toBe('9000.00|verified|');
  }, 600_000);
});
