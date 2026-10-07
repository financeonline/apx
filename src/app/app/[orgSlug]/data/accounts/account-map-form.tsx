'use client';

import { useActionState } from 'react';
import { Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { TR, TD } from '@/components/ui/table';
import { Badge } from '@/components/ui/surfaces';
import type { AccountRow } from '@/modules/dashboard';
import type { StandardCategory } from '@/modules/financials';
import { remapAccountAction } from './actions';
import { LoanSecurityControl } from './loan-security-form';

/**
 * One account, with its category and — for a role that may change it — the control that does.
 *
 * A role without `financials.edit` sees the category as text. The control is absent, not disabled
 * (§7.4, RBAC §5): a greyed-out select tells a client exactly which capability they are missing and
 * invites a support request about a button that was never theirs.
 */
export function AccountRowView({
  orgSlug,
  row,
  categories,
  categoryLabels,
  canEdit,
  isLoan = false,
}: {
  orgSlug: string;
  row: AccountRow;
  categories: readonly StandardCategory[];
  categoryLabels: Readonly<Record<string, string>>;
  canEdit: boolean;
  /** A loan or long-term liability account, which can be marked secured or unsecured (ADR-156). */
  isLoan?: boolean;
}) {
  const [state, action] = useActionState(remapAccountAction, null);
  const { account } = row;

  return (
    <TR>
      <TD className="tabular">{account.code ?? '—'}</TD>
      <TD>
        {account.name}
        {account.isSystem ? (
          <span className="ml-2 text-xs text-ink-faint">built in</span>
        ) : null}
      </TD>
      <TD>
        {canEdit && row.remappable ? (
          <form action={action} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="org_slug" value={orgSlug} />
            <input type="hidden" name="account_id" value={account.id} />
            <Select
              name="standard_category"
              defaultValue={account.standardCategory}
              aria-label={`Category for ${account.name}`}
              className="w-auto"
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {categoryLabels[category] ?? category}
                </option>
              ))}
            </Select>
            <SubmitButton pendingLabel="Saving…" tone="secondary">
              Save
            </SubmitButton>
          </form>
        ) : (
          row.categoryLabel
        )}
        <ActionMessage state={state} />
        {isLoan ? (
          <LoanSecurityControl
            orgSlug={orgSlug}
            accountId={account.id}
            accountName={account.name}
            security={account.loanSecurity ?? null}
            canEdit={canEdit}
          />
        ) : null}
      </TD>
      <TD>
        {row.needsAttention ? (
          <Badge tone="warn">{row.confidenceLabel}</Badge>
        ) : (
          <span className="text-ink-muted">{row.confidenceLabel}</span>
        )}
      </TD>
    </TR>
  );
}
