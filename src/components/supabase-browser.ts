import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The ONLY browser-side Supabase client in MOTION.
 *
 * It exists because authentication is the one thing the server cannot do on the user's behalf:
 * password sign-in, sign-up, password reset and TOTP enrolment all need the browser to hold the
 * PKCE verifier and to receive the upgraded session. It carries the anon key, which is safe only
 * because `authenticated` holds no write privilege on any table (ADR-026) and RLS is forced
 * everywhere — so this client can read what the user may read and execute `api.*`, nothing more.
 *
 * Everything else — every mutation, every tenant read — goes through the service layer on the
 * server. Nothing under `src/app` imports `@supabase/*` except `/auth/callback`.
 */
let client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Check .env.local.',
    );
  }
  client = createBrowserClient(url, anonKey);
  return client;
}

/**
 * Supabase Auth errors arrive as sentences aimed at developers. These are the ones a user can
 * actually hit; anything else falls back to a plain apology rather than leaking internals.
 */
export function authErrorMessage(message: string | undefined): string {
  if (!message) return 'Something went wrong on our side. Please try again.';
  const normalised = message.toLowerCase();
  if (normalised.includes('invalid login credentials')) {
    return 'That email address and password do not match an account.';
  }
  if (normalised.includes('email not confirmed')) {
    return 'Confirm your email address first — check your inbox for the link we sent.';
  }
  if (normalised.includes('user already registered')) {
    return 'There is already an account with that email address. Try signing in instead.';
  }
  if (normalised.includes('password')) return message;
  if (normalised.includes('rate limit') || normalised.includes('too many')) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  if (normalised.includes('expired') || normalised.includes('invalid')) {
    return 'That link is no longer valid. Please request a new one.';
  }
  return 'Something went wrong on our side. Please try again.';
}
