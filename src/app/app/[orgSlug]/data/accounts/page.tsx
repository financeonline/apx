import { ListChecks } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, Banner } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody } from '@/components/ui/table';
import { CATEGORY_LABELS, loadAccountsPage } from '@/modules/dashboard';
import { AccountRowView } from './account-map-form';
import { isLoanCategory } from '@/modules/financials';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * The chart of accounts and its category mapping (ROUTE_ARCHITECTURE.md §4; UX_ARCHITECTURE.md §4
 * level 4, "unmapped accounts → /data/accounts").
 *
 * The page exists to fix unmapped accounts, so they come first — every one of them is money the
 * engine has had to park in a holding category, and a list in alphabetical order would bury the
 * only rows that need a decision.
 */
export default async function AccountsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  const view = await loadAccountsPage(ctx.db, ctx.orgId!, ctx.requestId);
  const canEdit = can(ctx, 'financials.edit');
  const hasLoans = view.rows.some((row) => isLoanCategory(row.account.standardCategory));

  return (
    <>
      <PageHeader
        eyebrow="Data"
        title="Accounts and categories"
        description="Every account name found in your files, and the category it is added up under in your reports — Revenue, Payroll or Marketing, for example. If an account sits under the wrong category, your profit figures will be wrong, so it is worth a quick check."
      />

      {view.unmappedCount > 0 ? (
        <div className="mb-6">
          <Banner
            tone="warn"
            title={
              view.unmappedCount === 1
                ? 'One account still needs a category'
                : `${view.unmappedCount} accounts still need a category`
            }
          >
            Until an account has a category, whatever went through it sits outside your profit
            figures. Those accounts are listed first below — pick a category for each and press Save.
          </Banner>
        </div>
      ) : null}

      <Card>
        <CardHeader
          icon={<ListChecks />}
          tint="violet"
          title="Your accounts (the chart of accounts)"
          description={
            canEdit
              ? 'To move an account, pick a new category and press Save. The change applies to every month the account appears in, and your figures are updated.'
              : 'Owners, admins, accountants and your Financial Analyst can change a category here.'
          }
        />
        <CardBody className="px-0 py-0">
          {hasLoans ? (
            <p className="px-6 pt-4 text-sm text-ink-muted">
              For each loan, choose whether it is secured (backed by something the business owns, such as
              property or equipment) or unsecured. APX does not guess this from the name.
            </p>
          ) : null}
          <TableWrap>
            <caption className="sr-only">
              Accounts with their category and how sure we are that it is right
            </caption>
            <THead columns={['Code', 'Account', 'Category', 'Checked?']} />
            <TBody>
              {view.rows.map((row) => (
                <AccountRowView
                  key={row.account.id}
                  orgSlug={orgSlug}
                  row={row}
                  categories={view.categories}
                  categoryLabels={CATEGORY_LABELS}
                  canEdit={canEdit}
                  isLoan={isLoanCategory(row.account.standardCategory)}
                />
              ))}
            </TBody>
          </TableWrap>
        </CardBody>
      </Card>
    </>
  );
}
