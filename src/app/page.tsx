import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { homePathFor } from '@/modules/tenancy';

export const dynamic = 'force-dynamic';

/**
 * The front page is the sign-in page (owner, 2026-10-14: "directly uses sign-in"); a signed-in
 * visitor goes to their own home (§8.6) — the platform, the Command Centre, or their companies.
 */
export default async function LandingPage() {
  redirect((await homePathFor(await createUserClient())) ?? '/sign-in');
}
