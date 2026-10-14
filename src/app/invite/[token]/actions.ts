'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { acceptInvitation, landingPathForRole, listMyOrganizations } from '@/modules/tenancy';
import { newRequestId } from '@/core/logging';
import { fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

export async function acceptInvitationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const requestId = newRequestId();
  let landing: string | null = null;
  try {
    const db = await createUserClient();
    const organizationId = await acceptInvitation(db, text(form, 'token'), requestId);
    const organizations = await listMyOrganizations(db);
    const joined = organizations.find((o) => o.organizationId === organizationId);
    // Departments — or Home for a 3rd party, who would otherwise land on a refusal (ADR-172).
    landing = joined ? landingPathForRole(joined.slug, joined.role) : null;
  } catch (error) {
    return fail(error, { requestId, action: 'invite.accept' });
  }
  redirect(landing ?? '/select-organization');
}
