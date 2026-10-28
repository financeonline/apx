import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The journeys' handle on the Firebase emulators (FIRESTORE_DATA_MODEL.md §1, §9).
 *
 * The journeys drive the product through a browser, but some steps need a fact the browser cannot
 * give: a person who already exists, a membership an owner would grant on another screen, a state a
 * job would reach after days. Those are written here, straight to the emulator, with the SAME
 * fixture writers the integration suite uses (`test/fixtures/seed.ts`, `test/integration/*-fixtures.ts`)
 * — so a journey's seeded document is exactly the document an import, a job or a page would write.
 *
 * `server-only`. Every `src/db` module begins with `import 'server-only'`, which throws anywhere but
 * a React Server bundle. Vitest aliases it to a no-op (test/stubs/server-only.ts); Playwright has no
 * alias, so this file resolves it to the package's own `react-server` build (`empty.js`) — the file
 * Next itself loads on the server. The hook is registered before anything under `src/` is loaded,
 * which is why those modules are imported lazily (`backend()`), never at the top of this file: a
 * static import is resolved before this module's body runs, and would reach the throwing build.
 * A global `--conditions=react-server` would do the same, but would also reach `next start`, whose
 * own bundles must not resolve React that way.
 *
 * Never a real project: the journeys write and delete freely, so anything but a `demo-` project (which
 * cannot reach Google's servers at all) is refused before the first call.
 */

const SERVER_ONLY_EMPTY = pathToFileURL(
  path.join(path.dirname(createRequire(import.meta.url).resolve('server-only')), 'empty.js'),
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: SERVER_ONLY_EMPTY, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// The same defaults the integration harness and scripts/write-local-env.sh use.
process.env.FIREBASE_PROJECT_ID ??= 'demo-apx';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';

async function load() {
  const project = process.env.FIREBASE_PROJECT_ID ?? '';
  if (!project.startsWith('demo-')) {
    throw new Error(`The journeys only ever write to a demo- Firebase project, not "${project}"`);
  }
  const [firebase, setup, seed, portfolio, schema, shared, jobs, api] = await Promise.all([
    import('@/db/firestore'),
    import('../test/integration/setup'),
    import('../test/fixtures/seed'),
    import('../test/integration/portfolio-fixtures'),
    import('@/db/schema'),
    import('@/db/app/shared'),
    import('@/db/app/jobs'),
    import('@/db/api'),
  ]);
  return { firebase, setup, seed, portfolio, schema, shared, jobs, api };
}

let loaded: ReturnType<typeof load> | null = null;

/**
 * The fixture writers and `src/db` helpers, loaded on first use:
 *
 *  - `firebase`: the Admin SDK handles (`auth()` for sign-in accounts).
 *  - `setup`: the integration harness — `fs()`, `createAuthUser`, `clientFor(uid)`, `rpc`.
 *  - `seed`: `test/fixtures/seed.ts` — `seedMember`, `seedInvoice`, `seedCurrentFigures`, …
 *  - `portfolio`: the Command Centre fixtures — `actionDoc`, `alertDoc`, `healthScoreDoc`, …
 *  - `schema`, `shared`: `orgRow`, `newId`, `nowIso`, `uniqueGuard`, `periodId`, …
 *  - `jobs`: `prepareEnqueue`, for a job the product would have queued.
 *  - `api`: every `api.*` function, for a step that must happen as the product does it.
 */
export function backend(): ReturnType<typeof load> {
  loaded ??= load();
  return loaded;
}

type OrgTable = Parameters<Awaited<ReturnType<typeof load>>['schema']['orgCollection']>[2];
export type Row = Record<string, unknown>;

/** The organisation with this slug; a journey that cannot find its own organisation fails here. */
export async function orgIdBySlug(slug: string): Promise<string> {
  const { setup } = await backend();
  const snap = await setup.fs().collection('organizations').where('slug', '==', slug).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) throw new Error(`no organisation with slug ${slug}`);
  return doc.id;
}

/** The organisation with this (run-unique) name. */
export async function orgIdByName(name: string): Promise<string> {
  const { setup } = await backend();
  const snap = await setup.fs().collection('organizations').where('name', '==', name).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) throw new Error(`no organisation named ${name}`);
  return doc.id;
}

/** Every document of one organisation table, as plain rows (optionally narrowed by a predicate). */
export async function orgRows(orgId: string, table: OrgTable, where: (row: Row) => boolean = () => true): Promise<Row[]> {
  const { setup, schema } = await backend();
  const snap = await schema.orgCollection(setup.fs(), orgId, table).get();
  return snap.docs.map((d) => d.data()).filter(where);
}

/** One organisation document by id, or null. */
export async function orgRowById(orgId: string, table: OrgTable, id: string): Promise<Row | null> {
  const { setup, schema } = await backend();
  const snap = await schema.orgRow(setup.fs(), orgId, table, id).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

/** Newest first by `created_at` (an ISO string, so it sorts as text). */
export function newestFirst(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** The audit events of one organisation (a top-level collection, filtered by `organization_id`). */
export async function auditEvents(orgId: string): Promise<Row[]> {
  const { setup } = await backend();
  const snap = await setup.fs().collection('audit_events').where('organization_id', '==', orgId).get();
  return snap.docs.map((d) => d.data());
}

/** The jobs of one organisation. */
export async function jobsOf(orgId: string): Promise<Row[]> {
  const { seed } = await backend();
  return seed.jobsOf(orgId);
}

/** The fiscal period id for the month starting `periodStart` (a deterministic id, as the app derives it). */
export async function periodOf(orgId: string, periodStart: string): Promise<string> {
  const { shared } = await backend();
  return shared.periodId(orgId, periodStart);
}

/** An active membership, as accepting an invitation leaves it (the document id is the user's id). */
export async function addMembership(orgId: string, userId: string, role: string): Promise<void> {
  const { seed } = await backend();
  await seed.seedMember(orgId, userId, role);
}

/** APX staff (`platform_users`, keyed by the uid). */
export async function addPlatformUser(userId: string, role: 'employee' | 'super_admin' = 'employee'): Promise<void> {
  const { seed } = await backend();
  await seed.seedPlatformUser(userId, role);
}

/** An active, in-window assignment of an employee to an organisation, as a super admin grants it. */
export async function addAssignment(orgId: string, employeeId: string): Promise<void> {
  const { portfolio } = await backend();
  await portfolio.assign(orgId, employeeId);
}

/** Merges fields into the organisation document (a platform admin's switch: features, currency). */
export async function updateOrganization(orgId: string, fields: Row): Promise<void> {
  const { setup, schema } = await backend();
  await setup.fs().collection('organizations').doc(orgId).update({ ...fields, updated_at: schema.nowIso() });
}

/**
 * Switches feature flags on (the old `features || '{…}'` merge): the other flags are kept.
 *
 * Switching Funding Readiness on also queues its first assessment, which the `funding_enablement`
 * trigger used to do and `api.set_org_module` does now (ADR-145) — there is no trigger, so
 * the writer does it, with the same job and idempotency key.
 */
export async function enableFeatures(orgId: string, flags: Readonly<Record<string, boolean>>): Promise<void> {
  const { setup, schema, jobs } = await backend();
  const f = setup.fs();
  const ref = f.collection('organizations').doc(orgId);
  await f.runTransaction(async (tx) => {
    const before = ((await tx.get(ref)).get('features') ?? {}) as Row;
    const features = { ...before, ...flags };
    const funding = String(features.funding_readiness ?? '') === 'true' && String(before.funding_readiness ?? '') !== 'true'
      ? await jobs.prepareEnqueue(f, {
        organizationId: orgId, jobType: 'funding.assess', payload: { trigger: 'enablement_backfill' },
        requestedBy: null, idempotencyKey: `funding.assess:${orgId}`,
      }, tx)
      : null;
    tx.update(ref, { features, updated_at: schema.nowIso() });
    funding?.write(tx);
  });
}

/**
 * An `api.*` function called as `userId` — the TypeScript function of that name, through the same
 * user-actor handle a signed-in request builds (`clientFor`).
 */
export async function callAs<T = unknown>(userId: string, fn: string, args: Row): Promise<T> {
  const { setup } = await backend();
  const { data, error } = await setup.rpc<T>(setup.clientFor(userId), fn, args);
  if (error) throw error;
  return data as T;
}

/**
 * Deletes one organisation and everything that hangs off it: its sub-collections, its slug guard and
 * its jobs (what `delete from organizations` cascaded to).
 */
export async function deleteOrganization(orgId: string): Promise<void> {
  const { setup, schema } = await backend();
  const f = setup.fs();
  const ref = f.collection('organizations').doc(orgId);
  const slug = (await ref.get()).get('slug') as string | undefined;
  await f.recursiveDelete(ref);
  if (slug) await schema.uniqueGuard(f, 'global', 'organizations_slug_key', [slug]).ref.delete();
  const jobs = await f.collection('jobs').where('organization_id', '==', orgId).get();
  for (const j of jobs.docs) await j.ref.delete();
}

/** Deletes a sign-in account with its profile and any platform role. */
export async function deleteUser(uid: string): Promise<void> {
  const { setup, firebase } = await backend();
  const f = setup.fs();
  await firebase.auth().deleteUser(uid).catch(() => undefined);
  await f.collection('profiles').doc(uid).delete();
  await f.collection('platform_users').doc(uid).delete();
}

/** Every sign-in account whose email passes `match`, with when it was created. */
export async function usersWhere(match: (email: string) => boolean): Promise<Array<{ uid: string; createdAt: Date }>> {
  const { auth } = (await backend()).firebase;
  const out: Array<{ uid: string; createdAt: Date }> = [];
  let page = await auth().listUsers(1000);
  for (;;) {
    for (const u of page.users) {
      if (u.email && match(u.email)) out.push({ uid: u.uid, createdAt: new Date(u.metadata.creationTime) });
    }
    if (!page.pageToken) break;
    page = await auth().listUsers(1000, page.pageToken);
  }
  return out;
}

/** The organisation's earliest fiscal period id (creating an organisation makes 24 of them). */
export async function firstPeriod(orgId: string): Promise<string> {
  const periods = await orgRows(orgId, 'fiscal_periods');
  periods.sort((a, b) => String(a.period_start).localeCompare(String(b.period_start)));
  const first = periods[0];
  if (!first) throw new Error(`organisation ${orgId} has no fiscal periods`);
  return String(first.id);
}

/**
 * A succeeded calculation run over `periodFrom`..`periodTo`, with the field set the engine's run
 * document carries (the same one `seedCurrentFigures` writes). Returns its id.
 */
export async function seedRun(orgId: string, input: { periodFrom: string; periodTo?: string; asOf: string }): Promise<string> {
  const { setup, schema } = await backend();
  const id = schema.newId();
  const now = schema.nowIso();
  await schema.orgRow(setup.fs(), orgId, 'calculation_runs', id).set({
    id, organization_id: orgId, job_id: null, trigger: 'recalc_manual', trigger_ref_id: null, engine_version: '1.0.0',
    period_from: input.periodFrom, period_to: input.periodTo ?? input.periodFrom, as_of: input.asOf, as_of_ts: now,
    status: 'succeeded', failure_reason: null, stale: false, input_fingerprint: null, chunks: [], progress: {},
    started_at: now, finished_at: now, duration_ms: 0, error: null, stats: {}, created_at: now, updated_at: now,
  });
  return id;
}

/**
 * An open alert as `persist_alerts` writes one (src/db/api_server/reporting.ts): the alert, its
 * revision 1 as the current revision, and the dedupe and revision-number guards. Returns its id.
 */
export async function seedAlert(orgId: string, input: {
  periodId: string; runId: string; ruleKey: string; severity: string; title: string; explanation: string; dedupeKey: string;
}): Promise<string> {
  const { setup, schema, portfolio } = await backend();
  const f = setup.fs();
  const alert: Row = {
    ...portfolio.alertDoc(orgId, input.periodId, input.runId, input.severity, input.title, { dedupe: input.dedupeKey }),
    rule_key: input.ruleKey, explanation: input.explanation,
  };
  const alertId = String(alert.id);
  const revisionId = schema.newId();
  await f.runTransaction(async (tx) => {
    const dedupe = await schema.uniqueGuard(f, { orgId }, 'alert_dedupe', [input.dedupeKey]).read(tx);
    const revisionNo = await schema.uniqueGuard(f, { orgId }, 'alert_revisions_no_unique', [alertId, 1]).read(tx);
    tx.set(schema.orgRow(f, orgId, 'alerts', alertId), { ...alert, current_revision_id: revisionId });
    tx.set(schema.orgRow(f, orgId, 'alert_revisions', revisionId), {
      id: revisionId, organization_id: orgId, alert_id: alertId, revision_no: 1, rule_version: alert.rule_version,
      severity: input.severity, explanation: input.explanation, threshold_summary: {}, evidence_bundle_id: null,
      calculation_run_id: input.runId, created_at: schema.nowIso(),
    });
    dedupe.take(tx, alertId);
    revisionNo.take(tx, revisionId);
  });
  return alertId;
}

/** An action as a person creates one by hand (`source_type: 'user'`). Returns its id. */
export async function seedAction(orgId: string, input: {
  title: string; priority: string; status?: string; due: string | null; owner?: string | null; createdBy: string;
  issue?: string | null;
}): Promise<string> {
  const { setup, schema, portfolio } = await backend();
  const action: Row = {
    ...portfolio.actionDoc(orgId, input.title, input.priority, input.due, { status: input.status, owner: input.owner ?? null }),
    created_by: input.createdBy, issue: input.issue ?? null,
  };
  await schema.orgRow(setup.fs(), orgId, 'actions', String(action.id)).set(action);
  return String(action.id);
}

/**
 * Finished months with current figures, written the way the engine writes them: each month marked
 * complete, one `metric_snapshots` document per figure (value a decimal string at scale 6) and its
 * `metric_current` pointer under `metricCellId` — the field set `seedCurrentFigures`
 * (test/fixtures/seed.ts) writes, with the data-quality flags a journey needs to choose.
 */
export async function seedMonthlyFigures(orgId: string, input: {
  runId: string; periodStarts: readonly string[]; values: Readonly<Record<string, string>>;
  currency?: string; basis?: string; assurance?: string; proxy?: boolean; warnings?: readonly string[];
}): Promise<void> {
  const { setup, schema, shared } = await backend();
  const { Decimal } = await import('@/core/money/decimal');
  const f = setup.fs();
  const now = schema.nowIso();
  const batch = f.batch();
  for (const start of input.periodStarts) {
    const period = shared.periodId(orgId, start);
    batch.update(schema.orgRow(f, orgId, 'fiscal_periods', period), { is_complete: true, updated_at: now });
    for (const [metricKey, value] of Object.entries(input.values)) {
      const id = schema.newId();
      const cell = { period_id: period, metric_key: metricKey, dimension_type: 'none', dimension_id: null, dimension_key: null };
      batch.set(schema.orgRow(f, orgId, 'metric_snapshots', id), {
        id, organization_id: orgId, calculation_run_id: input.runId, ...cell,
        value: new Decimal(value).toFixed(6), unit: 'money', currency: input.currency ?? 'GBP',
        basis: input.basis ?? 'ledger', assurance_level: input.assurance ?? 'verified',
        data_quality: { completeness: 1, proxy: input.proxy ?? false, warnings: [...(input.warnings ?? [])], missing: [] },
        components: {}, evidence_query: null, created_at: now,
      });
      batch.set(schema.orgRow(f, orgId, 'metric_current', schema.metricCellId(cell)), {
        organization_id: orgId, ...cell, snapshot_id: id, calculation_run_id: input.runId, previous_snapshot_id: null, updated_at: now,
      });
    }
  }
  await batch.commit();
}
