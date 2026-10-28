import Link from 'next/link';
import { Info } from 'lucide-react';
import type { QuotaStatus } from '@/modules/ai';
import { Card, CardBody, IconBadge } from '@/components/ui/surfaces';

/**
 * What the AI Analyst can and cannot do, and what a question uses (client-friendliness pass,
 * 2026-10-28). An owner should not have to spend a question to find out what is in scope.
 *
 * The scope follows AI_ARCHITECTURE.md: it reads the business's own figures through APX's tools,
 * reports APX's forecast and affordability check rather than working figures out itself, refuses
 * a new what-if (the What-if page works those out) and anything outside the business's data, and
 * gives no regulated advice. The allowance is the organisation's daily count (`ai_quota_status`
 * counts every member's questions since UTC midnight), with a monthly ceiling behind it.
 *
 * Open by default until the reader has a conversation; after that it folds away, one click from
 * view. No question is sent from here: the examples are text, and asking stays the reader's act.
 */
export function AboutAnalyst({
  quota, open, whatIfHref,
}: {
  quota: QuotaStatus;
  open: boolean;
  /** The What-if page, for a reader who may open it; otherwise it is named without a link. */
  whatIfHref: string | null;
}) {
  const whatIf = whatIfHref === null
    ? 'the What-if page'
    : <Link href={whatIfHref} className="text-accent underline underline-offset-2">the What-if page</Link>;
  return (
    <Card>
      <CardBody className="p-4">
        <details open={open} className="group text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-3 pointer-coarse:min-h-10 [&::-webkit-details-marker]:hidden">
            <IconBadge tint="violet" size="sm"><Info /></IconBadge>
            <span className="font-medium text-ink">What the AI Analyst can help with</span>
            <span className="ml-auto text-xs text-accent group-open:hidden">Show</span>
            <span className="ml-auto hidden text-xs text-accent group-open:inline">Hide</span>
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="font-medium text-ink">It can answer</h3>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-ink-muted">
                <li>How a month went, and why profit or cash moved</li>
                <li>Which costs went up, and by how much</li>
                <li>Who your biggest customers are, and who owes you money</li>
                <li>What APX expects for the months ahead, from its forecast</li>
                <li>Whether a planned spend looks affordable, from that forecast</li>
                <li>What needs your attention first</li>
              </ul>
            </div>
            <div>
              <h3 className="font-medium text-ink">It cannot</h3>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-ink-muted">
                <li>Work out a &ldquo;what if&rdquo; itself: use {whatIf}, and it can read a saved one back</li>
                <li>Use figures you have not added to APX, or see your bank live (it reads the statements you import)</li>
                <li>Answer questions about anything other than your business&apos;s figures</li>
                <li>Give tax, legal or regulated financial advice</li>
              </ul>
            </div>
          </div>
          <div className="mt-4">
            <h3 className="font-medium text-ink">Good questions to ask</h3>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-ink-muted">
              <li>&ldquo;Why did profit fall last month?&rdquo;</li>
              <li>&ldquo;Which customers owe us the most?&rdquo;</li>
              <li>&ldquo;How much cash will we have in three months?&rdquo;</li>
              <li>&ldquo;Can we afford to spend £5,000 on new equipment next month?&rdquo;</li>
            </ul>
            <p className="mt-2 text-xs text-ink-faint">Name a month (&ldquo;in September&rdquo;) for a sharper answer.</p>
          </div>
          <div className="mt-4 border-t border-line pt-3 text-ink-muted">
            <h3 className="font-medium text-ink">How answers work</h3>
            <p className="mt-1">
              Every figure comes from your own records, as APX has worked them out. Each line is labelled
              (for example Fact, Calculated or Estimate), and &ldquo;Why?&rdquo; shows where a figure came from.
            </p>
            <p className="mt-2">
              {quota.dailyLimit === null
                ? 'There is no daily limit on questions for your business.'
                : `Each question uses one of your business's ${quota.dailyLimit} questions a day, shared by everyone in the business. The count starts again at midnight (UTC).`}
              {quota.monthlyCeiling === null ? '' : ' There is also a monthly limit; if it is reached, the analyst pauses until the next month.'}
            </p>
          </div>
        </details>
      </CardBody>
    </Card>
  );
}
