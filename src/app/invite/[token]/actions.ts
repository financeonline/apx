'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { acceptInvitation, listMyOrganizations } from '@/modules/tenancy';
import { newRequestId } from '@/core/logging';
import { fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

export async function acceptInvitationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const requestId = newRequestId();
  let slug: string | null = null;
  try {
    const db = await createUserClient();
    const organizationId = await acceptInvitation(db, text(form, 'token'), requestId);
    const organizations = await listMyOrganizations(db);
    slug = organizations.find((o) => o.organizationId === organizationId)?.slug ?? null;
  } catch (error) {
    return fail(error, { requestId, action: 'invite.accept' });
  }
  redirect(slug ? `/app/${slug}/home` : '/select-organization');
}
