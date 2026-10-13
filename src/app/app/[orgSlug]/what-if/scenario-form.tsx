'use client';

import { useActionState, type ReactNode } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { Field, Input, Select } from '@/components/ui/field';
import { runScenarioAction } from './actions';

/**
 * "What would you like to change?" (§15).
 *
 * The whole form is eight questions a person could be asked across a desk, each closed until it is
 * wanted. Nothing is ticked to begin with, because a pre-ticked change is an assumption MOTION
 * made; and every row that IS ticked shows, in words, what MOTION will do with the answer and what
 * it will deliberately not do with it.
 *
 * The rows are plain `<details>` elements and the fields are plain inputs, so the form works before
 * any JavaScript arrives and the server reads named fields it chose rather than a JSON blob the
 * browser assembled. The only things this component adds are the pending state and the message.
 *
 * **Every word it renders arrives as a prop.** A client component cannot import the scenarios
 * module: its barrel exports services, and importing it here would pull `server-only` code — and
 * with it the shape of the write path — into the browser bundle.
 */

export interface ScenarioFormRow {
  readonly kind: string;
  readonly question: string;
  readonly note: string;
  /** Borrowing and repayments are cash by definition, so there is no choice to offer. */
  readonly cashFixed: boolean;
  readonly defaultCashEffect: string;
}

export interface ScenarioFormCopy {
  readonly cashSameMonth: string;
  readonly cashNone: string;
}

function Row({
  row, months, copy, children,
}: {
  row: ScenarioFormRow;
  months: readonly { value: number; label: string }[];
  copy: ScenarioFormCopy;
  children: ReactNode;
}) {
  const { kind } = row;
  return (
    <details className="rounded-card border border-line bg-surface p-4">
      <summary className="cursor-pointer text-sm font-medium text-ink">{row.question}</summary>
      <div className="mt-4 flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name={`include.${kind}`} className="size-4 accent-accent" />
          Include this change
        </label>

        {children}

        <div className="flex flex-wrap gap-4">
          <Field label="From which month?" htmlFor={`${kind}.startsInMonth`}>
            <Select id={`${kind}.startsInMonth`} name={`${kind}.startsInMonth`} defaultValue="1">
              {months.map((month) => (
                <option key={month.value} value={month.value}>{month.label}</option>
              ))}
            </Select>
          </Field>

          {row.cashFixed ? null : (
            <Field label="Does this change your cash?" htmlFor={`${kind}.cashEffect`}>
              <Select
                id={`${kind}.cashEffect`}
                name={`${kind}.cashEffect`}
                defaultValue={row.defaultCashEffect}
              >
                <option value="same_month">{copy.cashSameMonth}</option>
                <option value="none">{copy.cashNone}</option>
              </Select>
            </Field>
          )}
        </div>

        <p className="text-xs text-ink-muted">{row.note}</p>
      </div>
    </details>
  );
}

function SizedFields({ kind }: { kind: string }) {
  return (
    <div className="flex flex-wrap gap-4">
      <Field label="By how much?" htmlFor={`${kind}.value`}>
        <Input
          id={`${kind}.value`}
          name={`${kind}.value`}
          inputMode="decimal"
          placeholder="10"
          className="max-w-40"
        />
      </Field>
      <Field label="Up or down by" htmlFor={`${kind}.mode`}>
        <Select id={`${kind}.mode`} name={`${kind}.mode`} defaultValue="percent">
          <option value="percent">per cent</option>
          <option value="amount">a month, as an amount</option>
        </Select>
      </Field>
    </div>
  );
}

function FollowCosts({ kind }: { kind: string }) {
  return (
    <label className="flex items-start gap-2 text-sm text-ink">
      <input
        type="checkbox"
        name={`${kind}.directCostsFollow`}
        className="mt-0.5 size-4 accent-accent"
      />
      <span>
        Direct costs move too, at the rate they run at now
        <span className="block text-xs text-ink-muted">
          Leave this off and every extra pound of sales is treated as profit.
        </span>
      </span>
    </label>
  );
}

function fieldsFor(kind: string): ReactNode {
  switch (kind) {
    case 'revenue_change':
      return (<><SizedFields kind={kind} /><FollowCosts kind={kind} /></>);
    case 'pricing_change':
      return (
        <>
          <div className="flex flex-wrap gap-4">
            <Field label="Prices change by (%)" htmlFor="pricing_change.pricePercent">
              <Input
                id="pricing_change.pricePercent"
                name="pricing_change.pricePercent"
                inputMode="decimal"
                placeholder="5"
                className="max-w-40"
              />
            </Field>
            <Field
              label="And the number of sales changes by (%)"
              htmlFor="pricing_change.volumePercent"
              hint="Put 0 if you expect to sell the same amount."
            >
              <Input
                id="pricing_change.volumePercent"
                name="pricing_change.volumePercent"
                inputMode="decimal"
                placeholder="0"
                className="max-w-40"
              />
            </Field>
          </div>
          <FollowCosts kind={kind} />
        </>
      );
    case 'hiring':
      return (
        <div className="flex flex-wrap gap-4">
          <Field label="How many people?" htmlFor="hiring.headcount">
            <Input
              id="hiring.headcount"
              name="hiring.headcount"
              inputMode="numeric"
              placeholder="1"
              className="max-w-32"
            />
          </Field>
          <Field
            label="Cost of each, per month"
            htmlFor="hiring.monthlyCostPerPerson"
            hint="Everything you pay, not just the wage."
          >
            <Input
              id="hiring.monthlyCostPerPerson"
              name="hiring.monthlyCostPerPerson"
              inputMode="decimal"
              placeholder="3000"
              className="max-w-40"
            />
          </Field>
        </div>
      );
    case 'debt_drawdown':
      return (
        <Field label="How much would you borrow?" htmlFor="debt_drawdown.amount">
          <Input
            id="debt_drawdown.amount"
            name="debt_drawdown.amount"
            inputMode="decimal"
            placeholder="25000"
            className="max-w-40"
          />
        </Field>
      );
    case 'debt_repayment':
      return (
        <div className="flex flex-wrap gap-4">
          <Field label="Repayment each month" htmlFor="debt_repayment.monthlyAmount">
            <Input
              id="debt_repayment.monthlyAmount"
              name="debt_repayment.monthlyAmount"
              inputMode="decimal"
              placeholder="1200"
              className="max-w-40"
            />
          </Field>
          <Field
            label="Interest each month (optional)"
            htmlFor="debt_repayment.monthlyInterest"
            hint="Leave this empty if you do not know it — APX will not work one out."
          >
            <Input
              id="debt_repayment.monthlyInterest"
              name="debt_repayment.monthlyInterest"
              inputMode="decimal"
              placeholder="300"
              className="max-w-40"
            />
          </Field>
        </div>
      );
    default:
      return <SizedFields kind={kind} />;
  }
}

export function ScenarioForm({
  orgSlug, months, rows, copy,
}: {
  orgSlug: string;
  months: readonly { value: number; label: string }[];
  rows: readonly ScenarioFormRow[];
  copy: ScenarioFormCopy;
}) {
  const [state, submit] = useActionState(runScenarioAction, null);

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="org_slug" value={orgSlug} />

      <Field
        label="What shall we call this?"
        htmlFor="name"
        hint="So you can find it again, for example “Sales up 10%, one new hire”."
      >
        <Input id="name" name="name" required maxLength={120} placeholder="Sales up 10%" />
      </Field>

      {rows.map((row) => (
        <Row key={row.kind} row={row} months={months} copy={copy}>
          {fieldsFor(row.kind)}
        </Row>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Working it out…">Work it out</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
