import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { sessionUserOf } from '@/modules/tenancy';
import { PageHeader } from '@/components/ui/surfaces';
import { AcceptInvitation } from './accept-invitation';
import { BrandedScreen } from '@/components/dashboard/branded-screen';

export const dynamic = 'force-dynamic';

/**
 * The token is never looked up from the table: validity is decided inside api.accept_invitation,
 * which binds the invitation to the signed-in account's email and re-checks the inviter (DATABASE_ARCHITECTURE.md §1).
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = await createUserClient();
  if (!sessionUserOf(db)) redirect(`/sign-in?next=/invite/${encodeURIComponent(token)}`);

  return (
    <BrandedScreen width="lg">
      <PageHeader
        title="You have been invited to APX"
        description="Accepting adds your account to the organisation that invited you."
      />
      <AcceptInvitation token={token} />
    </BrandedScreen>
  );
}
