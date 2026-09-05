import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-muted">Loading…</p>}>
      <AuthForm mode="forgot" />
      <p className="text-sm text-ink-muted"><a className="underline" href="/sign-in">Back to sign in</a></p>
    </Suspense>
  );
}
