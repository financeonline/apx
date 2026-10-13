import { formatMoney } from '@/core/money';
import {
  AFFORDABILITY_RULE_TEXT, AFFORDABILITY_UNAVAILABLE_TEXT, AFFORDABILITY_VERDICT_LABEL, AFFORDABILITY_VERDICT_TEXT,
  type AffordabilityCheck,
} from '@/modules/scenarios';
import { Calculator } from 'lucide-react';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { Button, Input, NativeSelect, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/shadcn';

/**
 * "Can we afford it?" (SOW §12; ADR-146). A plain GET form: the check is worked out on the server
 * when the page loads with the question in the address, and nothing is saved. The analyst calls
 * the same service, so the two cannot disagree.
 */
export function AffordabilityCard({
  orgSlug, months, asked, check,
}: {
  orgSlug: string;
  months: readonly { value: number; label: string }[];
  asked: { amount: string; recurrence: string; start: number } | null;
  /** NULL when nothing was asked; `unreadable` when the amount could not be read. */
  check: AffordabilityCheck | 'unreadable' | null;
}) {
  const fmt = (value: string, currency: string | null) => formatMoney(value, { currency: currency ?? 'GBP', showMinorUnits: true });
  return (
    <Card className="mt-6">
      <CardHeader
        title="Can we afford it?"
        icon={<Calculator />}
        tint="pink"
        description="Enter a spend you are thinking about. APX checks it against the cash it expects over the forecast months."
      />
      <CardBody>
        <form method="get" action={`/app/${orgSlug}/what-if`} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Amount</span>
            <Input name="afford_amount" defaultValue={asked?.amount ?? ''} inputMode="decimal" required
              className="w-40 px-2 py-1" placeholder="25,000" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">How often</span>
            <NativeSelect name="afford_recurrence" defaultValue={asked?.recurrence ?? 'one_off'}
              className="px-2 py-1">
              <option value="one_off">Once</option>
              <option value="monthly">Every month</option>
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">From</span>
            <NativeSelect name="afford_start" defaultValue={String(asked?.start ?? 1)}
              className="px-2 py-1">
              {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </NativeSelect>
          </label>
          <Button type="submit" variant="secondary" className="px-3 py-1.5">Check</Button>
        </form>

        {check === 'unreadable' ? (
          <p role="status" className="mt-4 text-sm text-ink">{AFFORDABILITY_UNAVAILABLE_TEXT.invalid_amount}</p>
        ) : check === null ? null : check.result.unavailable !== null ? (
          <p role="status" className="mt-4 text-sm text-ink">{AFFORDABILITY_UNAVAILABLE_TEXT[check.result.unavailable]}</p>
        ) : (
          <section aria-label="Affordability result" className="mt-5">
            <p className="flex flex-wrap items-baseline gap-3">
              <Badge tone={check.result.verdict === 'affordable' ? 'accent' : check.result.verdict === 'tight' ? 'warn' : 'danger'}>{AFFORDABILITY_VERDICT_LABEL[check.result.verdict!]}</Badge>
              <span className="text-sm text-ink">{AFFORDABILITY_VERDICT_TEXT[check.result.verdict!]}</span>
            </p>
            <p className="mt-2 text-sm text-ink-muted">
              {fmt(check.result.amount, check.currency)} {check.result.recurrence === 'monthly' ? 'every month' : 'once'} from {check.startLabel}.
              {' '}Lowest cash after it: {fmt(check.result.lowest!.cashAfter, check.currency)} in {check.result.lowest!.periodLabel}.
              {' '}One month of normal money out: {fmt(check.result.buffer!, check.currency)}.
              {check.result.verdictWithout !== 'affordable' ? ' Cash is already below that cushion before this spend.' : ''}
            </p>
            <Table className="mt-4 min-w-0 max-w-lg">
              <TableHeader><TableRow className="text-left text-ink-muted"><TableHead className="py-1 font-normal">Month</TableHead><TableHead className="py-1 text-right font-normal">Cash expected</TableHead><TableHead className="py-1 text-right font-normal">After this spend</TableHead></TableRow></TableHeader>
              <TableBody>
                {check.result.months.map((m) => (
                  <TableRow key={m.periodId} className="border-t border-line">
                    <TableCell className="py-1 text-ink">{m.periodLabel}</TableCell>
                    <TableCell className="py-1 text-right text-ink-muted">{fmt(m.expectedCash, check.currency)}</TableCell>
                    <TableCell className="py-1 text-right text-ink">{fmt(m.cashAfter, check.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {check.forecast?.stale ? <p className="mt-2 text-sm text-ink">The figures have moved since this forecast was worked out; work it out again for a current answer.</p> : null}
            <p className="mt-3 text-xs text-ink-faint">{AFFORDABILITY_RULE_TEXT}</p>
          </section>
        )}
      </CardBody>
    </Card>
  );
}
