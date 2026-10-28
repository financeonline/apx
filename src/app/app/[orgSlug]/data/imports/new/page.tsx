import { getAccessContext } from '@/modules/tenancy';
import { IMPORT_TYPE_SPECS, IMPORT_TYPES, pdfHandling } from '@/modules/imports';
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

  const { data: org } = await ctx.db.from('organizations').select('name').eq('id', ctx.orgId!).maybeSingle();

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
        description="Upload the files your business already has. APX reads them, checks every row, and shows you what it found before anything counts."
      />

      <div className="mt-8">
        <UploadGuide />
      </div>

      <div className="mt-6">
        <Card>
          <CardBody>
            <UploadForm
              orgSlug={orgSlug}
              bankAccounts={bankAccounts}
              bankAccountTypes={IMPORT_TYPES.filter((t) => IMPORT_TYPE_SPECS[t].bankAccount === 'required')}
              pdfReadTypes={IMPORT_TYPES.filter((t) => IMPORT_TYPE_SPECS[t].pdfSupported)}
              aiReadTypes={IMPORT_TYPES.filter((t) => pdfHandling(t) === 'read_on_request')}
              orgName={(org as { name?: string } | null)?.name ?? ''}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/**
 * Which files to bring, in what order, and what happens after "Upload and check" — the questions a
 * new client asks before their first upload. The order follows what each file unlocks: a bank
 * statement gives cash, the books give profit, invoice lists give who owes whom (the same order the
 * home page's first-run copy recommends).
 */
function UploadGuide() {
  return (
    <Card>
      <CardBody className="p-4 sm:p-6">
        <div className="grid gap-6 md:grid-cols-2">
          <section aria-labelledby="bring-heading">
            <h2 id="bring-heading" className="font-serif text-lg text-ink">What to bring, in this order</h2>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-ink-muted marker:text-ink-faint">
              <li>
                <span className="font-medium text-ink">Bank statements</span> — one for each business bank
                account, ideally the last 12 months. A CSV download from online banking works best; a PDF
                statement works too. This shows your cash.
              </li>
              <li>
                <span className="font-medium text-ink">Your books</span> — a general ledger, trial balance or
                profit and loss report exported from Xero, QuickBooks, Sage or similar. This shows your
                profit and costs.
              </li>
              <li>
                <span className="font-medium text-ink">Sales and purchase invoice lists</span> — including
                invoices that are still unpaid. This shows who owes you and who you owe.
              </li>
            </ol>
            <p className="mt-2 text-sm text-ink-muted">
              If you have them, a balance sheet and a budget add more. Not sure which kind a file is? Pick the
              closest — you check everything before it counts.
            </p>
          </section>
          <section aria-labelledby="next-heading">
            <h2 id="next-heading" className="font-serif text-lg text-ink">What happens next</h2>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-ink-muted marker:text-ink-faint">
              <li>
                <span className="font-medium text-ink">We read and check the file.</span> Nothing is added
                to your figures yet.
              </li>
              <li>
                <span className="font-medium text-ink">You review it.</span> Answer a few questions about the
                file and say what to do with any rows we could not read.
              </li>
              <li>
                <span className="font-medium text-ink">You press Import.</span> The rows join your figures and
                everything is recalculated. If a file was wrong, you can remove it later from Imports.
              </li>
            </ol>
          </section>
        </div>
      </CardBody>
    </Card>
  );
}
