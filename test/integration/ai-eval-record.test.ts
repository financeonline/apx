import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { drainJobs } from '@/modules/jobs';
import { PROMPT_VERSION, resolvePeriodContext, runTool, snapshotAccess, type PeriodRow as PeriodRowInput, type RecordedToolCall } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { generateForecast } from '@/modules/forecast';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

/**
 * The eval corpus's recorded tool outputs (AI_ARCHITECTURE.md §12; TEST_STRATEGY.md §10.3, line
 * "Recorded AI"): a synthetic service business — CD-30's first golden organisation — with two
 * months of ledger, two customers and their invoices, computed by the real engine and read through
 * the real tools.
 *
 * Two modes, one test:
 *   * `RECORD_AI_EVAL=1` re-records `test/fixtures/ai/recorded-tools.json`, stamped with the prompt
 *     version. Run it when a tool's output changes on purpose.
 *   * otherwise the recording must still match what the tools return today, key for key — a tool
 *     whose shape drifted invalidates every eval case built on it, and this is where that is caught.
 */

export const RECORDING_PATH = 'test/fixtures/ai/recorded-tools.json';

const RUN = `ev${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.eval.itest`;

let ownerId: string;
let orgId: string;
let periods: PeriodRowInput[] = [];

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function accountId(category: string): string {
  return one(`select id from public.accounts where organization_id = '${orgId}' and standard_category = '${category}' and is_system`);
}

function contextFor(userId: string): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: 'owner', permissions: permissionsFor('owner'),
    actorType: 'user', db: clientFor(userId, { email: `owner@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'), organizationStatus: 'active',
  };
}

/** The calls the corpus rests on: every tool, the SOW §10 metrics, and both months for a trend. */
const CALLS: ReadonlyArray<{ name: string; input: Record<string, unknown> }> = [
  { name: 'get_business_summary', input: { period: 'May 2026' } },
  { name: 'get_metric', input: { metric_key: 'revenue', period: 'May 2026' } },
  { name: 'get_metric', input: { metric_key: 'revenue', period: 'Apr 2026' } },
  { name: 'get_metric', input: { metric_key: 'gross_profit', period: 'May 2026' } },
  { name: 'get_metric', input: { metric_key: 'operating_profit', period: 'May 2026' } },
  { name: 'get_metric', input: { metric_key: 'net_profit', period: 'May 2026' } },
  { name: 'get_metric', input: { metric_key: 'operating_expenses', period: 'May 2026' } },
  { name: 'get_metric', input: { metric_key: 'net_margin', period: 'May 2026' } },
  { name: 'get_metric', input: { metric_key: 'closing_cash', period: 'May 2026' } },
  { name: 'get_metric_trend', input: { metric_key: 'revenue', from: 'Apr 2026', to: 'May 2026' } },
  { name: 'get_expense_changes', input: { period: 'May 2026', compare_to: 'prev_period', by: 'standard_category' } },
  { name: 'get_customer_profitability', input: { period: 'May 2026' } },
  { name: 'get_cash_analysis', input: { period: 'May 2026' } },
  { name: 'get_receivables', input: { period: 'May 2026' } },
  { name: 'get_payables', input: { period: 'May 2026' } },
  { name: 'get_alerts', input: { period: 'May 2026' } },
  { name: 'get_health_score', input: { period: 'May 2026' } },
  { name: 'get_data_coverage', input: {} },
  { name: 'get_customer_profitability', input: { period: 'Apr 2026' } },
  { name: 'get_business_summary', input: { period: 'Apr 2026' } },
  { name: 'get_actions', input: {} },
  // Phase 11: the corpus needs a real forecast output to build golden forecast cases from (ADR-099).
  { name: 'get_forecast', input: {} },
  /*
   * Phase 12 (ADR-100). This organisation has two complete months and MIN_PERIODS is three, so it
   * has no forecast — and therefore no scenario either. The recording is deliberately of THAT:
   * what the analyst gets when somebody asks about a what-if nobody has run. The corpus's
   * adversarial cases prove the model neither invents one nor claims the feature is missing.
   */
  { name: 'get_scenario', input: {} },
  // Phase 13 (ADR-101): the banking tools, against an organisation with no bank account — the
  // honest NO_DATA the corpus's banking cases are built on. Appended, so earlier seqs stand.
  { name: 'get_bank_accounts', input: { period: 'May 2026' } },
  { name: 'get_recurring_payments', input: {} },
  { name: 'get_unusual_transactions', input: { period: 'May 2026' } },
  { name: 'get_bank_categories', input: { period: 'May 2026' } },
  // Phase 14 (ADR-102): the commercial tools, against an organisation that has recorded no products,
  // campaigns or opportunities — the honest NO_DATA the corpus's attribution cases are built on.
  { name: 'get_product_contribution', input: { period: 'May 2026' } },
  { name: 'get_campaign_performance', input: { period: 'May 2026' } },
  { name: 'get_sales_pipeline', input: { period: 'May 2026' } },
];

export interface Recording {
  readonly promptVersion: string;
  readonly recordedAt: string;
  readonly fiscalYearStartMonth: number;
  readonly periods: readonly PeriodRowInput[];
  readonly calls: readonly RecordedToolCall[];
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Eval ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  // One committed batch per month, the shape a real import leaves (a batch declares one period).
  const batchFor = (start: string, end: string): { documentId: string; batchId: string } => {
    const documentId = one(`
      insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
      values ('${orgId}', '${orgId}/eval/gl-${start}.csv', 'gl-${start}.csv', 'text/csv', 10, decode('ee${start.slice(5, 7)}','hex'), 'ready', 'general_ledger') returning id`);
    const batchId = one(`
      insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
      values ('${orgId}', '${documentId}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '${start}', '${end}', now()) returning id`);
    return { documentId, batchId };
  };
  const april = batchFor('2026-04-01', '2026-04-30');
  const may = batchFor('2026-05-01', '2026-05-31');
  let line = 1;
  const post = (category: string, direction: string, amount: string, date: string, counterparty: string | null = null) => {
    const { documentId, batchId } = date < '2026-05-01' ? april : may;
    line += 1;
    const rowId = one(`
      insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
      values ('${orgId}', '${batchId}', ${line}, 'csv:row:${line}', '{}'::jsonb, '{}'::jsonb, 'committed') returning id`);
    const entryId = one(`
      insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, import_row_id, source_ref, counterparty_id)
      values ('${orgId}', '${date}', '${accountId(category)}', '${direction}', ${amount}, '00000000-0000-0000-0000-000000000000', 'accepted', '${documentId}', '${batchId}', '${rowId}', 'csv:row:${line}', ${counterparty ? `'${counterparty}'` : 'null'}) returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id) values ('${orgId}', 'ledger_entries', '${entryId}', 'accepted', '${batchId}')`);
  };

  // Two customers, so "who are our biggest customers" has an answer (concentration §3.5).
  const acme = one(`insert into public.counterparties (organization_id, name, normalized_name, kind) values ('${orgId}', 'Acme Trading Ltd', 'acme trading ltd', 'customer') returning id`);
  const beta = one(`insert into public.counterparties (organization_id, name, normalized_name, kind) values ('${orgId}', 'Beta Retail', 'beta retail', 'customer') returning id`);

  // April: £18,000 sales (Acme £12,000, Beta £6,000), £5,400 direct costs, £5,000 payroll, £1,200 marketing.
  // The last line of each month falls on its last day: a period is complete only when the source's
  // latest data date reaches the period end (ADR-030.1), and the corpus needs two complete months.
  post('revenue', 'credit', '12000.00', '2026-04-10', acme);
  post('revenue', 'credit', '6000.00', '2026-04-18', beta);
  post('cost_of_sales', 'debit', '5400.00', '2026-04-12');
  post('payroll', 'debit', '5000.00', '2026-04-25');
  post('marketing', 'debit', '1200.00', '2026-04-30');
  // May: £25,000 sales (Acme £16,000, Beta £9,000), £6,000 direct costs, £5,000 payroll, £3,400 marketing, £900 other running costs.
  post('revenue', 'credit', '16000.00', '2026-05-10', acme);
  post('revenue', 'credit', '9000.00', '2026-05-18', beta);
  post('cost_of_sales', 'debit', '6000.00', '2026-05-12');
  post('payroll', 'debit', '5000.00', '2026-05-25');
  post('marketing', 'debit', '3400.00', '2026-05-20');
  post('operating_expense', 'debit', '900.00', '2026-05-31');

  // Two runs: the first proves the months complete, the second computes the comparisons that only
  // a complete previous month allows (ADR-030.4) — the state a customer's organisation is in after
  // its nightly run, and the one the corpus's "why did it change" questions need.
  for (const pass of [1, 2]) {
    const jobId = adminSql(`
      insert into public.jobs (organization_id, job_type, payload, max_attempts)
      values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-06-15"}'::jsonb, 3) returning id`).split('\n')[0]!.trim();
    expect(await drainUntilFinished(drainJobs, jobId), `calculation pass ${pass} must succeed`).toBe('succeeded');
  }
  // The alerts the corpus records come from `alerts.evaluate`, queued by the run. In the full
  // suite the queue is shared, so drain until THIS organisation has nothing left in it.
  for (let round = 0; round < 20; round += 1) {
    const pending = adminSql(`select count(*) from public.jobs where organization_id = '${orgId}' and status in ('queued', 'running')`);
    if (pending === '0') break;
    await drainJobs(5);
  }
  expect(adminSql(`select count(*) from public.jobs where organization_id = '${orgId}' and status in ('queued', 'running')`), "the organisation's queue is empty before recording").toBe('0');

  /*
   * A forecast exists only once somebody has asked for one (ADR-099), so the recorder asks — the
   * same call the page makes. Recording `get_forecast` against an organisation with no forecast
   * would record a NO_DATA and build a corpus that could never test a forecast answer.
   */
  await generateForecast(contextFor(ownerId));

  const withData = new Set(adminSql(`select distinct period_id::text from public.ledger_entries where organization_id = '${orgId}'`).split('\n').map((l) => l.trim()));
  periods = adminSql(`select id || '|' || label || '|' || period_start || '|' || is_complete from public.fiscal_periods where organization_id = '${orgId}' order by period_start`)
    .split('\n').filter(Boolean).map((l) => {
      const [id, label, periodStart, complete] = l.trim().split('|') as [string, string, string, string];
      return { id, label, periodStart, isComplete: complete === 'true' || complete === 't', hasData: withData.has(id) };
    });
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Eval%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Eval %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.eval.itest' and created_at < now() - interval '1 hour';`);
});

/** Every dotted key path in a value, ids and figures ignored — the SHAPE of a tool's output. */
export function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [`${prefix}[]`] : keyPaths(value[0], `${prefix}[]`);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as object).sort().flatMap((k) => keyPaths((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

async function record(): Promise<Recording> {
  const ctx = contextFor(ownerId);
  const periodContext = resolvePeriodContext({ question: 'how did May 2026 go?', periods, fiscalYearStartMonth: 1 });
  const calls: RecordedToolCall[] = [];
  let seq = 0;
  for (const call of CALLS) {
    seq += 1;
    const { result } = await runTool({
      seq, name: call.name, rawInput: call.input,
      resolveAccess: async () => ctx, started: snapshotAccess(ctx),
      call: { periodContext, knownPeriods: periods.filter((p) => p.hasData).map((p) => ({ id: p.id, label: p.label })), now: new Date('2026-06-15T00:00:00Z') },
    });
    calls.push({ seq, name: call.name, input: call.input, result });
  }
  return { promptVersion: PROMPT_VERSION, recordedAt: new Date().toISOString(), fiscalYearStartMonth: 1, periods, calls };
}

describe('the recorded tool outputs the eval corpus rests on', () => {
  it('are recorded (RECORD_AI_EVAL=1) or still match today’s tools, key for key', async () => {
    const live = await record();
    if (process.env.RECORD_AI_EVAL === '1') {
      mkdirSync('test/fixtures/ai', { recursive: true });
      writeFileSync(RECORDING_PATH, `${JSON.stringify(live, null, 2)}\n`);
      expect(live.calls.length).toBe(CALLS.length);
      return;
    }
    const recorded = JSON.parse(readFileSync(RECORDING_PATH, 'utf8')) as Recording;
    expect(recorded.calls.map((c) => `${c.name}:${JSON.stringify(c.input)}`)).toEqual(live.calls.map((c) => `${c.name}:${JSON.stringify(c.input)}`));
    for (const [i, call] of live.calls.entries()) {
      const was = recorded.calls[i]!;
      expect(call.result.ok, `${call.name} ok`).toBe(was.result.ok);
      expect(keyPaths(call.result.data), `${call.name} #${call.seq} output shape`).toEqual(keyPaths(was.result.data));
    }
  });
});
