import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The user-session client: the anon key plus the caller's JWT.
 *
 * It can SELECT under RLS and EXECUTE api.* functions. It holds NO table write privilege
 * (ADR-026), which is why the anon key being public is safe.
 */
export async function createUserClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component: middleware refreshes the session instead.
          }
        },
      },
    },
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * A request-scoped client for the PKCE callback route, which must write refreshed session cookies
 * onto an outgoing response rather than into the Server Component cookie store.
 *
 * It lives here because `core/db` is the only layer allowed to import Supabase (ADR-022); routes
 * receive a ready-made client instead of constructing one.
 */
export function createCallbackClient(
  getCookies: () => Array<{ name: string; value: string }>,
  setCookie: (name: string, value: string, options: Record<string, unknown>) => void,
): SupabaseClient {
  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => getCookies(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            setCookie(name, value, (options ?? {}) as Record<string, unknown>);
          }
        },
      },
    },
  );
}
