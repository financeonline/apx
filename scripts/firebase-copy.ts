/**
 * Copies APX's data from the local Firebase emulators into a real Firebase project
 * (FIRESTORE_DATA_MODEL.md §11; ADR-178).
 *
 * One process cannot talk to the emulators and to a real project at once (the emulator hosts are
 * process-wide), so the copy is two steps through a local folder:
 *
 *   # 1. with the emulators running on the saved data (npm run db:start):
 *   npx tsx scripts/firebase-copy.ts dump <dir>
 *   # 2. with no emulator host set and the target's service account key:
 *   GOOGLE_APPLICATION_CREDENTIALS=<key.json> APX_SECRETS_KEY=<base64> \
 *     npx tsx scripts/firebase-copy.ts load <dir> --project=<id> --bucket=<bucket> \
 *       [--only=firestore,auth,storage] [--super-admin=<email>]
 *
 * What `load` writes, and how:
 *  - every Firestore document at the same path, unchanged — except `platform_secrets`, whose values
 *    are sealed under the emulator's development key and are re-sealed under APX_SECRETS_KEY;
 *  - the sign-in accounts from the emulator's auth export, with their uid, and the bcrypt hashes
 *    imported from Supabase (a real project checks them, so passwords keep working); a hash the
 *    emulator itself made is not importable and that account signs in after "Forgot password";
 *  - every stored file, at the same `bucket/key` name, with its content type;
 *  - `--super-admin`: the one super admin (ADR-159) becomes that account — created without a
 *    password if it does not exist — and the previous one an ordinary login, with an audit event.
 *
 * The dump folder holds real data and sign-in hashes: keep it outside the repository and delete it
 * after the copy.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type UserImportRecord } from 'firebase-admin/auth';
import { getFirestore, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const [mode, dir] = process.argv.slice(2);
const flags = new Map(process.argv.slice(4).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k!, v ?? 'true'] as const;
}));

const EMULATOR_HOSTS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'];
const EMULATOR_SECRETS_KEY = createHash('sha256').update('apx-local-emulator-secrets').digest();

interface DumpedDoc { path: string; data: Record<string, unknown> }

/** Fails on any value a JSON dump would not carry back unchanged (APX stores none: §3). */
function assertPlain(value: unknown, where: string): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Array.isArray(value)) { value.forEach((v, i) => assertPlain(v, `${where}[${i}]`)); return; }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertPlain(v, `${where}.${k}`);
    return;
  }
  throw new Error(`${where} holds a value that is not plain JSON (${Object.prototype.toString.call(value)})`);
}

async function dumpCollection(ref: DocumentReference | Firestore, out: NodeJS.WritableStream, count: { n: number }): Promise<void> {
  for (const col of await ref.listCollections()) {
    for (const doc of await col.listDocuments()) {
      const snap = await doc.get();
      if (snap.exists) {
        const data = snap.data()!;
        assertPlain(data, doc.path);
        out.write(`${JSON.stringify({ path: doc.path, data } satisfies DumpedDoc)}\n`);
        count.n += 1;
      }
      await dumpCollection(doc, out, count); // a parent without fields can still hold sub-collections
    }
  }
}

async function dump(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error('dump reads the emulators: set FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST');
  }
  mkdirSync(join(dir!, 'storage'), { recursive: true });
  const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'demo-apx' });
  const stream = createWriteStream(join(dir!, 'firestore.jsonl'));
  const count = { n: 0 };
  await dumpCollection(getFirestore(app), stream, count);
  await new Promise<void>((resolve) => stream.end(resolve));
  console.log(`firestore: ${count.n} documents`);

  const bucket = getStorage(app).bucket(process.env.FIREBASE_STORAGE_BUCKET ?? 'demo-apx.appspot.com');
  const [files] = await bucket.getFiles();
  const meta: Array<{ name: string; contentType: string | null }> = [];
  for (const f of files) {
    const [bytes] = await f.download();
    const target = join(dir!, 'storage', f.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    meta.push({ name: f.name, contentType: (f.metadata.contentType as string | undefined) ?? null });
  }
  writeFileSync(join(dir!, 'storage.json'), JSON.stringify(meta));
  console.log(`storage: ${meta.length} files`);
  console.log('auth: copy firebase/emulator-data/auth_export/accounts.json into the dump folder as accounts.json');
}

function reseal(sealed: string, key: Buffer): string {
  const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', EMULATOR_SECRETS_KEY, iv!);
  d.setAuthTag(tag!);
  const plain = Buffer.concat([d.update(body!), d.final()]).toString('utf8');
  const iv2 = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv2);
  const out = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv2, c.getAuthTag(), out].map((b) => b.toString('base64')).join('.');
}

async function loadFirestore(fs: Firestore, secretsKey: Buffer): Promise<void> {
  const lines = readFileSync(join(dir!, 'firestore.jsonl'), 'utf8').split('\n').filter(Boolean);
  const writer = fs.bulkWriter();
  let failed = 0;
  writer.onWriteError((e) => {
    if (e.failedAttempts < 5) return true;
    failed += 1;
    console.error(`  write failed ${e.documentRef.path}: ${e.message}`);
    return false;
  });
  for (const line of lines) {
    const { path, data } = JSON.parse(line) as DumpedDoc;
    const value = path.startsWith('platform_secrets/') && typeof data.value === 'string'
      ? { ...data, value: reseal(data.value, secretsKey) } : data;
    void writer.set(fs.doc(path), value);
  }
  await writer.close();
  console.log(`firestore: ${lines.length - failed} of ${lines.length} documents written`);
}

async function loadAuth(app: App): Promise<void> {
  const file = join(dir!, 'accounts.json');
  const users = (JSON.parse(readFileSync(file, 'utf8')) as { users: Array<Record<string, unknown>> }).users;
  const records: UserImportRecord[] = users.map((u) => {
    const hash = typeof u.passwordHash === 'string' ? Buffer.from(u.passwordHash, 'base64') : null;
    const bcrypt = hash && hash.subarray(0, 2).toString() === '$2';
    return {
      uid: String(u.localId),
      email: String(u.email),
      emailVerified: Boolean(u.emailVerified),
      disabled: Boolean(u.disabled),
      ...(typeof u.displayName === 'string' && u.displayName ? { displayName: u.displayName } : {}),
      ...(bcrypt ? { passwordHash: hash } : {}),
    };
  });
  const auth = getAuth(app);
  for (let i = 0; i < records.length; i += 1000) {
    const result = await auth.importUsers(records.slice(i, i + 1000), { hash: { algorithm: 'BCRYPT' } });
    for (const e of result.errors) console.error(`  user ${records[i + e.index]?.email}: ${e.error.message}`);
  }
  console.log(`auth: ${records.length} accounts (${records.filter((r) => r.passwordHash).length} with their passwords)`);
}

async function loadStorage(app: App, bucketName: string): Promise<void> {
  const meta = JSON.parse(readFileSync(join(dir!, 'storage.json'), 'utf8')) as Array<{ name: string; contentType: string | null }>;
  const bucket = getStorage(app).bucket(bucketName);
  for (const m of meta) {
    await bucket.file(m.name).save(readFileSync(join(dir!, 'storage', m.name)), {
      resumable: false, ...(m.contentType ? { contentType: m.contentType } : {}),
    });
  }
  console.log(`storage: ${meta.length} files to ${bucketName}`);
}

async function setSuperAdmin(app: App, fs: Firestore, email: string): Promise<void> {
  const auth = getAuth(app);
  const user = await auth.getUserByEmail(email).catch(() => null)
    ?? await auth.createUser({ email, emailVerified: true });
  const now = new Date().toISOString();
  const current = await fs.collection('platform_users').where('platform_role', '==', 'super_admin').get();
  const batch = fs.batch();
  for (const d of current.docs) if (d.id !== user.uid) batch.delete(d.ref);
  batch.set(fs.collection('platform_users').doc(user.uid), {
    user_id: user.uid, platform_role: 'super_admin', status: 'active', granted_by: null,
    notes: 'super admin handed over when APX moved to Firebase (ADR-178)', created_at: now, updated_at: now,
  });
  const profile = fs.collection('profiles').doc(user.uid);
  if (!(await profile.get()).exists) {
    batch.set(profile, {
      id: user.uid, email: email.toLowerCase(), full_name: null, avatar_url: null, last_active_org_id: null,
      timezone: 'Europe/London', onboarding_state: {}, disabled_at: null, email_confirmed_at: now,
      created_at: now, updated_at: now,
    });
  }
  const eventId = randomUUID();
  batch.set(fs.collection('audit_events').doc(eventId), {
    id: eventId, organization_id: null, actor_user_id: null, actor_type: 'system', action: 'platform.super_admin_transferred',
    target_table: 'platform_users', target_id: user.uid, before: { super_admins: current.docs.map((d) => d.id) },
    after: { super_admin: user.uid }, metadata: { reason: 'moved to Firebase (ADR-178)' }, ip: null, user_agent: null,
    request_id: randomUUID(), created_at: now,
  });
  await batch.commit();
  console.log(`super admin: ${email} (previous: ${current.docs.map((d) => d.id).join(', ') || 'none'})`);
}

async function load(): Promise<void> {
  const set = EMULATOR_HOSTS.filter((h) => process.env[h]);
  if (set.length > 0) throw new Error(`load writes to a real project: unset ${set.join(', ')}`);
  const project = flags.get('project');
  if (!project || project.startsWith('demo-')) throw new Error('name the target with --project=<id>');
  const keyB64 = process.env.APX_SECRETS_KEY;
  const secretsKey = keyB64 ? Buffer.from(keyB64, 'base64') : null;
  if (!secretsKey || secretsKey.length !== 32) throw new Error('APX_SECRETS_KEY must be 32 bytes, base64');
  if (!existsSync(join(dir!, 'firestore.jsonl'))) throw new Error(`${dir} is not a dump folder`);
  const only = new Set((flags.get('only') ?? 'firestore,auth,storage').split(','));

  const app = initializeApp({ projectId: project });
  const fs = getFirestore(app);
  if (only.has('firestore')) await loadFirestore(fs, secretsKey);
  if (only.has('auth')) await loadAuth(app);
  if (only.has('storage')) {
    const bucket = flags.get('bucket');
    if (!bucket) throw new Error('name the Storage bucket with --bucket=<name>');
    await loadStorage(app, bucket);
  }
  const superAdmin = flags.get('super-admin');
  if (superAdmin) await setSuperAdmin(app, fs, superAdmin);
}

if (!dir || (mode !== 'dump' && mode !== 'load')) {
  console.error('usage: firebase-copy.ts dump|load <dir> [flags]');
  process.exit(1);
}
(mode === 'dump' ? dump() : load()).catch((e) => { console.error(e); process.exit(1); });
