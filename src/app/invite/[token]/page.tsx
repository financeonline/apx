import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { PageHeader } from '@/components/ui/surfaces';
import { AcceptInvitation } from './accept-invitation';

export const dynamic = 'force-dynamic';

/**
 * The token is never looked up from the table: validity is decided inside api.accept_invitation,
 * which binds the invitation to the JWT email and re-checks the inviter (DATABASE_ARCHITECTURE.md §1).
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/sign-in?next=/invite/${encodeURIComponent(token)}`);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-6 py-12">
      <PageHeader
        title="You have been invited to MOTION"
        description="Accepting adds your account to the organisation that invited you."
      />
      <AcceptInvitation token={token} />
    </main>
  );
}
