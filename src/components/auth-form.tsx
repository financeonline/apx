'use client';

import { useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabaseBrowser } from '@/components/supabase-browser';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

type Mode = 'sign-in' | 'sign-up' | 'forgot' | 'reset';

const COPY: Record<Mode, { title: string; submit: string; busy: string }> = {
  'sign-in': { title: 'Sign in', submit: 'Sign in', busy: 'Signing in…' },
  'sign-up': { title: 'Create your account', submit: 'Create account', busy: 'Creating…' },
  forgot: { title: 'Reset your password', submit: 'Send reset link', busy: 'Sending…' },
  reset: { title: 'Choose a new password', submit: 'Save password', busy: 'Saving…' },
};

/**
 * Real Supabase Auth in every mode — there is no mock path (SECURITY_MODEL.md §3).
 * The browser only ever holds the anon key; it has no table write privilege (ADR-026).
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const fullName = String(form.get('full_name') ?? '').trim();
    const supabase = supabaseBrowser();

    try {
      if (mode === 'sign-in') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        router.push(safeNext);
        router.refresh();
        return;
      }
      if (mode === 'sign-up') {
        const { error: err } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (err) throw err;
        setNotice(
          'Check your email to confirm the address. You can sign in once it is confirmed.',
        );
        return;
      }
      if (mode === 'forgot') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
        });
        if (err) throw err;
        setNotice('If that address has an account, a reset link is on its way.');
        return;
      }
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw err;
      setNotice('Password saved. You can use it next time you sign in.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const copy = COPY[mode];

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>

      {mode === 'sign-up' && (
        <Field label="Your name" htmlFor="full_name">
          <Input id="full_name" name="full_name" autoComplete="name" required />
        </Field>
      )}

      {mode !== 'reset' && (
        <Field label="Email address" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
      )}

      {(mode === 'sign-in' || mode === 'sign-up' || mode === 'reset') && (
        <Field
          label={mode === 'reset' ? 'New password' : 'Password'}
          htmlFor="password"
          hint={mode === 'sign-in' ? undefined : 'At least 12 characters.'}
        >
          <Input
            id="password"
            name="password"
            type="password"
            minLength={mode === 'sign-in' ? undefined : 12}
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            required
          />
        </Field>
      )}

      {error && (
        <p role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border border-line bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
          {notice}
        </p>
      )}

      <Button type="submit" disabled={busy}>{busy ? copy.busy : copy.submit}</Button>
    </form>
  );
}
