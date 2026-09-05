import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-muted">Loading…</p>}>
      <AuthForm mode="sign-up" />
      <p className="text-sm text-ink-muted">Already have an account? <a className="underline" href="/sign-in">Sign in</a></p>
    </Suspense>
  );
}
