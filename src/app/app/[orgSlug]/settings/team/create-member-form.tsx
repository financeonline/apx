'use client';

import { useActionState, useId, useState, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { createMemberLoginAction } from './actions';
import { Field, Input } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import type { CreateMemberView } from './access-view';

/**
 * "Create a team member" (ADR-173; owner, 2026-10-14): the company makes the person's login — their
 * email and the password typed here, which stays their password — and ticks the departments they can
 * open and what they can do. "Start from" pre-ticks a kind of team member's usual permissions; the
 * ticks are what the person gets. A permission the viewer does not hold is drawn, disabled, with the
 * reason: nobody gives what they do not have (the service and the database refuse it anyway).
 */

type Template = CreateMemberView['templates'][number]['role'];

function startingDepartments(view: CreateMemberView, template: Template): Set<string> {
  const keys = view.departments.map((d) => d.key);
  if (template === 'third_party') return new Set(keys.filter((key) => key === 'reports'));
  if (template === 'accountant') return new Set(keys.filter((key) => key !== 'analyst'));
  return new Set(keys);
}

function startingPermissions(view: CreateMemberView, role: keyof CreateMemberView['defaults']): Set<string> {
  const held = new Set(view.permissionGroups.flatMap((g) => g.choices.filter((c) => c.held).map((c) => c.permission)));
  return new Set(view.defaults[role].filter((p) => held.has(p)));
}

export function CreateMemberForm({ orgSlug, view }: { orgSlug: string; view: CreateMemberView }) {
  const [state, action] = useActionState(createMemberLoginAction, null);
  const first = view.templates[0]?.role ?? 'client';
  const [template, setTemplate] = useState<Template>(first);
  const [manager, setManager] = useState(false);
  const [departments, setDepartments] = useState(() => startingDepartments(view, first));
  const [permissions, setPermissions] = useState(() => startingPermissions(view, first));
  const [showPassword, setShowPassword] = useState(false);
  // Bumped after a member is created: remounts the typed fields, which clears them.
  const [round, setRound] = useState(0);
  const ids = { name: useId(), email: useId(), password: useId() };

  // A created member clears the form for the next one (the message stays).
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) {
      setRound((n) => n + 1);
      setTemplate(first);
      setManager(false);
      setDepartments(startingDepartments(view, first));
      setPermissions(startingPermissions(view, first));
      setShowPassword(false);
    }
  }

  const role = template === 'client' && manager ? 'admin' : template;

  const choose = (next: Template) => {
    setTemplate(next);
    setManager(false);
    setDepartments(startingDepartments(view, next));
    setPermissions(startingPermissions(view, next));
  };
  const toggleManager = (on: boolean) => {
    setManager(on);
    setPermissions(startingPermissions(view, on ? 'admin' : 'client'));
  };
  const flip = (set: Set<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key); else next.delete(key);
    return next;
  };

  if (view.templates.length === 0) return null;

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="role" value={role} />

      <div key={round} className="grid gap-4 md:grid-cols-3">
        <Field label="Name" htmlFor={ids.name}>
          <Input id={ids.name} name="full_name" autoComplete="off" required maxLength={200} />
        </Field>
        <Field label="Email (their login)" htmlFor={ids.email}>
          <Input id={ids.email} name="email" type="email" autoComplete="off" required />
        </Field>
        <Field label="Password" htmlFor={ids.password} hint="At least 8 characters. Give it to them yourself.">
          <div className="relative">
            <Input
              id={ids.password}
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={72}
              className="pr-12"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide the password' : 'Show the password'}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-ink-muted hover:text-ink"
            >
              {showPassword ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
            </button>
          </div>
        </Field>
      </div>

      {view.templates.length > 1 ? (
        <fieldset>
          <legend className="text-sm font-medium">Start from</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {view.templates.map((option) => (
              <label key={option.role} className={CARD}>
                <input
                  type="radio"
                  name="template"
                  value={option.role}
                  checked={template === option.role}
                  onChange={() => choose(option.role)}
                  className="mt-1 size-4 shrink-0 accent-accent"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.name}</span>
                  <span className="block text-xs text-ink-muted">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {template === 'client' && view.canMakeManager ? (
        <label className={CARD}>
          <input
            type="checkbox"
            checked={manager}
            onChange={(e) => toggleManager(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-accent"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Can manage the team and company settings</span>
            <span className="block text-xs text-ink-muted">
              They can create and remove team members and change their access — never an owner, and never
              more than they have themselves. Not billing or deleting the company.
            </span>
          </span>
        </label>
      ) : null}

      <TickGroup
        legend="Departments they can open"
        hint="Departments that are not ticked are hidden from them."
        all={view.departments.map((d) => d.key)}
        ticked={departments}
        onAll={(on) => setDepartments(on ? new Set(view.departments.map((d) => d.key)) : new Set())}
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {view.departments.map((d) => (
            <Tick
              key={d.key}
              name="departments"
              value={d.key}
              title={d.title}
              detail={d.detail}
              checked={departments.has(d.key)}
              onChange={(on) => setDepartments((set) => flip(set, d.key, on))}
            />
          ))}
        </div>
      </TickGroup>

      <TickGroup legend="What they can see and do" hint="Inside the departments they can open.">
        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
          {view.permissionGroups.map((group) => (
            <div key={group.title}>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">{group.title}</p>
              <div className="mt-2 grid gap-2">
                {group.choices.map((c) => (
                  <Tick
                    key={c.permission}
                    name="permissions"
                    value={c.permission}
                    title={c.title}
                    detail={c.held ? c.detail : `${c.detail}. You don’t have this yourself, so you can’t give it.`}
                    checked={permissions.has(c.permission)}
                    disabled={!c.held}
                    onChange={(on) => setPermissions((set) => flip(set, c.permission, on))}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </TickGroup>

      <ActionMessage state={state} />
      <div>
        <SubmitButton pendingLabel="Creating…">Create team member</SubmitButton>
      </div>
    </form>
  );
}

const CARD = 'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface-sunken p-3 transition-colors hover:border-line-strong has-checked:border-accent has-checked:bg-accent-soft';

function TickGroup({
  legend,
  hint,
  all,
  ticked,
  onAll,
  children,
}: {
  legend: string;
  hint: string;
  all?: readonly string[];
  ticked?: ReadonlySet<string>;
  onAll?: (on: boolean) => void;
  children: ReactNode;
}) {
  const everything = all && ticked ? all.every((key) => ticked.has(key)) : false;
  return (
    <fieldset>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <legend className="text-sm font-medium">{legend}</legend>
        {onAll && all && all.length > 1 ? (
          <button type="button" onClick={() => onAll(!everything)} className="min-h-8 text-xs text-accent underline underline-offset-2 hover:text-accent-hover">
            {everything ? 'Untick all' : 'Tick all'}
          </button>
        ) : null}
      </div>
      <p className="mb-2 text-xs text-ink-muted">{hint}</p>
      {children}
    </fieldset>
  );
}

function Tick({
  name,
  value,
  title,
  detail,
  checked,
  disabled = false,
  onChange,
}: {
  name: string;
  value: string;
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className={`${CARD} ${disabled ? 'cursor-not-allowed opacity-60 hover:border-line' : ''}`}>
      <input
        type="checkbox"
        name={name}
        value={value}
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-ink-muted">{detail}</span>
      </span>
    </label>
  );
}
