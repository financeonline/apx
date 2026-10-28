import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { listMyOrganizations, sessionUserOf } from '@/modules/tenancy';
import { OnboardingForm } from './onboarding-form';
import { BrandedScreen } from '@/components/dashboard/branded-screen';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const db = await createUserClient();
  if (!sessionUserOf(db)) redirect('/sign-in?next=/onboarding');

  const organizations = await listMyOrganizations(db);
  if (organizations.length > 0) redirect('/select-organization');

  return (
    <BrandedScreen width="lg">
      <div>
        <h1 className="text-3xl">Set up your organisation</h1>
        <p className="mt-2 text-ink-muted">
          This is the business APX will report on. You can change these details later in Settings.
        </p>
      </div>
      <OnboardingForm />
    </BrandedScreen>
  );
}
