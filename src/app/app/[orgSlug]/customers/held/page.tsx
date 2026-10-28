import { notFound } from 'next/navigation';
import { UsersRound } from 'lucide-react';
import { getAccessContext } from '@/modules/tenancy';
import { can } from '@/core/permissions';
import { listHeldCounterparties } from '@/modules/financials';
import { heldNameKey } from '@/modules/imports';
import { PageHeader, Card, CardBody, IconBadge } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { MergeHeldForm, RenameHeldForm } from './held-controls';

export const dynamic = 'force-dynamic';

/**
 * D-5 (owner decision): customers and suppliers HELD for an identity decision.
 *
 * When names became Unicode-aware (ADR-136), records the new key calls one name were kept apart and
 * marked held: imports naming them are refused (IMP-CP-019) until a person decides. This page is
 * where they decide — the same business (merge, audited, nothing deleted) or different businesses
 * (rename one; the last record left takes the name back when it is saved).
 */
export default async function HeldNamesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'customers.view');
  if (ctx.orgId === null) notFound();

  const data = await listHeldCounterparties(ctx.db, ctx.orgId);

  const groups = new Map<string, Array<{ id: string; name: string; kind: string }>>();
  for (const row of data) {
    const key = heldNameKey(row.normalizedName);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), { id: row.id, name: row.name, kind: row.kind }]);
  }
  const canEdit = can(ctx, 'customers.edit');

  return (
    <>
      <PageHeader
        eyebrow="Customers"
        title="Names to check"
        description="Customers or suppliers whose names look the same to APX — for example, the same name with different accents or spacing. New imports that mention them wait until you decide whether they are one business or two."
      />
      <div className="mt-8 flex flex-col gap-6">
        {groups.size === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="held-none">Nothing is waiting for a decision. If two names ever look the same, they will appear here for you to decide.</p>
        ) : [...groups.entries()].map(([key, members]) => (
          <Card key={key}>
            <CardBody className="p-4" data-testid="held-group">
              <div className="flex min-w-0 gap-3.5">
                <IconBadge tint="pink" size="sm"><UsersRound /></IconBadge>
                <div className="min-w-0">
                  <h2 className="font-serif text-lg text-ink">{members.map((m) => `“${m.name}”`).join(' and ')}</h2>
                  <p className="mt-1 text-sm text-ink-muted">
                    {members.length === 1
                      ? 'The other record of this name was renamed or merged. Save this one to release the name.'
                      : 'These are read as one name. Are they the same business?'}
                  </p>
                </div>
              </div>
              {canEdit ? (
                <div className="mt-3 flex flex-col gap-4">
                  {members.length > 1 ? <MergeHeldForm orgSlug={orgSlug} members={members} /> : null}
                  <div className="flex flex-col gap-2">
                    <p className="text-sm text-ink">
                      {members.length > 1 ? 'Or they are different businesses — rename one so the names differ:' : 'Save the name:'}
                    </p>
                    {members.map((m) => <RenameHeldForm key={m.id} orgSlug={orgSlug} id={m.id} name={m.name} />)}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-sm text-ink-muted">Someone who can edit customers can decide this.</p>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
