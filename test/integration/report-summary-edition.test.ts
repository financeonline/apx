import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordAccessEvent } from '@/core/db';
import { isMotionError } from '@/core/errors';
import type { EffectiveRole } from '@/core/permissions';
import { loadHome } from '@/modules/dashboard';
import { drainJobs } from '@/modules/jobs';
import {
  getMonthlyReport, getMonthlySummary, getReportFile, listAvailable, readsFullMonthlyReport, renderSummaryPdf,
  requestPdf,
} from '@/modules/reporting';
import { agreedPermissions, type AccessContext } from '@/modules/tenancy';
import { tokenisePdf } from '../../src/modules/imports/domain/parsers/pdf-text';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, serviceStorage } from './setup';

/**
 * The Monthly Management Report's summary edition, against the database (ADR-172 addendum; the
 * owner's decision of 2026-10-14).
 *
 * A fixture company with real figures from the engine, and named detail exactly where the FULL
 * report prints it: an open alert whose sentence names a customer, an open action whose title names
 * them, a named bank account, a named customer. The gate is the owner's sentence, checked on the
 * PDF's own text (extracted with the import pipeline's tokeniser): the customer's name, the bank
 * account's name, the alert's sentence and the action's title are ABSENT from the summary edition a
 * 3rd party downloads, while the headline figures and the Business Health Score are PRESENT. The
 * same names ARE in the full PDF — so the fixture is one that would leak, and the summary's silence
 * is the edition's doing, not an empty month's.
 *
 * Run-unique fixtures (ADR-052.12), removed afterwards. Never companies "a"/"b".
 */

const RUN = `v${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.summary.itest`;

/** In every name below and nowhere else (the organisation's own name carries `RUN`, not this). */
const MARK = `nm${RUN}`;
const NAMES = {
  customer: `Zephyr Wholesale ${MARK} Ltd`,
  bank: `Harbour Reserve ${MARK}`,
  alertTitle: `One customer is 62% of revenue ${MARK}`,
  alertSentence: `Zephyr Wholesale ${MARK} Ltd is 62% of revenue this month.`,
  actionTitle: `Chase Zephyr Wholesale ${MARK} Ltd for the May invoice`,
};

type Who = 'owner' | 'client' | 'third' | 'stranger';
const ids = {} as Record<Who, string>;
let orgId: string;
let slug: string;
let otherOrgId: string;
let mayId: string;
let juneId: string;
let fullFileId: string;

const email = (who: Who) => `${who}@${DOMAIN}`;
const db = (who: Who): SupabaseClient => clientFor(ids[who], { email: email(who) });
const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

/** The context a page hands a service, from the same `api.my_access` the resolver calls. */
async function ctxFor(who: Who): Promise<AccessContext> {
  const { data, error } = await db(who).schema('api').rpc('my_access', { p_slug: slug });
  if (error) throw new Error(error.message);
  const row = (data as Array<{ role: EffectiveRole; overrides: unknown; permissions: string[] }>)[0];
  if (!row) throw new Error(`${who} has no access to ${slug}`);
  return {
    userId: ids[who], orgId, orgSlug: slug, effectiveRole: row.role,
    permissions: agreedPermissions(row.role, row.overrides, row.permissions).agreed,
    actorType: 'user', db: db(who), requestId: `itest-${RUN}`,
    now: () => new Date('2026-06-15T00:00:00Z'), organizationStatus: 'active',
  };
}

async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return isMotionError(error) ? error.code : `thrown: ${String(error)}`;
  }
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const tokens = await tokenisePdf(bytes);
  return tokens.pages.flatMap((page) => page.lines.map((line) => line.text)).join('\n').replace(/\s+/g, ' ');
}

/** What a drawn PDF can hold of a string: pdf-kit replaces dashes and drops what Helvetica lacks. */
function drawn(text: string): string {
  return text.replace(/[–—−]/g, '-').normalize('NFKD').replace(/[^\x20-\x7E£€]/g, '').replace(/\s+/g, ' ');
}

beforeAll(async () => {
  for (const who of ['owner', 'client', 'third', 'stranger'] as Who[]) ids[who] = createAuthUser(email(who));
  const created = await db('owner').schema('api').rpc('create_organization', { p_name: `ITest Summary ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  slug = one(`select slug from public.organizations where id = '${orgId}'`);
  const other = await db('stranger').schema('api').rpc('create_organization', { p_name: `ITest Summary Other ${RUN}` });
  otherOrgId = other.data as unknown as string;

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status) values
      ('${orgId}', '${ids.client}', 'client', 'active'),
      ('${orgId}', '${ids.third}', 'third_party', 'active');`);

  mayId = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-05-01'`);
  juneId = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-06-01'`);

  // April and May from a general ledger, so May has figures, a comparison month and a score.
  const account = (category: string) => one(`
    select id from public.accounts where organization_id = '${orgId}' and standard_category = '${category}' and is_system`);
  const post = (category: string, direction: string, amount: string, date: string) => {
    const id = one(`
      insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '${date}', '${account(category)}', '${direction}', ${amount},
              '00000000-0000-0000-0000-000000000000', 'accepted')
      returning id`);
    adminSql(`insert into public.record_status_events (organization_id, record_table, record_id, event)
              values ('${orgId}', 'ledger_entries', '${id}', 'accepted')`);
  };
  post('revenue', 'credit', '38000.00', '2026-04-10');
  post('cost_of_sales', 'debit', '8000.00', '2026-04-12');
  post('payroll', 'debit', '11000.00', '2026-04-25');
  post('revenue', 'credit', '40000.00', '2026-05-10');
  post('cost_of_sales', 'debit', '9000.00', '2026-05-12');
  post('payroll', 'debit', '12000.00', '2026-05-25');

  const doc = one(`
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgId}', '${orgId}/summary/gl.csv', 'gl.csv', 'text/csv', 10, decode('e6','hex'), 'ready', 'general_ledger')
    returning id`);
  adminSql(`
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status,
                                       extraction_method, period_start, period_end, committed_at)
    values ('${orgId}', '${doc}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-04-01', '2026-05-31', now())`);

  const jobId = adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-06-15"}'::jsonb, 3)
    returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId), 'the figures must exist').toBe('succeeded');

  /*
   * The Business Health Score. A ledger alone reaches fewer than three of the engine's areas, which
   * honestly yields no score; the edition must print a score, so May's is written here as the engine
   * writes it — a score of a succeeded run, made current through `health_current` — with a breakdown
   * that carries named detail in its condition (which the redacted view a 3rd party reads drops, and
   * the edition never prints).
   */
  const runId = one(`select calculation_run_id from public.metric_current where organization_id = '${orgId}' and period_id = '${mayId}' limit 1`);
  const scoreRun = one(`
    insert into public.calculation_runs (organization_id, trigger, engine_version, period_from, period_to, as_of, status)
    select organization_id, 'recalc_manual', engine_version, period_from, period_to, as_of, 'succeeded'
      from public.calculation_runs where id = '${runId}'
    returning id`);
  adminSql(`
    with h as (
      insert into public.health_scores (organization_id, calculation_run_id, period_id, score, dimensions_used, dimensions_total, config_version, breakdown)
      values ('${orgId}', '${scoreRun}', '${mayId}', 64, 3, 5, 'itest',
              jsonb_build_array(
                jsonb_build_object('key', 'profitability', 'score', 72, 'weight_config', 25, 'weight_applied', 40, 'included', true,
                  'exclusion_reason', null, 'capped', false, 'cap_reason', null,
                  'positives', '["Net margin of 47.5% is healthy"]'::jsonb, 'negatives', '[]'::jsonb,
                  'metrics', '[]'::jsonb, 'rules', '[]'::jsonb,
                  'conditions', jsonb_build_array(jsonb_build_object('rule_key', 'concentration.customer', 'subject_id', null,
                                  'subject_key', '${NAMES.customer}', 'snapshot_ids', '[]'::jsonb, 'record_ids', '[]'::jsonb)),
                  'positives_structured', '[]'::jsonb, 'negatives_structured', '[]'::jsonb,
                  'data_quality', '{"completeness": 1, "warnings": []}'::jsonb),
                jsonb_build_object('key', 'revenue_growth', 'score', 61, 'weight_config', 15, 'weight_applied', 30, 'included', true,
                  'exclusion_reason', null, 'capped', false, 'cap_reason', null,
                  'positives', '[]'::jsonb, 'negatives', '[]'::jsonb, 'metrics', '[]'::jsonb, 'rules', '[]'::jsonb, 'conditions', '[]'::jsonb,
                  'positives_structured', '[]'::jsonb, 'negatives_structured', '[]'::jsonb,
                  'data_quality', '{"completeness": 1, "warnings": []}'::jsonb),
                jsonb_build_object('key', 'banking_health', 'score', null, 'weight_config', 15, 'weight_applied', 0, 'included', false,
                  'exclusion_reason', 'no_bank_coverage', 'capped', false, 'cap_reason', null,
                  'positives', '[]'::jsonb, 'negatives', '[]'::jsonb, 'metrics', '[]'::jsonb, 'rules', '[]'::jsonb, 'conditions', '[]'::jsonb,
                  'positives_structured', '[]'::jsonb, 'negatives_structured', '[]'::jsonb,
                  'data_quality', '{"completeness": 0, "warnings": []}'::jsonb)))
      returning id, organization_id, period_id)
    insert into public.health_current (organization_id, period_id, health_score_id)
    select organization_id, period_id, id from h
    on conflict (organization_id, period_id) do update set health_score_id = excluded.health_score_id`);

  // The named detail the FULL report prints: a customer, a bank account, an open alert naming the
  // customer, and an open action naming them.
  adminSql(`
    insert into public.counterparties (organization_id, name, normalized_name, kind)
    values ('${orgId}', '${NAMES.customer}', lower('${NAMES.customer}'), 'customer');
    insert into public.bank_accounts (organization_id, name, bank_name, account_type)
    values ('${orgId}', '${NAMES.bank}', 'ITest Bank', 'savings');
    insert into public.alerts (organization_id, period_id, rule_key, rule_version, severity, key_kind, calculation_run_id,
                               title, explanation, status, recommended_next_step, first_seen_at, dedupe_key)
    values ('${orgId}', '${mayId}', 'concentration.customer', '1', 'high', 'state', '${runId}',
            '${NAMES.alertTitle}', '${NAMES.alertSentence}', 'open',
            'Talk to ${NAMES.customer} about the payment terms', now(), 'itest-${RUN}');
    insert into public.actions (organization_id, title, owner_user_id, created_by)
    values ('${orgId}', '${NAMES.actionTitle}', '${ids.owner}', '${ids.owner}');`);

  // The FULL report's PDF, produced as the product does (the owner asks; the job renders and stores).
  const renderJob = await requestPdf(await ctxFor('owner'), mayId);
  expect(await drainUntilFinished(drainJobs, renderJob), 'the full PDF must render').toBe('succeeded');
  fullFileId = one(`select id::text from public.report_files where organization_id = '${orgId}' and period_id = '${mayId}'`);
});

afterAll(() => {
  adminSql(`
    delete from public.report_files where organization_id in (select id from public.organizations where name like 'ITest Summary%${RUN}');
    delete from public.organizations where name like 'ITest Summary%${RUN}';
    delete from public.api_rate_limits where actor_user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Summary %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.summary.itest' and created_at < now() - interval '1 hour';`);
});

describe('the fixture would leak: the FULL report carries the named detail', () => {
  it('its stored PDF prints the alert sentence, the alert title and the action title', async () => {
    const path = one(`select storage_path from public.report_files where id = '${fullFileId}'`);
    const { data, error } = await serviceStorage().storage.from('reports').download(path);
    expect(error).toBeNull();
    const text = await pdfText(new Uint8Array(await data!.arrayBuffer()));
    expect(text).toContain(drawn(NAMES.alertSentence));
    expect(text).toContain(drawn(NAMES.alertTitle));
    expect(text).toContain(drawn(NAMES.actionTitle));
  });
});

describe('the summary edition a 3rd party downloads (the owner\'s sentence, on the PDF\'s text)', () => {
  let text: string;
  let figures: readonly { value: string; label: string }[];

  beforeAll(async () => {
    const summary = await getMonthlySummary(await ctxFor('third'), mayId);
    expect(summary).not.toBeNull();
    figures = summary!.figures;
    text = await pdfText(await renderSummaryPdf(summary!));
  });

  it('says on its cover which edition it is', () => {
    expect(text).toContain('Summary edition for external readers: figures and Business Health Score only');
    expect(text).toContain('Monthly management report - summary edition - May 2026');
  });

  it('PRESENT: every headline figure, and the Business Health Score', () => {
    expect(figures.length).toBeGreaterThan(0);
    expect(figures.map((f) => f.value)).toContain('£40,000');
    for (const figure of figures) {
      expect(text, `${figure.label} must be printed`).toContain(drawn(figure.label));
      expect(text, `${figure.label}'s value must be printed`).toContain(drawn(figure.value));
    }
    expect(text).toContain('Business Health Score');
    expect(text).toContain('Score out of 100');
    expect(text).toMatch(/Score out of 100 64\b/);
    expect(text).toContain('Profitability');
  });

  it('ABSENT: the customer\'s name, the bank account\'s name, the alert\'s sentence and title, the action\'s title', () => {
    for (const [what, value] of Object.entries(NAMES)) {
      expect(text, `${what} must not be in the summary edition`).not.toContain(drawn(value));
    }
    // And not even a fragment: the mark is in every name and nowhere else.
    expect(text).not.toContain(MARK);
  });

  it('is the same document whoever downloads it: the 3rd party\'s equals the owner\'s', async () => {
    const asThird = await getMonthlySummary(await ctxFor('third'), mayId);
    const asOwner = await getMonthlySummary(await ctxFor('owner'), mayId);
    expect(asOwner).toEqual(asThird);
  });

  it('says what Home says: each figure equals its Home card (ARCHITECTURE risk 7)', async () => {
    const owner = await ctxFor('owner');
    const home = await loadHome(owner.db, orgId, slug, owner.requestId);
    if (home.kind !== 'ready') throw new Error(`expected figures, got ${home.kind}`);
    expect(home.view.period.id).toBe(mayId);
    const summary = (await getMonthlySummary(await ctxFor('third'), mayId))!;
    expect(summary.figures.map((f) => ({ key: f.metricKey, label: f.label, value: f.value, change: f.change })))
      .toEqual(home.view.cards.map((c) => ({ key: c.metricKey, label: c.label, value: c.value, change: c.change?.text ?? null })));
  });
});

describe('who gets which edition', () => {
  it('a reader without financials.view is refused the full report and offered no stored file', async () => {
    const third = await ctxFor('third');
    expect(readsFullMonthlyReport(third)).toBe(false);
    expect(await outcome(getMonthlyReport(third, mayId))).toBe('PERMISSION_DENIED');
    const available = await listAvailable(third);
    expect(available.find((r) => r.periodId === mayId)?.file ?? null, 'the full PDF does not exist for them').toBeNull();
    expect(await getReportFile(third, fullFileId)).toBeNull();
  });

  it('… and the database will not record — so the signer will not sign — a download of the full file for them', async () => {
    await expect(recordAccessEvent(
      { userId: ids.third, requestId: `itest-${RUN}` },
      { organizationId: orgId, action: 'report.downloaded', targetTable: 'report_files', targetId: fullFileId },
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(Number(one(`select count(*) from public.audit_events where action = 'report.downloaded'
                         and actor_user_id = '${ids.third}' and target_table = 'report_files'`))).toBe(0);
  });

  it('it records their summary-edition download against the month', async () => {
    const id = await recordAccessEvent(
      { userId: ids.third, requestId: `itest-${RUN}` },
      { organizationId: orgId, action: 'report.downloaded', targetTable: 'fiscal_periods', targetId: mayId,
        metadata: { period_id: mayId, surface: 'summary_edition' } },
    );
    expect(id).toBeGreaterThan(0);
  });

  it('a holder of financials.view reads the full report and its file, as before — and the summary edition too', async () => {
    for (const who of ['owner', 'client'] as const) {
      const ctx = await ctxFor(who);
      expect(readsFullMonthlyReport(ctx)).toBe(true);
      const report = await getMonthlyReport(ctx, mayId);
      expect(report!.alerts.map((a) => a.explanation)).toContain(NAMES.alertSentence);
      expect((await getReportFile(ctx, fullFileId))?.reportKind).toBe('monthly_management');
      expect(await getMonthlySummary(ctx, mayId)).not.toBeNull();
    }
  });

  it('a client whose financials.view the owner switches off gets only the summary edition', async () => {
    const { error } = await db('owner').schema('api').rpc('set_member_permission', {
      p_org: orgId, p_user: ids.client, p_permission: 'financials.view', p_granted: false,
    });
    expect(error).toBeNull();
    const client = await ctxFor('client');
    expect(readsFullMonthlyReport(client)).toBe(false);
    expect(await outcome(getMonthlyReport(client, mayId))).toBe('PERMISSION_DENIED');
    expect(await getReportFile(client, fullFileId)).toBeNull();
    expect(await getMonthlySummary(client, mayId)).not.toBeNull();
  });
});

describe('the summary edition exists exactly where the full report would', () => {
  it('not for a month that has not finished', async () => {
    expect(await getMonthlySummary(await ctxFor('third'), juneId)).toBeNull();
  });

  it('not for another organisation\'s month', async () => {
    const foreign = one(`select id from public.fiscal_periods where organization_id = '${otherOrgId}' and period_start = '2026-05-01'`);
    expect(await getMonthlySummary(await ctxFor('third'), foreign)).toBeNull();
  });
});
