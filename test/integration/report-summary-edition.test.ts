import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordAccessEvent } from '@/core/db';
import { getObject } from '@/core/storage/signer';
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
import { auth } from '@/db/firestore';
import { newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import type { Db } from '@/db/types';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs, rpc } from './setup';
import { addMember, createOrgFixture } from './r-fixtures';
import { ensureMonths, monthId, systemAccountId, writeJob } from './r-metrics';
import {
  writeAction, writeAlert, writeBankAccount, writeCounterparty, writeImportBatch, writeLedgerEntry, writeSourceDocument,
} from './r-records';

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
 * Run-unique fixtures (ADR-052.12), written into Firestore as an import and the engine leave them,
 * removed afterwards. Never companies "a"/"b".
 */

// Each case reads Home and the report several times over the shared emulator.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const RUN = `v${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.summary.itest.motion`;

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
const db = (who: Who): Db => clientFor(ids[who], { email: email(who) });

/** The context a page hands a service, from the same `api.my_access` the resolver calls. */
async function ctxFor(who: Who): Promise<AccessContext> {
  const { data, error } = await rpc(db(who), 'my_access', { p_slug: slug });
  if (error) throw error;
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
  for (const who of ['owner', 'client', 'third', 'stranger'] as Who[]) ids[who] = await createAuthUser(email(who));
  const org = await createOrgFixture({ name: `ITest Summary ${RUN}`, ownerId: ids.owner });
  orgId = org.id;
  slug = org.slug;
  otherOrgId = (await createOrgFixture({ name: `ITest Summary Other ${RUN}`, ownerId: ids.stranger })).id;
  await ensureMonths(orgId, '2026-01-01', '2026-12-31');
  await ensureMonths(otherOrgId, '2026-01-01', '2026-12-31');

  await addMember(orgId, ids.client, 'client');
  await addMember(orgId, ids.third, 'third_party');

  mayId = monthId(orgId, '2026-05');
  juneId = monthId(orgId, '2026-06');

  // April and May from a general ledger, so May has figures, a comparison month and a score.
  const post = async (category: string, direction: 'debit' | 'credit', amount: string, date: string) =>
    writeLedgerEntry(orgId, { accountId: await systemAccountId(orgId, category), date, direction, amount });
  await post('revenue', 'credit', '38000.00', '2026-04-10');
  await post('cost_of_sales', 'debit', '8000.00', '2026-04-12');
  await post('payroll', 'debit', '11000.00', '2026-04-25');
  await post('revenue', 'credit', '40000.00', '2026-05-10');
  await post('cost_of_sales', 'debit', '9000.00', '2026-05-12');
  await post('payroll', 'debit', '12000.00', '2026-05-25');

  const doc = await writeSourceDocument(orgId, { path: `${orgId}/summary/gl.csv`, filename: 'gl.csv', kind: 'general_ledger', sha256: 'e6' });
  await writeImportBatch(orgId, {
    documentId: doc, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
    periodStart: '2026-04-01', periodEnd: '2026-05-31',
  });

  const jobId = await writeJob(orgId, { jobType: 'calculation.run', payload: { trigger: 'recalc_manual', as_of: '2026-06-15' } });
  expect(await drainUntilFinished(drainJobs, jobId), 'the figures must exist').toBe('succeeded');

  /*
   * The Business Health Score. A ledger alone reaches fewer than three of the engine's areas, which
   * honestly yields no score; the edition must print a score, so May's is written here as the engine
   * writes it — a score of a succeeded run, made current through `health_current` — with a breakdown
   * that carries named detail in its condition (which the redacted view a 3rd party reads drops, and
   * the edition never prints).
   */
  const pointer = (await orgCollection(fs(), orgId, 'metric_current').where('period_id', '==', mayId).limit(1).get()).docs[0]!;
  const runId = String(pointer.get('calculation_run_id'));
  const run = (await orgRow(fs(), orgId, 'calculation_runs', runId).get()).data()!;
  const scoreRun = newId();
  const now = nowIso();
  await orgRow(fs(), orgId, 'calculation_runs', scoreRun).set({ ...run, id: scoreRun, job_id: null, status: 'succeeded', created_at: now, updated_at: now });
  const empty = { positives: [], negatives: [], metrics: [], rules: [], conditions: [], positives_structured: [], negatives_structured: [] };
  const healthId = newId();
  await orgRow(fs(), orgId, 'health_scores', healthId).set({
    id: healthId, organization_id: orgId, calculation_run_id: scoreRun, period_id: mayId, score: 64,
    dimensions_used: 3, dimensions_total: 5, config_version: 'itest', created_at: now,
    breakdown: [
      { key: 'profitability', score: 72, weight_config: 25, weight_applied: 40, included: true, exclusion_reason: null,
        capped: false, cap_reason: null, ...empty, positives: ['Net margin of 47.5% is healthy'],
        conditions: [{ rule_key: 'concentration.customer', subject_id: null, subject_key: NAMES.customer, snapshot_ids: [], record_ids: [] }],
        data_quality: { completeness: 1, warnings: [] } },
      { key: 'revenue_growth', score: 61, weight_config: 15, weight_applied: 30, included: true, exclusion_reason: null,
        capped: false, cap_reason: null, ...empty, data_quality: { completeness: 1, warnings: [] } },
      { key: 'banking_health', score: null, weight_config: 15, weight_applied: 0, included: false,
        exclusion_reason: 'no_bank_coverage', capped: false, cap_reason: null, ...empty,
        data_quality: { completeness: 0, warnings: [] } },
    ],
  });
  const currentRef = orgRow(fs(), orgId, 'health_current', mayId);
  const previous = await currentRef.get();
  await currentRef.set({
    organization_id: orgId, period_id: mayId, health_score_id: healthId, calculation_run_id: scoreRun,
    previous_health_score_id: previous.exists ? (previous.get('health_score_id') ?? null) : null, updated_at: now,
  });

  // The named detail the FULL report prints: a customer, a bank account, an open alert naming the
  // customer, and an open action naming them.
  await writeCounterparty(orgId, NAMES.customer);
  await writeBankAccount(orgId, { name: NAMES.bank, type: 'savings' });
  const alertId = await writeAlert(orgId, {
    periodId: mayId, runId, title: NAMES.alertTitle, severity: 'high', firstSeen: nowIso(), dedupeKey: `itest-${RUN}`,
  });
  // A rule key with no display template, so the stored sentence is what every surface prints (since
  // ADR-177 a templated rule's wording is re-rendered from its threshold summary, which this fixture
  // does not carry; the named detail must reach the full report for the test to mean anything).
  await orgRow(fs(), orgId, 'alerts', alertId).update({
    rule_key: 'fixture.customer_named', key_kind: 'state', explanation: NAMES.alertSentence,
    recommended_next_step: `Talk to ${NAMES.customer} about the payment terms`,
  });
  const actionId = await writeAction(orgId, { title: NAMES.actionTitle, due: null, ownerId: ids.owner });
  await orgRow(fs(), orgId, 'actions', actionId).update({ priority: 'medium' });

  // The FULL report's PDF, produced as the product does (the owner asks; the job renders and stores).
  const renderJob = await requestPdf(await ctxFor('owner'), mayId);
  expect(await drainUntilFinished(drainJobs, renderJob), 'the full PDF must render').toBe('succeeded');
  const files = (await orgCollection(fs(), orgId, 'report_files').where('period_id', '==', mayId).get()).docs;
  fullFileId = files[0]!.id;
}, 180_000);

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    if (!org) continue;
    for (const j of (await fs().collection('jobs').where('organization_id', '==', org).get()).docs) await j.ref.delete();
    await deleteOrg(org);
  }
  for (const who of Object.keys(ids) as Who[]) {
    await fs().collection('profiles').doc(ids[who]).delete();
    await auth().deleteUser(ids[who]).catch(() => undefined);
  }
});

describe('the fixture would leak: the FULL report carries the named detail', () => {
  it('its stored PDF prints the alert sentence, the alert title and the action title', async () => {
    const path = String((await orgRow(fs(), orgId, 'report_files', fullFileId).get()).get('storage_path'));
    const text = await pdfText(await getObject({ orgId, userId: ids.owner }, 'reports', path));
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
    const events = await fs().collection('audit_events').where('actor_user_id', '==', ids.third).get();
    expect(events.docs.filter((d) => d.get('action') === 'report.downloaded' && d.get('target_table') === 'report_files')).toHaveLength(0);
  });

  it('it records their summary-edition download against the month', async () => {
    const id = await recordAccessEvent(
      { userId: ids.third, requestId: `itest-${RUN}` },
      { organizationId: orgId, action: 'report.downloaded', targetTable: 'fiscal_periods', targetId: mayId,
        metadata: { period_id: mayId, surface: 'summary_edition' } },
    );
    // audit_events ids are uuids now (they were bigint identities).
    expect(String(id)).toMatch(/^[0-9a-f-]{36}$/);
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
    const { error } = await rpc(db('owner'), 'set_member_permission', {
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
    const foreign = monthId(otherOrgId, '2026-05');
    expect(await getMonthlySummary(await ctxFor('third'), foreign)).toBeNull();
  });
});
