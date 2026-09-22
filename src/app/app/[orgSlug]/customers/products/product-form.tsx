'use client';

import { useActionState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { createProductAction } from '../actions';

/** "Add a product or service" — rendered only for `customers.edit`. */
export function ProductForm({ orgSlug }: { orgSlug: string }) {
  const [state, action] = useActionState(createProductAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <Field label="What is it called?" htmlFor="name" hint="The name you use on invoices, for example “Monthly bookkeeping”.">
        <Input id="name" name="name" required maxLength={200} />
      </Field>
      <Field label="Is it a product or a service?" htmlFor="kind">
        <Select id="kind" name="kind" defaultValue="service">
          <option value="service">Service</option>
          <option value="product">Product</option>
        </Select>
      </Field>
      <Field label="Code (optional)" htmlFor="code" hint="If your invoicing system uses one.">
        <Input id="code" name="code" maxLength={60} />
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Add this product or service</SubmitButton>
    </form>
  );
}
