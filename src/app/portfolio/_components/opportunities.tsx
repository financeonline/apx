import Link from 'next/link';
import { ChevronRight, Lightbulb } from 'lucide-react';
import { hrefs, type OpportunityEntry, type PortfolioOrganisation } from '@/modules/portfolio';
import { Card, CardBody, EmptyState, IconBadge } from '@/components/ui/surfaces';
import { RecordOpportunity } from './record-opportunity';

/**
 * Advisory opportunities (SOW §20; ADR-148). Each one names the scores and rule results that
 * triggered it, from the client's latest complete month; nothing here is worked out on screen.
 */
export function OpportunityList({
  entries, organisations, withActions,
}: {
  entries: readonly OpportunityEntry[];
  organisations: readonly PortfolioOrganisation[];
  /** On a client's page the adviser can record each one as an action. */
  withActions: boolean;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState title="No advisory opportunities in the latest figures">
        None of MOTION&apos;s opportunity rules is met by a client&apos;s latest complete month. That changes as their figures do.
      </EmptyState>
    );
  }
  const orgById = new Map(organisations.map((o) => [o.id, o]));
  return (
    <ul className="flex flex-col gap-3">
      {entries.map((entry) => {
        const org = orgById.get(entry.organizationId);
        if (org === undefined) return null;
        const links = hrefs(org);
        return (
          <li key={entry.organizationId}>
            <Card>
              <CardBody>
                {withActions ? null : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-3">
                      <IconBadge tint="pink" size="sm"><Lightbulb /></IconBadge>
                      <Link href={links.client} className="min-w-0 font-semibold text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline">{org.name}</Link>
                    </span>
                    <span className="text-xs text-ink-faint">{entry.periodLabel}</span>
                  </div>
                )}
                <ul className={withActions ? 'flex flex-col gap-4' : 'mt-2 flex flex-col gap-3'}>
                  {entry.opportunities.map((o) => (
                    <li key={o.kind}>
                      <p className="text-sm font-medium text-ink">{o.title}</p>
                      <p className="mt-0.5 text-sm text-ink-muted">Because: {o.because.join('; ')}.</p>
                      <p className="mt-0.5 text-sm text-ink">{o.suggestion}</p>
                      {withActions ? <div className="mt-2"><RecordOpportunity orgId={entry.organizationId} kind={o.kind} /></div> : null}
                    </li>
                  ))}
                </ul>
                {entry.evidenceBundleId === null ? null : (
                  <p className="mt-3 text-sm">
                    <Link href={links.evidence(entry.evidenceBundleId)} className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft">
                      See the {entry.periodLabel} Health Score these rest on <ChevronRight aria-hidden="true" className="size-4" />
                    </Link>
                  </p>
                )}
              </CardBody>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
