import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Eye, History, KeyRound } from 'lucide-react';
import { can } from '@/core/permissions';
import {
  getAccessContext,
  listAccessRequests,
  mayRequestAccess,
  type SwitchablePermission,
} from '@/modules/tenancy';
import { Badge, Card, CardBody, CardHeader, PageHeader } from '@/components/ui/surfaces';
import { ROLE_LABELS } from '@/components/labels';
import { RequestAccessForm, WithdrawRequestForm } from './access-forms';
import {
  MESSAGE_MAX, askablePermissions, heldPermissions, myRequestView, pendingRequest, type MyRequestView,
} from './access-view';

export const dynamic = 'force-dynamic';

/**
 * "Your access" — what a member can see in this company, and "Request more information" (ADR-172;
 * the client's SOW: a 3rd party may "request access for additional information if needed").
 *
 * Three bands, top to bottom: what you can see now (the switchable permissions you hold, in the
 * contract's plain words), ask for more (tick what you lack, and/or a message ≤ 1,000 characters),
 * and your requests with their answers — Withdraw on the one that is waiting.
 *
 * For members who may ask (`mayRequestAccess`: admin, accountant, client, 3rd party). An owner holds
 * everything; APX staff are given access by the super admin; a suspended organisation is frozen —
 * for them the page does not exist (404), and nothing links here. The database is the authority on
 * every rule the form shows: one waiting request, five a day, nothing beyond the switchable set.
 */
export default async function YourAccessPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  if (!mayRequestAccess(ctx.effectiveRole)) notFound();

  const holds = (p: SwitchablePermission) => can(ctx, p);
  const held = heldPermissions(holds);
  const askable = askablePermissions(holds);
  // An admin also reads everyone else's requests (they decide them on the team page); this page is
  // only ever about one's own.
  const mine = (await listAccessRequests(ctx)).filter((r) => r.requesterId === ctx.userId);
  const waiting = pendingRequest(mine);
  const views = mine.map(myRequestView);
  const roleName = ROLE_LABELS[ctx.effectiveRole] ?? 'Member';

  return (
    <>
      <PageHeader
        eyebrow="You"
        title="Your access"
        description="What you can see in this company, and how to ask the owner or an admin for more."
      />

      {/* A readable measure on a very wide screen; the bands stack on a phone. */}
      <div className="flex max-w-5xl flex-col gap-6">
        <Card>
          <CardHeader
            icon={<Eye />}
            tint="violet"
            title="What you can see now"
            description={`You are ${/^[aeiou]/i.test(roleName) ? 'an' : 'a'} ${roleName} in this company. The owner or an admin can change what you see.`}
          />
          <CardBody>
            {held.length === 0 ? (
              <p className="text-sm text-ink-muted">None of the extra areas have been switched on for you yet. Use the form below to ask for them.</p>
            ) : (
              <ul className="grid gap-2 md:grid-cols-2">
                {held.map((p) => (
                  <li key={p.permission} className="min-w-0 rounded-xl border border-line bg-surface-sunken/40 p-3">
                    <p className="text-sm font-medium text-ink">{p.title}</p>
                    <p className="text-xs text-ink-muted">{p.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card id="ask">
          <CardHeader
            icon={<KeyRound />}
            tint="pink"
            title="Request more information"
            description="Your request goes to the company’s owner and admins. They may switch on all of it, some of it, or none, and can leave you a note."
          />
          <CardBody>
            {waiting === null ? (
              <RequestAccessForm orgSlug={orgSlug} askable={askable} maxLength={MESSAGE_MAX} />
            ) : (
              <p className="text-sm text-ink">
                You have a request waiting, sent {myRequestView(waiting).askedOn}. You can ask again once it is answered,
                or withdraw it below and send a new one.
              </p>
            )}
          </CardBody>
        </Card>

        <Card id="requests">
          <CardHeader icon={<History />} tint="violet" title="Your requests" />
          <CardBody>
            {views.length === 0 ? (
              <p className="text-sm text-ink-muted">You have not asked for more access in this company.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {views.map((view) => (
                  <RequestRow key={view.id} orgSlug={orgSlug} view={view} />
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-ink-muted">
              Answers also arrive in your{' '}
              <Link href={`/app/${orgSlug}/notifications`} className="text-accent underline underline-offset-2">notifications</Link>.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function RequestRow({ orgSlug, view }: { orgSlug: string; view: MyRequestView }) {
  return (
    <li className="flex min-w-0 flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink">Asked {view.askedOn}</p>
        <Badge tone={view.tone === 'good' ? 'accent' : view.tone === 'warn' ? 'warn' : 'neutral'}>{view.statusLabel}</Badge>
      </div>
      {view.asked.length > 0 ? (
        <p className="text-sm text-ink-muted">
          <span className="text-ink">You asked for:</span> {view.asked.join(', ')}
        </p>
      ) : null}
      {view.message ? (
        <blockquote className="border-l-2 border-line-strong pl-3 text-sm whitespace-pre-line [overflow-wrap:anywhere]">
          {view.message}
        </blockquote>
      ) : null}
      <p className="text-sm text-ink">{view.outcome}</p>
      {view.notGranted.length > 0 ? (
        <p className="text-sm text-ink-muted">Not switched on: {view.notGranted.join(', ')}.</p>
      ) : null}
      {view.note ? (
        <div className="rounded-xl border border-line bg-surface-sunken/40 p-3 text-sm">
          <p className="text-xs text-ink-faint">Their note{view.answeredOn ? ` · ${view.answeredOn}` : ''}</p>
          <p className="mt-1 whitespace-pre-line text-ink [overflow-wrap:anywhere]">{view.note}</p>
        </div>
      ) : view.answeredOn ? (
        <p className="text-xs text-ink-faint">Answered {view.answeredOn}</p>
      ) : null}
      {view.canWithdraw ? <WithdrawRequestForm orgSlug={orgSlug} requestId={view.id} /> : null}
    </li>
  );
}
