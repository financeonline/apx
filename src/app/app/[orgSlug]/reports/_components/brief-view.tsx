import Link from 'next/link';
import { formatMoney } from '@/core/money';
import {
  INTERIM_DISCLAIMER, INTERIM_LABELS, INTERIM_NOTES, REPORT_PRIORITY_LABELS, REPORT_SEVERITY_LABELS,
  notShown, resolveHref, windowLabel,
  type BriefActionLine, type BriefAlertLine, type BriefComparisonRow, type BriefContent, type BriefMonth, type Capped,
} from '@/modules/reporting';
import type { ReactNode } from 'react';
import { Bell, ChartColumn, ClipboardCheck, Lightbulb, TrendingUp, TriangleAlert } from 'lucide-react';
import { Badge, Card, CardBody, IconBadge, type IconTint } from '@/components/ui/surfaces';
import { formatDate, formatDateTime } from '@/components/labels';

/**
 * A Daily Executive Brief or Weekly Intelligence Report on screen (Phase 17).
 *
 * Renders the content as composed — stored, or a live preview — and computes nothing: every figure
 * is a value the interim calculator or the monthly engine produced, formatted once.
 */

function Section({
  title, icon, tint = 'violet', children,
}: { title: string; icon?: ReactNode; tint?: IconTint; children: ReactNode }) {
  return (
    <Card>
      <CardBody>
        <div className="flex min-w-0 items-center gap-3">
          {icon ? <IconBadge tint={tint} size="sm">{icon}</IconBadge> : null}
          <h2 className="min-w-0 font-serif text-lg text-ink">{title}</h2>
        </div>
        <div className="mt-4 min-w-0">{children}</div>
      </CardBody>
    </Card>
  );
}

/**
 * A movement's name as an owner reads it. The two spending families arrive with their raw metric key
 * as the label, and a category as its key ("expense_by_category · cost_of_sales"), in reports already
 * stored as well as new ones; this names them in words. Every other label is shown as it was stored.
 */
const FAMILY_NAMES: Readonly<Record<string, string>> = {
  expense_by_account: 'Spending by account',
  expense_by_category: 'Spending by type',
};

function movementName(m: { readonly label: string; readonly dimensionLabel: string | null }): string {
  const family = FAMILY_NAMES[m.label] ?? m.label;
  if (m.dimensionLabel === null) return family;
  const dimension = /^[a-z0-9_]+$/.test(m.dimensionLabel)
    ? `${m.dimensionLabel.charAt(0).toUpperCase()}${m.dimensionLabel.slice(1).replace(/_/g, ' ')}`
    : m.dimensionLabel;
  return `${family}: ${dimension}`;
}

function More({ list }: { list: Capped<unknown> }) {
  const hidden = notShown(list);
  if (hidden === 0) return null;
  return <p className="mt-2 text-sm text-ink-muted">…and {hidden} more.</p>;
}

export function AlertList({ list, orgSlug, empty }: { list: Capped<BriefAlertLine>; orgSlug: string; empty: string }) {
  if (list.items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <>
      <ul className="flex flex-col gap-3">
        {list.items.map((alert) => (
          <li key={alert.id} className="border-b border-line pb-3 last:border-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <Badge tone={alert.severity === 'critical' ? 'danger' : alert.severity === 'high' ? 'warn' : 'neutral'}>
                {REPORT_SEVERITY_LABELS[alert.severity]}
              </Badge>
              <Link href={resolveHref(alert.href, orgSlug)} className="min-w-0 text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline">
                {alert.title}
              </Link>
            </div>
            <p className="mt-1 text-sm text-ink-muted">{alert.explanation}</p>
            {alert.nextStep === null ? null : <p className="mt-1 text-sm text-ink">Next step: {alert.nextStep}</p>}
          </li>
        ))}
      </ul>
      <More list={list} />
    </>
  );
}

export function ActionList({ list, orgSlug, empty }: { list: Capped<BriefActionLine>; orgSlug: string; empty: string }) {
  if (list.items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {list.items.map((action) => (
          <li key={action.id} className="flex flex-wrap justify-between gap-2 text-sm">
            <Link href={resolveHref(action.href, orgSlug)} className="min-w-0 text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline">
              {action.title}
            </Link>
            <span className="text-ink-muted">
              {REPORT_PRIORITY_LABELS[action.priority]} · {action.dueDate === null ? 'no due date' : `due ${formatDate(action.dueDate)}`}
              {action.assigned ? '' : ' · not assigned'}
            </span>
          </li>
        ))}
      </ul>
      <More list={list} />
    </>
  );
}

function FigureRow({ row, currency, orgSlug, period }: { row: BriefComparisonRow; currency: string; orgSlug: string; period: 'day' | 'week' }) {
  const figure = row.current;
  return (
    <div className="border-b border-line pb-3">
      <dt className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        {INTERIM_LABELS[figure.key]}
        {figure.status === 'incomplete' ? <Badge tone="warn">Incomplete</Badge> : null}
      </dt>
      {/* Interim figures are small enough that pence matter: shown to the penny, unlike the month's. */}
      <dd className="mt-1 font-serif text-2xl text-ink">{formatMoney(figure.value, { currency, showMinorUnits: true })}</dd>
      {row.previous === null || row.change === null ? null : (
        <dd className="mt-1 text-sm text-ink-muted">
          {formatMoney(row.change, { currency, signDisplay: 'always', showMinorUnits: true })} against the {period} before
          ({formatMoney(row.previous.value, { currency, showMinorUnits: true })})
        </dd>
      )}
      <dd className="mt-1 text-xs text-ink-faint">{INTERIM_NOTES[figure.key]}</dd>
      {figure.records.length === 0 ? null : (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer py-1 text-accent pointer-coarse:py-2.5">
            What this is made of ({figure.recordCount} record{figure.recordCount === 1 ? '' : 's'})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {figure.records.map((record) => (
              <li key={`${record.kind}:${record.id}`} className="flex flex-wrap justify-between gap-2">
                <Link
                  href={`/app/${encodeURIComponent(orgSlug)}/evidence/record/${record.kind}/${record.id}`}
                  className="min-w-0 text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline"
                >
                  {formatDate(record.date)} · {record.label}
                </Link>
                <span className="text-ink-muted">{formatMoney(record.amount, { currency, showMinorUnits: true })}</span>
              </li>
            ))}
          </ul>
          {figure.recordCount > figure.records.length ? (
            <p className="mt-1 text-xs text-ink-faint">The {figure.records.length} largest are listed.</p>
          ) : null}
        </details>
      )}
    </div>
  );
}

export function MonthSection({ month, orgSlug, title }: { month: BriefMonth; orgSlug: string; title: string }) {
  return (
    <Section title={title} icon={<ChartColumn />} tint="violet">
      <p className="text-sm text-ink-muted">{month.basisLine}</p>
      {month.health === null ? null : (
        <p className="mt-3 text-sm text-ink">
          Health score <span className="font-serif text-xl">{month.health.score}</span> out of 100, based on{' '}
          {month.health.dimensionsUsed} of {month.health.dimensionsTotal} areas
          {month.health.changeVsPrevious === null ? '' : ` (${month.health.changeVsPrevious >= 0 ? '+' : ''}${month.health.changeVsPrevious} on the month before)`}.
        </p>
      )}
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        {month.cards.map((card) => (
          <div key={card.metricKey} className="border-b border-line pb-3">
            <dt className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
              {card.label}
              {card.statusLabel === null ? null : <Badge>{card.statusLabel}</Badge>}
            </dt>
            <dd className="mt-1 font-serif text-2xl text-ink">
              <Link href={resolveHref(card.href, orgSlug)} className="underline-offset-2 hover:underline">{card.value}</Link>
            </dd>
            {card.change === null ? null : <dd className="mt-1 text-sm text-ink-muted">{card.change}</dd>}
          </div>
        ))}
      </dl>
      {[['Biggest changes for the worse', month.adverse], ['Biggest changes for the better', month.favourable]].map(([heading, list]) => {
        const movements = list as BriefMonth['adverse'];
        if (movements.length === 0) return null;
        return (
          <div key={heading as string} className="mt-4">
            <h3 className="text-sm font-medium text-ink">{heading as string}</h3>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {movements.map((m) => (
                <li key={`${m.label}|${m.dimensionLabel ?? ''}`} className="flex flex-wrap justify-between gap-2">
                  <Link href={resolveHref(m.href, orgSlug)} className="min-w-0 text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline">
                    {movementName(m)}
                  </Link>
                  <span className="text-ink-muted">{m.change}{m.percent === null ? '' : ` (${m.percent})`} · from {m.comparison} to {m.current}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </Section>
  );
}

export function BriefView({ content, orgSlug }: { content: BriefContent; orgSlug: string }) {
  const daily = content.kind === 'daily_brief';
  const sev = content.attention.standingBySeverity;
  const collected = content.interim.invoicing?.find((f) => f.key === 'sales_collected') ?? null;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-ink-faint">{INTERIM_DISCLAIMER}</p>

      <Section title={daily ? 'Key movements' : 'Financial changes this week'} icon={<TrendingUp />} tint="violet">
        {content.comparison.length === 0 ? (
          <p className="text-sm text-ink-muted">No day or week figures are available for this period.</p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            {content.comparison.map((row) => (
              <FigureRow key={row.key} row={row} currency={content.currency} orgSlug={orgSlug} period={daily ? 'day' : 'week'} />
            ))}
          </dl>
        )}
        {content.notices.length === 0 ? null : (
          <ul className="mt-4 flex flex-col gap-1 text-sm text-ink-muted">
            {content.notices.map((notice) => <li key={`${notice.kind}:${notice.text}`}>{notice.text}</li>)}
          </ul>
        )}
      </Section>

      <Section title={daily ? 'Risks' : 'Causes'} icon={<TriangleAlert />} tint="pink">
        <AlertList list={content.events.alertsRaised} orgSlug={orgSlug}
          empty={daily ? 'No new alerts were raised.' : 'No new alerts were raised this week.'} />
        {!daily && content.latestMonth !== null && content.latestMonth.adverse.length > 0 ? (
          <p className="mt-4 text-sm text-ink-muted">
            What moved most in {content.latestMonth.label} is under the month below.
          </p>
        ) : null}
      </Section>

      {daily ? (
        <Section title="Opportunities" icon={<Lightbulb />} tint="violet">
          {collected !== null && collected.recordCount > 0 ? (
            <p className="text-sm text-ink">
              {formatMoney(collected.value, { currency: content.currency, showMinorUnits: true })} collected from customers
              ({collected.recordCount} invoice{collected.recordCount === 1 ? '' : 's'} paid in full).
            </p>
          ) : null}
          {(content.latestMonth?.favourable ?? []).length === 0 && (collected === null || collected.recordCount === 0) ? (
            <p className="text-sm text-ink-muted">Nothing new to point to.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {(content.latestMonth?.favourable ?? []).map((m) => (
                <li key={`${m.label}|${m.dimensionLabel ?? ''}`}>
                  <Link href={resolveHref(m.href, orgSlug)} className="text-ink underline-offset-2 hover:underline">
                    {movementName(m)}: {m.change}
                  </Link>
                  <span className="text-ink-muted"> in {content.latestMonth?.label}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <Section title={daily ? 'What needs attention today' : 'Unresolved issues'} icon={<Bell />} tint="pink">
        <p className="text-sm text-ink">
          Open alerts: {sev.critical} critical, {sev.high} high, {sev.medium} medium, {sev.low} low.
        </p>
        <div className="mt-4">
          <AlertList list={content.attention.standingAlerts} orgSlug={orgSlug} empty="No critical or high alerts are open." />
        </div>
        <h3 className="mt-6 text-sm font-medium text-ink">Overdue actions</h3>
        <div className="mt-2"><ActionList list={content.attention.overdueActions} orgSlug={orgSlug} empty="Nothing is overdue." /></div>
        <h3 className="mt-6 text-sm font-medium text-ink">Due in the next 7 days</h3>
        <div className="mt-2"><ActionList list={content.attention.dueSoonActions} orgSlug={orgSlug} empty="Nothing falls due." /></div>
        <p className="mt-4 text-xs text-ink-faint">As at {formatDateTime(content.composedAt)} UTC, when this was made.</p>
      </Section>

      <Section title="Actions" icon={<ClipboardCheck />} tint="violet">
        <p className="text-sm text-ink">
          {content.events.actionsCompleted.total} completed, {content.events.actionsCreated.total} created,{' '}
          {content.events.alertsResolved.total} alert{content.events.alertsResolved.total === 1 ? '' : 's'} resolved.
        </p>
        <div className="mt-4"><ActionList list={content.events.actionsCompleted} orgSlug={orgSlug} empty="No actions were completed." /></div>
      </Section>

      {content.latestMonth === null ? null : (
        <MonthSection month={content.latestMonth} orgSlug={orgSlug} title={`The latest complete month: ${content.latestMonth.label}`} />
      )}

      <p className="text-xs text-ink-faint">
        {daily ? 'Daily Executive Brief' : 'Weekly Intelligence Report'} for {windowLabel(content.window.start, content.window.end)}.
        {' '}Days run midnight to midnight, {content.timezone} time.
        {content.dataRefreshedAt === null ? '' : ` Data last added ${formatDate(content.dataRefreshedAt)}.`}
      </p>
    </div>
  );
}
