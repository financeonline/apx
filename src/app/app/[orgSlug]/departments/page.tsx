import Link from 'next/link';
import { loadDepartments, type TileTone } from '@/modules/departments';
import { getAccessContext } from '@/modules/tenancy';
import { Badge, Card, CardBody, PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';

export const dynamic = 'force-dynamic';

/**
 * The Departmental Dashboard (Agreement §4; ADR-143): every department of the business as MOTION
 * sees it, and how the system itself is running. A department the viewer may not open is absent.
 */

const TONE: Readonly<Record<TileTone, { label: string; tone: 'accent' | 'warn' | 'neutral' }>> = {
  good: { label: 'In order', tone: 'accent' },
  attention: { label: 'Needs attention', tone: 'warn' },
  quiet: { label: 'Nothing yet', tone: 'neutral' },
};

export default async function DepartmentsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  // Not `dashboard.view` alone: a suspended member sees only the frozen Home (ADR-044.4).
  requirePermission(ctx, 'financials.view');
  const view = await loadDepartments(ctx);

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Departments"
        description="Each part of the business at a glance, and how MOTION itself is running. Every figure is the one its own page shows."
      />
      <section aria-labelledby="departments-heading">
        <h2 id="departments-heading" className="sr-only">Business departments</h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {view.tiles.map((tile) => (
            <li key={tile.key}>
              <Card className="h-full">
                <CardBody>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-serif text-lg text-ink">
                      <Link href={tile.href} className="underline-offset-2 hover:underline">{tile.title}</Link>
                    </h3>
                    <Badge tone={TONE[tile.tone].tone}>{TONE[tile.tone].label}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-ink">{tile.headline}</p>
                  {tile.lines.map((line) => <p key={line} className="mt-1 text-sm text-ink-muted">{line}</p>)}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <Card className="mt-8">
        <CardBody>
          <h2 className="font-serif text-lg text-ink">How MOTION is running</h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm text-ink">
            <li>{view.system.dataRefreshed}</li>
            <li>{view.system.lastCalculation}</li>
            {view.system.imports === null ? null : <li>{view.system.imports}</li>}
            {view.system.team === null ? null : <li>{view.system.team}</li>}
          </ul>
          <h3 className="mt-4 text-sm font-medium text-ink">On a schedule</h3>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
            {view.system.schedule.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <h3 className="mt-4 text-sm font-medium text-ink">Switched on for this organisation</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {view.system.modules.map((m) => (
              <li key={m.label} className="flex justify-between gap-2">
                <span className="text-ink">{m.label}</span>
                <span className="text-ink-muted">{m.on ? 'On' : 'Off'}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}
