import Link from 'next/link';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardBody, EmptyState } from '@/components/ui/surfaces';
import { PeriodPicker, StatusBadgeView } from '@/components/dashboard';
import { loadMoneyIndex, loadPeriodScope } from '@/modules/dashboard';
import { WhyLink } from './_components/figures';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * The Money section index (UX_ARCHITECTURE.md §3.1: "Profit and loss, cash, bank activity, who owes
 * you and who you owe").
 *
 * One line per sub-page with the month's headline figure on it, so the reader chooses where to go
 * knowing what they will find rather than guessing from a tab label.
 */
export default async function MoneyPage({
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

  const scope = await loadPeriodScope(ctx.db, ctx.orgId!, period ?? null, ctx.requestId);

  if (!scope) {
    return (
      <>
        <PageHeader title="The numbers in detail" />
        <EmptyState
          title="There are no figures to show yet"
          actionHref={`/app/${orgSlug}/data/imports/new`}
          actionLabel="Add data"
        >
          Profit and loss, cash, bank activity and your invoice books all come from files you
          already have. Add a bank statement, a ledger export or an invoice list and this section
          will fill in.
        </EmptyState>
      </>
    );
  }

  const view = await loadMoneyIndex(ctx.db, ctx.orgId!, orgSlug, scope, ctx.requestId);
  const links = view.links.filter((link) => can(ctx, link.permission));

  return (
    <>
      <PageHeader
        eyebrow="Money"
        title={`The numbers in detail — ${scope.period.label}`}
        description="Each page below shows the same month. Open one to see it line by line."
      />
      <div className="mb-8">
        <PeriodPicker
          periods={scope.periods}
          value={scope.period.id}
          hrefFor={(id) => `/app/${orgSlug}/money?period=${id}`}
        />
      </div>

      <ul className="flex flex-col gap-4">
        {links.map((link) => (
          <li key={link.href}>
            <Card>
              <CardBody className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-base">
                    <Link href={`${link.href}?period=${scope.period.id}`} className="underline underline-offset-2">
                      {link.title}
                    </Link>
                  </h2>
                  <p className="mt-1 text-sm text-ink-muted">{link.description}</p>
                </div>
                {link.figure ? (
                  <div className="shrink-0 text-right">
                    <p
                      className={`tabular text-xl ${
                        link.figure.status.kind === 'not_available' ? 'text-ink-faint' : ''
                      }`.trim()}
                      title={
                        link.figure.status.kind === 'not_available'
                          ? link.figure.status.tooltip
                          : undefined
                      }
                    >
                      {link.figure.value}
                    </p>
                    <p className="text-xs text-ink-muted">{link.figure.label}</p>
                    <p className="mt-1 flex items-center justify-end gap-2 text-sm">
                      {link.figure.status.kind === 'not_available' ? null : (
                        <StatusBadgeView status={link.figure.status} size="sm" />
                      )}
                      <WhyLink row={link.figure} />
                    </p>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
