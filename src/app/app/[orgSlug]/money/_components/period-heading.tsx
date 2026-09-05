import { PageHeader } from '@/components/ui/surfaces';
import { PeriodPicker } from '@/components/dashboard';
import type { PeriodScope } from '@/modules/dashboard';

/**
 * The heading every period-scoped page carries (UX_ARCHITECTURE.md §4).
 *
 * §4 makes two demands of a page that shows a month: it must state the month IN THE HEADING, and it
 * must offer the period picker. Both here, once, so the Money sub-pages and Customers cannot drift
 * apart on either — a page titled "Profit & loss" with a picker somewhere below it leaves a reader
 * unsure which month they are looking at, which is the whole failure this rule exists to prevent.
 */
export function PeriodHeading({
  eyebrow,
  title,
  description,
  scope,
  hrefFor,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  scope: PeriodScope;
  hrefFor: (periodId: string) => string;
  action?: React.ReactNode;
}) {
  return (
    <>
      <PageHeader
        eyebrow={eyebrow}
        title={`${title} — ${scope.period.label}`}
        description={description}
        action={action}
      />
      <div className="mb-8">
        <PeriodPicker periods={scope.periods} value={scope.period.id} hrefFor={hrefFor} />
      </div>
    </>
  );
}
