import Link from 'next/link';
import { formatMoney, formatPercent } from '@/core/money';
import { missingReasonText } from '@/modules/dashboard';
import { getBudgetView, type BudgetLineKey } from '@/modules/budgets';
import { getAccessContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, EmptyState, PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * Budget against actual (Agreement §9; ADR-142). The budget is what was imported; the actual is the
 * figure the engine wrote for the month — the same one Profit & loss shows. Nothing here is computed
 * from records.
 */

const LINE_LABELS: Readonly<Record<BudgetLineKey, string>> = {
  revenue: 'Revenue',
  other_income: 'Other income',
  cost_of_sales: 'Cost of sales',
  gross_profit: 'Gross profit',
  operating_expense: 'Operating expenses (general)',
  payroll: 'Payroll',
  marketing: 'Marketing',
  depreciation: 'Depreciation',
  operating_expenses: 'Operating expenses, total',
  operating_profit: 'Operating profit',
  other_expense: 'Other expenses',
  interest_expense: 'Interest',
  tax_expense: 'Tax',
  net_profit: 'Net profit',
};

const CATEGORY_NAME = (category: string) => category.replace(/_/g, ' ');

export default async function BudgetPage({
  params, searchParams,
}: { params: Promise<{ orgSlug: string }>; searchParams: Promise<{ period?: string }> }) {
  const { orgSlug } = await params;
  const { period } = await searchParams;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'financials.view');

  const view = await getBudgetView(ctx, period);
  const money = (value: string) => formatMoney(value, { currency: view.currency, showMinorUnits: true });

  if (view.period === null) {
    return (
      <>
        <PageHeader eyebrow="Money" title="Budget against actual" />
        <EmptyState title="There is no budget yet" actionHref={`/app/${orgSlug}/data/imports/new`} actionLabel="Import a budget">
          Import a budget as a spreadsheet with a month, an account and an amount on each line — choose
          &quot;Budget&quot; as the kind of file. Each month&apos;s actual figures are then set beside it.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Money"
        title={`Budget against actual — ${view.period.label}`}
        description="The budget is what was imported; the actual is the figure on Profit & loss for the same month. Shown to the penny."
      />
      {view.months.length > 1 ? (
        <nav aria-label="Budget months" className="mb-6 flex flex-wrap gap-3 text-sm">
          {view.months.map((m) => (
            <Link key={m.id} href={`/app/${orgSlug}/money/budget?period=${m.id}`}
              aria-current={m.id === view.period?.id ? 'page' : undefined}
              className={m.id === view.period?.id ? 'font-medium text-ink' : 'text-accent underline underline-offset-2'}>
              {m.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {view.period.isComplete ? null : (
        <p className="mb-4 text-sm text-ink-muted">This month is not over, so its actual figures are still moving.</p>
      )}

      <Card>
        <CardBody>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-muted">
                  <th className="py-2 font-normal">Line</th>
                  <th className="py-2 text-right font-normal">Budget</th>
                  <th className="py-2 text-right font-normal">Actual</th>
                  <th className="py-2 text-right font-normal">Difference</th>
                </tr>
              </thead>
              <tbody>
                {(view.variance?.rows ?? []).map((row) => (
                  <tr key={row.key} className={`border-b border-line align-top last:border-0 ${row.derived ? 'font-medium' : ''}`}>
                    <th scope="row" className="py-2 pr-3 text-left font-normal text-ink">
                      {LINE_LABELS[row.key]}
                      {row.assumedZero.length === 0 ? null : (
                        <span className="block text-xs text-ink-faint">
                          No budget for {row.assumedZero.map(CATEGORY_NAME).join(', ')}; counted as nil.
                        </span>
                      )}
                    </th>
                    <td className="py-2 text-right text-ink">{row.budget === null ? '—' : money(row.budget)}</td>
                    <td className="py-2 text-right text-ink">
                      {row.actual === null ? (
                        <span className="text-ink-muted" title={missingReasonText(row.actualMissing)}>—</span>
                      ) : money(row.actual)}
                      {row.actualStatusLabel === null ? null : <span className="ml-1"><Badge>{row.actualStatusLabel}</Badge></span>}
                    </td>
                    <td className={`py-2 text-right ${row.favourable === null ? 'text-ink-muted' : row.favourable ? 'text-ink' : 'text-danger'}`}>
                      {row.variance === null ? '—' : formatMoney(row.variance, { currency: view.currency, showMinorUnits: true, signDisplay: 'always' })}
                      {row.variancePct === null ? null : (
                        <span className="block text-xs text-ink-muted">{formatPercent(row.variancePct, { signDisplay: 'always' })}</span>
                      )}
                      {row.favourable === null ? null : (
                        <span className="sr-only">{row.favourable ? ' favourable' : ' unfavourable'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(view.variance?.notCompared ?? []).length === 0 ? null : (
            <p className="mt-4 text-sm text-ink-muted">
              Also budgeted, but not part of the profit and loss so not compared:{' '}
              {view.variance!.notCompared.map((n) => `${CATEGORY_NAME(n.category)} ${money(n.budget)}`).join('; ')}.
            </p>
          )}
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardBody>
          <h2 className="font-serif text-lg text-ink">The budget lines</h2>
          <ul className="mt-3 flex flex-col divide-y divide-line text-sm">
            {view.lines.map((line) => (
              <li key={line.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-ink">
                  {line.accountCode === null ? '' : `${line.accountCode} · `}{line.accountName}
                  <span className="text-ink-muted"> · {CATEGORY_NAME(line.category)}</span>
                </span>
                <span className="text-ink-muted">
                  {money(line.amount)}
                  {line.importBatchId === null ? null : (
                    <> · <Link href={`/app/${orgSlug}/data/imports/${line.importBatchId}`} className="text-accent underline underline-offset-2">import</Link></>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}
