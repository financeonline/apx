'use client';

import { useActionState, useId, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Lock } from 'lucide-react';
import { setMemberPermissionAction, resetMemberPermissionsAction, setMemberDepartmentsAction } from './actions';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { Badge } from '@/components/ui/surfaces';
import type { AccessPanelView, DepartmentsPanelView, SwitchView } from './access-view';

/**
 * One person's permissions, switch by switch (ADR-172). Each switch is its own small form, so a
 * press saves at once and works before the page's script has loaded; the panel shares one result
 * message between them. What a switch would refuse is drawn disabled with the reason beside it,
 * never drawn live and refused — the service and the api.* function re-check either way. A switch an
 * owner set is drawn locked for a viewer who is not an owner ("Set by the owner"), and an owner sees
 * it as any other (RBAC_MATRIX.md §3.17, rev 1.4).
 */
export function AccessPanel({
  orgSlug,
  who,
  panel,
  departments,
}: {
  orgSlug: string;
  who: string;
  panel: AccessPanelView;
  /** ADR-173: the departments this person can open, when there are any to choose. */
  departments?: DepartmentsPanelView | null;
}) {
  const [state, action] = useActionState(setMemberPermissionAction, null);
  const [resetState, resetAction] = useActionState(resetMemberPermissionsAction, null);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-line bg-surface p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-base">Access for {who}</h3>
          <p className="text-sm text-ink-muted">
            Starts from the {panel.roleName} role’s defaults.{' '}
            {panel.changedCount === 0
              ? 'Nothing is changed for this person.'
              : panel.changedCount === 1
                ? '1 permission is changed for this person.'
                : `${panel.changedCount} permissions are changed for this person.`}
          </p>
        </div>
        {panel.resettable.length > 0 ? (
          <form action={resetAction}>
            <input type="hidden" name="org_slug" value={orgSlug} />
            <input type="hidden" name="user_id" value={panel.userId} />
            <SubmitButton pendingLabel="Resetting…" tone="secondary" aria-label={`Reset all of ${who}’s permissions to the role’s defaults`}>
              Reset all
            </SubmitButton>
          </form>
        ) : null}
      </div>
      {/*
        What "Reset all" leaves alone, or why it is not offered — the database would refuse those
        resets: a default the viewer could not give back, or a switch an owner set (rev 1.4).
      */}
      {panel.resetAllNote ? <p className="mt-2 text-xs text-warn">{panel.resetAllNote}</p> : null}

      <div className="mt-3 empty:hidden">
        <ActionMessage state={state} />
        <ActionMessage state={resetState} />
      </div>

      {departments && departments.choices.length > 0 ? (
        <DepartmentsForm orgSlug={orgSlug} userId={panel.userId} who={who} view={departments} />
      ) : null}

      <div className="mt-4 grid gap-x-8 gap-y-5 lg:grid-cols-2">
        {panel.groups.map((group) => (
          <SwitchGroup key={group.title} title={group.title}>
            {group.switches.map((view) => (
              <SwitchRow key={view.permission} orgSlug={orgSlug} userId={panel.userId} view={view} action={action} />
            ))}
          </SwitchGroup>
        ))}
      </div>
    </section>
  );
}

/**
 * The departments this person can open (ADR-173): ticks and one Save, since a choice of several is
 * one decision. Locked, with the reason, when an owner chose them and the viewer is not an owner.
 */
function DepartmentsForm({
  orgSlug,
  userId,
  who,
  view,
}: {
  orgSlug: string;
  userId: string;
  who: string;
  view: DepartmentsPanelView;
}) {
  const [state, action] = useActionState(setMemberDepartmentsAction, null);
  const headingId = useId();
  const locked = view.lockedReason !== null;
  return (
    <form action={action} aria-labelledby={headingId} className="mt-4 rounded-xl border border-line p-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="role" value={view.role} />
      <h4 id={headingId} className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">Departments</h4>
      <p className="text-xs text-ink-muted">Departments that are not ticked are hidden from {who}.</p>
      {view.lockedReason ? (
        <p className="mt-1 inline-flex items-start gap-1 text-xs text-warn">
          <Lock aria-hidden="true" className="mt-px size-3 shrink-0" />
          <span>{view.lockedReason}</span>
        </p>
      ) : null}
      <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {view.choices.map((choice) => (
          <label key={choice.key} className={`flex min-h-11 items-center gap-2 text-sm ${locked ? 'opacity-60' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              name="departments"
              value={choice.key}
              defaultChecked={choice.checked}
              disabled={locked}
              className="size-4 shrink-0 accent-accent"
            />
            <span title={choice.detail}>{choice.title}</span>
          </label>
        ))}
      </div>
      {locked ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <SubmitButton pendingLabel="Saving…" tone="secondary" aria-label={`Save ${who}’s departments`}>
            Save departments
          </SubmitButton>
          <ActionMessage state={state} />
        </div>
      )}
    </form>
  );
}

function SwitchGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <h4 id={id} className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">{title}</h4>
      <ul className="mt-1 divide-y divide-line">{children}</ul>
    </div>
  );
}

function SwitchRow({
  orgSlug,
  userId,
  view,
  action,
}: {
  orgSlug: string;
  userId: string;
  view: SwitchView;
  action: (form: FormData) => void;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const detailId = `${id}-detail`;
  const reasonId = `${id}-reason`;
  const withheldId = `${id}-withheld`;
  const describedBy = [detailId, view.lockedReason ? reasonId : null, view.withheldNote ? withheldId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <span id={titleId}>{view.title}</span>
          {view.change === 'added' ? <Badge tone="accent">Added</Badge> : null}
          {view.change === 'taken_away' ? <Badge tone="warn">Taken away</Badge> : null}
        </p>
        <p id={detailId} className="text-xs text-ink-muted">{view.detail}</p>
        <p className="mt-0.5 text-xs text-ink-faint">Role default: {view.byDefault ? 'on' : 'off'}</p>
        {/* A switch-off the ceiling stored at a role change or an invitation (RBAC_MATRIX §3.15, rev 1.4). */}
        {view.withheldNote ? (
          <p id={withheldId} className="mt-1 text-xs text-ink-muted">{view.withheldNote}</p>
        ) : null}
        {/*
          Why the switch is disabled. For a switch an owner set and a viewer who is not an owner, this
          is the whole story (§3.17): no "Back to the role's default" is drawn, and no reset reason.
        */}
        {view.lockedReason ? (
          <p id={reasonId} className="mt-1 inline-flex items-start gap-1 text-xs text-warn">
            {view.ownerLocked ? <Lock aria-hidden="true" className="mt-px size-3 shrink-0" /> : null}
            <span>{view.lockedReason}</span>
          </p>
        ) : null}
        {view.resetLockedReason ? (
          <p className="mt-1 text-xs text-ink-muted">
            <span className="text-ink-faint line-through decoration-ink-faint/60">Back to the role’s default</span>{' '}
            — {view.resetLockedReason}
          </p>
        ) : null}
        {view.canReset ? (
          <form action={action} className="mt-1">
            <input type="hidden" name="org_slug" value={orgSlug} />
            <input type="hidden" name="user_id" value={userId} />
            <input type="hidden" name="permission" value={view.permission} />
            <input type="hidden" name="granted" value="default" />
            <ResetButton title={view.title} />
          </form>
        ) : null}
      </div>
      <form action={action} className="shrink-0">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="user_id" value={userId} />
        <input type="hidden" name="permission" value={view.permission} />
        <input type="hidden" name="granted" value={view.next} />
        <Switch on={view.on} disabled={view.lockedReason !== null} labelledBy={titleId} describedBy={describedBy} />
      </form>
    </li>
  );
}

/**
 * The switch itself: a submit button with the switch role, so a screen reader hears its name, its
 * state and its reason, and a keyboard presses it with Space or Enter. At least 44px tall to touch.
 * The word beside the track says the state too, so it never rests on colour alone.
 */
function Switch({
  on,
  disabled,
  labelledBy,
  describedBy,
}: {
  on: boolean;
  disabled: boolean;
  labelledBy: string;
  describedBy: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className="inline-flex min-h-11 items-center gap-2 rounded-full px-1 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
          on ? 'border-transparent bg-accent bg-brand-gradient' : 'border-line-strong bg-surface-sunken'
        } ${pending ? 'animate-pulse' : ''}`}
      >
        <span
          className={`inline-block size-5 rounded-full bg-ink shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </span>
      <span aria-hidden="true" className="w-7 text-left text-xs text-ink-muted">
        {pending ? '…' : on ? 'On' : 'Off'}
      </span>
    </button>
  );
}

function ResetButton({ title }: { title: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={`Back to the role’s default for ${title}`}
      className="min-h-8 text-xs text-accent underline underline-offset-2 hover:text-accent-hover disabled:opacity-50"
    >
      {pending ? 'Working…' : 'Back to the role’s default'}
    </button>
  );
}
