import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@/core/permissions';
import { listAvailable } from '@/modules/reporting';
import { getAccessContext } from '@/modules/tenancy';
import { ReportsBeforeFirstMonthEmpty } from '@/components/dashboard';
import { Card, CardBody, PageHeader } from '@/components/ui/surfaces';

export const dynamic = 'force-dynamic';

/**
 * The report list (ROUTE_ARCHITECTURE.md §118; ADR-024).
 *
 * Complete months only. A management report for a month still in progress is a set of figures that
 * will change after somebody has acted on them — so the list does not offer one, rather than
 * offering it with a caveat nobody reads (ADR-030.4).
 */
export default async function ReportsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  if (!can(ctx, 'reports.view')) notFound();

  const reports = await listAvailable(ctx);

  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title="Monthly Management Report"
        description="One report a month, from the figures MOTION has already calculated."
      />

      <div className="mt-8">
        {reports.length === 0 ? (
          <ReportsBeforeFirstMonthEmpty addDataHref={`/app/${orgSlug}/data/imports/new`} />
        ) : (
          <ul className="flex flex-col gap-3">
            {reports.map((report) => (
              <li key={report.periodId}>
                <Card>
                  <CardBody className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div>
                      <p className="text-ink">{report.periodLabel}</p>
                      <p className="mt-1 text-sm text-ink-muted">
                        {report.file === null
                          ? 'Ready to read on screen. A PDF can be produced from the report.'
                          : `PDF produced ${report.file.createdAt.slice(0, 10)}`}
                      </p>
                    </div>
                    <Link
                      href={`/app/${orgSlug}/reports/monthly/${report.periodId}`}
                      className="text-sm text-accent underline underline-offset-2"
                    >
                      Open the report
                      <span className="sr-only"> for {report.periodLabel}</span>
                    </Link>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
