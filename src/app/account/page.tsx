import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { ProfileForm } from './profile-form';
import { BrandedScreen } from '@/components/dashboard/branded-screen';

export const dynamic = 'force-dynamic';

interface ProfileRow {
  full_name: string | null;
  email: string;
  timezone: string;
}

export default async function AccountPage() {
  const db = await createUserClient();
  const { data: session } = await db.auth.getUser();
  if (!session.user) redirect('/sign-in?next=/account');

  const { data } = await db.schema('api').rpc('my_profile');
  const profile = (data as ProfileRow[] | null)?.[0];

  return (
    <BrandedScreen width="2xl" panel={false}>
      <PageHeader title="Your account" description="Your details and how you sign in." />
      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <CardHeader title="Your details" />
          <CardBody>
            <ProfileForm
              fullName={profile?.full_name ?? ''}
              email={profile?.email ?? session.user.email ?? ''}
              timezone={profile?.timezone ?? 'Europe/London'}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Two-step sign-in"
            description="An authenticator code in addition to your password. Required for MOTION staff accounts."
          />
          <CardBody>
            <ButtonLink href="/account/mfa" tone="secondary">Set up two-step sign-in</ButtonLink>
          </CardBody>
        </Card>
      </div>
    </BrandedScreen>
  );
}
