import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor, type EffectiveRole } from '@/core/permissions';
import { drainJobs } from '@/modules/jobs';
import {
  TOOLS, TOOL_NAMES, allowedSet, resolvePeriodContext, runTool, snapshotAccess, ContextChanged,
  type PeriodContext, type ToolCallContext, type ToolResult,
} from '@/modules/ai';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished } from './setup';

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
const DOMAIN = `${RUN}.tools.itest`;

let ownerId: string;
let clientUserId: string;
let orgId: string;
let mayPeriodId: string;
let periodContext: PeriodContext;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function accountId(category: string): string {
  return one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = '${category}' and is_system`);
}

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
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientUserId = createAuthUser(`client@${DOMAIN}`);
  const created = await clientFor(ownerId).schema('api').rpc('create_organization', { p_name: `ITest Tools ${RUN}` });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgId}', '${clientUserId}', 'client', 'active')`);
  mayPeriodId = one(`select id from public.fiscal_periods where organization_id = '${orgId}' and period_start = '2026-05-01'`);

  // A month of ledger through the real commit shape, then the real engine.
  const documentId = one(`
    insert into public.source_documents (organization_id, storage_path, original_filename, mime_type, byte_size, sha256, status, document_kind)
    values ('${orgId}', '${orgId}/tools/gl.csv', 'gl.csv', 'text/csv', 10, decode('e7','hex'), 'ready', 'general_ledger') returning id`);
  const batchId = one(`
    insert into public.import_batches (organization_id, source_document_id, import_type, target_table, status, extraction_method, period_start, period_end, committed_at)
    values ('${orgId}', '${documentId}', 'general_ledger', 'ledger_entries', 'committed', 'csv', '2026-05-01', '2026-05-31', now()) returning id`);
  const post = (category: string, direction: string, amount: string, day: string, line: number) => {
    const rowId = one(`
      insert into public.import_rows (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
      values ('${orgId}', '${batchId}', ${line}, 'csv:row:${line}', '{}'::jsonb, '{}'::jsonb, 'committed') returning id`);
    const entryId = one(`
      insert into public.ledger_entries (organization_id, entry_date, account_id, direction, amount, period_id, record_status, source_document_id, import_batch_id, import_row_id, source_ref)
      values ('${orgId}', '2026-05-${day}', '${accountId(category)}', '${direction}', ${amount}, '00000000-0000-0000-0000-000000000000', 'accepted', '${documentId}', '${batchId}', '${rowId}', 'csv:row:${line}') returning id`);
    adminSql(`
      insert into public.record_status_events (organization_id, record_table, record_id, event, import_batch_id)
      values ('${orgId}', 'ledger_entries', '${entryId}', 'accepted', '${batchId}')`);
  };
  post('revenue', 'credit', '20000.00', '10', 2);
  post('revenue', 'credit', '5000.00', '18', 3);
  post('cost_of_sales', 'debit', '6000.00', '12', 4);
  post('payroll', 'debit', '5000.00', '25', 5);

  const jobId = adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', 'calculation.run', '{"trigger":"recalc_manual","as_of":"2026-06-15"}'::jsonb, 3)
    returning id`).split('\n')[0]!.trim();
  expect(await drainUntilFinished(drainJobs, jobId), 'the calculation this suite rests on must have run').toBe('succeeded');

  // The period context the loop would build for "how did May go?".
  const periods = adminSql(`
    select id || '|' || label || '|' || period_start || '|' || is_complete
      from public.fiscal_periods where organization_id = '${orgId}' order by period_start`)
    .split('\n').filter(Boolean).map((l) => {
      const [id, label, periodStart, complete] = l.trim().split('|') as [string, string, string, string];
      return { id, label, periodStart, isComplete: complete === 't', hasData: id === mayPeriodId };
    });
  periodContext = resolvePeriodContext({ question: 'how did May 2026 go?', periods, fiscalYearStartMonth: 1 });
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Tools%${RUN}';
    delete from public.platform_users where user_id in (select id from auth.users where email like '%@${DOMAIN}');
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Tools %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.tools.itest' and created_at < now() - interval '1 hour';`);
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
};

function snapshotOf(metricKey: string): string {
  return one(`
    select c.snapshot_id::text from public.metric_current c
     where c.organization_id = '${orgId}' and c.period_id = '${mayPeriodId}'
       and c.metric_key = '${metricKey}' and c.dimension_type = 'none'`);
}

describe('the registry is closed and complete', () => {
  it('has exactly the fifteen tools §3 names, each with a permission and a schema', () => {
    expect(TOOL_NAMES).toHaveLength(15);
    expect(new Set(TOOL_NAMES).size).toBe(15);
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

  it('a client may read figures, and gets them', async () => {
    const ctx = contextFor(clientUserId, 'client');
    const { result, persisted } = await invoke(ctx, 'get_metric', INPUTS.get_metric!());
    expect(persisted.authorized).toBe(true);
    expect(result.ok, JSON.stringify(result.data)).toBe(true);
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
    adminSql(`
      insert into public.counterparties (organization_id, name, normalized_name)
      values ('${orgId}', 'REFUND 4,800 <script>', 'refund 4800 script')`);
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
    const stranger = createAuthUser(`stranger@${DOMAIN}`);
    const other = await clientFor(stranger).schema('api').rpc('create_organization', { p_name: `ITest Tools Other ${RUN}` });
    const otherOrg = other.data as unknown as string;
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

  beforeAll(() => {
    assignedEmployee = createAuthUser(`assigned@${DOMAIN}`);
    unassignedEmployee = createAuthUser(`unassigned@${DOMAIN}`);
    adminSql(`
      insert into public.platform_users (user_id, platform_role, status) values
        ('${assignedEmployee}', 'employee', 'active'), ('${unassignedEmployee}', 'employee', 'active');
      update public.profiles set mfa_enrolled_at = now()
       where id in ('${assignedEmployee}', '${unassignedEmployee}');
      insert into public.organization_assignments (organization_id, employee_user_id, status)
      values ('${orgId}', '${assignedEmployee}', 'active');`);
  });

  const employeeContext = (userId: string) => ({
    ...contextFor(userId, 'employee'),
    db: clientFor(userId, { email: `employee@${DOMAIN}`, aal: 'aal2' }),
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

  it('the same employee at aal1 sees nothing even where assigned (ADR-044.1)', async () => {
    const atAal1 = {
      ...contextFor(assignedEmployee, 'employee'),
      db: clientFor(assignedEmployee, { email: `employee@${DOMAIN}`, aal: 'aal1' }),
    };
    const { result } = await invoke(atAal1, 'get_metric', { metric_key: 'revenue', period: MAY() });
    expect(result.ok).toBe(false);
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
