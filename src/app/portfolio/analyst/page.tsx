import Link from 'next/link';
import { getPortfolioContext, hrefs, listAdviserTurns } from '@/modules/portfolio';
import { PageHeader, Card, CardBody, CardHeader, Badge } from '@/components/ui/surfaces';
import { Disclaimer } from '@/components/dashboard';
import { formatDateTime } from '@/components/labels';
import { AskForm } from './ask-form';

export const dynamic = 'force-dynamic';

const STATUS_LABELS = {
  passed: { label: 'Grounded', tone: 'accent' },
  degraded: { label: 'Partly grounded', tone: 'warn' },
  not_applicable: { label: 'No figures', tone: 'neutral' },
  failed: { label: 'Not answered', tone: 'danger' },
} as const;

/**
 * The adviser analyst (SOW §18 "client AI analysis"; ADR-113). The answer is a briefing over the
 * Command Centre's own facts, and every client it names links to that client's own evidence.
 */
export default async function PortfolioAnalystPage() {
  const ctx = await getPortfolioContext();
  const turns = await listAdviserTurns(ctx);
  const orgById = new Map(ctx.organisations.map((o) => [o.id, o]));

  return (
    <>
      <PageHeader
        eyebrow="Command Centre"
        title="Adviser analyst"
        description="Summaries of what MOTION has already established about the clients you advise: health, alerts, actions and what needs attention. The analyst does not work out figures; for a figure, open the client."
      />
      <Card>
        <CardBody><AskForm /></CardBody>
      </Card>

      <section aria-labelledby="answers" className="mt-8 flex flex-col gap-4">
        <h2 id="answers" className="font-serif text-lg">Recent answers</h2>
        {turns.length === 0 ? <p className="text-sm text-ink-muted">Nothing asked yet.</p> : null}
        {turns.map((turn) => {
          const status = STATUS_LABELS[turn.groundingStatus ?? 'failed'];
          const answer = turn.answer;
          return (
            <Card key={turn.id}>
              <CardHeader
                title={turn.question}
                description={formatDateTime(turn.createdAt)}
                action={turn.status === 'pending' ? <Badge tone="neutral">Working…</Badge> : <Badge tone={status.tone}>{status.label}</Badge>}
              />
              <CardBody>
                {answer === null ? (
                  <p className="text-sm text-ink-muted">
                    {turn.status === 'pending' ? 'Still being answered.' : 'The adviser analyst could not answer this one.'}
                  </p>
                ) : (
                  <>
                    <p className="text-base">{answer.briefing.headline}</p>
                    {answer.briefing.clients.length > 0 ? (
                      <ul className="mt-4 flex flex-col gap-3">
                        {answer.briefing.clients.map((client) => {
                          const named = answer.clients.find((c) => c.ref === client.ref);
                          const org = named === undefined ? undefined : orgById.get(named.id);
                          const cited = answer.refs.filter((r) => client.because.includes(r.ref));
                          return (
                            <li key={client.ref} className="rounded-md border border-line px-4 py-3">
                              <p className="font-medium">
                                {org !== undefined ? (
                                  <Link href={hrefs(org).client} className="underline-offset-2 hover:underline">{org.name}</Link>
                                ) : (named?.name ?? client.ref)}
                              </p>
                              <p className="mt-1 text-sm">{client.summary}</p>
                              {cited.length > 0 && org !== undefined ? (
                                <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                                  {cited.map((ref) => (
                                    <Link
                                      key={ref.ref}
                                      href={ref.kind === 'alert' ? hrefs(org).alert(ref.id) : hrefs(org).action(ref.id)}
                                      className="text-accent underline underline-offset-2"
                                    >
                                      {ref.title}
                                    </Link>
                                  ))}
                                </p>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    {answer.briefing.notes.length > 0 ? (
                      <ul className="mt-4 list-disc pl-5 text-sm">
                        {answer.briefing.notes.map((note) => <li key={note}>{note}</li>)}
                      </ul>
                    ) : null}
                    {answer.briefing.limitations.length > 0 ? (
                      <p className="mt-3 text-xs text-ink-muted">Could not tell: {answer.briefing.limitations.join(' ')}</p>
                    ) : null}
                  </>
                )}
              </CardBody>
            </Card>
          );
        })}
      </section>
      <Disclaimer />
    </>
  );
}
