import Link from 'next/link';
import { formatMoney } from '@/core/money';
import {
  REPORT_DIMENSION_LABELS, REPORT_EXCLUSION_TEXT, resolveHref, type AdviserContent,
} from '@/modules/reporting';
import { Card, CardBody } from '@/components/ui/surfaces';
import { ActionList, AlertList, MonthSection } from './brief-view';

/** The Accountant/CFO Report on screen (Phase 17, REQ-RP-04). Renders the stored content only. */
export function AdviserView({ content, orgSlug }: { content: AdviserContent; orgSlug: string }) {
  const sev = content.alerts.bySeverity;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardBody>
          <h2 className="font-serif text-lg text-ink">Needs attention</h2>
          {content.attention.length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">Nothing in the Command Centre&apos;s rules flags this client.</p>
          ) : (
            <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
              {content.attention.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </CardBody>
      </Card>

      <MonthSection month={content.month} orgSlug={orgSlug} title={`${content.month.label} at a glance`} />

      <Card>
        <CardBody>
          <h2 className="font-serif text-lg text-ink">Health, area by area</h2>
          <dl className="mt-4 flex flex-col gap-3">
            {content.dimensions.map((d) => (
              <div key={d.key} className="border-b border-line pb-3 last:border-0">
                <dt className="flex justify-between text-sm text-ink">
                  <span>{REPORT_DIMENSION_LABELS[d.key]}</span>
                  <span className="font-serif text-lg">{d.score === null ? '—' : d.score}</span>
                </dt>
                <dd className="mt-1 text-sm text-ink-muted">
                  {d.included
                    ? [...d.negatives, ...d.positives].join(' ') || 'Scored.'
                    : REPORT_EXCLUSION_TEXT[d.exclusionReason ?? ''] ?? 'Not scored.'}
                </dd>
              </div>
            ))}
          </dl>
          {content.trend.length === 0 ? null : (
            <p className="mt-4 text-sm text-ink-muted">
              Scores: {content.trend.map((p) => `${p.periodLabel} ${p.score ?? '—'}`).join(' · ')}
            </p>
          )}
          <p className="mt-3 text-xs text-ink-faint">{content.disclaimer}</p>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="font-serif text-lg text-ink">Open alerts</h2>
          <p className="mt-2 text-sm text-ink">{sev.critical} critical, {sev.high} high, {sev.medium} medium, {sev.low} low.</p>
          <div className="mt-4">
            <AlertList list={content.alerts.standing} orgSlug={orgSlug} empty="No critical, high or medium alerts are open." />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="font-serif text-lg text-ink">Actions</h2>
          <p className="mt-2 text-sm text-ink">{content.actions.open} open.</p>
          <h3 className="mt-4 text-sm font-medium text-ink">Overdue</h3>
          <div className="mt-2"><ActionList list={content.actions.overdue} orgSlug={orgSlug} empty="Nothing is overdue." /></div>
          <h3 className="mt-4 text-sm font-medium text-ink">Urgent</h3>
          <div className="mt-2"><ActionList list={content.actions.urgent} orgSlug={orgSlug} empty="Nothing urgent." /></div>
          <h3 className="mt-4 text-sm font-medium text-ink">Completed in the last 30 days</h3>
          {content.actions.completedRecently.items.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">None.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {content.actions.completedRecently.items.map((action) => (
                <li key={action.id} className="flex flex-wrap justify-between gap-2">
                  <Link href={resolveHref(action.href, orgSlug)} className="text-ink underline-offset-2 hover:underline">{action.title}</Link>
                  <span className="text-ink-muted">
                    {action.at?.slice(0, 10)}
                    {action.outcomeValue === null ? '' : ` · outcome ${formatMoney(action.outcomeValue, { currency: action.outcomeCurrency ?? content.currency })}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="font-serif text-lg text-ink">How far the data goes</h2>
          <p className="mt-2 text-sm text-ink">
            {content.dataQuality.dataRefreshedAt === null ? 'No data has been added yet.' : `Data last added ${content.dataQuality.dataRefreshedAt.slice(0, 10)}.`}
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-ink-muted">
            {content.dataQuality.bankAccounts.map((account) => (
              <li key={account.name}>
                {account.name}: {account.latestDate === null ? 'no transactions imported' : `statements reach ${account.latestDate}`}
              </li>
            ))}
          </ul>
          {content.dataQuality.monthsWithoutData.length === 0 ? null : (
            <p className="mt-2 text-sm text-ink-muted">Months with no figures: {content.dataQuality.monthsWithoutData.join(', ')}.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
