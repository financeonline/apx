import Link from 'next/link';
import {
  ArrowLeftRight, ChevronRight, CircleAlert, Gauge, Landmark, ChartPie, Plus, Repeat, Scale,
} from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, EmptyState, Badge, Banner, DetailList, IconBadge } from '@/components/ui/surfaces';
import { TableWrap, THead, TBody, TR, TD } from '@/components/ui/table';
import { CLICKABLE_CARD, CardLink, TOUCH_TARGET } from '@/components/ui/clickable-card';
import { formatDate } from '@/components/labels';
import { MetricCard, DATA_QUALITY_NOTE_TEXT, StatusBadgeView } from '@/components/dashboard';
import {
  BANK_SOURCE_SENTENCE, loadBankAccountsForBalances, loadBankingOverview, loadPeriodScope,
  type BankAccountCardView, type NoticeView, type ReconciliationStatus,
} from '@/modules/dashboard';
import { PeriodHeading } from '../_components/period-heading';
import { WhyLink } from '../_components/figures';
import { AddAccountForm } from './add-account-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Banking (Phase 13, ADR-101; REQ-BK-01…11; UX_ARCHITECTURE.md §4).
 *
 * The page a business owner reads, in the order they ask the questions: how much cash is there,
 * what came in and went out this month, what should I notice, which accounts — and, opened only
 * if they want it, the regular payments, where the money went, the liquidity indicators and the
 * reconciliation. Every figure is the engine's or an aggregation of the same rows; every page
 * says, in the same sentence, that the data is imported statements and not a bank connection.
 */
const RECONCILIATION_TONE: Readonly<Record<ReconciliationStatus, 'neutral' | 'accent' | 'warn' | 'danger'>> = {
  reconciled: 'accent', unreconciled: 'danger', balances_missing: 'warn', no_statement: 'neutral',
};

export default async function BankingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'banking.view');
  const mayAddAccount = can(ctx, 'financials.edit');

  const [scope, currency] = await Promise.all([
    loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId),
    baseCurrency(ctx),
  ]);

  if (!scope) {
    const accounts = await loadBankAccountsForBalances(ctx.db, ctx.orgId!, ctx.requestId);
    return (
      <>
        <PageHeader eyebrow="Money" title="Banking" description={BANK_SOURCE_SENTENCE} />
        <EmptyState
          title={accounts.length === 0 ? 'Add a bank account, then upload its statement' : 'No bank statement has been imported yet'}
          actionHref={accounts.length === 0 ? undefined : `/app/${orgSlug}/data/imports/new`}
          actionLabel={accounts.length === 0 ? undefined : 'Add data'}
        >
          Upload a statement as a CSV, spreadsheet or PDF and this page will show your cash, what
          came in and went out, and anything worth a look.
        </EmptyState>
        {mayAddAccount ? (
          <div className="mt-6">
            <Card>
              <CardHeader title="Add a bank account" description="Statements are matched to an account, so the account comes first." icon={<Plus />} />
              <CardBody><AddAccountForm orgSlug={orgSlug} currency={currency} /></CardBody>
            </Card>
          </div>
        ) : null}
      </>
    );
  }

  const view = await loadBankingOverview(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId);
  const [cash, moneyIn, moneyOut, net] = [
    view.headline.find((f) => f.metricKey === 'closing_cash'),
    view.headline.find((f) => f.metricKey === 'cash_inflows'),
    view.headline.find((f) => f.metricKey === 'cash_outflows'),
    view.headline.find((f) => f.metricKey === 'net_cash_movement'),
  ];
  const txHref = `/app/${orgSlug}/money/banking/transactions?period=${scope.period.id}`;

  return (
    <>
      <PeriodHeading
        eyebrow="Money"
        title="Banking"
        description={view.source.sentence}
        scope={scope}
        hrefFor={(id) => `/app/${orgSlug}/money/banking?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        <Banner tone="info" title="Based on imported statements" >
          {view.source.lastStatement
            ? <>Last statement imported {formatDate(view.source.lastStatement.committedAt)}, covering to {formatDate(view.source.lastStatement.coveringTo)}{view.source.lastStatement.accountName ? ` (${view.source.lastStatement.accountName})` : ''}. Nothing updates on its own: upload the next statement when you have it.</>
            : <>No statement has been imported yet.</>}
        </Banner>

        {/* Level 1 — cash available */}
        <section aria-labelledby="cash-heading" data-testid="banking-cash">
          <h2 id="cash-heading" className="sr-only">Cash available</h2>
          {cash ? (
            <MetricCard card={cash} />
          ) : (
            <Card><CardBody><p className="text-sm text-ink-muted">APX cannot show a cash balance for {scope.period.label} yet — usually because an opening balance is missing. The movements below are still real.</p></CardBody></Card>
          )}
        </section>

        {/* Level 2 — this month */}
        <section aria-labelledby="month-heading">
          <div className="flex items-center gap-3">
            <IconBadge tint="violet" size="sm"><ArrowLeftRight /></IconBadge>
            <h2 id="month-heading" className="font-serif text-lg text-ink">This month</h2>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="banking-month">
            {[moneyIn, moneyOut, net].map((figure, i) => figure
              ? <MetricCard key={figure.metricKey} card={figure} variant="compact" />
              : <Card key={i}><CardBody><p className="text-sm text-ink-muted">Not available</p></CardBody></Card>)}
          </div>
        </section>

        {/* Level 3 — things to notice */}
        <Card>
          <CardHeader title="Things to notice" description={view.notices.length === 0 ? undefined : 'Worked out from your statements by APX’s rules — nothing here was guessed.'} icon={<CircleAlert />} tint="pink" />
          <CardBody>
            {view.notices.length === 0 ? (
              <p className="text-sm text-ink-muted">Nothing unusual in {scope.period.label}.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm" data-testid="banking-notices">
                {view.notices.map((notice, i) => <NoticeItem key={i} notice={notice} />)}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Accounts */}
        <Card>
          <CardHeader
            title="Accounts"
            description="Balances are the ones printed on your statements; money in and out leave transfers between your own accounts out, the same way your cash figures do."
            action={<Link href={txHref} className={`inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft ${TOUCH_TARGET}`}>All transactions ({view.counts.transactions}) <ChevronRight aria-hidden="true" className="size-4" /></Link>}
            icon={<Landmark />}
          />
          <CardBody>
            {view.accounts.length === 0 ? (
              <p className="text-sm text-ink-muted">No bank accounts yet.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="banking-accounts">
                {view.accounts.map((account) => <AccountCard key={account.id} account={account} />)}
              </ul>
            )}
          </CardBody>
        </Card>

        {mayAddAccount ? (
          // Open when there is no account yet, and reachable by link (`#add-account`) from the upload form,
          // so "add a bank account first" leads straight to the form (owner, 2026-10-14).
          <details id="add-account" className="panel scroll-mt-6 rounded-card" open={view.accounts.length === 0}>
            <summary className="flex cursor-pointer items-center gap-3 px-5 py-4 font-serif text-lg text-ink"><IconBadge tint="violet" size="sm"><Plus /></IconBadge>Add a bank account</summary>
            <div className="border-t border-line px-5 py-5"><AddAccountForm orgSlug={orgSlug} currency={currency} /></div>
          </details>
        ) : null}

        {/* Progressive disclosure */}
        <details className="panel rounded-card" data-testid="banking-recurring">
          <summary className="flex cursor-pointer items-center gap-3 px-5 py-4 font-serif text-lg text-ink">
            <IconBadge tint="pink" size="sm"><Repeat /></IconBadge>
            Regular payments{view.recurring.length > 0 ? ` (${view.recurring.length})` : ''}
          </summary>
          <div className="border-t border-line">
            {view.recurring.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-muted">APX needs at least three occurrences of a payment before it calls it regular. Nothing qualifies yet.</p>
            ) : (
              <TableWrap stack>
                <caption className="sr-only">Regular payments detected from your statements</caption>
                <THead columns={['What', 'How often', 'Usually', 'Last time', 'Status']} />
                <TBody>
                  {view.recurring.map((r) => (
                    <TR key={r.id}>
                      <TD>
                        <Link href={r.href} className="text-ink hover:underline">{r.description}</Link>
                        <span className="block text-xs text-ink-muted">{r.direction === 'in' ? 'Money in' : 'Money out'} · {r.accountName} · seen {r.occurrences} times</span>
                      </TD>
                      <TD className="text-ink-muted" label="How often">{r.cadenceLabel}</TD>
                      <TD className="whitespace-nowrap tabular" label="Usually">{r.expected}</TD>
                      <TD className="whitespace-nowrap tabular" label="Last time">{r.last}{r.changed ? <span className="ml-2 text-xs text-warn">changed</span> : null}<span className="block text-xs text-ink-muted">{formatDate(r.lastSeen)}</span></TD>
                      <TD label="Status"><Badge tone={r.status === 'changed' ? 'warn' : r.status === 'stopped' ? 'neutral' : 'accent'}>{r.statusLabel}</Badge></TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
          </div>
        </details>

        <details className="panel rounded-card" data-testid="banking-categories">
          <summary className="flex cursor-pointer items-center gap-3 px-5 py-4 font-serif text-lg text-ink"><IconBadge tint="violet" size="sm"><ChartPie /></IconBadge>Where the money went</summary>
          <div className="border-t border-line">
            <p className="px-5 pt-4 text-sm text-ink-muted">Money out by category, from your bank statements. This is what left the bank, not a profit and loss: transfers between your own accounts and card repayments are left out.</p>
            {view.categories.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-muted">No movements in {scope.period.label}.</p>
            ) : (
              <TableWrap stack>
                <caption className="sr-only">Money out by category for {scope.period.label}</caption>
                <THead columns={['Category', 'Money out', 'Share', 'Money in']} />
                <TBody>
                  {view.categories.map((c) => (
                    <TR key={c.category}>
                      <TD>{c.category === 'uncategorised' ? <Badge tone="warn">{c.label}</Badge> : c.label}</TD>
                      <TD className="whitespace-nowrap text-right tabular" label="Money out">{c.outflow}</TD>
                      <TD className="whitespace-nowrap text-right tabular text-ink-muted" label="Share">{c.share ?? '—'}</TD>
                      <TD className="whitespace-nowrap text-right tabular text-ink-muted" label="Money in">{c.inflow}</TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            )}
          </div>
        </details>

        <details className="panel rounded-card" data-testid="banking-liquidity">
          <summary className="flex cursor-pointer items-center gap-3 px-5 py-4 font-serif text-lg text-ink"><IconBadge tint="pink" size="sm"><Gauge /></IconBadge>How liquid are we?</summary>
          <div className="border-t border-line px-5 py-5">
            <DetailList items={[
              { label: 'Cash available', value: view.liquidity.cashAvailable ? <span className="tabular">{view.liquidity.cashAvailable.value} <StatusBadgeView status={view.liquidity.cashAvailable.status} size="sm" /> <WhyLink row={view.liquidity.cashAvailable} /></span> : <span className="text-ink-muted">Not available — an opening balance is needed</span> },
              { label: 'How long it would last', value: view.liquidity.runway ? <span className="tabular">{view.liquidity.runway.value} <StatusBadgeView status={view.liquidity.runway.status} size="sm" /> <WhyLink row={view.liquidity.runway} /></span> : <span className="text-ink-muted">Needs three months of figures</span> },
              { label: 'Change in cash this month', value: view.liquidity.netMovement ? <span className="tabular">{view.liquidity.netMovement.value}</span> : <span className="text-ink-muted">Not available</span> },
              { label: 'Trend', value: view.liquidity.trend.sentence },
              { label: 'Where the cash sits', value: view.liquidity.concentration.sentence },
            ]} />
          </div>
        </details>

        <details className="panel rounded-card" data-testid="banking-reconciliation">
          <summary className="flex cursor-pointer items-center gap-3 px-5 py-4 font-serif text-lg text-ink"><IconBadge tint="violet" size="sm"><Scale /></IconBadge>Do the statements and APX agree?</summary>
          <div className="border-t border-line px-5 py-5 flex flex-col gap-4 text-sm">
            <p>{view.reconciliation.sentence}</p>
            {view.reconciliation.statementClosing ? (
              <DetailList items={[
                { label: 'Statements say', value: <span className="tabular">{view.reconciliation.statementClosing}</span> },
                { label: 'APX works out', value: <span className="tabular">{view.reconciliation.motionClosing}</span> },
                { label: 'Difference', value: <span className="tabular">{view.reconciliation.delta}</span> },
              ]} />
            ) : null}
            <ul className="flex flex-col gap-2">
              {view.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={RECONCILIATION_TONE[a.reconciliation.status]}>{a.reconciliation.label}</Badge>
                  <span className="text-ink">{a.name}</span>
                  <span className="text-ink-muted">— {a.reconciliation.sentence}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-ink-faint">A line on a statement is never marked reconciled just because it was imported. Matching lines to your accounting records one by one is not part of APX yet.</p>
          </div>
        </details>

        {view.dataQualityCodes.length > 0 ? (
          <p className="text-sm text-ink-muted" data-testid="banking-quality">
            A note on these figures: {view.dataQualityCodes.map((code) => DATA_QUALITY_NOTE_TEXT[code] ?? code.replace(/_/g, ' ')).join('; ')}.
          </p>
        ) : null}
      </div>
    </>
  );
}

function NoticeItem({ notice }: { notice: NoticeView }) {
  const dot = notice.tone === 'danger' ? 'bg-danger' : notice.tone === 'warn' ? 'bg-warn' : 'bg-ink-faint';
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
      {notice.href ? <Link href={notice.href} className="text-ink hover:underline">{notice.text}</Link> : <span>{notice.text}</span>}
    </li>
  );
}

/**
 * One account. The whole card opens its transactions (owner, 2026-10-14): "See transactions" is its
 * one link, stretched over it (`ui/clickable-card`). In, out and net sit three abreast where there is
 * room and wrap where there is not, so a large figure never runs out of its box.
 */
function AccountCard({ account }: { account: BankAccountCardView }) {
  return (
    <li className={`rounded-2xl border border-line bg-surface p-4 ${CLICKABLE_CARD}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 gap-3">
          <IconBadge tint="pink" size="sm"><Landmark /></IconBadge>
          <div className="min-w-0">
            <h3 className="font-serif text-lg text-ink">{account.name}</h3>
            <p className="text-xs text-ink-muted">{account.bankName} · {account.reference} · {account.typeLabel}</p>
          </div>
        </div>
        <Badge tone={RECONCILIATION_TONE[account.reconciliation.status]}>{account.reconciliation.label}</Badge>
      </div>
      <p className="mt-3 font-mono text-xl tabular-nums text-ink">
        {account.statementBalance ? account.statementBalance.value : <span className="text-ink-muted">—</span>}
      </p>
      <p className="text-xs text-ink-muted">
        {account.statementBalance
          ? `Balance on the statement at ${formatDate(account.statementBalance.asAt)}`
          : account.freshness ? 'The statement carries no running balance' : 'No statement for this month'}
      </p>
      <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2 rounded-xl bg-surface-sunken p-3 text-sm">
        <div><dt className="text-xs uppercase tracking-wide text-ink-faint">In</dt><dd className="tabular">{account.moneyIn}</dd></div>
        <div><dt className="text-xs uppercase tracking-wide text-ink-faint">Out</dt><dd className="tabular">{account.moneyOut}</dd></div>
        <div><dt className="text-xs uppercase tracking-wide text-ink-faint">Net</dt><dd className="tabular">{account.net}</dd></div>
      </dl>
      {account.transfersBetweenOwnAccounts ? <p className="mt-2 text-xs text-ink-muted">Plus {account.transfersBetweenOwnAccounts} moved between your own accounts.</p> : null}
      <p className="mt-2 text-xs text-ink-muted">
        {account.freshness
          ? `Statement covering to ${formatDate(account.freshness.coveringTo)}, added ${formatDate(account.freshness.committedAt)}.`
          : 'No statement covers this month.'}
        {account.needsOpeningBalance ? ' Opening balance not entered yet.' : ''}
      </p>
      <p className="mt-2 text-sm"><CardLink href={account.href} className="text-ink-muted after:rounded-2xl hover:text-ink group-hover:text-ink">See transactions ({account.rowCount}{account.uncategorisedCount > 0 ? `, ${account.uncategorisedCount} uncategorised` : ''})</CardLink></p>
    </li>
  );
}

async function baseCurrency(ctx: Awaited<ReturnType<typeof getAccessContext>>): Promise<string> {
  const { data } = await ctx.db.from('organizations').select('base_currency').eq('id', ctx.orgId!).maybeSingle();
  return ((data as { base_currency?: string } | null)?.base_currency) ?? 'GBP';
}
