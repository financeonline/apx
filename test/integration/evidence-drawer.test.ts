import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { permissionsFor } from '@/core/permissions';
import { drainJobs } from '@/modules/jobs';
import {
  buildBundleForMetric, getBundle, getDocumentReference, loadEvidenceDrawer, resolveItem,
} from '@/modules/evidence';
import type { AccessContext } from '@/modules/tenancy';
import { adminSql, clientFor, createAuthUser, sqlstate } from './setup';

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

  const post = (category: string, direction: string, amount: string, day: string, line: number) => {
    const rowId = one(`
      insert into public.import_rows
             (organization_id, batch_id, row_number, source_ref, raw_data, mapped_data, status)
      values ('${orgId}', '${batchId}', ${line}, 'csv:row:${line}', '{}'::jsonb, '{}'::jsonb, 'committed')
      returning id`);
    const entryId = one(`
      insert into public.ledger_entries
             (organization_id, entry_date, account_id, direction, amount, period_id, record_status,
              source_document_id, import_batch_id, import_row_id, source_ref)
      values ('${orgId}', '2026-05-${day}', '${accountId(category)}', '${direction}', ${amount},
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

  post('revenue', 'credit', '20000.00', '10', 2);
  post('revenue', 'credit', '5000.00', '18', 3);
  post('cost_of_sales', 'debit', '6000.00', '12', 4);
  post('payroll', 'debit', '5000.00', '25', 5);

  adminSql(`
    insert into public.jobs (organization_id, job_type, payload, max_attempts)
    values ('${orgId}', 'calculation.run',
            '{"trigger":"recalc_manual","as_of":"2026-06-15"}'::jsonb, 3)`);
  await drainJobs(6);
});

afterAll(() => {
  adminSql(`
    delete from public.organizations where name like 'ITest Evidence%${RUN}';
    delete from auth.users where email like '%@${DOMAIN}';
    delete from public.organizations where name like 'ITest Evidence %' and created_at < now() - interval '1 hour';
    delete from auth.users where email like '%.evidence.itest' and created_at < now() - interval '1 hour';`);
});

describe('every figure opens into the rows behind it (§9)', () => {
  it('the run wrote the figures this suite is about', () => {
    expect(one(`
      select s.value::text from public.metric_current c
        join public.metric_snapshots s
          on s.organization_id = c.organization_id and s.id = c.snapshot_id
       where c.organization_id = '${orgId}' and c.period_id = '${mayPeriodId}'
         and c.metric_key = 'revenue' and c.dimension_type = 'none'`)).toBe('25000.000000');
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

    expect(view.metric?.value).toBe('25000');
    expect(view.records).toHaveLength(1);
    const block = view.records[0]!;
    expect(block.selection.count, 'both revenue entries').toBe(2);
    expect(block.selection.total).toBe('25000.00');
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
    expect(view.metric?.value).toBe('19000');

    expect(view.components.map((c) => c.name).sort()).toEqual(['cost_of_sales', 'revenue']);
    for (const component of view.components) {
      expect(component.leaf, `${component.name} descends straight to records`).toBe(true);
      expect(component.snapshotId).not.toBeNull();
    }

    // One reconciliation block per leaf, each openable to its rows (§6).
    const blocks = Object.fromEntries(view.records.map((r) => [r.forLabel, r]));
    expect(Object.keys(blocks).sort()).toEqual(['Cost of sales', 'Revenue']);
    expect(blocks.Revenue!.selection.total).toBe('25000.00');
    expect(blocks['Cost of sales']!.selection.total).toBe('6000.00');
    for (const block of view.records) expect(block.reconciles).toBe(true);
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
    expect(after.selection.total, 'and still totals what the figure said').toBe('25000.00');
    expect(after.selection.rows.map((r) => r.id).sort())
      .toEqual(before.selection.rows.map((r) => r.id).sort());
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
    const recordId = one(`
      select e.id::text from public.ledger_entries e
       join public.accounts a on a.id = e.account_id
      where e.organization_id = '${orgId}' and a.standard_category = 'revenue'
      order by e.amount asc limit 1`);

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

describe('an authenticated caller cannot forge evidence (§8.5)', () => {
  it('build_metric_bundle refuses an item type a metric bundle may not carry', async () => {
    const db = clientFor(ownerId, { email: `owner@${DOMAIN}` });
    const { error } = await db.schema('api').rpc('build_metric_bundle', {
      p_snapshot: snapshotOf('operating_profit'),
      p_items: [{ item_type: 'alert', ref_id: null, label: 'forged', assurance_level: 'verified' }],
    });
    expect(error).not.toBeNull();
    expect(sqlstate(error)).toBe('22023');
  });

  it('and refuses to create an empty bundle (§8.6)', async () => {
    const db = clientFor(ownerId, { email: `owner@${DOMAIN}` });
    const { error } = await db.schema('api').rpc('build_metric_bundle', {
      p_snapshot: snapshotOf('operating_profit'), p_items: [],
    });
    expect(sqlstate(error)).toBe('22023');
  });

  it('and no authenticated role can write the evidence tables directly (ADR-026)', async () => {
    const db = clientFor(ownerId, { email: `owner@${DOMAIN}` });
    const { error } = await db.from('evidence_bundles').insert({
      organization_id: orgId, kind: 'metric', origin_table: 'metric_snapshots',
    });
    expect(sqlstate(error)).toBe('42501');
  });
});
