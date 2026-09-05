import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { listMyOrganizations } from '@/modules/tenancy';
import { OnboardingForm } from './onboarding-form';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect('/sign-in?next=/onboarding');

  const organizations = await listMyOrganizations(db);
  if (organizations.length > 0) redirect('/select-organization');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-6 py-12">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Set up your organisation</h1>
        <p className="mt-2 text-ink-muted">
          This is the business MOTION will report on. You can change these details later in Settings.
        </p>
      </div>
      <OnboardingForm />
    </main>
  );
}
