import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { drainJobs } from '@/modules/jobs';
import {
  TOOLS, TOOL_NAMES, allowedSet, resolvePeriodContext, runTool, snapshotAccess, ContextChanged,
  type PeriodContext, type ToolCallContext, type ToolResult,
} from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { orgCollection } from '@/db/schema';
import {
  addCommittedBatch, addCounterparty, addMember, addPlatformUser, assign, currentSnapshot, dropUsers, dropWhere,
  enqueue, makeOrg, periodOf, postLedger,
} from './ai-fixtures';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs } from './setup';

/**
 * The tool registry against a REAL computed organisation (TEST_STRATEGY.md §10.1; AI_ARCHITECTURE.md
 * §3, §4; F-C-02, F-C-09, F-C-17).
 *
 * The role × tool matrix is the security property: a role that lacks a tool's permission gets a
 * structured refusal recorded as `authorized = false`, never data. The rest is what makes the
 * numbers usable at all — every figure a tool returns must enter the grounding allowed set with a
 * `snapshot_id` beside it, or the model can quote it and cite nothing.
 *
 * Figures come from the engine, driven through the queue, never hand-written snapshots
 * (the evidence suite's rule, for the same reason). Run-unique fixtures (ADR-052.12).
 */

const RUN = `t${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.tools.itest.motion`;

let ownerId: string;
let clientUserId: string;
let orgId: string;
let mayPeriodId: string;
let ledgerDocumentId: string;
let aLedgerEntryId: string;
let periodContext: PeriodContext;
let revenueSnapshot: string;
let otherOrg: string | null = null;

function contextFor(userId: string, role: EffectiveRole, org: string = orgId): AccessContext {
  return {
    userId, orgId: org, orgSlug: null, effectiveRole: role, permissions: permissionsFor(role),
    actorType: 'user', db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'), organizationStatus: 'active',
  };
}

function callFor(ctx: AccessContext): Omit<ToolCallContext, 'ctx'> & { ctx: AccessContext } {
  return { ctx, periodContext, knownPeriods: [], now: new Date('2026-06-15T00:00:00Z') };
}

/** Runs one tool as the loop does: through `runTool`, with the access re-resolved to the same context. */
async function invoke(ctx: AccessContext, name: string, rawInput: unknown, seq = 1) {
  const call = callFor(ctx);
  return runTool({
    seq, name, rawInput,
    resolveAccess: async () => ctx,
    started: snapshotAccess(ctx),
    call: { periodContext: call.periodContext, knownPeriods: call.knownPeriods, now: call.now },
  });
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientUserId = await createAuthUser(`client@${DOMAIN}`);
  orgId = await makeOrg(ownerId, `ITest Tools ${RUN}`);
  await addMember(orgId, clientUserId, 'client');
  mayPeriodId = periodOf(orgId, '2026-05-01');

  // A month of ledger through the real commit shape, then the real engine.
  const batch = await addCommittedBatch(orgId, {
    importType: 'general_ledger', targetTable: 'ledger_entries', periodStart: '2026-05-01', periodEnd: '2026-05-31',
    filename: 'gl.csv', documentKind: 'general_ledger',
  });
  ledgerDocumentId = batch.documentId;
  const post = async (category: string, direction: 'debit' | 'credit', amount: string, day: string, line: number) => {
    // Kept so the two Phase 9 evidence tools can be exercised against a real row and its real file.
    aLedgerEntryId = await postLedger(orgId, batch, { category, direction, amount, date: `2026-05-${day}`, line });
  };
  await post('revenue', 'credit', '20000.00', '10', 2);
  await post('revenue', 'credit', '5000.00', '18', 3);
  await post('cost_of_sales', 'debit', '6000.00', '12', 4);
  await post('payroll', 'debit', '5000.00', '25', 5);

  const jobId = await enqueue(orgId, 'calculation.run', { trigger: 'recalc_manual', as_of: '2026-06-15' });
  expect(await drainUntilFinished(drainJobs, jobId), 'the calculation this suite rests on must have run').toBe('succeeded');
  revenueSnapshot = await currentSnapshot(orgId, mayPeriodId, 'revenue');

  // The period context the loop would build for "how did May go?".
  const periods = (await orgCollection(fs(), orgId, 'fiscal_periods').orderBy('period_start').get()).docs.map((d) => ({
    id: d.id, label: String(d.get('label')), periodStart: String(d.get('period_start')),
    isComplete: d.get('is_complete') === true, hasData: d.id === mayPeriodId,
  }));
  periodContext = resolvePeriodContext({ question: 'how did May 2026 go?', periods, fiscalYearStartMonth: 1 });
}, 120_000);

afterAll(async () => {
  await deleteOrg(orgId);
  await dropWhere('jobs', 'organization_id', [orgId]);
  if (otherOrg) await deleteOrg(otherOrg);
  await dropUsers(DOMAIN);
});

const MAY = () => periodContext.resolved[0]?.label ?? periodContext.default!.label;

/** A representative valid input per tool, so the matrix exercises the real run path. */
const INPUTS: Record<string, () => unknown> = {
  get_business_summary: () => ({ period: MAY() }),
  get_metric: () => ({ metric_key: 'revenue', period: MAY() }),
  get_metric_trend: () => ({ metric_key: 'revenue', from: MAY(), to: MAY() }),
  get_expense_changes: () => ({ period: MAY(), compare_to: 'prev_period', by: 'standard_category' }),
  get_customer_profitability: () => ({ period: MAY() }),
  get_cash_analysis: () => ({ period: MAY() }),
  get_receivables: () => ({ period: MAY() }),
  get_payables: () => ({ period: MAY() }),
  get_alerts: () => ({ period: MAY() }),
  get_health_score: () => ({ period: MAY() }),
  get_evidence: () => ({ evidence_bundle_id: '00000000-0000-4000-8000-000000000000' }),
  get_source_document_reference: () => ({ record_type: 'ledger_entry', record_id: '00000000-0000-4000-8000-000000000000' }),
  get_transactions_for_evidence: () => ({ metric_snapshot_id: snapshotOf('revenue') }),
  get_data_coverage: () => ({}),
  get_actions: () => ({}),
  get_record_evidence: () => ({ record_type: 'ledger_entry', record_id: aLedgerEntryId }),
  get_document_evidence: () => ({ document_id: ledgerDocumentId }),
  get_forecast: () => ({}),
  get_scenario: () => ({}),
  get_bank_accounts: () => ({ period: MAY() }),
  get_recurring_payments: () => ({}),
  get_unusual_transactions: () => ({ period: MAY() }),
  get_bank_categories: () => ({ period: MAY() }),
  get_product_contribution: () => ({ period: MAY() }),
  get_campaign_performance: () => ({ period: MAY() }),
  get_sales_pipeline: () => ({ period: MAY() }),
  get_budget_variance: () => ({ period: MAY() }),
  check_affordability: () => ({ amount_as_written: '5000', recurrence: 'one_off' }),
};

/** The engine's current revenue snapshot for May — every figure here is revenue's. */
function snapshotOf(metricKey: string): string {
  if (metricKey !== 'revenue') throw new Error(`no fixture snapshot for ${metricKey}`);
  return revenueSnapshot;
}

describe('the registry is closed and complete', () => {
  it('has exactly the twenty-eight tools §3 names, each with a permission and a schema', () => {
    // Fifteen through Phase 8; the two evidence tools in Phase 9 (ADR-097); `get_forecast` in
    // Phase 11 (ADR-099); `get_scenario` in Phase 12 (ADR-100); the four banking tools in Phase 13
    // (ADR-101); the three commercial tools in Phase 14 (ADR-102); budget against actual (ADR-142);
    // the affordability check (ADR-146).
    // The count is asserted so a tool cannot be added without editing this test.
    expect(TOOL_NAMES).toHaveLength(28);
    expect(new Set(TOOL_NAMES).size).toBe(28);
    for (const tool of TOOLS) {
      expect(tool.permission, `${tool.name} has a permission`).toBeTruthy();
      expect(tool.description.length, `${tool.name} tells the model when to use it`).toBeGreaterThan(40);
    }
    expect(Object.keys(INPUTS).sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe('the role × tool matrix (§10.1)', () => {
  it('an owner may call every tool and each result is either data or an honest NO_DATA', async () => {
    const ctx = contextFor(ownerId, 'owner');
    for (const name of TOOL_NAMES) {
      const { result, persisted } = await invoke(ctx, name, INPUTS[name]!());
      expect(persisted.authorized, `${name} is authorised for an owner`).toBe(true);
      if (!result.ok) {
        // A tool with nothing to report says so with a code, never a guess.
        expect(['NO_DATA', 'NOT_FOUND', 'INSUFFICIENT_DATA'], `${name} failed honestly`).toContain((result.data as { code: string }).code);
      }
    }
  });

  it('a client is refused the source-document tool with a structured denial, recorded as unauthorised', async () => {
    const ctx = contextFor(clientUserId, 'client');
    const { result, persisted } = await invoke(ctx, 'get_source_document_reference', INPUTS.get_source_document_reference!());
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toBe('PERMISSION_DENIED');
    expect((result.data as { message: string }).message).toMatch(/not available to your role/);
    expect(persisted.authorized).toBe(false);
    expect(persisted.denial_reason).toBe('missing:documents.view');
  });

  it('a client may call the three commercial tools (customers.view), and each answers with data or an honest NO_DATA (ADR-102)', async () => {
    const ctx = contextFor(clientUserId, 'client');
    for (const name of ['get_product_contribution', 'get_campaign_performance', 'get_sales_pipeline']) {
      const { result, persisted } = await invoke(ctx, name, INPUTS[name]!());
      expect(persisted.authorized, `${name} is authorised for a client`).toBe(true);
      if (!result.ok) expect((result.data as { code: string }).code).toBe('NO_DATA');
    }
  });

  it('a client may read figures, and gets them', async () => {
    const ctx = contextFor(clientUserId, 'client');
    const { result, persisted } = await invoke(ctx, 'get_metric', INPUTS.get_metric!());
    expect(persisted.authorized).toBe(true);
    expect(result.ok, JSON.stringify(result.data)).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// The two Phase 9 evidence tools (ADR-097)
// -----------------------------------------------------------------------------------------------

describe('the analyst can reach the two ends of the evidence chain (ADR-096, ADR-097)', () => {
  it('walks one record to its import and the line of the file it came from', async () => {
    const { result, persisted } = await invoke(
      contextFor(ownerId, 'owner'), 'get_record_evidence',
      { record_type: 'ledger_entry', record_id: aLedgerEntryId },
    );
    expect(persisted.authorized).toBe(true);
    expect(result.ok, JSON.stringify(result.data)).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.counted, 'an accepted, unsuperseded row is inside the figures').toBe(true);
    expect(data.has_document).toBe(true);
    expect(data.document_id).toBe(ledgerDocumentId);
    expect((data.imported_by as { import_id: string } | null)?.import_id).toBeTruthy();

    // The amount is a branded envelope, not a bare number the model could restate its own way.
    expect(data.amount).toMatchObject({ unit: 'money' });
    // Imported text travels wrapped, so an instruction inside a description is data (§9).
    expect(JSON.stringify(data.where_in_file)).toMatch(/csv:row:/);
  });

  it('tells the analyst what rests on one file, in records and months', async () => {
    const { result } = await invoke(
      contextFor(ownerId, 'owner'), 'get_document_evidence', { document_id: ledgerDocumentId },
    );
    expect(result.ok, JSON.stringify(result.data)).toBe(true);
    const data = result.data as Record<string, unknown>;

    expect(data.records_in_figures).toMatchObject({ unit: 'count' });
    expect(data.contributed_to, 'the months are the reader’s labels, not ids').toContain('May 2026');
    expect(JSON.stringify(data), 'no table name reaches the model').not.toMatch(/ledger_entries/);
  });

  it('refuses a client the document tool, and gives them no filename from the record tool', async () => {
    const ctx = contextFor(clientUserId, 'client');

    const document = await invoke(ctx, 'get_document_evidence', { document_id: ledgerDocumentId });
    expect(document.result.ok).toBe(false);
    expect((document.result.data as { code: string }).code).toBe('PERMISSION_DENIED');
    expect(document.persisted.authorized, 'and it is recorded as an unauthorised attempt').toBe(false);
    expect(document.persisted.denial_reason).toBe('missing:documents.view');

    /*
     * The record tool IS open to a client — the row is theirs to see. What must not travel is the
     * file: §10 and CD-17 stop a client at the document, and the line reference is what lets them
     * ask an admin for the right thing.
     */
    const record = await invoke(ctx, 'get_record_evidence', { record_type: 'ledger_entry', record_id: aLedgerEntryId });
    expect(record.persisted.authorized).toBe(true);
    expect(record.result.ok).toBe(true);
    const data = record.result.data as Record<string, unknown>;
    expect(data.counted).toBe(true);
    expect(data.document_id, 'a client is not told which file it is').toBeNull();
    expect(JSON.stringify(data.document_filename)).not.toMatch(/gl\.csv/);
  });

  it('answers NOT FOUND for a record and a document of another organisation', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const invented = '00000000-0000-4000-8000-000000000000';

    const record = await invoke(ctx, 'get_record_evidence', { record_type: 'ledger_entry', record_id: invented });
    expect(record.result.ok).toBe(false);
    expect((record.result.data as { code: string }).code).toBe('NOT_FOUND');

    const document = await invoke(ctx, 'get_document_evidence', { document_id: invented });
    expect(document.result.ok).toBe(false);
    expect((document.result.data as { code: string }).code).toBe('NOT_FOUND');
  });

  it('refuses a record type the enum does not name, before any query runs', async () => {
    const { result } = await invoke(
      contextFor(ownerId, 'owner'), 'get_record_evidence',
      { record_type: 'ledger_entries', record_id: aLedgerEntryId },
    );
    expect(result.ok, 'a table name is not a record type').toBe(false);
    // Refused before any query runs; the code is the pipeline's, not this tool's invention.
    expect(['INVALID_INPUT', 'NOT_FOUND']).toContain((result.data as { code: string }).code);
  });
});

describe('what a tool returns is groundable (§3, §7.1, F-C-09)', () => {
  it('get_metric’s figure enters the allowed set with its snapshot id, metric key and period', async () => {
    const { result } = await invoke(contextFor(ownerId, 'owner'), 'get_metric', INPUTS.get_metric!());
    expect(result.ok, JSON.stringify(result.data)).toBe(true);
    const entries = allowedSet([result]);
    const value = entries.find((e) => e.path === 'value');
    expect(value, 'the headline value is a branded number at path "value"').toBeDefined();
    expect(value!.metricKey).toBe('revenue');
    expect(value!.unit).toBe('money');
    expect(value!.derivedEvidenceType).toBe('metric_snapshot');
    expect(value!.derivedEvidenceId).toBe(snapshotOf('revenue'));
    expect(value!.periodIds).toEqual([mayPeriodId]);
    // What the model is shown to quote is what the customer's screen shows.
    expect(value!.display).toMatch(/^£[\d,]+$/);
  });

  it('the ids a tool returned are exactly what the bundle may later cite (§14.2)', async () => {
    const { result, persisted } = await invoke(contextFor(ownerId, 'owner'), 'get_metric', INPUTS.get_metric!());
    expect(result.ok).toBe(true);
    expect(persisted.returned_ids).toContain(snapshotOf('revenue'));
    expect(persisted.output_hash).toMatch(/^[0-9a-f]{64}$/);
    // The summary names shapes and period labels, never a payload: strip the labels (a year is four
    // digits) and no figure the model could quote remains.
    const summaryText = JSON.stringify(persisted.output_summary).replace(/"[A-Z][a-z]+ \d{4}"/g, '""');
    expect(summaryText).not.toMatch(/\d{4,}/);
  });

  it('an imported name reaches the model wrapped, so a name containing a figure grounds nothing', async () => {
    await addCounterparty(orgId, 'REFUND 4,800 <script>');
    const { result } = await invoke(contextFor(ownerId, 'owner'), 'get_customer_profitability', INPUTS.get_customer_profitability!());
    // Whether or not the customer has revenue this month, nothing in the output may carry the raw
    // name, and the allowed set may not contain 4,800.
    const text = JSON.stringify(result.data);
    expect(text).not.toContain('<script>');
    const entries = allowedSet([result]);
    expect(entries.some((e) => e.value.toString() === '4800'), 'a figure inside a name is not groundable').toBe(false);
  });
});

describe('the boundaries a tool never crosses (§4)', () => {
  it('takes the organisation from the context, never from an argument the model adds', async () => {
    const stranger = await createAuthUser(`stranger@${DOMAIN}`);
    otherOrg = await makeOrg(stranger, `ITest Tools Other ${RUN}`);
    // The model tries to name our organisation while acting in the stranger's context.
    const { result } = await invoke(contextFor(stranger, 'owner', otherOrg), 'get_metric',
      { metric_key: 'revenue', period: MAY(), organization_id: orgId, orgSlug: 'x' });
    // Zod strips the foreign keys; the stranger's own org has no May figures, so: no data, not ours.
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toMatch(/NO_DATA|PERIOD_NOT_FOUND/);
    expect(JSON.stringify(result.data)).not.toContain(snapshotOf('revenue'));
  });

  it('rejects a descriptor-shaped input to get_transactions_for_evidence (F-C-02)', async () => {
    const { result, persisted } = await invoke(contextFor(ownerId, 'owner'), 'get_transactions_for_evidence',
      { query_descriptor: { v: 1, table: 'ledger_entries', filters: {} } });
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toBe('NOT_FOUND');
    expect(persisted.error).toMatch(/did not match|invalid|Invalid/i);
  });

  it('answers an unknown period label with PERIOD_NOT_FOUND, never the nearest month', async () => {
    const { result } = await invoke(contextFor(ownerId, 'owner'), 'get_metric', { metric_key: 'revenue', period: 'March 2019' });
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toBe('PERIOD_NOT_FOUND');
  });

  it('a foreign id yields NOT_FOUND, not a denial (SECURITY_MODEL.md §14)', async () => {
    const { result } = await invoke(contextFor(ownerId, 'owner'), 'get_evidence', INPUTS.get_evidence!());
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toBe('NOT_FOUND');
  });

  it('a demotion between two calls aborts the turn, and records why (F-C-17, ADR-032.8)', async () => {
    const owner = contextFor(ownerId, 'owner');
    const started = snapshotAccess(owner);
    // First call as the owner: fine.
    const first = await runTool({
      seq: 1, name: 'get_metric', rawInput: INPUTS.get_metric!(),
      resolveAccess: async () => owner, started,
      call: { periodContext, knownPeriods: [], now: new Date() },
    });
    expect(first.persisted.authorized).toBe(true);
    // Between calls the owner is demoted to client; the re-resolution sees it.
    const demoted = contextFor(ownerId, 'client');
    await expect(runTool({
      seq: 2, name: 'get_source_document_reference', rawInput: INPUTS.get_source_document_reference!(),
      resolveAccess: async () => demoted, started,
      call: { periodContext, knownPeriods: [], now: new Date() },
    })).rejects.toBeInstanceOf(ContextChanged);
  });
});

/**
 * A platform employee reaches an organisation's figures through the analyst only where assigned
 * (Phase 9 brief; RBAC_MATRIX.md §2.1, §3.5; AI_ARCHITECTURE.md §4; ADR-044.1).
 *
 * Two independent stops, and the test proves both because either alone would be a bad design. The
 * permission check answers "may this role call this tool at all"; RLS answers "and what may this
 * session see" — an unassigned employee passes the first and is stopped by the second, which is why
 * a tool that returned rows from `ctx.db` without RLS would leak a whole customer's ledger to any
 * member of staff who typed a question.
 */
describe('an employee reaches figures only where assigned (§4)', () => {
  let assignedEmployee: string;
  let unassignedEmployee: string;

  beforeAll(async () => {
    assignedEmployee = await createAuthUser(`assigned@${DOMAIN}`);
    unassignedEmployee = await createAuthUser(`unassigned@${DOMAIN}`);
    await addPlatformUser(assignedEmployee, 'employee');
    await addPlatformUser(unassignedEmployee, 'employee');
    await assign(orgId, assignedEmployee);
  });

  const employeeContext = (userId: string) => ({
    ...contextFor(userId, 'employee'),
    db: clientFor(userId, { email: `employee@${DOMAIN}` }),
  });

  it('the assigned employee reads the organisation’s figures', async () => {
    const { result, persisted } = await invoke(employeeContext(assignedEmployee), 'get_metric',
      { metric_key: 'revenue', period: MAY() });
    expect(persisted.authorized, 'an employee holds financials.view').toBe(true);
    expect(result.ok, JSON.stringify(result.data)).toBe(true);
    expect(JSON.stringify(result.data)).toContain('£25,000');
  });

  it('the unassigned employee is authorised by role and still gets no figures, because RLS decides', async () => {
    const { result, persisted } = await invoke(employeeContext(unassignedEmployee), 'get_metric',
      { metric_key: 'revenue', period: MAY() });
    // The permission check passes — the role holds financials.view — and the session still sees
    // nothing, so the tool answers honestly rather than with another organisation's figure.
    expect(persisted.authorized).toBe(true);
    expect(result.ok).toBe(false);
    expect((result.data as { code: string }).code).toMatch(/NO_DATA|PERIOD_NOT_FOUND/);
    expect(JSON.stringify(result.data)).not.toContain('25,000');
  });

  it('the source-document tool is refused to neither employee by role, and yields nothing unassigned', async () => {
    // An employee holds documents.view, so the denial is not the stop here — the assignment is.
    const assigned = await invoke(employeeContext(assignedEmployee), 'get_source_document_reference',
      { record_table: 'ledger_entries', record_id: '00000000-0000-4000-8000-000000000000' });
    expect(assigned.persisted.authorized).toBe(true);
    expect((assigned.result.data as { code: string }).code).toBe('NOT_FOUND');

    const unassigned = await invoke(employeeContext(unassignedEmployee), 'get_source_document_reference',
      { record_table: 'ledger_entries', record_id: '00000000-0000-4000-8000-000000000000' });
    expect(unassigned.persisted.authorized).toBe(true);
    expect((unassigned.result.data as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('every tool call is a persistable record (§4)', () => {
  it('carries sequence, name, input, an output hash and a shape summary — never the payload', async () => {
    const { persisted } = await invoke(contextFor(ownerId, 'owner'), 'get_business_summary', INPUTS.get_business_summary!(), 4);
    expect(persisted.sequence).toBe(4);
    expect(persisted.tool_name).toBe('get_business_summary');
    expect(persisted.input).toEqual({ period: MAY() });
    expect(typeof persisted.duration_ms).toBe('number');
    expect(persisted.output_summary).toMatchObject({ ok: true });
  });
});

export type { ToolResult };
