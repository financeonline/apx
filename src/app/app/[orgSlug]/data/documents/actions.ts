'use server';

import { revalidatePath } from 'next/cache';
import { assertCan } from '@/core/permissions';
import { deleteDocument } from '@/modules/documents';
import { getAccessContext } from '@/modules/tenancy';
import { done, fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/** Deleting a stored file (ROUTE_ARCHITECTURE.md §127). `api.delete_document` is the rule. */
export async function deleteDocumentAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'imports.review');
    await deleteDocument(ctx, text(form, 'document_id'));
    revalidatePath(`/app/${orgSlug}/data/documents`);
    return done('The file has been deleted.');
  } catch (error) {
    return fail(error, { requestId, action: 'documents.delete' });
  }
}
