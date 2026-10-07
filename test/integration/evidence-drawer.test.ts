import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildMetricBundle, type MetricBundleItem } from '@/core/db';
import { NotFound, ValidationError } from '@/core/errors';
import { Decimal, toMoneyString } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import { drainJobs } from '@/modules/jobs';
import {
  buildBundleForMetric, getBundle, getDocumentReference, loadEvidenceDrawer, resolveDescriptor,
  resolveItem, type QueryDescriptorV1,
} from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, drainUntilFinished, sqlstate } from './setup';

/**
 * The evidence chain, end to end (TEST_STRATEGY.md §9; EVIDENCE_MODEL.md §6, §8, §9).
 *
 * Everything here runs against figures a REAL calculation run produced from real ledger entries,
 * driven through the queue — not hand-written snapshots. That matters more here than anywhere else
 * in the product: the whole claim of the evidence model is that the number on the screen and the
 * rows behind it are the same thing, and a fixture snapshot with a hand-written descriptor would
 * prove only that the test author can keep two hand-written things in agreement.
 *
 * Run-unique fixtures (ADR-052.12).
 */

const RUN = `e${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.evidence.itest`;

let ownerId: string;
let clientUserId: string;
let orgId: string;
let mayPeriodId: string;
let documentId: string;

const one = (sql: string): string => adminSql(`with q as (${sql}) select * from q`);

function accountId(category: string): string {
  return one(`
    select id from public.accounts
     where organization_id = '${orgId}' and standard_category = '${category}' and is_system`);
}

/** The context a page hands a service: the caller's own client, their real permission set. */
function contextFor(
  userId: string,
  role: 'owner' | 'client',
  org: string = orgId,
): AccessContext {
  return {
    userId,
    orgId: org,
    orgSlug: null,
    effectiveRole: role,
    permissions: permissionsFor(role),
    actorType: 'user',
    db: clientFor(userId, { email: `${role}@${DOMAIN}` }),
    requestId: `itest-${RUN}`,
    now: () => new Date('2026-06-15T00:00:00Z'),
    organizationStatus: 'active',
  };
}

function snapshotOf(metricKey: string): string {
  return one(`
    select c.snapshot_id::text from public.metric_current c
     where c.organization_id = '${orgId}' and c.period_id = '${mayPeriodId}'
       and c.metric_key = '${metricKey}' and c.dimension_type = 'none'`);
}

beforeAll(async () => {
  ownerId = createAuthUser(`owner@${DOMAIN}`);
  clientUserId = createAuthUser(`client@${DOMAIN}`);

  const created = await clientFor(ownerId).schema('api').rpc('create_organization', {
    p_name: `ITest Evidence ${RUN}`,
  });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;

  adminSql(`
    insert into public.organization_memberships (organization_id, user_id, role, status)
    values ('${orgId}', '${clientUserId}', 'client', 'active')`);

  mayPeriodId = one(`
    select id from public.fiscal_periods
     where organization_id = '${orgId}' and period_start = '2026-05-01'`);

  // A source document, so the record → document chain (level 4) has something real at the end.
  documentId = one(`
    insert into public.source_documents
           (organization_id, storage_path, original_filename, mime_type, byte_size, sha256,
            status, document_kind, page_count)
    values ('${orgId}', '${orgId}/evidence/gl.csv', 'gl.csv', 'text/csv', 10, decode('e5','hex'),
            'ready', 'general_ledger', null)
    returning id`);

  const batchId = one(`
    insert into public.import_batches
           (organization_id, source_document_id, import_type, target_table, status,
            extraction_method, period_start, period_end, committed_at)
    values ('${orgId}', '${documentId}', 'general_ledger', 'ledger_entries', 'committed',
            'csv', '2026-05-01', '2026-05-31', now())
    returning id`);

  const postTo = (
    account: string, direction: string, amount: string, day: string, line: number,
  ) => {
    const rowId = one(`
      insert into public.import_rows
             (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
      values ('${orgId}', '${batchId}', ${line}, 'csv:row:${line}', '{}'::jsonb, '{}'::jsonb, 'committed')
      returning id`);
    const entryId = one(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status,
              source_document_id, import_batch_id, import_row_id, source_ref)
      values ('${orgId}', '2026-05-${day}', '${account}', '${direction}', ${amount},
              '00000000-0000-0000-0000-000000000000', 'accepted',
              '${documentId}', '${batchId}', '${rowId}', 'csv:row:${line}')
      returning id`);
    /*
     * The `accepted` lifecycle event, exactly as `api.commit_import_batch` writes it.
     *
     * The resolver reconstructs what was visible at an instant from `record_status_events`, never
     * from the `record_status` column, because a rollback resets the column and the events are the
     * only record of what a past run actually saw (§3, ADR-047.1). A fixture that sets the column
     * and skips the event is therefore a row the ENGINE can see and the EVIDENCE cannot — which is
     * a state the product never reaches, and would make this suite prove nothing.
     */
    adminSql(`
      insert into public.record_status_events
             (organization_id, record_table, record_id, event, import_batch_id)
      values ('${orgId}', 'ledger_entries', '${entryId}', 'accepted', '${batchId}')`);
  };

  const post = (category: string, direction: string, amount: string, day: string, line: number) =>
    postTo(accountId(category), direction, amount, day, line);

  post('revenue', 'credit', '20000.00', '10', 2);
  post('revenue', 'credit', '5000.00', '18', 3);
  post('cost_of_sales', 'debit', '6000.00', '12', 4);
  post('payroll', 'debit', '5000.00', '25', 5);

  /*
   * The fixture asserts itself before the engine runs.
   *
   * Every figure below is a statement about these entries, so a suite that enqueued the
   * calculation without checking they were there would report a wrong TOTAL when what actually went
   * wrong was a missing ROW — which is exactly the shape of the confusing failure this replaces.
   */
  expect(one(`
    select count(*)::text from public.ledger_entries
     where organization_id = '${orgId}' and record_status = 'accepted'`),
  'every seeded entry is accepted before the engine sees anything').toBe('4');

  // `adminSql`, not `one()`: `one()` wraps in its own CTE, and a data-modifying WITH may not nest.
  const jobId = adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', 'calculation.run',
            '{"trigger":"recalc_manual","as_of":"2026-06-15"}'::jsonb, 3)
    returning id`).split('\n')[0]!.trim();

  // Waited on by ITS OWN row, not by a claim count: the queue is shared, and a fixed budget is a
  // bet that no other suite left work in it.
  expect(await drainUntilFinished(drainJobs, jobId),
    'the calculation this suite rests on must have run').toBe('succeeded');
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Evidence%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Evidence %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.evidence.itest' and created_at < now() - interval '1 hour';`);
});

/*
 * Asserted as an INVARIANT, not as a number.
 *
 * What this suite is about is "the rows behind a figure are that figure" — and pinning the
 * literal £25,000 made it a test of the engine's categorisation rules as well, which move for
 * reasons that have nothing to do with evidence. It read 20,000 in some runs and 25,000 in
 * others; both were the engine being consistent with itself about an account, and neither told
 * us anything about whether the drawer reconciles.
 */
const figureFor = (metricKey: string): string => one(`
  select s.value::text from public.metric_current c
    join public.metric_snapshots s
      on s.organization_id = c.organization_id and s.id = c.snapshot_id
   where c.organization_id = '${orgId}' and c.period_id = '${mayPeriodId}'
     and c.metric_key = '${metricKey}' and c.dimension_type = 'none'`);

/** NUMERIC(20,6) from psql to the two-decimal money string the resolver returns (ADR-006). */
const asMoney = (value: string): string => toMoneyString(new Decimal(value));

describe('every figure opens into the rows behind it (§9)', () => {
  it('the run wrote the figures this suite is about', () => {
    expect(figureFor('revenue'), 'revenue was computed').toMatch(/^\d+\.\d+$/);
    expect(figureFor('gross_profit'), 'and so was gross profit').toMatch(/^\d+\.\d+$/);
  });

  it('a leaf metric materialises a bundle of the snapshot, its run and one selection (§5)', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ctx, snapshotOf('revenue'));

    const bundle = await getBundle(ctx, bundleId);
    expect(bundle.kind).toBe('metric');
    expect(bundle.origin.table).toBe('metric_snapshots');
    expect(bundle.items.map((i) => i.itemType))
      .toEqual(['metric_snapshot', 'calculation_run', 'query']);
    expect(bundle.asOf, 'the as-of run is the context every item is read under').not.toBeNull();

    // §2.2: the label is server-generated from the referenced object, in the accountant's register.
    expect(bundle.items[0]!.label).toMatch(/^Revenue, /);
    expect(bundle.items[2]!.descriptorHash, 'a query item always carries its hash (§3)')
      .toMatch(/^[0-9a-f]{64}$/);
  });

  it('the selection reconciles to the figure it supports, to the cent (§9)', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const view = await loadEvidenceDrawer(ctx, await buildBundleForMetric(ctx, snapshotOf('revenue')));

    expect(view.records).toHaveLength(1);
    const block = view.records[0]!;
    expect(block.selection.count, 'both revenue entries').toBe(2);
    expect(block.selection.total, 'the rows total the figure they are the evidence for')
      .toBe(asMoney(figureFor('revenue')));
    expect(block.reconciles, 'the rows behind the number ARE the number').toBe(true);
  });

  it('resolving the same descriptor twice returns the same ids in the same order (§9)', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ctx, snapshotOf('revenue'));
    const item = (await getBundle(ctx, bundleId)).items.find((i) => i.itemType === 'query')!;

    const first = await resolveItem(ctx, item.id);
    const second = await resolveItem(ctx, item.id);
    expect(first.kind).toBe('query');
    if (first.kind !== 'query' || second.kind !== 'query') throw new Error('expected a selection');

    expect(second.selection.rows.map((r) => r.id)).toEqual(first.selection.rows.map((r) => r.id));
    expect(second.selection.total).toBe(first.selection.total);
  });

  it('materialising twice returns the same bundle, because bundles are immutable (§8.1)', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const snapshot = snapshotOf('revenue');
    expect(await buildBundleForMetric(ctx, snapshot)).toBe(await buildBundleForMetric(ctx, snapshot));

    expect(Number(one(`
      select count(*) from public.evidence_bundles
       where organization_id = '${orgId}' and kind = 'metric' and origin_id = '${snapshot}'`))).toBe(1);
  });
});

describe('a derived metric walks to leaves that each reconcile (F-C-15, §6 level 3)', () => {
  it('gross profit names its components, and each block reproduces its own figure', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const view = await loadEvidenceDrawer(ctx, await buildBundleForMetric(ctx, snapshotOf('gross_profit')));

    expect(view.metric?.metricKey).toBe('gross_profit');
    expect(new Decimal(view.metric!.value!).equals(new Decimal(figureFor('gross_profit'))),
      'the drawer shows the figure the run stored').toBe(true);

    expect(view.components.map((c) => c.name).sort()).toEqual(['cost_of_sales', 'revenue']);
    for (const component of view.components) {
      expect(component.leaf, `${component.name} descends straight to records`).toBe(true);
      expect(component.snapshotId).not.toBeNull();
    }

    // One reconciliation block per leaf, each openable to its rows (§6).
    const blocks = Object.fromEntries(view.records.map((r) => [r.forLabel, r]));
    expect(Object.keys(blocks).sort()).toEqual(['Cost of sales', 'Revenue']);
    expect(blocks.Revenue!.selection.total).toBe(asMoney(figureFor('revenue')));
    expect(blocks['Cost of sales']!.selection.total).toBe(asMoney(figureFor('cost_of_sales')));
    // The whole point: each leaf reconciles to its own figure, and together they make the derived
    // one — which is what a reader disputing gross profit is actually checking.
    for (const block of view.records) expect(block.reconciles).toBe(true);
  });

  /*
   * §6 level 3: "500 of 1,238 rows shown". Each block pages on its own, because a derived metric has
   * one selection per leaf and a single cursor applied to all of them would silently skip rows in
   * the ones it was not meant for. Asserted with an offset of one over a two-row selection rather
   * than by seeding five hundred rows: the property is that the cursor reaches exactly one block.
   */
  it('pages one component’s rows without moving another’s', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ctx, snapshotOf('gross_profit'));

    const whole = await loadEvidenceDrawer(ctx, bundleId);
    const revenue = whole.records.find((r) => r.forLabel === 'Revenue')!;
    const costs = whole.records.find((r) => r.forLabel === 'Cost of sales')!;
    expect(revenue.selection.count).toBe(2);

    const paged = await loadEvidenceDrawer(ctx, bundleId, {
      itemId: revenue.itemId, cursor: { offset: 1 },
    });
    const pagedRevenue = paged.records.find((r) => r.forLabel === 'Revenue')!;
    const pagedCosts = paged.records.find((r) => r.forLabel === 'Cost of sales')!;

    expect(pagedRevenue.selection.rows).toHaveLength(1);
    expect(pagedRevenue.selection.rows[0]!.id, 'the second row, not the first')
      .toBe(revenue.selection.rows[1]!.id);
    expect(pagedRevenue.offset).toBe(1);

    // The count and the total stay whole-selection, which is what lets a truncated list reconcile.
    expect(pagedRevenue.selection.count).toBe(2);
    expect(pagedRevenue.selection.total).toBe(revenue.selection.total);

    // And the other block has not moved.
    expect(pagedCosts.offset).toBe(0);
    expect(pagedCosts.selection.rows.map((r) => r.id))
      .toEqual(costs.selection.rows.map((r) => r.id));
  });
});

describe('as-of semantics survive what happens to the data afterwards (§8.7)', () => {
  it('a superseded record still resolves through the descriptor that was written before it', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ctx, snapshotOf('revenue'));
    const item = (await getBundle(ctx, bundleId)).items.find((i) => i.itemType === 'query')!;

    const before = await resolveItem(ctx, item.id);
    if (before.kind !== 'query') throw new Error('expected a selection');
    expect(before.selection.count).toBe(2);
    const publishedTotal = before.selection.total;

    // Supersede one of the two revenue entries with a correction, the way a re-import would.
    const supersededId = one(`
      select e.id::text from public.ledger_entries e
       join public.accounts a on a.id = e.account_id
      where e.organization_id = '${orgId}' and a.standard_category = 'revenue'
      order by e.amount desc limit 1`);
    const replacementId = one(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      select organization_id, entry_date, account_id, direction, 21000.00, period_id, 'accepted'
        from public.ledger_entries where id = '${supersededId}'
      returning id`);
    adminSql(`
      insert into public.record_status_events
             (organization_id, record_table, record_id, event)
      values ('${orgId}', 'ledger_entries', '${replacementId}', 'accepted')`);
    adminSql(`
      update public.ledger_entries
         set superseded_by = '${replacementId}', superseded_at = now()
       where organization_id = '${orgId}' and id = '${supersededId}'`);
    adminSql(`
      insert into public.record_status_events
             (organization_id, record_table, record_id, event, related_record_id)
      values ('${orgId}', 'ledger_entries', '${supersededId}', 'superseded', '${replacementId}')`);

    const after = await resolveItem(ctx, item.id);
    if (after.kind !== 'query') throw new Error('expected a selection');
    expect(after.selection.count, 'the run saw two rows and still sees those two').toBe(2);
    expect(after.selection.total, 'and still totals what it totalled').toBe(publishedTotal);
    expect(after.selection.rows.map((r) => r.id).sort())
      .toEqual(before.selection.rows.map((r) => r.id).sort());
  });
  /*
   * F-C-07, the rest of it (TEST_STRATEGY.md §9).
   *
   * "After remapping an account, overriding a bank category, superseding an invoice and rolling
   * back a batch, resolving the original descriptor with its `as_of` returns the original rows and
   * `total` equals the cited value to the cent." Supersession is covered above; these are the other
   * two the ledger fixture can reach. Each is a way the data can legitimately change AFTER a figure
   * was published, and the promise is that the figure's evidence does not change with it.
   */
  /*
   * Seeded HERE, after the calculation, and never in the shared fixture.
   *
   * An account the engine can see changes what the engine computes — an imported account's
   * contribution depends on whether it has been categorised, and putting one in the fixture made
   * the figure assertions above a test of the engine's mapping rules as well, which moved run to
   * run. This case needs an account and a row; it does not need the engine to have seen them.
   */
  it('survives the account behind it being re-categorised (F-C-07)', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const runId = one(`
      select id::text from public.calculation_runs
       where organization_id = '${orgId}' order by started_at desc limit 1`);

    const account = one(`
      insert into public.accounts
             (organization_id, code, name, standard_category, account_type, mapping_confidence)
      values ('${orgId}', '6100', 'Subscriptions', 'other_expense', 'expense', 'confirmed')
      returning id`);
    const entry = one(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status)
      values ('${orgId}', '2026-05-22', '${account}', 'debit', 750.00,
              '00000000-0000-0000-0000-000000000000', 'accepted')
      returning id`);
    adminSql(`
      insert into public.record_status_events (organization_id, record_table, record_id, event)
      values ('${orgId}', 'ledger_entries', '${entry}', 'accepted')`);

    const descriptor = {
      v: 1,
      table: 'ledger_entries',
      filters: { account_ids: [account] },
      as_of: { calculation_run_id: runId, aggregated_at: one("select to_json(now())#>>'{}'") },
      order: [{ field: 'entry_date', dir: 'asc' }, { field: 'id', dir: 'asc' }],
    } as QueryDescriptorV1;

    const before = await resolveDescriptor(ctx, descriptor);
    expect(before.count, 'the one entry on that account').toBe(1);
    expect(before.rows[0]!.standardCategory).toBe('other_expense');

    const { error } = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .schema('api').rpc('remap_account', { p_account: account, p_category: 'marketing' });
    expect(error, 'the remap itself must succeed, or the test proves nothing').toBeNull();
    expect(one(`select standard_category::text from public.accounts where id = '${account}'`))
      .toBe('marketing');

    const after = await resolveDescriptor(ctx, descriptor);
    // A descriptor names account IDS, never categories (ADR-034) — which is exactly why a remap
    // cannot move rows into or out of a published figure.
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id));
    expect(after.total).toBe(before.total);
    // And the category shown against the row is the one in force at the as-of instant, from
    // `account_category_history` — not the one the account carries today (§3).
    expect(after.rows[0]!.standardCategory, 'as-of, not current').toBe('other_expense');
  });

  it('survives the batch behind it being rolled back (F-C-07)', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const item = (await getBundle(ctx, await buildBundleForMetric(ctx, snapshotOf('revenue'))))
      .items.find((i) => i.itemType === 'query')!;

    const before = await resolveItem(ctx, item.id);
    if (before.kind !== 'query') throw new Error('expected a selection');

    const batch = one(`
      select b.id::text from public.import_batches b
       where b.organization_id = '${orgId}' and b.status = 'committed' limit 1`);
    const { error } = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .schema('api').rpc('rollback_import_batch', {
        p_batch: batch, p_reason: 'itest: the evidence must survive this',
      });
    expect(error).toBeNull();

    /*
     * The rows are `rejected` now and no future run will count them. The published figure still
     * resolves to exactly what it was computed from, because membership at an instant is read from
     * `record_status_events` and never from the current status (ADR-047.1) — otherwise "why did you
     * tell me revenue was £25,000 in May" would become unanswerable the moment somebody corrected
     * an import.
     */
    const after = await resolveItem(ctx, item.id);
    if (after.kind !== 'query') throw new Error('expected a selection');
    expect(after.selection.rows.map((r) => r.id)).toEqual(before.selection.rows.map((r) => r.id));
    expect(after.selection.total).toBe(before.selection.total);
    expect(one(`
      select count(*) from public.ledger_entries
       where organization_id = '${orgId}' and record_status = 'rejected'`))
      .not.toBe('0');
  });
});

/**
 * A bundle the METRIC builder did not write (EVIDENCE_MODEL.md §4, §5 alert row, §8.3).
 *
 * The drawer is one reader for every producer — alerts today, AI answers at Phase 11 — and every
 * suite here had exercised only the bundles `buildBundleForMetric` writes. Two defects lived in
 * that gap: an alert's comparison snapshot was rendered as a component of the arithmetic, and the
 * pinned records — the duplicate pair, the unusual payment, the overdue invoice a rule fired on —
 * were computed and then dropped. Pinned records are the whole reason §4 separates them from
 * descriptors: "the reader must see *that* row even if data later changes".
 */
/**
 * The health score's own bundle (EVIDENCE_MODEL.md §5, health-dimension row).
 *
 * The score is the most prominent number in the product and was the only figure with nothing behind
 * it: Phase 8 built the score and the explainability panel and never built the bundle §5 asks for.
 * A panel that prints its own arithmetic answers "how was this worked out"; a bundle answers "and
 * which figures were those", which is the question somebody disputing a score actually asks.
 */
describe('a health score carries the figures it was worked out from (§5)', () => {
  it('writes one bundle per score, holding the run and every snapshot a dimension used', async () => {
    const bundleId = one(`
      select b.id::text from public.evidence_bundles b
       join public.health_scores h
         on h.organization_id = b.organization_id and h.id = b.origin_id
      where b.organization_id = '${orgId}' and b.kind = 'health_score'
        and h.period_id = '${mayPeriodId}' limit 1`);
    expect(bundleId, 'the run wrote a health bundle').toMatch(/^[0-9a-f-]{36}$/);

    const view = await loadEvidenceDrawer(contextFor(ownerId, 'owner'), bundleId);
    expect(view.bundle.kind).toBe('health_score');
    expect(view.bundle.origin.table).toBe('health_scores');

    const types = view.bundle.items.map((i) => i.itemType);
    expect(types[0], 'the run is the as-of context every item is read under').toBe('calculation_run');
    expect(types.filter((t) => t === 'metric_snapshot').length,
      'every figure a dimension used is named').toBeGreaterThan(0);

    // §2.2: the label is generated from the object, in the accountant's register.
    const snapshot = view.bundle.items.find((i) => i.itemType === 'metric_snapshot')!;
    expect(snapshot.label).toMatch(/, May 2026/);
  });

  it('names each snapshot exactly once, however many dimensions used it', async () => {
    const bundleId = one(`
      select b.id::text from public.evidence_bundles b
       join public.health_scores h
         on h.organization_id = b.organization_id and h.id = b.origin_id
      where b.organization_id = '${orgId}' and b.kind = 'health_score'
        and h.period_id = '${mayPeriodId}' limit 1`);

    const view = await loadEvidenceDrawer(contextFor(ownerId, 'owner'), bundleId);
    const refs = view.bundle.items
      .filter((i) => i.itemType === 'metric_snapshot')
      .map((i) => i.ref!.id);
    expect(new Set(refs).size, 'a figure two dimensions share is one item, not two')
      .toBe(refs.length);
  });
});

describe('a bundle that pins specific rows (§4)', () => {
  let bundleId: string;
  let supersededEntry: string;

  beforeAll(() => {
    const trigger = snapshotOf('revenue');
    const comparison = snapshotOf('cost_of_sales');
    const runId = one(`
      select calculation_run_id::text from public.metric_snapshots where id = '${trigger}'`);

    // A row that has since been REPLACED, so §8.3's "still fetched, shown with its badge" is under
    // test rather than assumed. The as-of suite above superseded the larger revenue entry.
    supersededEntry = one(`
      select e.id::text from public.ledger_entries e
       where e.organization_id = '${orgId}' and e.superseded_by is not null limit 1`);

    // Exactly the shape `app.build_alert_bundle` writes: the figure it fired on, the figure it
    // compared against, the rows it pinned, and the aggregate behind them.
    bundleId = one(`
      insert into public.evidence_bundles
             (organization_id, kind, origin_table, calculation_run_id, created_by_type)
      values ('${orgId}', 'alert', 'alerts', '${runId}', 'system')
      returning id`);

    const item = (sort: number, type: string, ref: string | null, label: string) => adminSql(`
      insert into public.evidence_items
             (organization_id, bundle_id, sort_order, item_type, ref_id, label, assurance_level)
      values ('${orgId}', '${bundleId}', ${sort}, '${type}',
              ${ref === null ? 'null' : `'${ref}'`}, '${label}', 'verified')`);

    item(0, 'metric_snapshot', trigger, 'Revenue, May 2026');
    item(1, 'metric_snapshot', comparison, 'Cost of sales, May 2026');
    item(2, 'ledger_entry', supersededEntry, 'The entry this fired on');
  });

  it('does not present a cited figure as part of an arithmetic it was no part of', async () => {
    const view = await loadEvidenceDrawer(contextFor(ownerId, 'owner'), bundleId);

    expect(view.metric?.metricKey, 'the first snapshot is what the claim is about').toBe('revenue');
    /*
     * `revenue` is a LEAF: it declares no components at all. Anything under "how it was worked out"
     * would therefore be invented, and before this test the comparison snapshot went there.
     */
    expect(view.components, 'a leaf metric has no components').toEqual([]);
    expect(view.relatedFigures.map((f) => f.name)).toEqual(['cost_of_sales']);
  });

  it('shows the row the claim pins, and says it has been replaced since (§8.3)', async () => {
    const view = await loadEvidenceDrawer(contextFor(ownerId, 'owner'), bundleId);

    expect(view.pinned).toHaveLength(1);
    const record = view.pinned[0]!;
    expect(record.itemType).toBe('ledger_entry');
    expect(record.recordId).toBe(supersededEntry);
    expect(record.superseded, 'a pinned row is never filtered by status — it is badged').toBe(true);
    expect(record.canReachDocument, 'a ledger entry descends to the file it came from').toBe(true);
  });
});

/**
 * The bank half of F-C-07 (TEST_STRATEGY.md §9): "overriding a bank category".
 *
 * A bank descriptor can select BY category — the bank-basis P&L proxy does exactly that — so a
 * re-categorisation is the one change that can move a row into or out of a published selection.
 * §3 is explicit that the category in force at the as-of instant comes from `category_history`, and
 * this is the case that proves it: the same descriptor, before and after the override, must return
 * the same rows and the same total.
 */
describe('a published selection survives a bank row being re-categorised (F-C-07)', () => {
  let bankAccount: string;
  let marketingAccount: string;
  let payrollAccount: string;
  let movedTxn: string;
  let descriptor: QueryDescriptorV1;

  beforeAll(() => {
    bankAccount = one(`
      insert into public.bank_accounts
             (organization_id, name, account_type, bank_name, account_number_masked, is_active)
      values ('${orgId}', 'Current', 'current', 'Test Bank', '****4321', true)
      returning id`);
    marketingAccount = accountId('marketing');
    payrollAccount = accountId('payroll');

    const spend = (amount: string, day: string, category: string) => {
      const id = one(`
        insert into public.bank_transactions
               (organization_id, bank_account_id, transaction_date, amount, description_raw,
                category_account_id, category_source, record_status, period_id)
        values ('${orgId}', '${bankAccount}', '2026-05-${day}', ${amount}, 'CARD PAYMENT',
                '${category}', 'rule', 'accepted', '00000000-0000-0000-0000-000000000000')
        returning id`);
      adminSql(`
        insert into public.record_status_events (organization_id, record_table, record_id, event)
        values ('${orgId}', 'bank_transactions', '${id}', 'accepted')`);
      return id;
    };

    movedTxn = spend('-400.00', '06', marketingAccount);
    spend('-250.00', '14', marketingAccount);
    spend('-900.00', '21', payrollAccount);

    const runId = one(`
      select id::text from public.calculation_runs
       where organization_id = '${orgId}' order by started_at desc limit 1`);

    /*
     * The as-of instant comes from the DATABASE, not from Node.
     *
     * `record_status_events.occurred_at` and `category_history.valid_from` both default to the
     * database's `now()`. Taking the instant from the test process compares two clocks, and the
     * container's drifts far enough from the host's to land the as-of between the two rows it is
     * meant to see — which made this suite pass alone and fail in a full run, for a reason that has
     * nothing to do with what it tests.
     *
     * Serialised through `to_json`, which is ISO 8601 with an offset. `now()::text` is not: it is
     * "2026-09-06 18:05:12.34+00", which `new Date()` reads as LOCAL time and shifts by the host's
     * offset — five and a half hours, on this machine.
     */
    const aggregatedAt = one("select to_json(now())#>>'{}'");

    descriptor = {
      v: 1,
      table: 'bank_transactions',
      filters: { bank_account_ids: [bankAccount], category_account_ids: [marketingAccount] },
      as_of: { calculation_run_id: runId, aggregated_at: aggregatedAt },
      order: [{ field: 'transaction_date', dir: 'asc' }, { field: 'id', dir: 'asc' }],
    } as QueryDescriptorV1;
  });

  it('keeps the rows and the total the selection was published with', async () => {
    const ctx = contextFor(ownerId, 'owner');

    const before = await resolveDescriptor(ctx, descriptor);
    expect(before.count, 'the two marketing payments, and not the payroll one').toBe(2);
    expect(before.total).toBe('-650.00');

    // A reviewer decides one of them was really payroll. Every future figure changes; no published
    // one may.
    const { error } = await clientFor(ownerId, { email: `owner@${DOMAIN}` })
      .schema('api').rpc('override_bank_category', {
        p_txn: movedTxn, p_account: payrollAccount,
      });
    expect(error, 'the override itself must succeed, or the test proves nothing').toBeNull();
    expect(one(`
      select category_account_id::text from public.bank_transactions where id = '${movedTxn}'`))
      .toBe(payrollAccount);

    const after = await resolveDescriptor(ctx, descriptor);
    expect(after.rows.map((r) => r.id), 'the same rows, in the same order')
      .toEqual(before.rows.map((r) => r.id));
    expect(after.total, 'and the same total, to the cent').toBe(before.total);
  });

  /*
   * The other half of the same rule. §3: "Without `as_of` (user-facing filters only) the resolver
   * returns currently accepted, non-superseded rows" — so the SAME filters, asked as a question
   * about today rather than about a run, must see the change. If they did not, the history would be
   * winning arguments it was never meant to enter.
   */
  it('while the same filters asked about today do see the change', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const { as_of: _asOf, ...withoutAsOf } = descriptor;

    const current = await resolveDescriptor(ctx, withoutAsOf as QueryDescriptorV1);
    expect(current.count, 'one marketing payment left').toBe(1);
    expect(current.total).toBe('-250.00');
  });
});

describe('the permission stop at the document level (§9, §10, CD-17)', () => {
  it('a client reads statement, metric, calculation and records', async () => {
    const ctx = contextFor(clientUserId, 'client');
    const view = await loadEvidenceDrawer(ctx, await buildBundleForMetric(ctx, snapshotOf('revenue')));
    expect(view.metric?.metricKey).toBe('revenue');
    expect(view.records[0]!.selection.count).toBe(2);
  });

  it('and is told the document level is locked, rather than shown an empty panel', async () => {
    // Pinned by its source reference, not by category: the F-C-07 case above re-categorises an
    // account, and a test that selected by category would quietly follow it to a different row.
    const recordId = one(`
      select id::text from public.ledger_entries
       where organization_id = '${orgId}' and source_ref = 'csv:row:3'`);

    const asClient = await getDocumentReference(
      contextFor(clientUserId, 'client'), { table: 'ledger_entries', id: recordId },
    );
    // §10 / UX §376: the level is locked, and nothing about the file travels with the refusal.
    expect(asClient.locked).toBe(true);
    expect(asClient.filename).toBeNull();
    expect(asClient.documentId).toBeNull();
    expect(asClient.row, 'the line reference is kept, so they can ask for the right thing').toBe(3);

    const asOwner = await getDocumentReference(
      contextFor(ownerId, 'owner'), { table: 'ledger_entries', id: recordId },
    );
    expect(asOwner.locked).toBe(false);
    expect(asOwner.documentId).toBe(documentId);
    expect(asOwner.row, 'the line within the file, from the import row').toBe(3);
  });
});

/**
 * A platform employee reaches evidence only for the organisations assigned to them (Phase 8 brief;
 * RBAC_MATRIX.md §2.1, §3.5; SECURITY_MODEL.md §4; ADR-044.1).
 *
 * The bundle and its items are org-scoped rows read through `app.accessible_org_ids()`, so the stop
 * is the assignment itself rather than a rule written per table. Asserted because evidence is the
 * layer that makes a figure checkable, and an unassigned employee reading it would be a quiet
 * disclosure of a customer's records — the mistake ADR-082 found in the other direction, where a
 * policy locked out the employee who was supposed to look.
 */
describe('an employee reaches evidence only where assigned (§9)', () => {
  let assignedId: string;
  let unassignedId: string;
  let bundleId: string;

  const employeeContext = (userId: string): AccessContext => ({
    userId, orgId, orgSlug: null, effectiveRole: 'employee', permissions: permissionsFor('employee'),
    actorType: 'employee', db: clientFor(userId, { email: `employee@${DOMAIN}` }),
    requestId: `itest-${RUN}`, now: () => new Date('2026-06-15T00:00:00Z'), organizationStatus: 'active',
  });

  beforeAll(async () => {
    assignedId = createAuthUser(`assigned@${DOMAIN}`);
    unassignedId = createAuthUser(`unassigned@${DOMAIN}`);
    adminSql(`
      insert into public.platform_users (user_id, platform_role, status) values
        ('${assignedId}', 'employee', 'active'), ('${unassignedId}', 'employee', 'active');
      insert into public.organization_assignments (organization_id, employee_user_id, status)
      values ('${orgId}', '${assignedId}', 'active');`);
    bundleId = await buildBundleForMetric(contextFor(ownerId, 'owner'), snapshotOf('revenue'));
  });

  it('the assigned employee opens the bundle and descends to the records', async () => {
    const view = await loadEvidenceDrawer(employeeContext(assignedId), bundleId);
    expect(view.metric?.metricKey).toBe('revenue');
    expect(view.records[0]!.selection.count).toBeGreaterThan(0);
  });

  it('the unassigned employee is told NotFound, learning nothing about whether it exists (§14)', async () => {
    await expect(loadEvidenceDrawer(employeeContext(unassignedId), bundleId))
      .rejects.toBeInstanceOf(NotFound);

    // And nothing of the underlying rows either, addressed directly.
    const direct = await clientFor(unassignedId)
      .from('evidence_items').select('id').eq('bundle_id', bundleId);
    expect(direct.data ?? []).toHaveLength(0);
  });

  it('revoking the assignment closes it again', async () => {
    adminSql(`update public.organization_assignments set status = 'revoked'
               where organization_id = '${orgId}' and employee_user_id = '${assignedId}'`);
    await expect(loadEvidenceDrawer(employeeContext(assignedId), bundleId))
      .rejects.toBeInstanceOf(NotFound);
    adminSql(`update public.organization_assignments set status = 'active'
               where organization_id = '${orgId}' and employee_user_id = '${assignedId}'`);
  });
});

describe('a bundle belongs to exactly one organisation (§8.4, isolation case 3)', () => {
  it('another organisation’s context gets NotFound, not a permission error', async () => {
    const strangerId = createAuthUser(`stranger@${DOMAIN}`);
    const other = await clientFor(strangerId).schema('api').rpc('create_organization', {
      p_name: `ITest Evidence Other ${RUN}`,
    });
    const otherOrgId = other.data as unknown as string;

    const ownerCtx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ownerCtx, snapshotOf('revenue'));

    await expect(getBundle(contextFor(strangerId, 'owner', otherOrgId), bundleId))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('bundles cannot be rewritten after the fact (§8.8)', () => {
  it('UPDATE on an evidence item raises IMMUTABLE', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ctx, snapshotOf('revenue'));
    const itemId = one(`
      select id::text from public.evidence_items
       where organization_id = '${orgId}' and bundle_id = '${bundleId}' limit 1`);

    expect(() => adminSql(`
      update public.evidence_items set label = 'rewritten' where id = '${itemId}'`))
      .toThrow(/IMMUTABLE/);
  });

  it('and so does DELETE on the bundle', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ctx, snapshotOf('revenue'));
    expect(() => adminSql(`delete from public.evidence_bundles where id = '${bundleId}'`))
      .toThrow(/IMMUTABLE/);
  });

  /*
   * §8.8 lists `category_history` and `account_category_history` among the append-only tables, and
   * they do not carry `append_only_guard` — they carry `history_close_only`, which is the same
   * promise made precisely. A period of validity ENDS by writing `valid_to` on the row that is
   * ending, so a blanket UPDATE ban would make the history unwritable; the trigger allows that one
   * column, once, and refuses everything else including DELETE. Installing the blunt guard here
   * broke re-categorising an account, which is how this test came to exist.
   */
  it('the category history the resolver reads can be closed, and nothing more', () => {
    expect(Number(one(`
      select count(*) from pg_trigger
       where tgname = 'history_close_only'
         and tgrelid in ('public.category_history'::regclass,
                         'public.account_category_history'::regclass)`))).toBe(2);

    const row = one(`
      insert into public.account_category_history
             (organization_id, account_id, standard_category, valid_from)
      select '${orgId}', id, standard_category, now() from public.accounts
       where organization_id = '${orgId}' and standard_category = 'revenue' and is_system
      returning id`);
    expect(() => adminSql(`
      update public.account_category_history set standard_category = 'marketing'
       where id = '${row}'`)).toThrow(/IMMUTABLE/);
    expect(() => adminSql(`
      delete from public.account_category_history where id = '${row}'`)).toThrow(/IMMUTABLE/);

    // …and closing the interval, which is the one write the resolver's history depends on, works.
    adminSql(`
      update public.account_category_history set valid_to = now() where id = '${row}'`);
  });
});

describe('nobody can forge evidence (§8.5, ADR-066)', () => {
  /*
   * PRODUCTION_AUDIT.md C2, executed: with `api.build_metric_bundle` granted to `authenticated`, a
   * CLIENT attached a `query` item labelled "FABRICATED BY CLIENT", hostile claim text and a payroll
   * descriptor to the owner's revenue figure. It became THE bundle for that figure — system-attributed,
   * immutable, returned to the owner's next click, unaudited.
   *
   * The function is gone. What remains is `api_server.build_metric_bundle_as`, reachable only with
   * the service role, which re-derives the figure's evidence tree in SQL and refuses anything outside
   * it. These tests drive that function the way the server does — so they prove that even the
   * server-side list cannot carry what the snapshot does not itself say.
   */
  const asServer = (userId: string) => ({ userId, requestId: `itest-${RUN}` });
  const draft = (over: Partial<MetricBundleItem> & Pick<MetricBundleItem, 'item_type' | 'label'>): MetricBundleItem => ({
    ref_id: null, query_descriptor: null, descriptor_hash: null, assurance_level: 'verified', ...over,
  });
  const root = (key: string) => draft({ item_type: 'metric_snapshot', ref_id: snapshotOf(key), label: key });

  it('a user token has no bundle-writing function to call at all', async () => {
    const db = clientFor(clientUserId, { email: `client@${DOMAIN}` });
    const { error } = await db.schema('api').rpc('build_metric_bundle', {
      p_snapshot: snapshotOf('revenue'), p_items: [],
    });
    expect(error).not.toBeNull();
    // PostgREST: no such function in an exposed schema. Not 42501 — there is nothing to be denied.
    expect(error!.code).toBe('PGRST202');
  });

  /*
   * Each refusal targets a figure NOTHING ELSE in this file opens. The function returns an existing
   * bundle before it looks at the items — nothing is written, so there is nothing to validate — and
   * a refusal test aimed at a figure that already has a bundle would pass for the wrong reason.
   */
  it('refuses the audit’s poison: a descriptor that is not a leaf of the figure’s own tree', async () => {
    await expect(buildMetricBundle(asServer(clientUserId), {
      snapshotId: snapshotOf('cost_of_sales'),
      items: [
        root('cost_of_sales'),
        draft({
          item_type: 'query',
          label: 'FABRICATED BY CLIENT',
          query_descriptor: { v: 1, table: 'ledger_entries', filters: { category_account_ids: [accountId('payroll')] } },
          descriptor_hash: 'ab'.repeat(32),
        }),
      ],
    })).rejects.toThrow(/not a leaf of this figure/);
  });

  it('refuses claim text on a metric bundle: figures, not sentences', async () => {
    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: snapshotOf('operating_expenses'),
      items: [{ ...root('operating_expenses'), claim: 'Revenue was £1 and the owner is lying' } as MetricBundleItem],
    })).rejects.toThrow(/figures, not claims/);
  });

  it('refuses a snapshot that is not in the figure’s tree, a foreign run, and a foreign dimension', async () => {
    // net_profit is derived; closing_cash is a real figure that is no part of its tree.
    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: snapshotOf('net_profit'),
      items: [root('net_profit'), root('closing_cash')],
    })).rejects.toThrow(/not a snapshot in this figure/);

    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: snapshotOf('net_profit'),
      items: [root('net_profit'), draft({ item_type: 'calculation_run', ref_id: snapshotOf('net_profit'), label: 'run' })],
    })).rejects.toThrow(/not the run that produced/);

    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: snapshotOf('net_profit'),
      items: [root('net_profit'), draft({ item_type: 'account', ref_id: accountId('revenue'), label: 'acct' })],
    })).rejects.toThrow(/not the dimension/);
  });

  it('refuses an item type a metric bundle may not carry, and an empty bundle (§8.6)', async () => {
    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: snapshotOf('operating_profit'),
      items: [{ ...draft({ item_type: 'metric_snapshot', label: 'forged' }), item_type: 'alert' } as unknown as MetricBundleItem],
    })).rejects.toBeInstanceOf(ValidationError);

    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: snapshotOf('operating_profit'), items: [],
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('answers an actor with no standing in the organisation with NOT_FOUND, not a denial', async () => {
    const outsiderId = createAuthUser(`outsider@${DOMAIN}`);
    await expect(buildMetricBundle(asServer(outsiderId), {
      snapshotId: snapshotOf('revenue'), items: [root('revenue')],
    })).rejects.toBeInstanceOf(NotFound);
  });

  it('writes an audit event naming who materialised the bundle', async () => {
    const bundleId = await buildBundleForMetric(contextFor(ownerId, 'owner'), snapshotOf('gross_profit'));
    const actor = one(`
      select actor_user_id::text from public.audit_events
       where organization_id = '${orgId}' and action = 'evidence.bundle_built'
         and target_id = '${bundleId}'`);
    expect(actor).toBe(ownerId);
  });

  it('and no authenticated role can write the evidence tables directly (ADR-026)', async () => {
    const db = clientFor(ownerId, { email: `owner@${DOMAIN}` });
    const { error } = await db.from('evidence_bundles').insert({
      organization_id: orgId, kind: 'metric', origin_table: 'metric_snapshots',
    });
    expect(sqlstate(error)).toBe('42501');
  });
});
