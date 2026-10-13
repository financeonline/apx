import Link from 'next/link';
import {
  CUSTOM_DIMENSIONS, FIXED_AREAS, MAX_CUSTOM_QUESTIONS, MAX_CUSTOM_QUESTION_CHARS, SUPPORTED_QUESTIONS, customReportPeriods,
} from '@/modules/reporting';
import { getAccessContext } from '@/modules/tenancy';
import { EmptyState, PageHeader } from '@/components/ui/surfaces';
import { requirePermission } from '@/app/_lib/authz';
import { CustomBuilder } from './custom-builder';

export const dynamic = 'force-dynamic';

/** Building a Custom AI Report (Phase 17, R17-4). */
export default async function NewCustomReportPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAccessContext(orgSlug);
  requirePermission(ctx, 'reports.view');
  requirePermission(ctx, 'ai.use');

  const periods = await customReportPeriods(ctx);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/app/${orgSlug}/reports`} className="inline-flex items-center text-accent underline underline-offset-2 pointer-coarse:min-h-10">Back to reports</Link>
      </p>
      <PageHeader
        eyebrow="Reports"
        title="Create a custom report"
        description={`Choose a month, the areas to look at and up to ${MAX_CUSTOM_QUESTIONS} questions. The AI Analyst answers each one under its usual checks, and each question counts towards your analyst allowance.`}
      />
      {periods.length === 0 ? (
        <EmptyState title="There is no complete month yet">
          A custom report is about a finished month. Once a month&apos;s figures are complete, you can create one.
        </EmptyState>
      ) : (
        <CustomBuilder
          orgSlug={orgSlug}
          periods={periods.map((p) => ({ id: p.id, label: p.label }))}
          suggestions={SUPPORTED_QUESTIONS}
          dimensions={Object.entries(CUSTOM_DIMENSIONS).map(([value, label]) => ({ value, label }))}
          fixedAreas={FIXED_AREAS}
          maxQuestions={MAX_CUSTOM_QUESTIONS}
          maxChars={MAX_CUSTOM_QUESTION_CHARS}
        />
      )}
    </>
  );
}
