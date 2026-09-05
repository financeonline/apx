import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-muted">Loading…</p>}>
      <AuthForm mode="sign-in" />
      <p className="text-sm text-ink-muted">New here? <a className="underline" href="/sign-up">Create an account</a> · <a className="underline" href="/forgot-password">Forgot your password?</a></p>
    </Suspense>
  );
}
