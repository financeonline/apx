import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local', quiet: true });

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
export const JWT_SECRET = process.env.SUPABASE_JWT_SECRET!;
const DB_CONTAINER = process.env.MOTION_DB_CONTAINER ?? 'supabase_db_MOTION';

if (!SUPABASE_URL || !ANON_KEY || !JWT_SECRET) {
  throw new Error('Integration tests need NEXT_PUBLIC_SUPABASE_URL, the anon key and SUPABASE_JWT_SECRET in .env.local');
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface JwtOptions {
  email?: string;
  aal?: 'aal1' | 'aal2';
  expiresInSeconds?: number;
  amrTimestamp?: number;
}

/**
 * Mint a Supabase-shaped access token. Tests exercise the real RLS path with a real JWT rather
 * than the service key, which is the only way the policies are actually proven (TEST_STRATEGY.md §1).
 */
export function mintJwt(userId: string, options: JwtOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    email: options.email ?? `${userId}@test.motion`,
    aal: options.aal ?? 'aal1',
    amr: [{ method: 'password', timestamp: options.amrTimestamp ?? now }],
    iat: now,
    exp: now + (options.expiresInSeconds ?? 3600),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = b64url(createHmac('sha256', JWT_SECRET).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

/** A client that carries a user's JWT: SELECT under RLS and EXECUTE on api.* — nothing else. */
export function userClient(jwt: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

export function clientFor(userId: string, options: JwtOptions = {}): SupabaseClient {
  return userClient(mintJwt(userId, options));
}

/** Fixture setup only. Never used to assert what a user can see. */
export function adminSql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

export function createAuthUser(email: string): string {
  const id = randomUUID();
  adminSql(`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at)
    values ('${id}','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            '${email}','x', now(), now(), now())
  `);
  return id;
}

/** Remove everything this suite created, so each file starts from a known state. */
export function resetFixtures(): void {
  adminSql(`
    delete from public.organizations where slug like 'itest-%' or name like 'ITest%';
    delete from public.platform_users where user_id in
      (select id from auth.users where email like '%@itest.motion');
    delete from auth.users where email like '%@itest.motion';
    delete from public.api_rate_limits;
  `);
}

/**
 * Runs `fn` with `platform_settings.platform_mfa_required` pinned (ADR-159), then puts back whatever
 * the local database had: the owner's own setting must survive a test run. Integration files run one
 * at a time (fileParallelism: false), so the global setting is not raced.
 */
export async function withPlatformMfaRequired(required: boolean, fn: () => Promise<void>): Promise<void> {
  const before = adminSql(`select value::text from public.platform_settings where key = 'platform_mfa_required'`);
  adminSql(`insert into public.platform_settings (key, value) values ('platform_mfa_required', '${required}'::jsonb)
            on conflict (key) do update set value = excluded.value`);
  try {
    await fn();
  } finally {
    adminSql(before
      ? `update public.platform_settings set value = '${before}'::jsonb where key = 'platform_mfa_required'`
      : `delete from public.platform_settings where key = 'platform_mfa_required'`);
  }
}

/** Postgres SQLSTATE carried by a PostgREST error, when there is one. */
export function sqlstate(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

export const PHASE1_TABLES = [
  'organizations',
  'profiles',
  'platform_users',
  'organization_memberships',
  'organization_assignments',
  'invitations',
  'ownership_transfers',
  'audit_events',
  'jobs',
  'api_rate_limits',
  'role_permissions',
  'platform_settings',
  'platform_org_settings',
] as const;

/**
 * A service-role client for the ONE thing `adminSql` cannot reach: object storage.
 *
 * Fixture setup only, exactly like `adminSql` — never used to assert what a user can see. Storage
 * has no SQL surface, so a test about signed URLs (TEST_STRATEGY.md §4 case 5) has to put an object
 * there first.
 */
export function serviceStorage(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('the local Supabase service-role key is not configured');
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The session preamble a direct `psql` call needs to look like a scoped server request (ADR-090).
 *
 * PostgREST sets `request.jwt.claims` and `request.headers` on every request, and the organization
 * scope rides in the latter. `adminSql` opens a plain connection, so a test that drives an
 * `api_server.*` function has to set both itself — otherwise it is asserting against a session the
 * server never produces.
 */
export function serverSession(organizationId?: string): string {
  const headers = organizationId
    ? `'{"x-motion-org":"${organizationId}"}'`
    : `'{}'`;
  return `select set_config('request.jwt.claims', '{"role":"service_role"}', false);
    select set_config('request.headers', ${headers}, false);`;
}

/**
 * A service-role client that asserts a given organization scope, or none (ADR-090).
 *
 * The production scope is set by `withOrgScope` from the `jobs` row; this exists so a test can
 * assert what happens when it is absent, or wrong, which is the whole point of a fail-closed guard.
 */
export function serviceClientScoped(organizationId?: string): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('the local Supabase service-role key is not configured');
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(organizationId ? { global: { headers: { 'x-motion-org': organizationId } } } : {}),
  });
}

/**
 * Drains the queue until ONE named job reaches a terminal state.
 *
 * `drainJobs(n)` claims at most n jobs from a queue every suite shares, so a fixed count is a bet
 * that nobody else left work in it — and when the bet loses, the suite fails on an empty
 * `metric_current` for a reason that has nothing to do with what it tests. Waiting on the job's own
 * row is the thing each suite actually means.
 *
 * Returns the job's terminal status, so a caller can assert it succeeded rather than assume it.
 */
export async function drainUntilFinished(
  drain: (max: number) => Promise<unknown>,
  jobId: string,
  rounds = 12,
): Promise<string> {
  for (let round = 0; round < rounds; round += 1) {
    const status = adminSql(`select status from public.jobs where id = '${jobId}'`).trim();
    if (status === 'succeeded' || status === 'failed' || status === 'dead' || status === '') {
      return status;
    }
    await drain(3);
  }
  return adminSql(`select status from public.jobs where id = '${jobId}'`).trim();
}
