'use client';

import { useActionState, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { saveCompanyProfileAction } from './actions';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import type { CompanyProfile } from '@/modules/marketing';

/** The limits the database applies, passed down by the page (a client file cannot import the module). */
export interface ProfileLimits {
  readonly website: number;
  readonly linkLabel: number;
  readonly linkUrl: number;
  readonly links: number;
  readonly productsServices: number;
  readonly industry: number;
  readonly description: number;
}

interface Row {
  readonly key: number;
  readonly label: string;
  readonly url: string;
}

/**
 * The company profile form (ADR-170). Every field is sent on every save — the profile is replaced
 * whole — and the social links are rows the analyst adds and removes; a row left blank is ignored.
 */
export function CompanyProfileForm({ orgSlug, profile, limits }: {
  orgSlug: string;
  profile: CompanyProfile;
  limits: ProfileLimits;
}) {
  const [state, action] = useActionState(saveCompanyProfileAction, null);
  const initial: Row[] = profile.socialLinks.length > 0
    ? profile.socialLinks.map((link, i) => ({ key: i, label: link.label, url: link.url }))
    : [{ key: 0, label: '', url: '' }];
  const [rows, setRows] = useState<Row[]>(initial);
  const [nextKey, setNextKey] = useState(initial.length);

  // After a save the page re-renders with the stored links, and React resets the form's fields to
  // their defaults. Start the rows again from what was stored, under new keys so each input mounts
  // with the stored value (otherwise the rows fall back to the links the page first opened with).
  const savedLinks = JSON.stringify(profile.socialLinks);
  const [shownLinks, setShownLinks] = useState(savedLinks);
  if (shownLinks !== savedLinks) {
    setShownLinks(savedLinks);
    const fresh: Row[] = profile.socialLinks.length > 0
      ? profile.socialLinks.map((link, i) => ({ key: nextKey + i, label: link.label, url: link.url }))
      : [{ key: nextKey, label: '', url: '' }];
    setRows(fresh);
    setNextKey(nextKey + fresh.length);
  }

  const addRow = () => {
    if (rows.length >= limits.links) return;
    setRows([...rows, { key: nextKey, label: '', url: '' }]);
    setNextKey(nextKey + 1);
  };
  const removeRow = (key: number) => {
    const left = rows.filter((r) => r.key !== key);
    setRows(left.length > 0 ? left : [{ key: nextKey, label: '', url: '' }]);
    if (left.length === 0) setNextKey(nextKey + 1);
  };

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={orgSlug} />

      <Field label="What the company sells" htmlFor="products_services" hint="Products or services, in your own words — for example “Handmade leather bags, belts and wallets”.">
        <Textarea id="products_services" name="products_services" rows={3} maxLength={limits.productsServices}
          defaultValue={profile.productsServices ?? ''} />
      </Field>
      <Field label="Industry" htmlFor="industry" hint="In plain words — for example “Luxury leather accessories”.">
        <Input id="industry" name="industry" maxLength={limits.industry} defaultValue={profile.industry ?? ''} />
      </Field>
      <Field label="About the business" htmlFor="description" hint="A short history or description: who it serves, where, and what makes it different.">
        <Textarea id="description" name="description" rows={5} maxLength={limits.description}
          defaultValue={profile.description ?? ''} />
      </Field>
      <Field label="Website" htmlFor="website" hint="For example bearabeara.co.uk — https:// is added for you.">
        <Input id="website" name="website" inputMode="url" maxLength={limits.website} defaultValue={profile.website ?? ''}
          placeholder="https://" />
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Social pages</legend>
        <p className="text-xs text-ink-muted">Instagram, LinkedIn, TikTok and the like, in the order you want them listed.</p>
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <li key={row.key} className="flex flex-wrap items-end gap-3">
              {/* Name and address side by side from `sm`; stacked on a phone. */}
              <div className="w-full space-y-1.5 sm:w-40 sm:shrink-0">
                <label htmlFor={`social_label_${row.key}`} className="text-xs text-ink-muted">Name</label>
                <Input id={`social_label_${row.key}`} name="social_label" maxLength={limits.linkLabel}
                  defaultValue={row.label} placeholder="Instagram" />
              </div>
              <div className="min-w-0 flex-1 basis-48 space-y-1.5">
                <label htmlFor={`social_url_${row.key}`} className="text-xs text-ink-muted">Web address</label>
                <Input id={`social_url_${row.key}`} name="social_url" inputMode="url" maxLength={limits.linkUrl}
                  defaultValue={row.url} placeholder="https://instagram.com/yourbrand" />
              </div>
              <Button type="button" tone="quiet" onClick={() => removeRow(row.key)} aria-label={`Remove social page ${index + 1}`}>
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
        {rows.length < limits.links ? (
          <Button type="button" tone="secondary" onClick={addRow}>
            <Plus aria-hidden="true" /> Add a social page
          </Button>
        ) : (
          <p className="text-xs text-ink-muted">That is the most social pages a profile holds ({limits.links}).</p>
        )}
      </fieldset>

      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
    </form>
  );
}
