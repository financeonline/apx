import Link from 'next/link';
import { hrefs, type OpportunityEntry, type PortfolioOrganisation } from '@/modules/portfolio';
import { Card, CardBody, EmptyState } from '@/components/ui/surfaces';
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
                  <p className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link href={links.client} className="font-medium text-ink underline-offset-2 hover:underline">{org.name}</Link>
                    <span className="text-xs text-ink-faint">{entry.periodLabel}</span>
                  </p>
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
                    <Link href={links.evidence(entry.evidenceBundleId)} className="text-accent underline underline-offset-2">
                      See the {entry.periodLabel} Health Score these rest on
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
