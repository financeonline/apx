import type { ReactNode } from 'react';
import { ArrowLeftRight, ChartColumn, HandCoins, Landmark, Receipt, Sparkles, TrendingUp, Wallet } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { PageHeader, Card, CardBody, EmptyState, IconBadge, type IconTint } from '@/components/ui/surfaces';
import { ABOVE_CARD_LINK, CLICKABLE_CARD, CardLink } from '@/components/ui/clickable-card';
import { PeriodPicker, StatusBadgeView } from '@/components/dashboard';
import { loadMoneyIndex, loadPeriodScope } from '@/modules/dashboard';
import { WhyLink } from './_components/figures';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/** Each sub-page's icon tile, as the Departments cards (ADR-155). Decorative; keyed by route slug. */
const PAGE_ICON: Readonly<Record<string, { icon: ReactNode; tint: IconTint }>> = {
  'profit-and-loss': { icon: <ChartColumn />, tint: 'violet' },
  cash: { icon: <Wallet />, tint: 'pink' },
  banking: { icon: <Landmark />, tint: 'violet' },
  receivables: { icon: <HandCoins />, tint: 'pink' },
  payables: { icon: <Receipt />, tint: 'violet' },
};

/**
 * The Money section index (UX_ARCHITECTURE.md §3.1: "Profit and loss, cash, bank activity, who owes
 * you and who you owe").
 *
 * One line per sub-page with the month's headline figure on it, so the reader chooses where to go
 * knowing what they will find rather than guessing from a tab label.
 *
 * Every card here opens its page from anywhere on it (owner, 2026-10-14): the heading's link is the
 * card's one link, stretched over it (`ui/clickable-card`); a figure's "Why?" and its badge sit above
 * it and keep their own targets.
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

      {/*
        * The forecast, reached from Money rather than from the primary navigation (ADR-099).
        * §3.1 fixes that navigation at seven items and ADR-037 created the Data menu specifically to
        * keep it there; an eighth would undo a decision the UX made on purpose. Money is "the
        * numbers in detail", and what the next months are expected to look like belongs beside them
        * — the same precedent `/evidence` and `/home/health` already set.
        */}
      <Card className={`mb-4 ${CLICKABLE_CARD}`}>
        <CardBody className="flex min-w-0 gap-3.5">
          <IconBadge tint="violet"><TrendingUp /></IconBadge>
          <div className="min-w-0">
            <h2 className="text-base">
              <CardLink href={`/app/${orgSlug}/forecast`} className="underline underline-offset-2 group-hover:text-accent">
                What is expected
              </CardLink>
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              What your finished months suggest the next three will look like. Expectations, not
              results.
            </p>
          </div>
        </CardBody>
      </Card>

      {/*
        * What-if, beside the forecast it changes and for the same reason (ADR-100): §3.1 fixes the
        * primary navigation at seven items, and a scenario is a statement about the same months the
        * rest of Money is about.
        */}
      <Card className={`mb-4 ${CLICKABLE_CARD}`}>
        <CardBody className="flex min-w-0 gap-3.5">
          <IconBadge tint="pink"><Sparkles /></IconBadge>
          <div className="min-w-0">
            <h2 className="text-base">
              <CardLink href={`/app/${orgSlug}/what-if`} className="underline underline-offset-2 group-hover:text-accent">
                What if things change?
              </CardLink>
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              Change one thing — sales, wages, a new hire, a loan — and see what it would do to your
              profit and your cash.
            </p>
          </div>
        </CardBody>
      </Card>

      <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {links.map((link) => {
          const look = PAGE_ICON[link.href.split('/').pop() ?? ''] ?? { icon: <ArrowLeftRight />, tint: 'violet' as const };
          return (
            <li key={link.href}>
              <Card className={`h-full ${CLICKABLE_CARD}`}>
                <CardBody className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-1 gap-3.5">
                    <IconBadge tint={look.tint}>{look.icon}</IconBadge>
                    <div className="min-w-0">
                      <h2 className="text-base">
                        <CardLink
                          href={`${link.href}?period=${scope.period.id}`}
                          // Why a figure is a dash, for a pointer: the link covers the figure itself.
                          title={link.figure?.status.kind === 'not_available' ? link.figure.status.tooltip : undefined}
                          className="underline underline-offset-2 group-hover:text-accent"
                        >
                          {link.title}
                        </CardLink>
                      </h2>
                      <p className="mt-1 text-sm text-ink-muted">{link.description}</p>
                    </div>
                  </div>
                  {link.figure ? (
                    <div className="ml-auto shrink-0 text-right">
                      <p
                        className={`font-mono tabular text-2xl ${
                          link.figure.status.kind === 'not_available' ? 'text-ink-faint' : ''
                        }`.trim()}
                      >
                        {link.figure.value}
                      </p>
                      <p className="text-xs text-ink-muted">{link.figure.label}</p>
                      <p className="mt-1 flex items-center justify-end gap-2 text-sm">
                        {link.figure.status.kind === 'not_available' ? null : (
                          <span className={ABOVE_CARD_LINK}>
                            <StatusBadgeView status={link.figure.status} size="sm" />
                          </span>
                        )}
                        <WhyLink row={link.figure} className={ABOVE_CARD_LINK} />
                      </p>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
    </>
  );
}
