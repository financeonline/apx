import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { drainJobs } from '@/modules/jobs';
import { PROMPT_VERSION, resolvePeriodContext, runTool, snapshotAccess, type PeriodRow as PeriodRowInput, type RecordedToolCall } from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { generateForecast } from '@/modules/forecast';
import { orgCollection } from '@/db/schema';
import { addCommittedBatch, addCounterparty, drainJobsOf, dropUsers, dropWhere, enqueue, makeOrg, postLedger } from './ai-fixtures';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs } from './setup';

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
const DOMAIN = `${RUN}.eval.itest.motion`;

let ownerId: string;
let orgId: string;
let periods: PeriodRowInput[] = [];

function contextFor(userId: string): AccessContext {
  return {
    userId, orgId, orgSlug: null, effectiveRole: 'owner', permissions: permissionsFor('owner'),
    actorType: 'user', db: clientFor(userId, { email: `owner@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'), organizationStatus: 'active',
  };
}

/** The calls the corpus rests on: every tool, the SOW §10 metrics, and both months for a trend. */
const CALLS: ReadonlyArray<{ name: string; input: Record<string, unknown>; question?: string }> = [
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
  // ADR-142: budget against actual, against an organisation with no budget imported — the honest
  // NO_DATA the corpus's budget cases are built on. Appended, so earlier seqs stand.
  { name: 'get_budget_variance', input: { period: 'May 2026' } },
  /*
   * ADR-146: the affordability check, against an organisation with two complete months and so no
   * forecast — the honest NO_DATA the corpus's affordability cases are built on. The amount must be
   * in the question, so this call carries the question it was asked under. Appended.
   */
  { name: 'check_affordability', input: { amount_as_written: '£5,000', recurrence: 'one_off' }, question: 'Can we afford a £5,000 laptop refresh?' },
];

export interface Recording {
  readonly promptVersion: string;
  readonly recordedAt: string;
  readonly fiscalYearStartMonth: number;
  readonly periods: readonly PeriodRowInput[];
  readonly calls: readonly RecordedToolCall[];
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Eval ${RUN}`);

  // One committed batch per month, the shape a real import leaves (a batch declares one period).
  const batchFor = (start: string, end: string) => addCommittedBatch(orgId, {
    importType: 'general_ledger', targetTable: 'ledger_entries', periodStart: start, periodEnd: end,
    filename: `gl-${start}.csv`, documentKind: 'general_ledger',
  });
  const april = await batchFor('2026-04-01', '2026-04-30');
  const may = await batchFor('2026-05-01', '2026-05-31');
  let line = 1;
  const post = async (category: string, direction: 'debit' | 'credit', amount: string, date: string, counterparty: string | null = null) => {
    line += 1;
    await postLedger(orgId, date < '2026-05-01' ? april : may, { category, direction, amount, date, line, counterpartyId: counterparty });
  };

  // Two customers, so "who are our biggest customers" has an answer (concentration §3.5).
  const acme = await addCounterparty(orgId, 'Acme Trading Ltd', 'customer');
  const beta = await addCounterparty(orgId, 'Beta Retail', 'customer');

  // April: £18,000 sales (Acme £12,000, Beta £6,000), £5,400 direct costs, £5,000 payroll, £1,200 marketing.
  // The last line of each month falls on its last day: a period is complete only when the source's
  // latest data date reaches the period end (ADR-030.1), and the corpus needs two complete months.
  await post('revenue', 'credit', '12000.00', '2026-04-10', acme);
  await post('revenue', 'credit', '6000.00', '2026-04-18', beta);
  await post('cost_of_sales', 'debit', '5400.00', '2026-04-12');
  await post('payroll', 'debit', '5000.00', '2026-04-25');
  await post('marketing', 'debit', '1200.00', '2026-04-30');
  // May: £25,000 sales (Acme £16,000, Beta £9,000), £6,000 direct costs, £5,000 payroll, £3,400 marketing, £900 other running costs.
  await post('revenue', 'credit', '16000.00', '2026-05-10', acme);
  await post('revenue', 'credit', '9000.00', '2026-05-18', beta);
  await post('cost_of_sales', 'debit', '6000.00', '2026-05-12');
  await post('payroll', 'debit', '5000.00', '2026-05-25');
  await post('marketing', 'debit', '3400.00', '2026-05-20');
  await post('operating_expense', 'debit', '900.00', '2026-05-31');

  // Two runs: the first proves the months complete, the second computes the comparisons that only
  // a complete previous month allows (ADR-030.4) — the state a customer's organisation is in after
  // its nightly run, and the one the corpus's "why did it change" questions need.
  for (const pass of [1, 2]) {
    const jobId = await enqueue(orgId, 'calculation.run', { trigger: 'recalc_manual', as_of: '2026-06-15' });
    expect(await drainUntilFinished(drainJobs, jobId), `calculation pass ${pass} must succeed`).toBe('succeeded');
  }
  // The alerts the corpus records come from `alerts.evaluate`, queued by the run. In the full
  // suite the queue is shared, so drain until THIS organisation has nothing left in it.
  expect(await drainJobsOf(drainJobs, orgId), "the organisation's queue is empty before recording").toBe(0);

  /*
   * A forecast exists only once somebody has asked for one (ADR-099), so the recorder asks — the
   * same call the page makes. Recording `get_forecast` against an organisation with no forecast
   * would record a NO_DATA and build a corpus that could never test a forecast answer.
   */
  await generateForecast(contextFor(ownerId));

  const withData = new Set((await orgCollection(fs(), orgId, 'ledger_entries').select('period_id').get()).docs
    .map((d) => String(d.get('period_id'))));
  periods = (await orgCollection(fs(), orgId, 'fiscal_periods').orderBy('period_start').get()).docs.map((d) => ({
    id: d.id, label: String(d.get('label')), periodStart: String(d.get('period_start')),
    isComplete: d.get('is_complete') === true, hasData: withData.has(d.id),
  }));
}, 300_000);

afterAll(async () => {
  await deleteOrg(orgId);
  await dropWhere('jobs', 'organization_id', [orgId]);
  await dropUsers(DOMAIN);
});

/** Every dotted key path in a value, ids and figures ignored — the SHAPE of a tool's output. */
export function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [`${prefix}[]`] : keyPaths(value[0], `${prefix}[]`);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as object).sort().flatMap((k) => keyPaths((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

/** `rule_key → key paths` of every alert in a `get_alerts` result, sorted: independent of list order. */
export function shapesByRule(data: unknown): string[] {
  const alerts = ((data ?? {}) as { alerts?: unknown[] }).alerts ?? [];
  return [...new Set(alerts.map((a) => `${String((a as { rule_key?: unknown }).rule_key)}: ${keyPaths(a).join(' ')}`))].sort();
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
      call: { periodContext, knownPeriods: periods.filter((p) => p.hasData).map((p) => ({ id: p.id, label: p.label })), now: new Date('2026-06-15T00:00:00Z'), question: call.question },
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
      // N-7: `keyPaths` reads an array's FIRST element, so for a list whose leading items tie it
      // compared whichever alert happened to come first. Every alert's shape, per rule, is compared
      // too — order-free, and stricter than the first element alone.
      if (call.name === 'get_alerts') {
        expect(shapesByRule(call.result.data), `${call.name} #${call.seq} shape of every alert, by rule`)
          .toEqual(shapesByRule(was.result.data));
      }
    }
  });
});
