/**
 * Copies APX's data from the local PostgreSQL (Supabase) database into Firestore and Firebase Auth
 * (FIRESTORE_DATA_MODEL.md; owner decision 2026-10-28).
 *
 *   npm run db:migrate-from-postgres -- [--dry-run] [--skip-audit] [--orgs=slug,slug]
 *
 * It reads the old database through `docker exec supabase_db_MOTION psql` (read-only queries) and
 * writes to whatever Firebase the environment names — the EMULATORS unless `--allow-real-project`
 * is passed, so a mistyped variable can never write into a live project.
 *
 * What it does, in the data model's terms:
 *  - every table row becomes a document at its §3 path, with the §3 document id and value encodings
 *    (timestamps → ISO-8601 UTC, numeric → decimal string, bytea → lowercase hex);
 *  - fiscal periods move to their deterministic ids (`periodId`), and every reference to an old
 *    period id anywhere — columns and inside jsonb — is rewritten to the new one;
 *  - every unique index becomes its guard documents (§4), using the index's own WHERE clause;
 *  - sign-in accounts are imported into Firebase Auth with their uid, email and bcrypt password
 *    hash, so people keep signing in with the passwords they have;
 *  - the Vault secrets (the AI keys) are sealed into `platform_secrets`, and every stored file is
 *    copied from Supabase Storage into the Firebase bucket at the same `bucket/key` path.
 *
 * It is idempotent: running it twice writes the same documents.
 */
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type UserImportRecord } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const DB_CONTAINER = process.env.MOTION_DB_CONTAINER ?? 'supabase_db_MOTION';
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const SKIP_AUDIT = args.has('--skip-audit');
const ONLY_ORGS = [...args].find((a) => a.startsWith('--orgs='))?.slice('--orgs='.length).split(',').filter(Boolean) ?? null;

if (!args.has('--allow-real-project') && (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must be set (or pass --allow-real-project).');
  process.exit(1);
}

// ── The id rules of src/db/schema.ts and src/db/app/shared.ts, restated (this script runs outside Next).

function hashKey(parts: ReadonlyArray<unknown>): string {
  const canonical = JSON.stringify(parts.map((p) => (p === undefined ? null : p)));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 40);
}
function periodId(orgId: string, periodStart: string): string {
  const h = createHash('sha256').update(`fiscal_period:${orgId}:${periodStart}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function uuidFrom(label: string): string {
  const h = createHash('sha256').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-b${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ── Reading PostgreSQL ───────────────────────────────────────────────────────────────────────────

function psql(sql: string): string {
  return execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
  });
}

interface Column { name: string; udt: string }

function tables(): Map<string, Column[]> {
  const out = new Map<string, Column[]>();
  const rows = psql(`
    select c.relname, a.attname, t.typname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
     where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition
     order by c.relname, a.attnum;`).trim().split('\n');
  for (const line of rows) {
    const [table, name, udt] = line.split('|') as [string, string, string];
    if (!out.has(table)) out.set(table, []);
    out.get(table)!.push({ name, udt });
  }
  return out;
}

/** One table's rows as JSON objects, with numeric as text and bytea as hex. */
function readRows(table: string, columns: Column[], where = 'true'): Record<string, unknown>[] {
  const select = columns.map(({ name, udt }) => {
    const q = `"${name}"`;
    if (udt === 'numeric') return `${q}::text as ${q}`;
    if (udt === 'bytea') return `encode(${q}, 'hex') as ${q}`;
    if (udt === 'inet') return `host(${q}) as ${q}`;
    return q;
  }).join(', ');
  const out = psql(`copy (select row_to_json(x) from (select ${select} from public."${table}" where ${where}) x) to stdout;`);
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l.replace(/\\\\/g, '\\')) as Record<string, unknown>);
}

// ── Converting ───────────────────────────────────────────────────────────────────────────────────

const GLOBAL = new Set(['organizations', 'profiles', 'platform_users', 'platform_settings', 'portfolio_ai_turns', 'audit_events', 'jobs']);
const SKIP = new Set(['role_permissions', 'api_rate_limits']);

function convert(row: Record<string, unknown>, columns: Column[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { name, udt } of columns) {
    const v = row[name];
    if (v === null || v === undefined) { out[name] = null; continue; }
    if (udt === 'timestamptz') out[name] = new Date(String(v)).toISOString();
    else out[name] = v;
  }
  return out;
}

/** Rewrites every string equal to an old fiscal period id, at any depth. */
function remap(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remap(v, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, remap(v, map)]));
  }
  return value;
}

function docPath(table: string, row: Record<string, unknown>): string {
  const org = row.organization_id as string | null;
  if (GLOBAL.has(table)) {
    switch (table) {
      case 'platform_users': return `platform_users/${row.user_id}`;
      case 'platform_settings': return `platform_settings/${row.key}`;
      default: return `${table}/${row.id}`;
    }
  }
  const base = `organizations/${org}/${table}`;
  switch (table) {
    case 'organization_memberships': return `${base}/${row.user_id}`;
    case 'organization_assignments': return `${base}/${row.employee_user_id}`;
    case 'organization_profiles':
    case 'platform_org_settings': return `${base}/current`;
    case 'health_current':
    case 'funding_current': return `${base}/${row.period_id}`;
    case 'member_permission_overrides': return `${base}/${row.user_id}__${row.permission}`;
    case 'metric_current':
      return `${base}/${hashKey([row.period_id, row.metric_key, row.dimension_type, row.dimension_id, row.dimension_key])}`;
    default: return `${base}/${row.id}`;
  }
}

// ── Unique guards from the unique indexes ────────────────────────────────────────────────────────

interface UniqueIndex { table: string; name: string; columns: string[]; predicate: string | null }

function uniqueIndexes(): UniqueIndex[] {
  const rows = psql(`
    select t.relname, i.relname,
           (select string_agg(a.attname, ',' order by k.ord)
              from unnest(x.indkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum),
           pg_get_expr(x.indpred, x.indrelid),
           (select bool_or(k = 0) from unnest(x.indkey) k)
      from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and x.indisunique and not x.indisprimary and not t.relispartition
     order by 1, 2;`).trim().split('\n');
  const out: UniqueIndex[] = [];
  for (const line of rows) {
    const [table, name, cols, predicate, hasExpr] = line.split('|') as [string, string, string, string, string];
    if (hasExpr === 't') { console.warn(`  skip ${name}: expression index`); continue; }
    if (name.endsWith('_org_id_unique')) continue; // (organization_id, id): the path already guarantees it
    out.push({ table, name, columns: cols.split(','), predicate: predicate || null });
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const app = getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'demo-apx' });
  const fs: Firestore = getFirestore(app);
  const meta = tables();

  const orgFilter = ONLY_ORGS
    ? `organization_id in (select id from public.organizations where slug in (${ONLY_ORGS.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')}))`
    : 'true';

  // Fiscal periods first: the id map every other table is rewritten with.
  const periods = readRows('fiscal_periods', meta.get('fiscal_periods')!, orgFilter);
  const periodMap = new Map(periods.map((p) => [String(p.id), periodId(String(p.organization_id), String(p.period_start))]));
  console.log(`fiscal periods: ${periodMap.size} re-keyed`);

  const writer = fs.bulkWriter();
  writer.onWriteError((e) => { console.error(`  write failed ${e.documentRef.path}: ${e.message}`); return false; });
  let written = 0;
  const put = (path: string, data: Record<string, unknown>) => {
    written += 1;
    if (!DRY) void writer.set(fs.doc(path), data);
  };

  for (const [table, columns] of meta) {
    if (SKIP.has(table)) continue;
    if (table === 'audit_events' && SKIP_AUDIT) continue;
    const hasOrg = columns.some((c) => c.name === 'organization_id');
    let where = 'true';
    if (ONLY_ORGS) {
      if (table === 'organizations') where = `slug in (${ONLY_ORGS.map((s) => `'${s}'`).join(',')})`;
      else if (hasOrg) where = orgFilter;
    }
    if (table === 'audit_events') {
      // Events of organisations that no longer exist are test residue; platform events are kept.
      where = `${where} and (organization_id is null or organization_id in (select id from public.organizations))`;
    }
    const rows = readRows(table, columns, where);
    for (const raw of rows) {
      let row = remap(convert(raw, columns), periodMap) as Record<string, unknown>;
      if (table === 'audit_events' || table === 'record_status_events') {
        row = { ...row, id: uuidFrom(`${table}:${raw.id}`) };
      }
      if (!GLOBAL.has(table) && !row.organization_id) continue;
      put(docPath(table, row), row);
    }
    console.log(`${table}: ${rows.length}`);
  }

  // Guards: one per row that the unique index (and its WHERE clause) covers.
  let guards = 0;
  for (const idx of uniqueIndexes()) {
    const columns = meta.get(idx.table);
    if (!columns || SKIP.has(idx.table)) continue;
    const isGlobal = GLOBAL.has(idx.table);
    const keyCols = idx.columns.filter((c) => isGlobal || c !== 'organization_id');
    const constraint = idx.name === 'jobs_idempotency_queued_unique' ? 'jobs_idempotency_queued' : idx.name;
    let where = idx.predicate ?? 'true';
    if (ONLY_ORGS && columns.some((c) => c.name === 'organization_id')) where = `(${where}) and ${orgFilter}`;
    const ownerCol = idx.table === 'platform_users' ? 'user_id' : 'id';
    const rows = readRows(idx.table, columns, where);
    for (const raw of rows) {
      const row = remap(convert(raw, columns), periodMap) as Record<string, unknown>;
      const key = keyCols.map((c) => row[c] ?? null);
      const parent = isGlobal || !row.organization_id ? '' : `organizations/${row.organization_id}/`;
      put(`${parent}_unique/${constraint}__${hashKey(key)}`, {
        owner_id: row[ownerCol] ?? null, constraint, created_at: new Date().toISOString(),
      });
      guards += 1;
    }
  }
  console.log(`unique guards: ${guards}`);

  if (!DRY) await writer.close();
  console.log(`${DRY ? 'would write' : 'wrote'} ${written} documents`);

  // Sign-in accounts, with their bcrypt hashes so passwords keep working.
  const users = psql(`copy (select row_to_json(u) from (
      select id, email, encrypted_password, email_confirmed_at is not null as verified,
             raw_user_meta_data ->> 'full_name' as full_name
        from auth.users where email is not null) u) to stdout;`)
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
      id: string; email: string; encrypted_password: string | null; verified: boolean; full_name: string | null;
    });
  const records: UserImportRecord[] = users.map((u) => ({
    uid: u.id,
    email: u.email.toLowerCase(),
    emailVerified: u.verified,
    ...(u.full_name ? { displayName: u.full_name } : {}),
    ...(u.encrypted_password?.startsWith('$2') ? { passwordHash: Buffer.from(u.encrypted_password) } : {}),
  }));
  if (!DRY) {
    const auth = getAuth(app);
    for (let i = 0; i < records.length; i += 1000) {
      const result = await auth.importUsers(records.slice(i, i + 1000), { hash: { algorithm: 'BCRYPT' } });
      for (const e of result.errors) console.error(`  user ${records[i + e.index]?.email}: ${e.error.message}`);
    }
  }
  console.log(`${DRY ? 'would import' : 'imported'} ${records.length} sign-in accounts (${records.filter((r) => r.passwordHash).length} with passwords)`);

  await copySecrets(fs);
  await copyStoredFiles(app);
}

// ── Vault secrets → platform_secrets (src/db/app/secrets.ts) ─────────────────────────────────────

/** The key `src/db/app/secrets.ts` seals with: APX_SECRETS_KEY, or the fixed emulator key. */
function secretsKey(): Buffer {
  const raw = process.env.APX_SECRETS_KEY;
  if (raw) return Buffer.from(raw, 'base64');
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('APX_SECRETS_KEY must be set to copy secrets into a real project');
  return createHash('sha256').update('apx-local-emulator-secrets').digest();
}

async function copySecrets(fs: Firestore): Promise<void> {
  // The values go straight from psql into the cipher: never printed, never written in the clear.
  const secrets = psql(`copy (select row_to_json(s) from (
      select name, description, decrypted_secret as value, updated_at from vault.decrypted_secrets) s) to stdout;`)
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { name: string; description: string | null; value: string; updated_at: string });
  for (const s of secrets) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secretsKey(), iv);
    const body = Buffer.concat([cipher.update(s.value, 'utf8'), cipher.final()]);
    const sealed = [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
    if (!DRY) {
      await fs.collection('platform_secrets').doc(s.name).set({
        name: s.name, value: sealed, description: s.description ?? `ending ${s.value.slice(-4)}`,
        updated_at: new Date(s.updated_at).toISOString(),
      });
    }
  }
  console.log(`${DRY ? 'would copy' : 'copied'} ${secrets.length} platform secrets (${secrets.map((s) => s.name).join(', ') || 'none'})`);
}

// ── Supabase Storage → Firebase Storage (src/core/storage/signer.ts layout) ──────────────────────

/**
 * Every stored file, read through the local Supabase Storage API with the service role key
 * (SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_URL) and written to `${bucket}/${key}` in the one
 * Firebase bucket — the same `storage_bucket` / `storage_path` pair the rows already hold.
 */
async function copyStoredFiles(app: App): Promise<void> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base = process.env.SUPABASE_STORAGE_URL ?? 'http://127.0.0.1:54421/storage/v1';
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set to copy the stored files');
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET ?? `${process.env.FIREBASE_PROJECT_ID ?? 'demo-apx'}.appspot.com`;
  const bucket = getStorage(app).bucket(bucketName);
  const objects = psql(`copy (select row_to_json(o) from (
      select bucket_id, name, metadata ->> 'mimetype' as mimetype from storage.objects
       where name not like '%.emptyFolderPlaceholder' order by bucket_id, name) o) to stdout;`)
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { bucket_id: string; name: string; mimetype: string | null });
  let copied = 0;
  for (const o of objects) {
    const path = o.name.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${base}/object/${o.bucket_id}/${path}`, { headers: { authorization: `Bearer ${serviceKey}` } });
    if (!response.ok) { console.error(`  file ${o.bucket_id}/${o.name}: HTTP ${response.status}`); continue; }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!DRY) {
      await bucket.file(`${o.bucket_id}/${o.name}`).save(bytes, {
        resumable: false, ...(o.mimetype ? { contentType: o.mimetype } : {}),
      });
    }
    copied += 1;
  }
  console.log(`${DRY ? 'would copy' : 'copied'} ${copied} of ${objects.length} stored files to ${bucketName}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
