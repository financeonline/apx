'use client';

import { useActionState, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  inviteMemberAction,
  revokeInvitationAction,
  changeMemberRoleAction,
  removeMemberAction,
  revokeAdviserAction,
} from '../actions';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { Badge } from '@/components/ui/surfaces';
import { buttonClass } from '@/components/ui/button';
import { AccessPanel } from './access-panel';
import type { AccessPanelView, DepartmentsPanelView, RoleOption } from './access-view';

/*
 * The team page's forms (ADR-172). Each list is a list of people rather than a table: on a phone a
 * person is a card with every field labelled, from `md` up the same items line up as rows under a
 * header — one markup, so nothing is duplicated for screen readers.
 */

/** The row grid, shared by the header and the items so the columns line up. */
const ROW_GRID = 'md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_minmax(0,0.8fr)_auto] md:items-start md:gap-4';

/** A list item: a card on a phone, a row from `md` up. */
const ITEM = 'rounded-xl border border-line bg-surface-sunken/40 p-3 md:rounded-none md:border-0 md:bg-transparent md:px-0 md:py-4';

/** The column headings above a list, shown from `md` up; on a phone each field carries its own. */
export function ListHeader({ columns }: { columns: readonly [string, string, string] }) {
  return (
    <div aria-hidden="true" className={`hidden border-b border-line pb-2 text-xs font-medium uppercase tracking-[0.08em] text-ink-faint ${ROW_GRID}`}>
      {columns.map((column) => <span key={column}>{column}</span>)}
      <span />
    </div>
  );
}

/** A field's name: visible above the value on a phone, read out (not shown) on a wider screen. */
function FieldName({ children }: { children: ReactNode }) {
  return <span className="mb-0.5 block text-xs text-ink-faint md:sr-only">{children}</span>;
}

export function InviteForm({
  orgSlug,
  roles,
  defaultRole,
}: {
  orgSlug: string;
  roles: readonly RoleOption[];
  defaultRole: string | undefined;
}) {
  const [state, action] = useActionState(inviteMemberAction, null);
  const emailId = useId();
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <Field label="Email address" htmlFor={emailId}>
        <Input id={emailId} name="email" type="email" autoComplete="off" required />
      </Field>
      <fieldset>
        <legend className="text-sm font-medium">What can they do?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {roles.map((option) => (
            <label
              key={option.role}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface-sunken p-3 transition-colors hover:border-line-strong has-checked:border-accent has-checked:bg-accent-soft"
            >
              <input
                type="radio"
                name="role"
                value={option.role}
                defaultChecked={option.role === defaultRole}
                required
                className="mt-1 size-4 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.name}</span>
                <span className="block text-xs text-ink-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Each role starts with its own permissions. Once they have joined, you can switch individual
          permissions on or off under Access.
        </p>
      </fieldset>
      <ActionMessage state={state} />
      <div>
        <SubmitButton pendingLabel="Creating…">Send invitation</SubmitButton>
      </div>
    </form>
  );
}

export function MemberItem(props: {
  orgSlug: string;
  userId: string;
  name: string | null;
  email: string;
  role: string;
  roleLabel: string;
  statusLabel: string;
  isSelf: boolean;
  canManage: boolean;
  assignableRoles: readonly RoleOption[];
  /** Present when the viewer may switch this person's permissions (never an owner, never oneself). */
  access: AccessPanelView | null;
  /** ADR-173: "All departments" or the ticked ones; null for an owner (who sees everything). */
  departmentsSummary?: string | null;
  /** ADR-173: the departments editor in the Access panel. */
  departments?: DepartmentsPanelView | null;
  /**
   * On the viewer's own row, for a viewer who manages the team: why there is no role selector
   * (`ownRoleNote`). Nobody changes their own role (RBAC_MATRIX.md §3.18, rev 1.4).
   */
  ownRoleNote?: string | null;
}) {
  const [roleState, roleAction] = useActionState(changeMemberRoleAction, null);
  const [removeState, removeAction] = useActionState(removeMemberAction, null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const roleSelectId = useId();
  const who = props.name ?? props.email;

  return (
    <li className={ITEM}>
      <div className={`flex flex-col gap-3 ${ROW_GRID}`}>
        <div className="min-w-0">
          <FieldName>Name</FieldName>
          <p className="truncate font-medium">
            {who}
            {props.isSelf ? <span className="font-normal text-ink-muted"> (you)</span> : null}
          </p>
          {props.name ? <p className="break-all text-sm text-ink-muted">{props.email}</p> : null}
          {props.departmentsSummary ? (
            <p className="mt-0.5 text-xs text-ink-faint">Departments: {props.departmentsSummary}</p>
          ) : null}
        </div>

        <div className="min-w-0">
          {/*
            Never on one's own row: nobody changes their own role, in either direction — the service
            and `api.change_member_role` refuse it (rev 1.4 §3.18), so no selector is drawn to refuse.
          */}
          {props.canManage && !props.isSelf ? (
            <form action={roleAction} className="flex flex-wrap items-center gap-2">
              <label htmlFor={roleSelectId} className="block w-full text-xs text-ink-faint md:sr-only">
                Role for {who}
              </label>
              <input type="hidden" name="org_slug" value={props.orgSlug} />
              <input type="hidden" name="user_id" value={props.userId} />
              <input type="hidden" name="from_role" value={props.role} />
              <Select id={roleSelectId} name="to_role" defaultValue={props.role} className="min-w-0 flex-1 md:max-w-48">
                {props.assignableRoles.map((option) => (
                  <option key={option.role} value={option.role}>{option.name}</option>
                ))}
              </Select>
              <SubmitButton pendingLabel="…" tone="secondary" aria-label={`Update the role for ${who}`}>
                Update
              </SubmitButton>
            </form>
          ) : (
            <>
              <FieldName>Role</FieldName>
              <p>{props.roleLabel}</p>
              {props.isSelf && props.ownRoleNote ? (
                <p className="mt-0.5 text-xs text-ink-muted">{props.ownRoleNote}</p>
              ) : null}
            </>
          )}
          {props.access && props.access.changedCount > 0 ? (
            <p className="mt-1.5">
              <Badge tone="accent">
                {props.access.changedCount === 1 ? '1 permission changed' : `${props.access.changedCount} permissions changed`}
              </Badge>
            </p>
          ) : null}
          <ActionMessage state={roleState} />
        </div>

        <div>
          <FieldName>Status</FieldName>
          <p>{props.statusLabel}</p>
        </div>

        <div className="flex flex-wrap items-start gap-2 md:justify-end">
          {props.access ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((value) => !value)}
              className={buttonClass('secondary', 'min-h-11 md:min-h-0')}
            >
              Access
              <span className="sr-only"> for {who}</span>
              <ChevronDown aria-hidden="true" className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          ) : null}
          {props.canManage && !props.isSelf ? (
            <form action={removeAction}>
              <input type="hidden" name="org_slug" value={props.orgSlug} />
              <input type="hidden" name="user_id" value={props.userId} />
              <SubmitButton pendingLabel="Removing…" tone="danger" aria-label={`Remove ${who}`}>
                Remove
              </SubmitButton>
            </form>
          ) : null}
          <ActionMessage state={removeState} />
        </div>
      </div>

      {props.access ? (
        <div id={panelId} hidden={!open} className="mt-4">
          <AccessPanel orgSlug={props.orgSlug} who={who} panel={props.access} departments={props.departments} />
        </div>
      ) : null}
    </li>
  );
}

export function InvitationItem(props: {
  orgSlug: string;
  invitationId: string;
  email: string;
  roleLabel: string;
  expires: string;
}) {
  const [state, action] = useActionState(revokeInvitationAction, null);
  return (
    <li className={ITEM}>
      <div className={`flex flex-col gap-3 ${ROW_GRID}`}>
        <div className="min-w-0">
          <FieldName>Email</FieldName>
          <p className="break-all">{props.email}</p>
        </div>
        <div>
          <FieldName>Role</FieldName>
          <p>{props.roleLabel}</p>
        </div>
        <div>
          <FieldName>Expires</FieldName>
          <p>{props.expires}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2 md:justify-end">
          <form action={action}>
            <input type="hidden" name="org_slug" value={props.orgSlug} />
            <input type="hidden" name="invitation_id" value={props.invitationId} />
            <SubmitButton pendingLabel="…" tone="quiet" aria-label={`Withdraw the invitation to ${props.email}`}>
              Withdraw
            </SubmitButton>
          </form>
          <ActionMessage state={state} />
        </div>
      </div>
    </li>
  );
}

/**
 * A Financial Analyst — APX's staff, assigned to this company by the super admin (ADR-172). Not a
 * member: no role to change and no switches; their access is set by the super admin. An owner may
 * still end the assignment (TENANCY_MODEL.md §5.4).
 */
export function AnalystItem(props: {
  orgSlug: string;
  assignmentId: string;
  name: string;
  roleLabel: string;
  assigned: string;
  ends: string | null;
  canRevoke: boolean;
}) {
  const [state, action] = useActionState(revokeAdviserAction, null);
  return (
    <li className={ITEM}>
      <div className={`flex flex-col gap-3 ${ROW_GRID}`}>
        <div className="min-w-0">
          <FieldName>Name</FieldName>
          <p className="truncate font-medium">{props.name}</p>
        </div>
        <div>
          <FieldName>Role</FieldName>
          <p>{props.roleLabel}</p>
          <p className="text-xs text-ink-muted">Managed by the super admin</p>
        </div>
        <div>
          <FieldName>Status</FieldName>
          <p>{props.ends ? `Assigned until ${props.ends}` : `Assigned since ${props.assigned}`}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2 md:justify-end">
          {props.canRevoke ? (
            <form action={action}>
              <input type="hidden" name="org_slug" value={props.orgSlug} />
              <input type="hidden" name="assignment_id" value={props.assignmentId} />
              <SubmitButton pendingLabel="…" tone="danger" aria-label={`Remove access for ${props.name}`}>
                Remove access
              </SubmitButton>
            </form>
          ) : null}
          <ActionMessage state={state} />
        </div>
      </div>
    </li>
  );
}
