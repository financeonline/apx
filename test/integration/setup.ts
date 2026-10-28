import { config as loadEnv } from 'dotenv';
import type { Firestore } from 'firebase-admin/firestore';
import { auth, db as firestore } from '@/db/firestore';
import type { Db } from '@/db/types';
import { API_FUNCTIONS } from '@/db/api';
import { SERVER_FUNCTIONS } from '@/db/api_server';
import { isMotionError } from '@/core/errors';
import { ensureProfile } from '@/db/app/profiles';

/**
 * The integration harness, on the Firebase emulators (TEST_STRATEGY.md §1; FIRESTORE_DATA_MODEL.md §9).
 *
 * Run with `npm run test:integration`, which starts the Auth, Firestore and Storage emulators for
 * the `demo-apx` project, runs the suite against them and stops them. Nothing leaves the machine.
 *
 * What a test asserts is what a USER can do, so every assertion goes through `clientFor(userId)` —
 * a handle with that person as the actor, exactly what `createUserClient()` builds from a session
 * cookie — and through the same `api.*` functions and `src/db/rls.ts` reads the application uses.
 * `fs()` writes fixtures directly and is never used to assert what a user can see.
 */

loadEnv({ path: '.env.local', quiet: true });

process.env.FIREBASE_PROJECT_ID ??= 'demo-apx';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';

/** The Admin SDK's Firestore, for fixtures. */
export function fs(): Firestore {
  return firestore();
}

export interface ClientOptions {
  email?: string;
  /** When the person last proved who they are (seconds); defaults to now. */
  authTime?: number;
  requestId?: string;
}

/** A signed-in person's handle: what every assertion about access is made through. */
export function clientFor(userId: string, options: ClientOptions = {}): Db {
  return {
    fs: firestore(),
    actor: {
      kind: 'user', userId, email: options.email ?? null,
      authTime: options.authTime ?? Math.floor(Date.now() / 1000),
    },
    meta: { requestId: options.requestId ?? null },
  };
}

/** Nobody signed in. */
export function anonClient(): Db {
  return { fs: firestore(), actor: { kind: 'anon' }, meta: {} };
}

/** The server itself, optionally scoped to one organisation (what `withOrgScope` builds). */
export function serviceClientScoped(organizationId?: string): Db {
  return { fs: firestore(), actor: { kind: 'service', scope: organizationId ?? null }, meta: {} };
}

export interface RpcResult<T = unknown> {
  data: T | null;
  /** The MotionError a refusal raised, with `.code` (`NOT_FOUND`, `PERMISSION_DENIED`, …). */
  error: (Error & { code?: string }) | null;
}

/**
 * Calls an `api.*` (or, with `server: true`, an `api_server.*`) function and returns
 * `{ data, error }` instead of throwing, so a test can assert a refusal as easily as a success.
 */
export async function rpc<T = unknown>(
  db: Db, fn: string, args: Record<string, unknown> = {}, options: { server?: boolean } = {},
): Promise<RpcResult<T>> {
  const impl = (options.server ? SERVER_FUNCTIONS : API_FUNCTIONS)[fn];
  if (!impl) throw new Error(`${options.server ? 'api_server' : 'api'}.${fn} is not defined`);
  try {
    return { data: (await impl(db, args)) as T, error: null };
  } catch (error) {
    return { data: null, error: error as Error & { code?: string } };
  }
}

/**
 * The SQLSTATE a refusal used to carry, from the MotionError it now is — so a ported assertion can
 * keep saying `expect(sqlstate(error)).toBe('42501')`.
 */
export function sqlstate(error: unknown): string | undefined {
  if (!isMotionError(error)) return undefined;
  switch (error.code) {
    case 'NOT_FOUND': return 'P0002';
    case 'PERMISSION_DENIED': return '42501';
    case 'VALIDATION': return '22023';
    case 'CONFLICT': return '23505';
    case 'QUOTA': return '53400';
    default: return undefined;
  }
}

/**
 * A sign-in account in the Auth emulator, with its `profiles` document (what signing up creates).
 * Returns the uid.
 */
export async function createAuthUser(email: string, password = 'itest-password-1'): Promise<string> {
  const existing = await auth().getUserByEmail(email).catch(() => null);
  const user = existing ?? await auth().createUser({ email, password, emailVerified: true });
  await ensureProfile(firestore(), user.uid, email, null);
  return user.uid;
}

/** Deletes a whole organisation and everything under it. Fixture teardown only. */
export async function deleteOrg(orgId: string): Promise<void> {
  await firestore().recursiveDelete(firestore().collection('organizations').doc(orgId));
}

/**
 * Removes what a suite created: organisations whose name or slug marks them as test fixtures, the
 * accounts under a test domain, and the rate-limit counters.
 */
export async function resetFixtures(match: { namePrefix?: string; emailDomain?: string } = {}): Promise<void> {
  const f = firestore();
  const prefix = match.namePrefix ?? 'ITest';
  const orgs = await f.collection('organizations').get();
  for (const o of orgs.docs) {
    const name = String(o.get('name') ?? '');
    const slug = String(o.get('slug') ?? '');
    if (name.startsWith(prefix) || slug.startsWith('itest-')) await f.recursiveDelete(o.ref);
  }
  const domain = match.emailDomain ?? 'itest.motion';
  let page = await auth().listUsers(1000);
  for (;;) {
    const doomed = page.users.filter((u) => u.email?.endsWith(`@${domain}`) || u.email?.endsWith(`.${domain}`));
    if (doomed.length > 0) {
      await auth().deleteUsers(doomed.map((u) => u.uid));
      for (const u of doomed) {
        await f.collection('profiles').doc(u.uid).delete();
        await f.collection('platform_users').doc(u.uid).delete();
      }
    }
    if (!page.pageToken) break;
    page = await auth().listUsers(1000, page.pageToken);
  }
  await f.recursiveDelete(f.collection('api_rate_limits'));
}

/** Clears the whole emulator database — the clean slate the emulator offers and Postgres did not. */
export async function wipeEmulator(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const project = process.env.FIREBASE_PROJECT_ID;
  await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' });
}

/**
 * Drains the queue until ONE named job reaches a terminal state, and returns that state.
 * `drain(n)` runs at most n jobs; waiting on the job's own document is what each suite means.
 */
export async function drainUntilFinished(
  drain: (max: number) => Promise<unknown>,
  jobId: string,
  rounds = 12,
): Promise<string> {
  const status = async () => String((await firestore().collection('jobs').doc(jobId).get()).get('status') ?? '');
  for (let round = 0; round < rounds; round += 1) {
    const s = await status();
    if (s === 'succeeded' || s === 'failed' || s === 'dead' || s === '') return s;
    await drain(3);
  }
  return status();
}
