'use client';

import { useActionState } from 'react';
import {
  inviteMemberAction,
  revokeInvitationAction,
  changeMemberRoleAction,
  removeMemberAction,
  revokeAdviserAction,
} from '../actions';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { TR, TD } from '@/components/ui/table';
import { MEMBERSHIP_ROLE_LABELS } from '@/components/labels';
import type { Member, PendingInvitation, Adviser, MembershipRole } from '@/modules/tenancy';

export function InviteForm({ orgSlug, roles }: { orgSlug: string; roles: readonly MembershipRole[] }) {
  const [state, action] = useActionState(inviteMemberAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <Field label="Email address" htmlFor="email">
        <Input id="email" name="email" type="email" required />
      </Field>
      <Field label="What can they do?" htmlFor="role">
        <Select id="role" name="role" defaultValue={roles.includes('client') ? 'client' : roles[0]}>
          {roles.map((role) => (
            <option key={role} value={role}>{MEMBERSHIP_ROLE_LABELS[role] ?? role}</option>
          ))}
        </Select>
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Creating…">Send invitation</SubmitButton>
    </form>
  );
}

export function MemberRow(props: {
  orgSlug: string;
  member: Member;
  canManage: boolean;
  isSelf: boolean;
  roleLabel: string;
  statusLabel: string;
  assignableRoles: readonly MembershipRole[];
}) {
  const [roleState, roleAction] = useActionState(changeMemberRoleAction, null);
  const [removeState, removeAction] = useActionState(removeMemberAction, null);
  const { member } = props;

  return (
    <TR>
      <TD>{member.fullName ?? '—'}</TD>
      <TD>{member.email}</TD>
      <TD>
        {props.canManage && !props.isSelf ? (
          <form action={roleAction} className="flex items-center gap-2">
            <input type="hidden" name="org_slug" value={props.orgSlug} />
            <input type="hidden" name="user_id" value={member.userId} />
            <input type="hidden" name="from_role" value={member.role} />
            <Select name="to_role" defaultValue={member.role} aria-label={`Role for ${member.email}`}>
              {props.assignableRoles.map((role) => (
                <option key={role} value={role}>{MEMBERSHIP_ROLE_LABELS[role] ?? role}</option>
              ))}
            </Select>
            <SubmitButton pendingLabel="…" tone="secondary">Update</SubmitButton>
          </form>
        ) : (
          props.roleLabel
        )}
        <ActionMessage state={roleState} />
      </TD>
      <TD>{props.statusLabel}</TD>
      <TD>
        {props.canManage && !props.isSelf && (
          <form action={removeAction}>
            <input type="hidden" name="org_slug" value={props.orgSlug} />
            <input type="hidden" name="user_id" value={member.userId} />
            <SubmitButton pendingLabel="Removing…" tone="danger">Remove</SubmitButton>
          </form>
        )}
        <ActionMessage state={removeState} />
      </TD>
    </TR>
  );
}

export function InvitationRow({ orgSlug, invitation }: { orgSlug: string; invitation: PendingInvitation }) {
  const [state, action] = useActionState(revokeInvitationAction, null);
  return (
    <TR>
      <TD>{invitation.email}</TD>
      <TD>{MEMBERSHIP_ROLE_LABELS[invitation.role] ?? invitation.role}</TD>
      <TD>{new Date(invitation.expiresAt).toLocaleDateString('en-GB')}</TD>
      <TD>
        <form action={action}>
          <input type="hidden" name="org_slug" value={orgSlug} />
          <input type="hidden" name="invitation_id" value={invitation.invitationId} />
          <SubmitButton pendingLabel="…" tone="quiet">Withdraw</SubmitButton>
        </form>
        <ActionMessage state={state} />
      </TD>
    </TR>
  );
}

export function AdviserRow(props: { orgSlug: string; adviser: Adviser; canRevoke: boolean }) {
  const [state, action] = useActionState(revokeAdviserAction, null);
  return (
    <TR>
      <TD>{props.adviser.fullName ?? 'APX adviser'}</TD>
      <TD>{new Date(props.adviser.assignedAt).toLocaleDateString('en-GB')}</TD>
      <TD>{props.adviser.endsAt ? new Date(props.adviser.endsAt).toLocaleDateString('en-GB') : '—'}</TD>
      <TD>
        {props.canRevoke && (
          <form action={action}>
            <input type="hidden" name="org_slug" value={props.orgSlug} />
            <input type="hidden" name="assignment_id" value={props.adviser.assignmentId} />
            <SubmitButton pendingLabel="…" tone="danger">Remove access</SubmitButton>
          </form>
        )}
        <ActionMessage state={state} />
      </TD>
    </TR>
  );
}
