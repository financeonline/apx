import 'server-only';
import { ValidationError } from '@/core/errors';
import type { AccessContext } from '../context';

/**
 * "Confirm it's you": a password sign-in for the person already signed in, so the database's
 * recent-sign-in check (`app.has_recent_auth`, ten minutes) passes for the sensitive super-admin
 * actions (`app.require_super_admin(true)`). The session cookies are replaced with the fresh
 * session, and `ctx.db` carries it for the rest of this request. Sign-in attempts are rate-limited
 * by Supabase Auth. The password is never stored or logged.
 */
export async function confirmPassword(ctx: AccessContext, password: string): Promise<void> {
  if (!password) throw new ValidationError('Enter your password to confirm it is you.');
  const { data, error: userError } = await ctx.db.auth.getUser();
  const email = data.user?.email;
  if (userError || !email || data.user?.id !== ctx.userId) {
    throw new ValidationError('Your session has ended. Sign in again.');
  }
  const { error } = await ctx.db.auth.signInWithPassword({ email, password });
  if (error) throw new ValidationError('That password is not right.');
}
