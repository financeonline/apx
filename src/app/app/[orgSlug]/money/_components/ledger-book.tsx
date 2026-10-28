import Link from 'next/link';
import { FileText, HandCoins, Receipt } from 'lucide-react';
import { Card, CardHeader, CardBody, PageHeader } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate } from '@/components/labels';
import { MoneyNoInvoicesEmpty } from '@/components/dashboard';
import type { LedgerBookView } from '@/modules/dashboard';
import { PeriodHeading } from './period-heading';
import { FigureTable } from './figures';

/**
 * Owed to you and You owe (ROUTE_ARCHITECTURE.md §4; UX_ARCHITECTURE.md §6).
 *
 * One component for both because they are the same page with the invoices pointing the other way,
 * and a second copy would be a second place for the aging rule or the empty copy to drift.
 *
 * The totals — what you are owed, what is overdue, how many days — are snapshots. The list beneath
 * is the evidence for them: invoices, bucketed by how late they are from their own due dates. The
 * list is never added up here (§4).
 */
export function LedgerBookPage({
  orgSlug,
  title,
  description,
  route,
  view,
}: {
  orgSlug: string;
  title: string;
  description: string;
  route: 'receivables' | 'payables';
  view: LedgerBookView;
}) {
  const comparison = view.scope.previous?.label ?? 'the previous month';
  // The other side of the invoice, named for who it is rather than a generic "Name".
  const party = route === 'receivables' ? 'Customer' : 'Supplier';

  return (
    <>
      <PeriodHeading
        eyebrow="Money"
        title={title}
        description={description}
        scope={view.scope}
        hrefFor={(id) => `/app/${orgSlug}/money/${route}?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="This month" icon={route === 'receivables' ? <HandCoins /> : <Receipt />} />
          <CardBody className="px-0 py-0">
            <FigureTable
              rows={view.figures}
              caption={`${title} for ${view.scope.period.label}`}
              comparisonLabel={comparison}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Unpaid invoices"
            description={
              // The list comes oldest due date first (the repository's order), so the most overdue lead.
              view.truncated
                ? 'The first 200 unpaid invoices are shown, the longest overdue first.'
                : 'The longest overdue first, so you can see who to chase.'
            }
            icon={<FileText />}
            tint="pink"
          />
          <CardBody className={view.invoices.length === 0 ? '' : 'px-0 py-0'}>
            {view.invoices.length === 0 ? (
              <NoInvoices orgSlug={orgSlug} />
            ) : (
              <TableWrap stack>
                <caption className="sr-only">Unpaid invoices with how late each one is</caption>
                <THead columns={['Invoice', party, 'Issued', 'Due', 'How late', 'Still unpaid']} />
                <TBody>
                  {view.invoices.map((invoice) => (
                    <TR key={invoice.id}>
                      <TD className="tabular max-sm:font-medium">{invoice.number}</TD>
                      <TD label={party}>
                        <Link
                          href={`/app/${orgSlug}/customers/${invoice.counterpartyId}`}
                          className="underline underline-offset-2"
                        >
                          {invoice.counterpartyName}
                        </Link>
                      </TD>
                      <TD className="whitespace-nowrap tabular" label="Issued">{formatDate(invoice.issueDate)}</TD>
                      <TD className="whitespace-nowrap tabular" label="Due">
                        {invoice.dueDate ? formatDate(invoice.dueDate) : '—'}
                      </TD>
                      <TD className="whitespace-nowrap" label="How late">{invoice.bucketLabel}</TD>
                      <TD className="whitespace-nowrap text-right tabular" label="Still unpaid">{invoice.balanceDue}</TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/**
 * §6 "Money → Owed to you / You owe, no invoices".
 *
 * The copy is the shared component's, not a paraphrase written here: §6 says "exact copy", and a
 * second wording of the same empty state is the easiest regression in the product to introduce and
 * the hardest to notice.
 */
export function NoInvoices({ orgSlug }: { orgSlug: string }) {
  return <MoneyNoInvoicesEmpty addDataHref={`/app/${orgSlug}/data/imports/new`} />;
}

/** The same empty state before any month has figures, so the page never renders bare. */
export function LedgerBookEmpty({ orgSlug, title }: { orgSlug: string; title: string }) {
  return (
    <>
      <PageHeader eyebrow="Money" title={title} />
      <NoInvoices orgSlug={orgSlug} />
    </>
  );
}
