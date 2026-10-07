import 'server-only';
import type { AccessContext } from '@/modules/tenancy';
import { callApi } from '@/core/db';

/**
 * The person shown at the foot of the sidebar — name (else email) and role, linking to Account. Every
 * shell shows it, so the signed-in account is always visible beside Sign out.
 */
export async function shellUser(db: AccessContext['db'], role: string, requestId?: string): Promise<{ name: string; role: string; href: string }> {
  const profile = (await callApi<Array<{ full_name: string | null; email: string }>>(db, 'my_profile', {}, requestId).catch(() => null))?.[0];
  return { name: profile?.full_name?.trim() || profile?.email || 'Your account', role, href: '/account' };
}
