import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { ButtonLink } from '@/components/ui/button';
import { ProfileForm } from './profile-form';
import { BrandedScreen } from '@/components/dashboard/branded-screen';
import { KeyRound } from 'lucide-react';
import { formatDateTime } from '@/components/labels';
import { AiKeyForm } from './ai-key-form';
import { SignOutButton } from '@/components/dashboard/sign-out-button';

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

  // ADR-157: the AI provider key is managed here, by a super admin only; nobody else's profile shows
  // it. Its status is readable only at aal2 (two-step sign-in), as every platform action is.
  const { data: roleRows } = await db.schema('api').rpc('my_platform_role');
  const role = (roleRows as Array<{ platform_role: string; status: string; has_aal2: boolean }> | null)?.[0];
  const superAdmin = role?.platform_role === 'super_admin' && role.status === 'active';
  let aiKey: { configured: boolean; ending: string | null; updatedAt: string | null } | null = null;
  if (superAdmin && role.has_aal2) {
    const { data: keyRows } = await db.schema('api').rpc('ai_api_key_status');
    const row = (keyRows as Array<{ configured: boolean; ending: string | null; updated_at: string | null }> | null)?.[0];
    aiKey = { configured: row?.configured === true, ending: row?.ending ?? null, updatedAt: row?.updated_at ?? null };
  }
  const serverFallback = Boolean(process.env.ANTHROPIC_API_KEY);

  return (
    <BrandedScreen width="2xl" panel={false}>
      <PageHeader
        title="Your account" description="Your details and how you sign in."
        action={<SignOutButton className="w-36 rounded-xl border border-line bg-surface" />}
      />
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
        {superAdmin ? (
          <Card>
            <CardHeader
              icon={<KeyRound />} tint="pink" title="AI provider key"
              description="The Anthropic key every organisation's AI Analyst and document reading use. Only super admins see this."
            />
            <CardBody className="flex flex-col gap-4">
              {aiKey === null ? (
                <p className="text-sm text-ink">
                  Sign in with two-step sign-in to see or change the key. Set it up above, then sign out and back in with your code.
                </p>
              ) : (
                <>
                  <p className="text-sm text-ink" data-testid="ai-key-status">
                    {aiKey.configured
                      ? <>A key ending <span className="font-mono">…{aiKey.ending}</span> is stored{aiKey.updatedAt ? `, set ${formatDateTime(aiKey.updatedAt)}` : ''}.</>
                      : serverFallback
                        ? 'No key is stored here; the AI is using the key in the server settings.'
                        : 'No key is set, so the AI is switched off until one is added.'}
                  </p>
                  <AiKeyForm configured={aiKey.configured} />
                </>
              )}
            </CardBody>
          </Card>
        ) : null}
      </div>
    </BrandedScreen>
  );
}
