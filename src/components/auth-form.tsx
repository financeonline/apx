'use client';

import Link from 'next/link';
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Eye, EyeOff, Lock, Mail, User, type LucideIcon } from 'lucide-react';
import { SESSION_ALIVE_COOKIE, SESSION_ONLY_COOKIE, safeNextPath } from '@/core/routing';
import {
  confirmPasswordReset, createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail,
  signInWithEmailAndPassword, updateProfile,
} from 'firebase/auth';
import { authErrorMessage, firebaseAuth, openServerSession, usingAuthEmulator } from '@/components/firebase-browser';
import { Label } from '@/components/ui/shadcn';
import { NAV_COOKIE } from '@/components/dashboard/nav-cookie';
import { startNavigationLoading } from '@/components/loading/page-loading';

type Mode = 'sign-in' | 'sign-up' | 'forgot' | 'reset';

const COPY: Record<Mode, { title: string; lead: string; submit: string; busy: string }> = {
  'sign-in': {
    title: 'Welcome back',
    lead: 'Log in to APX and take control of your financial future.',
    submit: 'Log in',
    busy: 'Logging in…',
  },
  'sign-up': {
    title: 'Create your account',
    lead: 'Join APX and put your finances in motion.',
    submit: 'Create account',
    busy: 'Creating…',
  },
  forgot: {
    title: 'Reset your password',
    lead: 'Enter your email and we will send you a link to choose a new password.',
    submit: 'Send reset link',
    busy: 'Sending…',
  },
  reset: {
    title: 'Choose a new password',
    lead: 'Use at least 12 characters.',
    submit: 'Save password',
    busy: 'Saving…',
  },
};

const FIELD =
  'block h-12 w-full rounded-xl border border-line-strong bg-surface/80 pr-4 pl-12 text-sm text-ink ' +
  'transition-colors duration-100 outline-none placeholder:text-ink-faint hover:border-ink-faint ' +
  'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/35';

/** A labelled input with an icon inside its left edge, as the reference (ADR-169). */
function IconField({
  id,
  label,
  icon: Icon,
  hint,
  trailing,
  ...input
}: {
  id: string;
  label: string;
  icon: LucideIcon;
  hint?: string;
  trailing?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-semibold text-ink">{label}</Label>
      <div className="relative">
        <Icon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-ink-muted" strokeWidth={1.6} />
        <input id={id} name={id} className={`${FIELD} ${trailing ? 'pr-12' : ''}`} {...input} />
        {trailing}
      </div>
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}

/** Remember, for the middleware, whether this sign-in should end when the browser closes. */
function rememberSessionChoice(keep: boolean) {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  // Each sign-in starts with the menu hidden (owner, 2026-10-14; `ShellFrame`).
  document.cookie = `${NAV_COOKIE}=; path=/; max-age=0; samesite=lax`;
  if (keep) {
    document.cookie = `${SESSION_ONLY_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
    return;
  }
  document.cookie = `${SESSION_ONLY_COOKIE}=1; path=/; max-age=31536000; samesite=lax${secure}`;
  // No max-age: the browser drops it when it closes.
  document.cookie = `${SESSION_ALIVE_COOKIE}=1; path=/; samesite=lax${secure}`;
}

/** Why the sign-in page was opened: the proxy and the email links say so in `?error=` / `?verified=`. */
const ARRIVAL: Record<string, string> = {
  disabled: 'This account has been switched off. Ask your administrator.',
  missing_code: 'That link is incomplete. Please request a new one.',
  exchange_failed: 'That link is no longer valid. Please request a new one.',
};

/**
 * Real Firebase Authentication in every mode — there is no mock path (SECURITY_MODEL.md §3).
 * The browser proves the password to Firebase and hands the ID token to `/auth/session`, which sets
 * the httpOnly session cookie; the browser keeps no session of its own and never reads data.
 * Laid out as the client's APX reference (ADR-169).
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => ARRIVAL[params.get('error') ?? ''] ?? null);
  const [notice, setNotice] = useState<string | null>(() =>
    params.get('verified') === '1' ? 'Email address confirmed. You can log in now.' : null);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The same rule the callback applies (ADR-069): `router.push` is not trusted to keep an
    // off-origin target internal, so it is never handed one. Worked out here, in the browser: the
    // form also renders on the server, where there is no `window`.
    const safeNext = safeNextPath(params.get('next'), window.location.origin);
    setBusy(true);
    setError(null);
    setNotice(null);

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const fullName = String(form.get('full_name') ?? '').trim();
    try {
      const auth = await firebaseAuth();
      if (mode === 'sign-in') {
        const keep = form.get('keep_signed_in') === 'on';
        const { user } = await signInWithEmailAndPassword(auth, email, password);
        await openServerSession(await user.getIdToken(), keep);
        rememberSessionChoice(keep);
        startNavigationLoading();
        router.push(safeNext);
        router.refresh();
        return;
      }
      if (mode === 'sign-up') {
        const { user } = await createUserWithEmailAndPassword(auth, email, password);
        if (fullName) await updateProfile(user, { displayName: fullName });
        if (usingAuthEmulator()) {
          // Locally there is no inbox to confirm from (the local Supabase stack had confirmations off).
          await openServerSession(await user.getIdToken(true), false);
          rememberSessionChoice(false);
          startNavigationLoading();
          router.push(safeNext);
          router.refresh();
          return;
        }
        await sendEmailVerification(user, { url: `${window.location.origin}/sign-in?next=${encodeURIComponent(safeNext)}` });
        await auth.signOut();
        setNotice(
          'Check your email to confirm the address. You can log in once it is confirmed.',
        );
        return;
      }
      if (mode === 'forgot') {
        await sendPasswordResetEmail(auth, email, { url: `${window.location.origin}/sign-in` }).catch((err: unknown) => {
          // Never confirm whether an address has an account.
          if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
        });
        setNotice('If that address has an account, a reset link is on its way.');
        return;
      }
      const code = params.get('oobCode');
      if (!code) {
        setError('That link is no longer valid. Please request a new one.');
        return;
      }
      await confirmPasswordReset(auth, code, password);
      setNotice('Password saved. You can use it next time you log in.');
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const copy = COPY[mode];
  const ToggleIcon = showPassword ? EyeOff : Eye;

  return (
    // `post`: a press before the page has hydrated is a native submit, and the browser's default GET
    // would put the email and password in the address bar, the history and the server's request log.
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-5">
      <div className="mb-2 space-y-3">
        <h1 className="text-4xl font-bold tracking-tight text-ink">{copy.title}</h1>
        <p className="text-lg leading-snug text-ink/90">{copy.lead}</p>
      </div>

      {mode === 'sign-up' && (
        <IconField id="full_name" label="Your name" icon={User} autoComplete="name" placeholder="Your full name" required />
      )}

      {mode !== 'reset' && (
        <IconField id="email" label="Email" icon={Mail} type="email" autoComplete="email" placeholder="name@yourcompany.com" required />
      )}

      {(mode === 'sign-in' || mode === 'sign-up' || mode === 'reset') && (
        <IconField
          id="password"
          label={mode === 'reset' ? 'New password' : 'Password'}
          icon={Lock}
          type={showPassword ? 'text' : 'password'}
          placeholder={mode === 'sign-in' ? 'Enter your password' : 'At least 12 characters'}
          minLength={mode === 'sign-in' ? undefined : 12}
          autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
          required
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-controls="password"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute top-1/2 right-2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-ink-muted transition-colors hover:text-ink"
            >
              <ToggleIcon aria-hidden="true" className="size-5" strokeWidth={1.6} />
            </button>
          }
        />
      )}

      {mode === 'sign-in' && (
        <div className="flex items-center justify-between gap-4 text-sm">
          <label className="flex cursor-pointer items-center gap-2.5 text-ink">
            <input type="checkbox" name="keep_signed_in" className="size-[1.125rem] rounded border-line-strong accent-accent" />
            Keep me signed in
          </label>
          <Link href="/forgot-password" className="font-medium text-accent hover:text-accent-hover">Forgot password?</Link>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-danger/50 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-xl border border-line bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
          {notice}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="bg-brand-gradient mt-2 flex h-13 w-full items-center justify-center gap-2.5 rounded-full text-base font-semibold text-on-accent shadow-[0_14px_32px_-14px_rgb(255_45_85/0.75)] transition-[filter] duration-150 outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? copy.busy : copy.submit}
        {busy ? null : <ArrowRight aria-hidden="true" className="size-5" strokeWidth={2} />}
      </button>

      {/* No "Sign up" link on sign-in (owner, 2026-11-02): companies are set up by APX; the page itself stays for invited people. */}
      {mode === 'sign-in' ? null : (
      <p className="mt-2 text-center text-sm text-ink-muted">
        {mode === 'sign-up' ? (
          <>Already have an account? <Link href="/sign-in" className="ml-1.5 font-medium text-accent hover:text-accent-hover">Log in</Link></>
        ) : (
          <Link href="/sign-in" className="font-medium text-accent hover:text-accent-hover">Back to log in</Link>
        )}
      </p>
      )}
    </form>
  );
}
