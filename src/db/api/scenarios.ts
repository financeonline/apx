import 'server-only';
import { raise } from '../raise';
import { arg, type DbFunctions } from '../registry';
import { acrossOrgs, nowIso } from '../schema';
import { runTx } from '../tx';
import { uidOf, type Db } from '../types';
import { requireOrg, requirePermission } from '../app/access';
import { prepareAudit } from '../app/audit';
import { throttle } from '../app/throttle';

/**
 * `api.*` functions of the scenarios area (Phase 12, ADR-100), ported from PostgreSQL
 * (FIRESTORE_DATA_MODEL.md §8). A scenario is WRITTEN by the server (`api_server.finish_scenario`);
 * the only thing a person changes on one is whether it is archived.
 */

/**
 * `api.archive_scenario`: archive (or restore) a saved scenario. The SQL found the scenario by id
 * across organisations and then required the caller to reach its organisation; the scenario id is
 * all the caller sends, so the lookup is a collection-group read on `scenario_runs.id`, and an
 * organisation the caller cannot reach is NotFound, as the SQL's `accessible_org_ids()` test was.
 */
async function archive_scenario(db: Db, args: Record<string, unknown>): Promise<string> {
  const scenario = arg.req(args, 'p_scenario');
  const archived = arg.bool(args, 'p_archived') ?? true;
  await throttle(db.fs, uidOf(db), 'rpc', 120, 60);

  const found = await acrossOrgs(db.fs, 'scenario_runs').where('id', '==', scenario).limit(1).get();
  const hit = found.docs[0];
  const org = hit ? String(hit.get('organization_id')) : null;
  if (!hit || !org) raise.notFound();
  await requireOrg(db, org);
  await requirePermission(db, org, 'intelligence.recompute');

  return runTx(db, async (tx) => {
    const snap = await tx.get(hit.ref);
    if (!snap.exists) raise.notFound();
    const was = snap.get('archived_at') ?? null;
    const audit = await prepareAudit(db, {
      organizationId: org, action: 'scenario.archived', targetTable: 'scenario_runs', targetId: scenario,
      before: { archived: was !== null }, after: { archived },
    }, tx);
    tx.update(hit.ref, { archived_at: archived ? nowIso() : null });
    audit.write(tx);
    return scenario;
  });
}

export const functions: DbFunctions = { archive_scenario };
