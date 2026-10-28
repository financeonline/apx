import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgRoleOf, requirePermission } from '@/db/app/access';
import { prepareRecalculation } from '@/db/app/jobs';
import { ensurePeriods, periodId } from '@/db/app/shared';
import { orgRows, orgRowById } from '@/db/rls';
import { newId, nowIso, orgRow, uniqueGuard } from '@/db/schema';
import { runTx } from '@/db/tx';
import { clientFor, createAuthUser, deleteOrg, fs, serviceClientScoped } from './setup';

/**
 * The foundation every ported function stands on (FIRESTORE_DATA_MODEL.md §2–§7): who reaches an
 * organisation, what a read admits, a unique key, the fiscal calendar and the queue's merge.
 */

const RUN = `f${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.foundation.itest.motion`;
let ownerId: string;
let clientId: string;
let strangerId: string;
const orgId = newId();

beforeAll(async () => {
  ownerId = await createAuthUser(`owner@${DOMAIN}`);
  clientId = await createAuthUser(`client@${DOMAIN}`);
  strangerId = await createAuthUser(`stranger@${DOMAIN}`);
  const now = nowIso();
  await fs().collection('organizations').doc(orgId).set({
    id: orgId, slug: `itest-${RUN}`, name: `ITest Foundation ${RUN}`, status: 'active',
    fiscal_year_start_month: 4, features: {}, created_at: now, updated_at: now,
  });
  for (const [uid, role] of [[ownerId, 'owner'], [clientId, 'client']] as const) {
    await orgRow(fs(), orgId, 'organization_memberships', uid).set({
      id: newId(), organization_id: orgId, user_id: uid, role, status: 'active', created_at: now, updated_at: now,
    });
  }
  await orgRow(fs(), orgId, 'ledger_entries', 'le-1').set({ id: 'le-1', organization_id: orgId, amount: '10.00' });
});

afterAll(async () => {
  await deleteOrg(orgId);
});

describe('access', () => {
  it('resolves roles, and nothing for a stranger', async () => {
    expect(await orgRoleOf(fs(), ownerId, orgId)).toBe('owner');
    expect(await orgRoleOf(fs(), clientId, orgId)).toBe('client');
    expect(await orgRoleOf(fs(), strangerId, orgId)).toBeNull();
  });

  it('refuses a stranger with NOT_FOUND and a client without the permission with PERMISSION_DENIED', async () => {
    await expect(requirePermission(clientFor(strangerId), orgId, 'financials.view')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(requirePermission(clientFor(clientId), orgId, 'users.manage')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(requirePermission(clientFor(ownerId), orgId, 'users.manage')).resolves.toBe('owner');
  });

  it('a suspended organisation freezes members to Home', async () => {
    await fs().collection('organizations').doc(orgId).update({ status: 'suspended' });
    expect(await orgRoleOf(fs(), ownerId, orgId)).toBe('suspended_member');
    await fs().collection('organizations').doc(orgId).update({ status: 'active' });
  });
});

describe('reads follow the policies', () => {
  it('the owner reads the ledger; a stranger reads nothing', async () => {
    expect(await orgRows(clientFor(ownerId), orgId, 'ledger_entries')).toHaveLength(1);
    expect(await orgRows(clientFor(strangerId), orgId, 'ledger_entries')).toHaveLength(0);
    expect(await orgRowById(clientFor(strangerId), orgId, 'ledger_entries', 'le-1')).toBeNull();
  });

  it('a member sees only their own membership; a manager sees all', async () => {
    expect(await orgRows(clientFor(clientId), orgId, 'organization_memberships')).toHaveLength(1);
    expect(await orgRows(clientFor(ownerId), orgId, 'organization_memberships')).toHaveLength(2);
  });
});

describe('a unique key', () => {
  it('lets the first writer take it and refuses the second with CONFLICT', async () => {
    const db = clientFor(ownerId);
    const take = (owner: string) => runTx(db, async (tx) => {
      const claim = await uniqueGuard(fs(), { orgId }, 'itest_unique', ['same-key']).read(tx);
      claim.take(tx, owner);
    });
    await take('row-a');
    await take('row-a');
    await expect(take('row-b')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('the fiscal calendar', () => {
  it('creates each month once, with the fiscal year the organisation starts in April', async () => {
    expect(await ensurePeriods(fs(), orgId, '2026-02-15', '2026-05-03')).toBe(4);
    expect(await ensurePeriods(fs(), orgId, '2026-03-01', '2026-04-30')).toBe(0);
    const april = (await orgRow(fs(), orgId, 'fiscal_periods', periodId(orgId, '2026-04-01')).get()).data()!;
    expect(april).toMatchObject({ label: 'Apr 2026', fiscal_year: 2026, fiscal_quarter: 1, period_end: '2026-04-30' });
    const march = (await orgRow(fs(), orgId, 'fiscal_periods', periodId(orgId, '2026-03-01')).get()).data()!;
    expect(march).toMatchObject({ fiscal_year: 2025, fiscal_quarter: 4 });
  });
});

describe('the queue', () => {
  it('merges a second recalculation request into the queued one', async () => {
    const db = serviceClientScoped(orgId);
    const enqueue = (trigger: string, ref: string) => runTx(db, async (tx) => {
      const job = await prepareRecalculation(fs(), orgId, trigger, ref, null, tx);
      job.write(tx);
      return job;
    });
    const first = await enqueue('import_committed', 'b1');
    const second = await enqueue('import_committed', 'b2');
    expect(second.merged).toBe(true);
    expect(second.id).toBe(first.id);
    const payload = (await fs().collection('jobs').doc(first.id).get()).get('payload');
    expect(payload.refs).toHaveLength(2);
    await fs().collection('jobs').doc(first.id).delete();
  });
});
