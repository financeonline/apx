import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildMetricBundle, type MetricBundleItem } from '@/core/db';
import { NotFound, ValidationError } from '@/core/errors';
import { Decimal, toMoneyString } from '@/core/money';
import { permissionsFor } from '@/core/permissions';
import {
  buildBundleForMetric, getBundle, getDocumentReference, loadEvidenceDrawer, resolveDescriptor,
  resolveItem, type QueryDescriptorV1,
} from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { API_FUNCTIONS } from '@/db/api';
import { periodId } from '@/db/app/shared';
import { orgRows } from '@/db/rls';
import { newId, nowIso, orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, deleteOrg, drainUntilFinished, fs, rpc } from './setup';
import { assignEmployee, auditEvents, createOrgFixture, deletePlatformUser } from './r-fixtures';
import {
  accountFor, currentCells, currentSnapshot, deleteAuthUsers, deleteJobsOf, drainShared, dropQueuedRecalculation,
  queueCalculation, seedAccount,
  seedBankAccount, seedBankTransaction, seedBatch, seedDocument, seedImportRow, seedLedgerEntry, seedStatusEvent,
} from './evidence-fixtures';

/**
 * The evidence chain, end to end (TEST_STRATEGY.md §9; EVIDENCE_MODEL.md §6, §8, §9).
 *
 * Everything here runs against figures a REAL calculation run produced from real ledger entries,
 * driven through the queue — not hand-written snapshots. That matters more here than anywhere else
 * in the product: the whole claim of the evidence model is that the number on the screen and the
 * rows behind it are the same thing, and a fixture snapshot with a hand-written descriptor would
 * prove only that the test author can keep two hand-written things in agreement.
 *
 * Run-unique fixtures (ADR-052.12), written straight into Firestore (`evidence-fixtures.ts`).
 */

const RUN = `e${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.evidence.itest.motion`;

let ownerId: string;
let clientUserId: string;
let orgId: string;
let mayPeriodId: string;
let documentId: string;
const otherOrgs: string[] = [];
const platformUsers: string[] = [];

const accountId = (category: string): Promise<string> => accountFor(orgId, category);

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

async function snapshotOf(metricKey: string): Promise<string> {
  const cell = (await currentCells(orgId, mayPeriodId, metricKey))[0];
  return String(cell?.snapshot_id ?? '');
}

/** The latest calculation run of the organisation (`order by started_at desc limit 1`). */
async function latestRunId(): Promise<string> {
  const runs = (await orgCollection(fs(), orgId, 'calculation_runs').get()).docs.map((d) => d.data());
  runs.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
  return String(runs[0]?.id ?? '');
}

/** The health score bundle of May (`evidence_bundles` ⋈ `health_scores`). */
async function mayHealthBundle(): Promise<string> {
  const bundles = await orgCollection(fs(), orgId, 'evidence_bundles').where('kind', '==', 'health_score').get();
  for (const b of bundles.docs) {
    const h = await orgRow(fs(), orgId, 'health_scores', String(b.get('origin_id'))).get();
    if (h.exists && h.get('period_id') === mayPeriodId) return b.id;
  }
  return '';
}

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientUserId = await createAuthUser(`client@${DOMAIN}`);

  orgId = (await createOrgFixture({
    name: `ITest Evidence ${RUN}`, ownerId, members: [{ userId: clientUserId, role: 'client' }],
  })).id;
  mayPeriodId = periodId(orgId, '2026-05-01');

  // A source document, so the record → document chain (level 4) has something real at the end.
  documentId = await seedDocument(orgId, { name: 'gl.csv', kind: 'general_ledger' });

  const batchId = await seedBatch(orgId, {
    documentId, importType: 'general_ledger', targetTable: 'ledger_entries', status: 'committed',
    periodStart: '2026-05-01', periodEnd: '2026-05-31',
  });

  const postTo = async (
    account: string, direction: 'debit' | 'credit', amount: string, day: string, line: number,
  ) => {
    const rowId = await seedImportRow(orgId, { batchId, rowNumber: line, sourceRef: `csv:row:${line}` });
    const entryId = await seedLedgerEntry(orgId, {
      date: `2026-05-${day}`, accountId: account, direction, amount, status: 'accepted',
      documentId, batchId, importRowId: rowId, sourceRef: `csv:row:${line}`,
    });
    /*
     * The `accepted` lifecycle event, exactly as `api.commit_import_batch` writes it.
     *
     * The resolver reconstructs what was visible at an instant from `record_status_events`, never
     * from the `record_status` column, because a rollback resets the column and the events are the
     * only record of what a past run actually saw (§3, ADR-047.1). A fixture that sets the column
     * and skips the event is therefore a row the ENGINE can see and the EVIDENCE cannot — which is
     * a state the product never reaches, and would make this suite prove nothing.
     */
    await seedStatusEvent(orgId, { table: 'ledger_entries', recordId: entryId, event: 'accepted', batchId });
  };

  const post = async (category: string, direction: 'debit' | 'credit', amount: string, day: string, line: number) =>
    postTo(await accountId(category), direction, amount, day, line);

  await post('revenue', 'credit', '20000.00', '10', 2);
  await post('revenue', 'credit', '5000.00', '18', 3);
  await post('cost_of_sales', 'debit', '6000.00', '12', 4);
  await post('payroll', 'debit', '5000.00', '25', 5);

  /*
   * The fixture asserts itself before the engine runs.
   *
   * Every figure below is a statement about these entries, so a suite that enqueued the
   * calculation without checking they were there would report a wrong TOTAL when what actually went
   * wrong was a missing ROW — which is exactly the shape of the confusing failure this replaces.
   */
  const accepted = await orgCollection(fs(), orgId, 'ledger_entries').where('record_status', '==', 'accepted').get();
  expect(accepted.size, 'every seeded entry is accepted before the engine sees anything').toBe(4);

  const jobId = await queueCalculation(orgId, { trigger: 'recalc_manual', as_of: '2026-06-15' });

  // Waited on by ITS OWN row, not by a claim count: the queue is shared, and a fixed budget is a
  // bet that no other suite left work in it.
  expect(await drainUntilFinished(drainShared, jobId),
    'the calculation this suite rests on must have run').toBe('succeeded');
}, 300_000);

afterAll(async () => {
  for (const org of [orgId, ...otherOrgs]) {
    if (!org) continue;
    await deleteJobsOf(org);
    await deleteOrg(org);
  }
  for (const uid of platformUsers) await deletePlatformUser(uid);
  await deleteAuthUsers(DOMAIN);
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
const figureFor = async (metricKey: string): Promise<string> =>
  String((await currentSnapshot(orgId, mayPeriodId, metricKey))?.value ?? '');

/** The stored decimal string to the two-decimal money string the resolver returns (ADR-006). */
const asMoney = (value: string): string => toMoneyString(new Decimal(value));

describe('every figure opens into the rows behind it (§9)', () => {
  it('the run wrote the figures this suite is about', async () => {
    expect(await figureFor('revenue'), 'revenue was computed').toMatch(/^\d+\.\d+$/);
    expect(await figureFor('gross_profit'), 'and so was gross profit').toMatch(/^\d+\.\d+$/);
  });

  it('a leaf metric materialises a bundle of the snapshot, its run and one selection (§5)', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ctx, await snapshotOf('revenue'));

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
    const view = await loadEvidenceDrawer(ctx, await buildBundleForMetric(ctx, await snapshotOf('revenue')));

    expect(view.records).toHaveLength(1);
    const block = view.records[0]!;
    expect(block.selection.count, 'both revenue entries').toBe(2);
    expect(block.selection.total, 'the rows total the figure they are the evidence for')
      .toBe(asMoney(await figureFor('revenue')));
    expect(block.reconciles, 'the rows behind the number ARE the number').toBe(true);
  });

  it('resolving the same descriptor twice returns the same ids in the same order (§9)', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ctx, await snapshotOf('revenue'));
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
    const snapshot = await snapshotOf('revenue');
    expect(await buildBundleForMetric(ctx, snapshot)).toBe(await buildBundleForMetric(ctx, snapshot));

    const bundles = await orgCollection(fs(), orgId, 'evidence_bundles').where('kind', '==', 'metric')
      .where('origin_id', '==', snapshot).get();
    expect(bundles.size).toBe(1);
  });
});

describe('a derived metric walks to leaves that each reconcile (F-C-15, §6 level 3)', () => {
  it('gross profit names its components, and each block reproduces its own figure', async () => {
    const ctx = contextFor(ownerId, 'owner');
    const view = await loadEvidenceDrawer(ctx, await buildBundleForMetric(ctx, await snapshotOf('gross_profit')));

    expect(view.metric?.metricKey).toBe('gross_profit');
    expect(new Decimal(view.metric!.value!).equals(new Decimal(await figureFor('gross_profit'))),
      'the drawer shows the figure the run stored').toBe(true);

    expect(view.components.map((c) => c.name).sort()).toEqual(['cost_of_sales', 'revenue']);
    for (const component of view.components) {
      expect(component.leaf, `${component.name} descends straight to records`).toBe(true);
      expect(component.snapshotId).not.toBeNull();
    }

    // One reconciliation block per leaf, each openable to its rows (§6).
    const blocks = Object.fromEntries(view.records.map((r) => [r.forLabel, r]));
    expect(Object.keys(blocks).sort()).toEqual(['Cost of sales', 'Revenue']);
    expect(blocks.Revenue!.selection.total).toBe(asMoney(await figureFor('revenue')));
    expect(blocks['Cost of sales']!.selection.total).toBe(asMoney(await figureFor('cost_of_sales')));
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
    const bundleId = await buildBundleForMetric(ctx, await snapshotOf('gross_profit'));

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
    const bundleId = await buildBundleForMetric(ctx, await snapshotOf('revenue'));
    const item = (await getBundle(ctx, bundleId)).items.find((i) => i.itemType === 'query')!;

    const before = await resolveItem(ctx, item.id);
    if (before.kind !== 'query') throw new Error('expected a selection');
    expect(before.selection.count).toBe(2);
    const publishedTotal = before.selection.total;

    // Supersede one of the two revenue entries with a correction, the way a re-import would.
    const revenueAccounts = new Set((await orgCollection(fs(), orgId, 'accounts')
      .where('standard_category', '==', 'revenue').get()).docs.map((d) => d.id));
    const revenueEntries = (await orgCollection(fs(), orgId, 'ledger_entries').get()).docs
      .map((d) => d.data()).filter((e) => revenueAccounts.has(String(e.account_id)))
      .sort((a, b) => new Decimal(String(b.amount)).comparedTo(new Decimal(String(a.amount))));
    const superseded = revenueEntries[0]!;
    const supersededId = String(superseded.id);
    const replacementId = await seedLedgerEntry(orgId, {
      date: String(superseded.entry_date), accountId: String(superseded.account_id),
      direction: superseded.direction as 'debit' | 'credit', amount: '21000.00', status: 'accepted',
    });
    await seedStatusEvent(orgId, { table: 'ledger_entries', recordId: replacementId, event: 'accepted' });
    await orgRow(fs(), orgId, 'ledger_entries', supersededId)
      .update({ superseded_by: replacementId, superseded_at: nowIso() });
    await seedStatusEvent(orgId, {
      table: 'ledger_entries', recordId: supersededId, event: 'superseded', relatedId: replacementId,
    });

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
    const runId = await latestRunId();

    const account = await seedAccount(orgId, {
      code: '6100', name: 'Subscriptions', category: 'other_expense', accountType: 'expense',
    });
    const entry = await seedLedgerEntry(orgId, {
      date: '2026-05-22', accountId: account, direction: 'debit', amount: '750.00', status: 'accepted',
    });
    await seedStatusEvent(orgId, { table: 'ledger_entries', recordId: entry, event: 'accepted' });

    const descriptor = {
      v: 1,
      table: 'ledger_entries',
      filters: { account_ids: [account] },
      as_of: { calculation_run_id: runId, aggregated_at: nowIso() },
      order: [{ field: 'entry_date', dir: 'asc' }, { field: 'id', dir: 'asc' }],
    } as QueryDescriptorV1;

    const before = await resolveDescriptor(ctx, descriptor);
    expect(before.count, 'the one entry on that account').toBe(1);
    expect(before.rows[0]!.standardCategory).toBe('other_expense');

    const { error } = await rpc(clientFor(ownerId, { email: `owner@${DOMAIN}` }),
      'remap_account', { p_account: account, p_category: 'marketing' });
    expect(error, 'the remap itself must succeed, or the test proves nothing').toBeNull();
    await dropQueuedRecalculation(orgId);
    expect((await orgRow(fs(), orgId, 'accounts', account).get()).get('standard_category'))
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
    const item = (await getBundle(ctx, await buildBundleForMetric(ctx, await snapshotOf('revenue'))))
      .items.find((i) => i.itemType === 'query')!;

    const before = await resolveItem(ctx, item.id);
    if (before.kind !== 'query') throw new Error('expected a selection');

    const batch = (await orgCollection(fs(), orgId, 'import_batches').where('status', '==', 'committed')
      .limit(1).get()).docs[0]!.id;
    const { error } = await rpc(clientFor(ownerId, { email: `owner@${DOMAIN}` }), 'rollback_import_batch', {
      p_batch: batch, p_reason: 'itest: the evidence must survive this',
    });
    expect(error).toBeNull();
    await dropQueuedRecalculation(orgId);

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
    expect((await orgCollection(fs(), orgId, 'ledger_entries').where('record_status', '==', 'rejected').get()).size)
      .not.toBe(0);
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
    const bundleId = await mayHealthBundle();
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
    const bundleId = await mayHealthBundle();

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

  beforeAll(async () => {
    const trigger = await snapshotOf('revenue');
    const comparison = await snapshotOf('cost_of_sales');
    const runId = String((await orgRow(fs(), orgId, 'metric_snapshots', trigger).get()).get('calculation_run_id'));

    // A row that has since been REPLACED, so §8.3's "still fetched, shown with its badge" is under
    // test rather than assumed. The as-of suite above superseded the larger revenue entry.
    supersededEntry = (await orgCollection(fs(), orgId, 'ledger_entries').get()).docs
      .find((d) => d.get('superseded_by') !== null && d.get('superseded_by') !== undefined)!.id;

    // Exactly the shape `app.build_alert_bundle` writes: the figure it fired on, the figure it
    // compared against, the rows it pinned, and the aggregate behind them.
    bundleId = newId();
    await orgRow(fs(), orgId, 'evidence_bundles', bundleId).set({
      id: bundleId, organization_id: orgId, kind: 'alert', origin_table: 'alerts', origin_id: null,
      calculation_run_id: runId, created_by_type: 'system', created_by: null, origin_message_id: null,
      created_at: nowIso(),
    });

    const item = (sort: number, type: string, ref: string | null, label: string) => {
      const id = newId();
      return orgRow(fs(), orgId, 'evidence_items', id).set({
        id, organization_id: orgId, bundle_id: bundleId, sort_order: sort, item_type: type, ref_id: ref,
        ref_revision_no: null, query_descriptor: null, descriptor_hash: null, label, claim: null,
        assurance_level: 'verified', created_at: nowIso(),
      });
    };

    await item(0, 'metric_snapshot', trigger, 'Revenue, May 2026');
    await item(1, 'metric_snapshot', comparison, 'Cost of sales, May 2026');
    await item(2, 'ledger_entry', supersededEntry, 'The entry this fired on');
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

  beforeAll(async () => {
    bankAccount = await seedBankAccount(orgId, { name: 'Current', accountType: 'current' });
    marketingAccount = await accountId('marketing');
    payrollAccount = await accountId('payroll');

    const spend = async (amount: string, day: string, category: string) => {
      const id = await seedBankTransaction(orgId, {
        bankAccountId: bankAccount, date: `2026-05-${day}`, amount, description: 'CARD PAYMENT',
        categoryAccountId: category, categorySource: 'rule', status: 'accepted',
      });
      await seedStatusEvent(orgId, { table: 'bank_transactions', recordId: id, event: 'accepted' });
      return id;
    };

    movedTxn = await spend('-400.00', '06', marketingAccount);
    await spend('-250.00', '14', marketingAccount);
    await spend('-900.00', '21', payrollAccount);

    const runId = await latestRunId();

    /*
     * The as-of instant is taken after the rows' own timestamps. On PostgreSQL it had to come from
     * the database's clock (the container drifted from the host); on Firestore every timestamp is
     * written by this process with `nowIso()`, so there is one clock and the instant is simply now.
     */
    const aggregatedAt = nowIso();

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
    const { error } = await rpc(clientFor(ownerId, { email: `owner@${DOMAIN}` }), 'override_bank_category', {
      p_txn: movedTxn, p_account: payrollAccount,
    });
    expect(error, 'the override itself must succeed, or the test proves nothing').toBeNull();
    await dropQueuedRecalculation(orgId);
    expect((await orgRow(fs(), orgId, 'bank_transactions', movedTxn).get()).get('category_account_id'))
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
    const view = await loadEvidenceDrawer(ctx, await buildBundleForMetric(ctx, await snapshotOf('revenue')));
    expect(view.metric?.metricKey).toBe('revenue');
    expect(view.records[0]!.selection.count).toBe(2);
  });

  it('and is told the document level is locked, rather than shown an empty panel', async () => {
    // Pinned by its source reference, not by category: the F-C-07 case above re-categorises an
    // account, and a test that selected by category would quietly follow it to a different row.
    const recordId = (await orgCollection(fs(), orgId, 'ledger_entries').where('source_ref', '==', 'csv:row:3')
      .get()).docs[0]!.id;

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
    assignedId = await createAuthUser(`assigned@${DOMAIN}`);
    unassignedId = await createAuthUser(`unassigned@${DOMAIN}`);
    platformUsers.push(assignedId, unassignedId);
    await assignEmployee(orgId, assignedId);
    // A platform employee, active, with no assignment here.
    await fs().collection('platform_users').doc(unassignedId).set({
      user_id: unassignedId, platform_role: 'employee', status: 'active', granted_by: null, notes: null,
      created_at: nowIso(), updated_at: nowIso(),
    });
    bundleId = await buildBundleForMetric(contextFor(ownerId, 'owner'), await snapshotOf('revenue'));
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
    const direct = await orgRows(clientFor(unassignedId), orgId, 'evidence_items', (q) => q.where('bundle_id', '==', bundleId));
    expect(direct).toHaveLength(0);
  });

  it('revoking the assignment closes it again', async () => {
    const assignment = orgRow(fs(), orgId, 'organization_assignments', assignedId);
    await assignment.update({ status: 'revoked' });
    await expect(loadEvidenceDrawer(employeeContext(assignedId), bundleId))
      .rejects.toBeInstanceOf(NotFound);
    await assignment.update({ status: 'active' });
  });
});

describe('a bundle belongs to exactly one organisation (§8.4, isolation case 3)', () => {
  it('another organisation’s context gets NotFound, not a permission error', async () => {
    const strangerId = await createAuthUser(`stranger@${DOMAIN}`);
    const otherOrgId = (await createOrgFixture({ name: `ITest Evidence Other ${RUN}`, ownerId: strangerId })).id;
    otherOrgs.push(otherOrgId);

    const ownerCtx = contextFor(ownerId, 'owner');
    const bundleId = await buildBundleForMetric(ownerCtx, await snapshotOf('revenue'));

    await expect(getBundle(contextFor(strangerId, 'owner', otherOrgId), bundleId))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/*
 * §8.8 (bundles cannot be rewritten after the fact). On PostgreSQL this was proved by the
 * `append_only_guard` and `history_close_only` TRIGGERS refusing an UPDATE or DELETE from the admin
 * connection. Firestore has no triggers: the browser can reach no document at all
 * (`firebase/firestore.rules` denies everything), and immutability is that NO `api.*` function
 * offers the mutation (FIRESTORE_DATA_MODEL.md §4). The assertion that remains true and checkable is
 * the second half — see "nobody can forge evidence" below: there is no evidence-writing surface.
 */

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
  const root = async (key: string) => draft({ item_type: 'metric_snapshot', ref_id: await snapshotOf(key), label: key });

  it('a user token has no bundle-writing function to call at all', async () => {
    // No such function among the `api.*` a user can reach. Not 42501 — there is nothing to be denied.
    expect(API_FUNCTIONS.build_metric_bundle).toBeUndefined();
    expect(Object.keys(API_FUNCTIONS).filter((name) => /bundle|evidence/.test(name)),
      'no user-callable function writes evidence').toEqual([]);
    await expect(rpc(clientFor(clientUserId, { email: `client@${DOMAIN}` }), 'build_metric_bundle', {
      p_snapshot: await snapshotOf('revenue'), p_items: [],
    })).rejects.toThrow(/not defined/);
  });

  /*
   * Each refusal targets a figure NOTHING ELSE in this file opens. The function returns an existing
   * bundle before it looks at the items — nothing is written, so there is nothing to validate — and
   * a refusal test aimed at a figure that already has a bundle would pass for the wrong reason.
   */
  it('refuses the audit’s poison: a descriptor that is not a leaf of the figure’s own tree', async () => {
    await expect(buildMetricBundle(asServer(clientUserId), {
      snapshotId: await snapshotOf('cost_of_sales'),
      items: [
        await root('cost_of_sales'),
        draft({
          item_type: 'query',
          label: 'FABRICATED BY CLIENT',
          query_descriptor: { v: 1, table: 'ledger_entries', filters: { category_account_ids: [await accountId('payroll')] } },
          descriptor_hash: 'ab'.repeat(32),
        }),
      ],
    })).rejects.toThrow(/not a leaf of this figure/);
  });

  it('refuses claim text on a metric bundle: figures, not sentences', async () => {
    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: await snapshotOf('operating_expenses'),
      items: [{ ...(await root('operating_expenses')), claim: 'Revenue was £1 and the owner is lying' } as MetricBundleItem],
    })).rejects.toThrow(/figures, not claims/);
  });

  it('refuses a snapshot that is not in the figure’s tree, a foreign run, and a foreign dimension', async () => {
    // net_profit is derived; closing_cash is a real figure that is no part of its tree.
    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: await snapshotOf('net_profit'),
      items: [await root('net_profit'), await root('closing_cash')],
    })).rejects.toThrow(/not a snapshot in this figure/);

    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: await snapshotOf('net_profit'),
      items: [await root('net_profit'), draft({ item_type: 'calculation_run', ref_id: await snapshotOf('net_profit'), label: 'run' })],
    })).rejects.toThrow(/not the run that produced/);

    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: await snapshotOf('net_profit'),
      items: [await root('net_profit'), draft({ item_type: 'account', ref_id: await accountId('revenue'), label: 'acct' })],
    })).rejects.toThrow(/not the dimension/);
  });

  it('refuses an item type a metric bundle may not carry, and an empty bundle (§8.6)', async () => {
    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: await snapshotOf('operating_profit'),
      items: [{ ...draft({ item_type: 'metric_snapshot', label: 'forged' }), item_type: 'alert' } as unknown as MetricBundleItem],
    })).rejects.toBeInstanceOf(ValidationError);

    await expect(buildMetricBundle(asServer(ownerId), {
      snapshotId: await snapshotOf('operating_profit'), items: [],
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('answers an actor with no standing in the organisation with NOT_FOUND, not a denial', async () => {
    const outsiderId = await createAuthUser(`outsider@${DOMAIN}`);
    await expect(buildMetricBundle(asServer(outsiderId), {
      snapshotId: await snapshotOf('revenue'), items: [await root('revenue')],
    })).rejects.toBeInstanceOf(NotFound);
  });

  it('writes an audit event naming who materialised the bundle', async () => {
    const bundleId = await buildBundleForMetric(contextFor(ownerId, 'owner'), await snapshotOf('gross_profit'));
    const events = (await auditEvents(orgId, 'evidence.bundle_built')).filter((e) => e.target_id === bundleId);
    expect(events.map((e) => e.actor_user_id)).toEqual([ownerId]);
  });
});
