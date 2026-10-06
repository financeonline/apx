'use client';

import { useActionState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { Button } from '@/components/ui/button';
import { upsertOpportunityAction } from '../actions';

const STAGES = [
  { value: 'lead', label: 'Lead' }, { value: 'qualified', label: 'Qualified' }, { value: 'proposal', label: 'Proposal' },
  { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' },
] as const;

export function NewOpportunityForm({ orgSlug, customers, campaigns, currency }: {
  orgSlug: string; customers: readonly { id: string; name: string }[]; campaigns: readonly { id: string; name: string }[]; currency: string;
}) {
  const [state, action] = useActionState(upsertOpportunityAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <Field label="What is the opportunity?" htmlFor="opp_name" hint="A short name — “Acme retainer”, “Website rebuild for Beta”.">
        <Input id="opp_name" name="name" required maxLength={200} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Stage" htmlFor="opp_stage">
          <Select id="opp_stage" name="stage" defaultValue="lead">
            {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        <Field label={`Estimated value (${currency}, optional)`} htmlFor="opp_value">
          <Input id="opp_value" name="estimated_value" inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field label="Customer (needed once won)" htmlFor="opp_customer" hint="Revenue is credited to a campaign only through the customer an opportunity was won with.">
          <Select id="opp_customer" name="counterparty_id" defaultValue="">
            <option value="">Not yet a customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Came from campaign (optional)" htmlFor="opp_campaign">
          <Select id="opp_campaign" name="campaign_id" defaultValue="">
            <option value="">Not set</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Created on" htmlFor="opp_created"><Input id="opp_created" name="created_on" type="date" /></Field>
        <Field label="Won on (if won)" htmlFor="opp_won"><Input id="opp_won" name="won_on" type="date" /></Field>
      </div>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Add to the pipeline</SubmitButton>
    </form>
  );
}

/** Move one opportunity to another stage; winning asks for the customer if there is none yet. */
export function MoveStageForm({ orgSlug, opportunityId, stage, customerId, customers }: {
  orgSlug: string; opportunityId: string; stage: string; customerId: string | null; customers: readonly { id: string; name: string }[];
}) {
  const [state, action] = useActionState(upsertOpportunityAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="opportunity_id" value={opportunityId} />
      <label className="text-xs text-ink-muted">
        Stage{' '}
        <Select name="stage" defaultValue={stage} className="inline-block w-auto px-2 py-1">
          {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </label>
      {customerId === null ? (
        <label className="text-xs text-ink-muted">
          Customer{' '}
          <Select name="counterparty_id" defaultValue="" className="inline-block w-auto px-2 py-1">
            <option value="">—</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </label>
      ) : null}
      <Button type="submit" tone="secondary">Update</Button>
      <ActionMessage state={state} />
    </form>
  );
}
