import { Landmark, PencilLine, Wallet } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardHeader, CardBody, EmptyState, DetailList, Banner } from '@/components/ui/surfaces';
import { loadBankAccountsForBalances, loadCash, loadPeriodScope } from '@/modules/dashboard';
import { PeriodHeading } from '../_components/period-heading';
import { FigureTable } from '../_components/figures';
import { OpeningBalanceForm } from './opening-balance-form';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Cash for one month (ROUTE_ARCHITECTURE.md §4; UX_ARCHITECTURE.md §4 bank-only variant, CD-06).
 *
 * Money in, money out, the change, the opening and closing balance and the runway — all read from
 * `metric_current`. When the opening balance is unknown the closing figure arrives as NULL with
 * `no_opening_cash`, which renders as "—" with that reason and puts the form on the page. It is
 * never shown as £0: a business with an unknown balance does not have no money (§1, §4).
 */
export default async function CashPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  const [scope, currency] = await Promise.all([
    loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId),
    baseCurrency(ctx.db, ctx.orgId!),
  ]);

  // No figures yet, but there may still be accounts waiting for an opening balance — which is
  // exactly the state the form exists for, so it is offered here too (§6, bank data only).
  if (!scope) {
    const accounts = await loadBankAccountsForBalances(ctx.db, ctx.orgId!, ctx.requestId);
    const waiting = accounts.filter((a) => a.needsOpeningBalance);
    return (
      <>
        <PageHeader eyebrow="Money" title="Cash" />
        <EmptyState
          title="There are no cash figures yet"
          actionHref={`/app/${orgSlug}/data/imports/new`}
          actionLabel="Add data"
        >
          Money in, money out and your cash balance come from bank statements. Upload one and this
          page will show what moved and what is left.
        </EmptyState>
        {waiting.length > 0 && can(ctx, 'financials.edit') ? (
          <div className="mt-6">
            <Card>
              <CardHeader
                title="Enter an opening balance"
                description="A statement says what moved, not what was there to begin with."
                icon={<PencilLine />}
              />
              <CardBody>
                <OpeningBalanceForm orgSlug={orgSlug} accounts={waiting} currency={currency} />
              </CardBody>
            </Card>
          </div>
        ) : null}
      </>
    );
  }

  const view = await loadCash(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId);
  const waiting = view.accounts.filter((a) => a.needsOpeningBalance);

  return (
    <>
      <PeriodHeading
        eyebrow="Money"
        title="Cash"
        description="What came in, what went out, and what is left in the bank."
        scope={scope}
        hrefFor={(id) => `/app/${orgSlug}/money/cash?period=${id}`}
      />

      <div className="flex flex-col gap-6">
        {/*
          ADR-124 D-2: an account the engine could not establish is named, never quietly left out of
          the total. The names come from the figure's own record of what it is missing.
        */}
        {view.missingAccounts.length > 0 ? (
          <Banner tone="warn" title="Your cash balance is not complete yet">
            Add a statement or an opening balance for {view.missingAccounts.join(', ')}.
          </Banner>
        ) : null}

        <Card>
          <CardHeader title="This month" icon={<Wallet />} />
          <CardBody className="px-0 py-0">
            <FigureTable
              rows={view.figures}
              caption={`Cash figures for ${scope.period.label}`}
              comparisonLabel={scope.previous?.label ?? 'the previous month'}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Your accounts"
            description="A balance for one account on its own is not a figure we calculate yet; the totals above cover every account together."
            icon={<Landmark />}
            tint="pink"
          />
          <CardBody>
            {view.accounts.length === 0 ? (
              <p className="text-sm text-ink-muted">No bank accounts yet.</p>
            ) : (
              <DetailList
                items={view.accounts.map((account) => ({
                  label: account.name,
                  value: (
                    <span className="text-ink-muted">
                      {account.reference} · balance at the start{' '}
                      <span
                        className="tabular"
                        title={
                          account.needsOpeningBalance
                            ? 'We need the opening bank balance before we can show your cash.'
                            : undefined
                        }
                      >
                        {account.openingBalance}
                      </span>
                    </span>
                  ),
                }))}
              />
            )}
          </CardBody>
        </Card>

        {waiting.length > 0 && can(ctx, 'financials.edit') ? (
          <Card>
            <CardHeader
              title="Enter an opening balance"
              description="Until we have it, your cash balance stays unknown rather than wrong."
              icon={<PencilLine />}
            />
            <CardBody>
              <OpeningBalanceForm orgSlug={orgSlug} accounts={waiting} currency={currency} />
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}

/** The organisation's currency, for the form's label. Never assumed (core/money). */
async function baseCurrency(
  db: Awaited<ReturnType<typeof getAccessContext>>['db'], orgId: string,
): Promise<string> {
  const { data } = await db.from('organizations').select('base_currency').eq('id', orgId).single();
  return (data?.base_currency as string | undefined) ?? 'GBP';
}
