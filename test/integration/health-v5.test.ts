import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadHealthCard } from '@/modules/health';
import { drainJobs } from '@/modules/jobs';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, serviceStorage } from './setup';

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
const DOMAIN = `${RUN}.health5.itest`;
let ownerId: string;
let orgId: string;
const MONTHS = ['2026-06', '2026-07', '2026-08'] as const;
const END: Record<string, string> = { '2026-06': '2026-06-30', '2026-07': '2026-07-31', '2026-08': '2026-08-31' };
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`).split('\n')[0]?.trim() ?? '';
const period = (ym: string) => one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '${ym}-01'`);

async function calculate(): Promise<void> {
  const job = adminSql(`insert into public.jobs (organization_id, job_type, payload, max_attempts)
                        values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');
}

/** `key|included|score|exclusion` of a dimension in the month's current score. */
function dimension(ym: string, key: string): string {
  return one(`select (d->>'included') || '|' || coalesce(d->>'score', 'NULL') || '|' || coalesce(d->>'exclusion_reason', '')
    from public.health_current hc join public.health_scores h on h.id = hc.health_score_id and h.organization_id = hc.organization_id,
         jsonb_array_elements(h.breakdown) d
   where hc.organization_id = '${orgId}' and hc.period_id = '${period(ym)}' and d->>'key' = '${key}'`);
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Health5 ${RUN}` });
  if (created.error) throw new Error(created.error.message);
  orgId = created.data as unknown as string;
  const account = (c: string) => one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = '${c}' and is_system`);
  const acme = one(`insert into public.counterparties (organization_id, name, normalized_name, kind) values ('${orgId}', 'Acme Ltd', 'acme ltd', 'customer') returning id`);

  for (const ym of MONTHS) {
    const doc = one(`insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
                     values ('${orgId}', '${orgId}/h5/${ym}.csv', '${ym}.csv', 'text/csv', 10, decode('a5${ym.slice(5)}','hex'), 'ready', 'general_ledger') returning id`);
    const batch = one(`insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
                       values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '${ym}-01', '${END[ym]}', now()) returning id`);
    for (const [c, d, a, date, cp] of [['revenue', 'credit', '10000.00', `${ym}-10`, acme], ['payroll', 'debit', '6000.00', END[ym]!, null]] as const) {
      const id = one(`insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, counterparty_id)
                      values ('${orgId}', '${date}', '${account(c)}', '${d}', ${a}, '00000000-0000-0000-0000-000000000000', 'accepted', '${doc}', '${batch}', ${cp ? `'${cp}'` : 'null'}) returning id`);
      adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id) values ('${orgId}', 'ledger_entries', '${id}', 'accepted', '${batch}')`);
    }
  }
  const campaign = one(`insert into public.campaigns (organization_id, name, normalized_name) values ('${orgId}', 'Spring', 'spring') returning id`);
  for (const ym of MONTHS) {
    adminSql(`insert into public.campaign_spend (organization_id, campaign_id, period_id, amount, currency) values ('${orgId}', '${campaign}', '${period(ym)}', 1000, 'GBP')`);
  }
  adminSql(`insert into public.opportunities (organization_id, name, stage, counterparty_id, campaign_id, currency, created_on, stage_changed_on, won_on)
            values ('${orgId}', 'Acme deal', 'won', '${acme}', '${campaign}', 'GBP', '2026-06-01', '2026-06-10', '2026-06-10')`);
  await calculate();
}, 300_000);

afterAll(() => {
  adminSql(`delete from public.organizations where name like 'ITest Health5%${RUN}';
            delete from auth.users where email like '%@${DOMAIN}';`);
});

describe('marketing efficiency, from the Commercial records, through a real run', () => {
  it('August: 30,000.00 from the customer the campaign won, over 3,000.00 of spend = 10x → 50 + 20 = 70', () => {
    // Window June–August. Acme was won 10 June, so all three months of its revenue count.
    // M2 has no earlier three months of spend to compare with → skipped.
    expect(dimension('2026-08', 'marketing_efficiency')).toBe('true|70|');
  });

  it('a month whose three-month window starts before the first period with spend is still scored on its spend', () => {
    // June: window April–June holds 1,000.00 of spend and 10,000.00 from Acme (won in June) → 10x.
    expect(dimension('2026-06', 'marketing_efficiency')).toBe('true|70|');
  });

  it('no debt, receivables or payables established from a ledger alone: funding readiness is not scored', () => {
    expect(dimension('2026-08', 'funding_readiness')).toBe('false|NULL|required_metric_missing');
  });
});

describe('a new Health config re-scores the whole history (ADR-147)', () => {
  it('queues the organisation, and the run rewrites every month — not only the latest', async () => {
    const before = Number(one(`select count(*) from public.health_scores where organization_id = '${orgId}'`));
    // As if the scores had been made under the previous config. Triggers off for this one statement:
    // a stored score is otherwise immutable, which is exactly what makes the re-score necessary.
    adminSql(`set session_replication_role = replica;
              update public.health_scores set config_version = 'health.config.v4' where organization_id = '${orgId}';`);

    const { data, error } = await serviceStorage().schema('api_server').rpc('enqueue_health_upgrade', { p_config_version: 'health.config.v5' });
    expect(error).toBeNull();
    expect(Number(data)).toBeGreaterThanOrEqual(1);
    const job = one(`select id from public.jobs where organization_id = '${orgId}' and job_type = 'calculation.run' and status = 'queued' order by created_at desc limit 1`);
    expect(job).toMatch(/^[0-9a-f-]{36}$/);
    expect(await drainUntilFinished(drainJobs, job)).toBe('succeeded');

    // Every complete month has a new v5 score behind its current pointer.
    for (const ym of MONTHS) {
      expect(one(`select h.config_version from public.health_current hc join public.health_scores h on h.id = hc.health_score_id
                   where hc.organization_id = '${orgId}' and hc.period_id = '${period(ym)}'`), ym).toBe('health.config.v5');
    }
    expect(Number(one(`select count(*) from public.health_scores where organization_id = '${orgId}'`))).toBe(before + MONTHS.length);
    // And with nothing left on another config, nothing more is queued for it.
    const again = await serviceStorage().schema('api_server').rpc('enqueue_health_upgrade', { p_config_version: 'health.config.v5' });
    const queuedNow = one(`select count(*) from public.jobs where organization_id = '${orgId}' and job_type = 'calculation.run' and status = 'queued'`);
    expect(again.error).toBeNull();
    expect(queuedNow).toBe('0');
  });

  it('refuses a config name that is not one', async () => {
    const { error } = await serviceStorage().schema('api_server').rpc('enqueue_health_upgrade', { p_config_version: 'v5; drop table x' });
    expect(error?.message).toMatch(/VALIDATION/);
  });
});

describe('scores under different configs are never compared (ADR-119 §5)', () => {
  it('Home and the reports show no change when the previous month was scored under other rules', async () => {
    const db = serviceStorage();
    const same = await loadHealthCard(db, orgId, period('2026-08'), period('2026-07'));
    expect(same?.changeVsPrevious).not.toBeNull();
    const julyScore = one(`select health_score_id from public.health_current where organization_id = '${orgId}' and period_id = '${period('2026-07')}'`);
    adminSql(`set session_replication_role = replica;
              update public.health_scores set config_version = 'health.config.v4' where id = '${julyScore}';`);
    const mixed = await loadHealthCard(db, orgId, period('2026-08'), period('2026-07'));
    expect(mixed?.score).not.toBeNull();
    expect(mixed?.changeVsPrevious).toBeNull();
  });

  it('the Command Centre summary returns no previous month across a config change', () => {
    expect(adminSql(`select position('h2.config_version = h1.config_version' in pg_get_functiondef('api.portfolio_summary(uuid[], date, date)'::regprocedure)) > 0`).trim()).toBe('t');
  });
});
