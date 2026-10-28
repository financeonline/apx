import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { formatMoney, formatPercent } from '@/core/money';
import { categoryLabel, missingReasonText } from '@/modules/dashboard';
import { getBudgetView, type BudgetLineKey } from '@/modules/budgets';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { Badge, Card, CardBody, EmptyState, IconBadge, PageHeader } from '@/components/ui/surfaces';
import { TOUCH_TARGET } from '@/components/ui/clickable-card';
import { requirePermission } from '@/app/_lib/authz';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shadcn';

export const dynamic = 'force-dynamic';

/**
 * Budget against actual (Agreement §9; ADR-142). The budget is what was imported; the actual is the
 * figure the engine wrote for the month — the same one Profit & loss shows. Nothing here is computed
 * from records.
 */

/*
 * The same names Profit & loss uses for the same lines (its §8.1 plain labels and category names),
 * so a reader comparing the two pages is never left wondering whether "Revenue" here is "Sales" there.
 */
const LINE_LABELS: Readonly<Record<BudgetLineKey, string>> = {
  revenue: 'Sales',
  other_income: 'Other income',
  cost_of_sales: 'Direct costs',
  gross_profit: 'Profit after direct costs',
  operating_expense: 'Other running costs',
  payroll: 'Payroll',
  marketing: 'Marketing',
  depreciation: 'Depreciation',
  operating_expenses: 'Running costs, total',
  operating_profit: 'Profit (before interest and tax)',
  other_expense: 'Other costs',
  interest_expense: 'Interest paid',
  tax_expense: 'Tax',
  net_profit: 'Profit after interest and tax',
};

/** A budget category in the words Profit & loss uses ("Other running costs", not "operating expense"). */
const CATEGORY_NAME = (category: string) => categoryLabel(category);

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
        {/* The upload page is `imports.create`; a reader without it is not sent to a refusal. */}
        <EmptyState
          title="There is no budget yet"
          actionHref={can(ctx, 'imports.create') ? `/app/${orgSlug}/data/imports/new` : undefined}
          actionLabel="Import a budget"
        >
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
        description="Are you on track with your plan? Each line shows what you budgeted, what actually happened (the same figure as on Profit & loss), and the gap between them."
      />
      {view.months.length > 1 ? (
        <nav aria-label="Budget months" className="mb-6 flex flex-wrap gap-2 text-sm">
          {view.months.map((m) => (
            <Link key={m.id} href={`/app/${orgSlug}/money/budget?period=${m.id}`}
              aria-current={m.id === view.period?.id ? 'page' : undefined}
              className={`inline-flex items-center ${TOUCH_TARGET} ${m.id === view.period?.id ? 'rounded-full bg-accent-soft px-3 py-1 font-medium text-accent' : 'rounded-full bg-surface-sunken px-3 py-1 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent'}`}>
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
          <Table className="min-w-0">
            <TableHeader>
              <TableRow className="border-b border-line text-left text-ink-muted">
                <TableHead className="py-2 pl-0 font-normal">Item</TableHead>
                <TableHead className="py-2 pl-0 text-right font-normal">Budget</TableHead>
                <TableHead className="py-2 pl-0 text-right font-normal">Actual</TableHead>
                <TableHead className="py-2 pl-0 text-right font-normal">Difference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(view.variance?.rows ?? []).map((row) => (
                <TableRow key={row.key} className={`border-b border-line align-top last:border-0 ${row.derived ? 'font-medium' : ''}`}>
                  <TableHead scope="row" className="py-2 pl-0 pr-3 text-left font-normal text-sm normal-case tracking-normal text-ink">
                    {LINE_LABELS[row.key]}
                    {row.assumedZero.length === 0 ? null : (
                      <span className="block text-xs text-ink-faint">
                        No budget set for {row.assumedZero.map(CATEGORY_NAME).join(', ')}, so it counts as zero.
                      </span>
                    )}
                  </TableHead>
                  <TableCell className="py-2 pl-0 text-right text-ink">{row.budget === null ? '—' : money(row.budget)}</TableCell>
                  <TableCell className="py-2 pl-0 text-right text-ink">
                    {row.actual === null ? (
                      <span className="text-ink-muted" title={missingReasonText(row.actualMissing)}>—</span>
                    ) : money(row.actual)}
                    {row.actualStatusLabel === null ? null : <span className="ml-1"><Badge>{row.actualStatusLabel}</Badge></span>}
                  </TableCell>
                  <TableCell className={`py-2 pl-0 text-right ${row.favourable === null ? 'text-ink-muted' : row.favourable ? 'text-ink' : 'text-danger'}`}>
                    {row.variance === null ? '—' : formatMoney(row.variance, { currency: view.currency, showMinorUnits: true, signDisplay: 'always' })}
                    {row.variancePct === null ? null : (
                      <span className="block text-xs text-ink-muted">{formatPercent(row.variancePct, { signDisplay: 'always' })}</span>
                    )}
                    {/* Said in words as well as colour (§10): red alone tells a colour-blind reader nothing. */}
                    {row.favourable === null || row.variance === null ? null : (
                      <span className="block text-xs">
                        {/* A difference of exactly nothing is neither better nor worse (a string test, no arithmetic). */}
                        {/^[-+]?0+(\.0+)?$/.test(row.variance) ? 'on budget' : row.favourable ? 'better than budget' : 'worse than budget'}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {(view.variance?.notCompared ?? []).length === 0 ? null : (
            <p className="mt-4 text-sm text-ink-muted">
              Also in the budget, but not a profit and loss line, so not compared here:{' '}
              {view.variance!.notCompared.map((n) => `${CATEGORY_NAME(n.category)} ${money(n.budget)}`).join('; ')}.
            </p>
          )}
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardBody>
          <div className="flex items-center gap-3">
            <IconBadge tint="pink" size="sm"><ListChecks /></IconBadge>
            <h2 className="font-serif text-lg text-ink">What is in your budget</h2>
          </div>
          <ul className="mt-3 flex flex-col divide-y divide-line text-sm">
            {view.lines.map((line) => (
              <li key={line.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-ink">
                  {line.accountCode === null ? '' : `${line.accountCode} · `}{line.accountName}
                  <span className="text-ink-muted"> · counted as {CATEGORY_NAME(line.category)}</span>
                </span>
                <span className="text-ink-muted">
                  {money(line.amount)}
                  {/* The import it came from opens for whoever reviews imports (a client does not). */}
                  {line.importBatchId === null || !can(ctx, 'imports.review') ? null : (
                    <> · <Link href={`/app/${orgSlug}/data/imports/${line.importBatchId}`} className="text-accent underline underline-offset-2">see the import</Link></>
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
