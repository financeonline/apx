import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { createUserClient } from '@/core/db/user-client';
import { homePathFor } from '@/modules/tenancy';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Signed-in visitors never see this page (§8.2); the proxy cannot verify the session at the edge.
  const home = await homePathFor(await createUserClient());
  if (home) redirect(home);
  return (
    <Suspense fallback={<p className="text-sm text-ink-muted">Loading…</p>}>
      <AuthForm mode="sign-up" />
    </Suspense>
  );
}
