import Link from 'next/link';
import { assertCan } from '@/core/permissions';
import { readableOrganizations, searchAudit } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { Card, CardBody, EmptyState, PageHeader } from '@/components/ui/surfaces';
import { THead, TBody, TR, TD } from '@/components/ui/table';
import { auditActionLabel, formatDateTime } from '@/components/labels';
import { Button, Input, NativeSelect, Table } from '@/components/ui/shadcn';

export const dynamic = 'force-dynamic';

/**
 * The global audit trail (ROUTE_ARCHITECTURE.md §155; MVP_SCOPE.md §2.2; ADR-088).
 *
 * Everything the platform recorded, newest first, across every organisation and the platform's own
 * events. The filters are links rather than a form so a search is a URL a person can keep, paste
 * into a ticket and come back to. `api.platform_audit_events` is the super admin only and resolves
 * the actor's name, which `profiles`' own-row-only RLS hides from a direct read.
 */

/** The families a platform reader actually looks for, as action prefixes. */
const FAMILIES: ReadonlyArray<{ readonly label: string; readonly prefix: string | null }> = [
  { label: 'Everything', prefix: null },
  { label: 'Members and roles', prefix: 'member.' },
  { label: 'Organisations', prefix: 'org.' },
  { label: 'Platform', prefix: 'platform.' },
  { label: 'Imports', prefix: 'import.' },
  { label: 'Documents', prefix: 'document.' },
  { label: 'The analyst', prefix: 'ai.' },
  { label: 'Jobs', prefix: 'job.' },
  { label: 'Exports', prefix: 'export.' },
];

const PAGE_SIZE = 100;

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; action?: string; from?: string; page?: string }>;
}) {
  const ctx = await getPlatformContext();
  assertCan(ctx, 'audit.view');
  const { org, action, from, page } = await searchParams;

  const organizationId = org && /^[0-9a-f-]{36}$/i.test(org) ? org : null;
  const prefix = action && /^[a-z_.]{1,40}$/.test(action) ? action : null;
  const since = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
  const pageNumber = Math.max(1, Number.parseInt(page ?? '1', 10) || 1);

  const organizations = (await readableOrganizations(ctx.db))
    .map((o) => ({ id: String(o.id), name: String(o.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);

  const events = await searchAudit(ctx, {
    organizationId, action: prefix, from: since,
    limit: PAGE_SIZE, offset: (pageNumber - 1) * PAGE_SIZE,
  });

  const href = (over: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const merged = { org: organizationId, action: prefix, from: since, page: pageNumber > 1 ? String(pageNumber) : null, ...over };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const query = next.toString();
    return `/platform/audit${query ? `?${query}` : ''}`;
  };

  return (
    <>
      <PageHeader title="Audit" description="Everything APX recorded, newest first." />

      <nav aria-label="Filter by what happened" className="mt-4 flex flex-wrap gap-2 text-sm">
        {FAMILIES.map((family) => (
          <Link key={family.label} href={href({ action: family.prefix, page: null })}
            aria-current={(family.prefix ?? null) === prefix ? 'page' : undefined}
            className={`inline-flex items-center rounded-xl border px-3 py-1.5 pointer-coarse:min-h-10 ${(family.prefix ?? null) === prefix ? 'border-accent/45 bg-accent-soft font-medium text-accent' : 'border-line bg-surface text-ink-muted transition-colors hover:border-accent/45 hover:text-ink'}`}>
            {family.label}
          </Link>
        ))}
      </nav>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <form className="flex min-w-0 max-w-full flex-wrap items-center gap-2" action="/platform/audit">
          {prefix ? <input type="hidden" name="action" value={prefix} /> : null}
          {/* `max-w-full`: a long organisation name narrows the select to the screen instead of widening the page. */}
          <label className="flex min-w-0 max-w-full items-center gap-2">
            <span className="text-ink-muted">Organisation</span>
            <NativeSelect name="org" defaultValue={organizationId ?? ''} className="w-auto min-w-0 max-w-full px-2 py-1">
              <option value="">All</option>
              {((organizations ?? []) as Array<{ id: string; name: string }>).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-ink-muted">Since</span>
            <Input type="date" name="from" defaultValue={since ?? ''} className="w-auto px-2 py-1" />
          </label>
          <Button type="submit" variant="secondary" className="px-3 py-1">Apply</Button>
        </form>
        {organizationId || since ? <Link href="/platform/audit" className="inline-flex items-center underline text-ink-muted pointer-coarse:min-h-10">Clear</Link> : null}
      </div>

      <div className="mt-6">
        <Card>
          <CardBody>
            {events.length === 0 ? (
              <EmptyState title="Nothing matches">Widen the filters, or come back when something has happened.</EmptyState>
            ) : (
              <Table>
                <caption className="sr-only">Audit events</caption>
                <THead columns={['When', 'What', 'Who', 'Organisation', 'Target']} />
                <TBody>
                  {events.map((event) => (
                    <TR key={event.id}>
                      <TD className="text-ink-muted">{formatDateTime(event.createdAt)}</TD>
                      <TD>{auditActionLabel(event.action)}</TD>
                      <TD className="text-ink-muted">{event.actorName ?? event.actorType.replace('_', ' ')}</TD>
                      <TD>
                        {event.organizationId
                          ? <Link className="underline" href={`/platform/organizations/${event.organizationId}`}>{event.organizationName ?? 'Unknown'}</Link>
                          : <span className="text-ink-muted">Platform</span>}
                      </TD>
                      <TD className="text-ink-muted">
                        {event.targetTable ? <span className="font-mono text-xs">{event.targetTable}</span> : '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        {pageNumber > 1 ? <Link className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft pointer-coarse:min-h-10" href={href({ page: pageNumber === 2 ? null : String(pageNumber - 1) })}>Newer</Link> : null}
        {events.length === PAGE_SIZE ? <Link className="inline-flex items-center gap-1 rounded-xl border border-accent/45 bg-surface px-3 py-1 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft pointer-coarse:min-h-10" href={href({ page: String(pageNumber + 1) })}>Older</Link> : null}
      </div>
    </>
  );
}
