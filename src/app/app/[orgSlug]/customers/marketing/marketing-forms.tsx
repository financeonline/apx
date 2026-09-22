'use client';

import { useActionState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { createCampaignAction, createChannelAction, setSpendAction } from '../actions';

/** The three small marketing forms, each for `customers.edit` only. */
export function ChannelForm({ orgSlug }: { orgSlug: string }) {
  const [state, action] = useActionState(createChannelAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <Field label="Channel name" htmlFor="channel_name" hint="Your own words — Instagram, Referrals, Google Ads, Word of mouth.">
        <Input id="channel_name" name="name" required maxLength={120} />
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Add channel</SubmitButton>
    </form>
  );
}

export function CampaignForm({ orgSlug, channels }: { orgSlug: string; channels: readonly { id: string; name: string }[] }) {
  const [state, action] = useActionState(createCampaignAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <Field label="Campaign name" htmlFor="campaign_name">
        <Input id="campaign_name" name="name" required maxLength={200} />
      </Field>
      <Field label="Which channel?" htmlFor="campaign_channel">
        <Select id="campaign_channel" name="channel_id" defaultValue="">
          <option value="">Not set</option>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts (optional)" htmlFor="campaign_starts"><Input id="campaign_starts" name="starts_on" type="date" /></Field>
        <Field label="Ends (optional)" htmlFor="campaign_ends"><Input id="campaign_ends" name="ends_on" type="date" /></Field>
      </div>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Add campaign</SubmitButton>
    </form>
  );
}

export function SpendForm({ orgSlug, campaignId, periods, currency }: { orgSlug: string; campaignId: string; periods: readonly { id: string; label: string }[]; currency: string }) {
  const [state, action] = useActionState(setSpendAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="campaign_id" value={campaignId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Month" htmlFor="spend_period">
          <Select id="spend_period" name="period_id" defaultValue={periods[periods.length - 1]?.id ?? ''}>
            {periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label={`Spend (${currency})`} htmlFor="spend_amount" hint="What was spent on this campaign that month. Replaces any earlier figure for the month.">
          <Input id="spend_amount" name="amount" inputMode="decimal" required placeholder="0.00" />
        </Field>
      </div>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Record spend</SubmitButton>
    </form>
  );
}
