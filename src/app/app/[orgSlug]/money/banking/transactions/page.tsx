import Link from 'next/link';
import { ArrowLeftRight } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { PageHeader, Card, CardHeader, CardBody, EmptyState, Badge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { formatDate } from '@/components/labels';
import { loadBankTransactionsPage, loadPeriodScope, parseListFilter, type BankingListFilter } from '@/modules/dashboard';
import { PeriodHeading } from '../../_components/period-heading';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Bank transactions, one month at a time, paged and filtered on the server (Phase 13 brief §26).
 * The table shows `descriptionNormalized` and nothing else — the raw text is not selectable by any
 * role (ADR-044.2). Each line opens its own page; nothing technical (ids, table names) is printed.
 */
const FILTERS: ReadonlyArray<{ key: BankingListFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'in', label: 'Money in' },
  { key: 'out', label: 'Money out' },
  { key: 'uncategorised', label: 'Not yet categorised' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'lookalike', label: 'Look like transfers' },
];

export default async function BankTransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ period?: string; account?: string; filter?: string; page?: string; recurring?: string }>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'banking.view');

  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, query.period ?? null, ctx.requestId);
  if (!scope) {
    return (
      <>
        <PageHeader eyebrow="Banking" title="Transactions" />
        <EmptyState title="No transactions yet" actionHref={`/app/${orgSlug}/data/imports/new`} actionLabel="Add data">
          Upload a bank statement and every line in it will appear here.
        </EmptyState>
      </>
    );
  }

  const pageNumber = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const recurring = query.recurring && /^[0-9a-f-]{36}$/i.test(query.recurring) ? query.recurring : undefined;
  const account = query.account && /^[0-9a-f-]{36}$/i.test(query.account) ? query.account : undefined;
  const view = await loadBankTransactionsPage(ctx.db, ctx.orgId!, orgSlug, scope, {
    ...(account ? { accountId: account } : {}),
    ...(recurring ? { recurringGroupId: recurring } : {}),
    filter: parseListFilter(query.filter),
    page: pageNumber,
  }, ctx.requestId);

  const base = `/app/${orgSlug}/money/banking/transactions`;
  const href = (over: { period?: string; account?: string | null; filter?: BankingListFilter; page?: number }) => {
    const p = new URLSearchParams();
    if (!recurring) p.set('period', over.period ?? scope.period.id);
    if (recurring) p.set('recurring', recurring);
    const acct = over.account === undefined ? view.account?.id : over.account;
    if (acct) p.set('account', acct);
    const filter = over.filter ?? view.filter;
    if (filter !== 'all') p.set('filter', filter);
    if ((over.page ?? 1) > 1) p.set('page', String(over.page));
    return `${base}?${p.toString()}`;
  };
  const pages = view.pages;

  return (
    <>
      {recurring ? (
        <PageHeader eyebrow="Banking" title="One regular payment, every time it happened" description={view.source} action={<Link href={`/app/${orgSlug}/money/banking`} className="text-sm text-ink-muted hover:text-ink">Back to Banking</Link>} />
      ) : (
        <PeriodHeading
          eyebrow="Banking"
          title={view.account ? `Transactions — ${view.account.name}` : 'Transactions'}
          description={view.source}
          scope={scope}
          hrefFor={(id) => href({ period: id, page: 1 })}
        />
      )}

      <Card>
        <CardHeader
          title={`${view.total} transaction${view.total === 1 ? '' : 's'}`}
          icon={<ArrowLeftRight />}
          action={
            <nav aria-label="Filter transactions" className="flex flex-wrap gap-2 text-sm">
              {FILTERS.map((f) => (
                <Link key={f.key} href={href({ filter: f.key, page: 1 })} aria-current={view.filter === f.key ? 'page' : undefined}
                  className={view.filter === f.key ? 'rounded-full bg-accent-soft px-3 py-1 font-medium text-accent' : 'rounded-full bg-surface-sunken px-3 py-1 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent'}>
                  {f.label}
                </Link>
              ))}
            </nav>
          }
        />
        {view.accounts.length > 1 && !recurring ? (
          <div className="border-b border-line px-5 py-2 text-sm">
            <span className="text-ink-muted">Account: </span>
            <Link href={href({ account: null, page: 1 })} className={view.account ? 'text-ink-muted hover:text-ink' : 'text-ink'}>All</Link>
            {view.accounts.map((a) => (
              <span key={a.id}>{' · '}<Link href={href({ account: a.id, page: 1 })} className={view.account?.id === a.id ? 'text-ink' : 'text-ink-muted hover:text-ink'}>{a.name}</Link></span>
            ))}
          </div>
        ) : null}
        <CardBody className="px-0 py-0">
          {view.rows.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-muted">
              {view.filter === 'uncategorised' ? 'Every transaction here has a category. Nothing to do.' : 'No transactions match.'}
            </p>
          ) : (
            <TableWrap>
              <caption className="sr-only">Bank transactions</caption>
              <THead columns={['Date', 'Description', 'Account', 'Category', 'Amount']} />
              <TBody>
                {view.rows.map((row) => (
                  <TR key={row.id}>
                    <TD className="whitespace-nowrap tabular">{formatDate(row.date)}</TD>
                    <TD>
                      <Link href={row.href} className="text-ink hover:underline">{row.description}</Link>
                      {row.transferKind ? <span className="ml-2 text-xs text-ink-muted">{row.transferKind}</span> : null}
                      {row.recurring ? <span className="ml-2 text-xs text-ink-muted">regular</span> : null}
                    </TD>
                    <TD className="text-ink-muted">{row.accountName}</TD>
                    <TD>{row.uncategorised ? <Badge tone="warn">{row.categoryLabel}</Badge> : row.categoryLabel}</TD>
                    <TD className="whitespace-nowrap text-right tabular">{row.amount}</TD>
                  </TR>
                ))}
              </TBody>
            </TableWrap>
          )}
        </CardBody>
        {pages > 1 ? (
          <nav aria-label="Pages" className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
            {view.page > 1 ? <Link href={href({ page: view.page - 1 })} className="text-ink-muted hover:text-ink">Previous</Link> : <span />}
            <span className="text-ink-muted">Page {view.page} of {pages}</span>
            {view.page < pages ? <Link href={href({ page: view.page + 1 })} className="text-ink-muted hover:text-ink">Next</Link> : <span />}
          </nav>
        ) : null}
      </Card>
    </>
  );
}
