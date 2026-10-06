'use client';

import { useActionState } from 'react';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { setInvoiceLinesAction } from '../actions';
import { Input, NativeSelect } from '@/components/ui/shadcn';

/**
 * Split one invoice across products or services (`customers.edit`). Up to four lines per save; the
 * lines may not add up to more than the invoice's net amount, and whatever is left stays "not yet
 * attributed" — never guessed onto a product.
 */
export function InvoiceLinesForm({ orgSlug, counterpartyId, invoiceId, net, existing, products }: {
  orgSlug: string; counterpartyId: string; invoiceId: string; net: string;
  existing: ReadonlyArray<{ productId: string | null; amountRaw: string; description: string | null }>;
  products: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [state, action] = useActionState(setInvoiceLinesAction, null);
  const rows = [...existing, ...Array.from({ length: Math.max(0, 4 - existing.length) }, () => ({ productId: null, amountRaw: '', description: null }))].slice(0, 4);
  return (
    <form action={action} className="flex flex-col gap-2 text-sm">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="counterparty_id" value={counterpartyId} />
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <p className="text-xs text-ink-muted">Invoice net amount {net}. Lines may not add up to more than that; anything left is shown as not yet attributed.</p>
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <NativeSelect name="product_id" defaultValue={row.productId ?? ''} aria-label={`Line ${i + 1} product`} className="px-2 py-1">
            <option value="">No product</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
          <Input name="amount" defaultValue={row.amountRaw} inputMode="decimal" placeholder="Amount" aria-label={`Line ${i + 1} amount`} className="px-2 py-1 tabular-nums" />
          <Input name="description" defaultValue={row.description ?? ''} placeholder="Description (optional)" aria-label={`Line ${i + 1} description`} className="px-2 py-1" />
        </div>
      ))}
      <ActionMessage state={state} />
      <div><SubmitButton pendingLabel="Saving…">Save lines</SubmitButton></div>
    </form>
  );
}
