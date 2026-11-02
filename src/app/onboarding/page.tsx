import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { platformHomeFor } from '@/modules/tenancy';
import { listMyOrganizations, sessionUserOf } from '@/modules/tenancy';
import { BrandedScreen } from '@/components/dashboard/branded-screen';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const db = await createUserClient();
  if (!sessionUserOf(db)) redirect('/sign-in?next=/onboarding');
  // Platform accounts are never members of a customer organisation (§8.5).
  const platformHome = await platformHomeFor(db);
  if (platformHome) redirect(platformHome);

  const organizations = await listMyOrganizations(db);
  if (organizations.length > 0) redirect('/select-organization');

  // No self-service company creation (owner, 2026-11-02): the Platform creates companies and their
  // owners. A signed-in person with no company is told whom to ask; `OnboardingForm` is kept unused.
  return (
    <BrandedScreen width="lg">
      <div>
        <h1 className="text-3xl">No company on this account yet</h1>
        <p className="mt-2 text-ink-muted">
          Companies and their logins are set up by APX. If you were expecting access to a company, ask the APX team
          to add your email to it, then sign in again.
        </p>
        <form action="/auth/sign-out" method="post" className="mt-6">
          <button type="submit" className="rounded-xl border border-line px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-accent/60 hover:bg-accent-soft hover:text-accent">
            Sign out
          </button>
        </form>
      </div>
    </BrandedScreen>
  );
}
