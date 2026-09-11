import { getAccessContext } from '@/modules/tenancy';
import { PageHeader, Card, CardBody } from '@/components/ui/surfaces';
import { UploadForm } from './upload-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Add data (IMPORT_ENGINE.md §2; ROUTE_ARCHITECTURE.md §4).
 *
 * The first screen of the journey every other page depends on: until a file goes through here,
 * MOTION has nothing to calculate. It is deliberately short — the questions it asks are the ones
 * that cannot be inferred safely, and nothing else.
 */
export default async function NewImportPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  // Hidden in the navigation for a role that lacks it; a deep link gets the uniform not-found (§7.4).
  requirePermission(ctx, 'imports.create');

  const { data } = await ctx.db
    .from('bank_accounts')
    .select('id, name, account_number_masked')
    .eq('organization_id', ctx.orgId!)
    .eq('is_active', true)
    .order('name');

  const bankAccounts = ((data ?? []) as Array<{
    id: string; name: string; account_number_masked: string | null;
  }>).map((row) => ({
    id: row.id,
    label: row.account_number_masked === null
      ? row.name : `${row.name} · ${row.account_number_masked}`,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Data"
        title="Add data"
        description="Upload a statement, ledger or invoice list. We check every row before anything is imported."
      />

      <div className="mt-8">
        <Card>
          <CardBody>
            <UploadForm orgSlug={orgSlug} bankAccounts={bankAccounts} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
