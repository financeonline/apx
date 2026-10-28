import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodId } from '@/db/app/shared';
import { newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { loadHealthCard } from '@/modules/health';
import { drainJobs } from '@/modules/jobs';
import { drainUntilFinished, fs, rpc, serviceClientScoped } from './setup';
import {
  removeSeeded, seedAccepted, seedBatch, seedCounterparty, seedJob, seedLedgerEntry, seedOrg,
} from '../fixtures/seed';

/**
 * health.config.v5 end to end (ADR-147), against figures a real calculation run produced:
 *
 *   - marketing efficiency reads the Commercial records the Customers pages read, through the
 *     calculation run (campaign spend, a won opportunity, the engine's own customer revenue);
 *   - a new Health config re-scores the organisation's WHOLE history, and the nightly step queues it;
 *   - two scores made under different configs are never compared.
 *
 * A ledger business: Acme pays 10,000.00 a month in June, July and August 2026; payroll 6,000.00.
 * Campaign "Spring" spent 1,000.00 in each month and won Acme on 10 June. Run-unique fixtures.
 */

const RUN = `h${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.health5.itest.motion`;
let orgId: string;
const MONTHS = ['2026-06', '2026-07', '2026-08'] as const;
const END: Record<string, string> = { '2026-06': '2026-06-30', '2026-07': '2026-07-31', '2026-08': '2026-08-31' };
const period = (ym: string) => periodId(orgId, `${ym}-01`);
const server = { server: true } as const;

async function calculate(): Promise<void> {
  const job = await seedJob(orgId, 'calculation.run', { trigger: 'recalc_manual' });
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
}

async function currentScore(ym: string): Promise<Record<string, unknown> | null> {
  const pointer = await orgRow(fs(), orgId, 'health_current', period(ym)).get();
  if (!pointer.exists) return null;
  const score = await orgRow(fs(), orgId, 'health_scores', String(pointer.get('health_score_id'))).get();
  return score.exists ? score.data()! : null;
}

/** `included|score|exclusion` of a dimension in the month's current score. */
async function dimension(ym: string, key: string): Promise<string> {
  const score = await currentScore(ym);
  const d = ((score?.breakdown ?? []) as Array<Record<string, unknown>>).find((x) => x.key === key);
  if (!d) return '';
  return `${String(d.included)}|${d.score === null || d.score === undefined ? 'NULL' : String(d.score)}|${String(d.exclusion_reason ?? '')}`;
}

const calcQueued = async () => (await fs().collection('jobs').where('organization_id', '==', orgId)
  .where('job_type', '==', 'calculation.run').where('status', '==', 'queued').get()).docs
  .map((d) => d.data()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

beforeAll(async () => {
  const seeded = await seedOrg({ name: `ITest Health5 ${RUN}`, ownerEmail: `owner@${DOMAIN}`, around: '2026-08-15' });
  orgId = seeded.orgId;
  const acme = await seedCounterparty(orgId, { name: 'Acme Ltd', kind: 'customer' });

  for (const ym of MONTHS) {
    const batch = await seedBatch(orgId, {
      importType: 'general_ledger', target: 'ledger_entries', start: `${ym}-01`, end: END[ym]!,
    });
    for (const [c, d, a, date, cp] of [['revenue', 'credit', '10000.00', `${ym}-10`, acme], ['payroll', 'debit', '6000.00', END[ym]!, null]] as const) {
      const id = await seedLedgerEntry(orgId, {
        date, accountId: seeded.accounts[c]!, direction: d, amount: a, batchId: batch, counterpartyId: cp,
      });
      await seedAccepted(orgId, 'ledger_entries', id, batch);
    }
  }
  const now = nowIso();
  const campaign = newId();
  await orgRow(fs(), orgId, 'campaigns', campaign).set({
    id: campaign, organization_id: orgId, name: 'Spring', normalized_name: 'spring', channel_id: null,
    starts_on: null, ends_on: null, status: 'active', notes: null, created_at: now, updated_at: now,
  });
  for (const ym of MONTHS) {
    const id = newId();
    await orgRow(fs(), orgId, 'campaign_spend', id).set({
      id, organization_id: orgId, campaign_id: campaign, period_id: period(ym), amount: '1000.00', currency: 'GBP',
      note: null, created_at: now, updated_at: now,
    });
  }
  const opp = newId();
  await orgRow(fs(), orgId, 'opportunities', opp).set({
    id: opp, organization_id: orgId, name: 'Acme deal', stage: 'won', counterparty_id: acme, campaign_id: campaign,
    channel_id: null, estimated_value: null, currency: 'GBP', created_on: '2026-06-01', stage_changed_on: '2026-06-10',
    won_on: '2026-06-10', lost_on: null, notes: null, created_by: null, created_at: now, updated_at: now,
  });
  await calculate();
}, 300_000);

afterAll(async () => {
  const mine = await fs().collection('jobs').where('organization_id', '==', orgId).get();
  for (const d of mine.docs) await d.ref.delete();
  await removeSeeded([orgId], DOMAIN);
});

describe('marketing efficiency, from the Commercial records, through a real run', () => {
  it('August: 30,000.00 from the customer the campaign won, over 3,000.00 of spend = 10x → 50 + 20 = 70', async () => {
    // Window June–August. Acme was won 10 June, so all three months of its revenue count.
    // M2 has no earlier three months of spend to compare with → skipped.
    expect(await dimension('2026-08', 'marketing_efficiency')).toBe('true|70|');
  });

  it('a month whose three-month window starts before the first period with spend is still scored on its spend', async () => {
    // June: window April–June holds 1,000.00 of spend and 10,000.00 from Acme (won in June) → 10x.
    expect(await dimension('2026-06', 'marketing_efficiency')).toBe('true|70|');
  });

  it('no debt, receivables or payables established from a ledger alone: funding readiness is not scored', async () => {
    expect(await dimension('2026-08', 'funding_readiness')).toBe('false|NULL|required_metric_missing');
  });
});

describe('a new Health config re-scores the whole history (ADR-147)', () => {
  it('queues the organisation, and the run rewrites every month — not only the latest', async () => {
    const scores = orgCollection(fs(), orgId, 'health_scores');
    const before = (await scores.get()).size;
    // As if the scores had been made under the previous config. Written directly: a stored score is
    // otherwise immutable (no function offers the change), which is what makes the re-score necessary.
    for (const d of (await scores.get()).docs) await d.ref.update({ config_version: 'health.config.v4' });

    const { data, error } = await rpc<number>(serviceClientScoped(), 'enqueue_health_upgrade', { p_config_version: 'health.config.v5' }, server);
    expect(error).toBeNull();
    expect(Number(data)).toBeGreaterThanOrEqual(1);
    const job = (await calcQueued())[0]?.id as string | undefined;
    expect(job).toMatch(/^[0-9a-f-]{36}$/);
    expect(await drainUntilFinished(drainJobs, job!)).toBe('succeeded');

    // Every complete month has a new v5 score behind its current pointer.
    for (const ym of MONTHS) {
      expect((await currentScore(ym))?.config_version, ym).toBe('health.config.v5');
    }
    expect((await scores.get()).size).toBe(before + MONTHS.length);
    // And with nothing left on another config, nothing more is queued for it.
    const again = await rpc(serviceClientScoped(), 'enqueue_health_upgrade', { p_config_version: 'health.config.v5' }, server);
    expect(again.error).toBeNull();
    expect(await calcQueued()).toHaveLength(0);
  }, 300_000); // a full recalculation of the history runs inside this test

  it('refuses a config name that is not one', async () => {
    const { error } = await rpc(serviceClientScoped(), 'enqueue_health_upgrade', { p_config_version: 'v5; drop table x' }, server);
    expect(error?.code).toBe('VALIDATION');
  });
});

describe('scores under different configs are never compared (ADR-119 §5)', () => {
  it('Home and the reports show no change when the previous month was scored under other rules', async () => {
    const db = serviceClientScoped(orgId);
    const same = await loadHealthCard(db, orgId, period('2026-08'), period('2026-07'));
    expect(same?.changeVsPrevious).not.toBeNull();
    const july = await orgRow(fs(), orgId, 'health_current', period('2026-07')).get();
    await orgRow(fs(), orgId, 'health_scores', String(july.get('health_score_id'))).update({ config_version: 'health.config.v4' });
    const mixed = await loadHealthCard(db, orgId, period('2026-08'), period('2026-07'));
    expect(mixed?.score).not.toBeNull();
    expect(mixed?.changeVsPrevious).toBeNull();
  });
  // The PostgreSQL suite also asserted `api.portfolio_summary`'s SQL text compared config versions
  // (a pg_catalog check). That function is Team P's port now; the rule is theirs to test.
});
