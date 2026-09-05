'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { supabaseBrowser } from '@/components/supabase-browser';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Card, CardBody } from '@/components/ui/surfaces';

/**
 * TOTP enrolment. After a successful verification the session is at aal2, and only then can
 * api.confirm_mfa_enrolment() stamp the profile — the stamp cannot be forged because the function
 * checks the caller's own assurance level (ADR-043, ADR-044.1).
 */
export function MfaEnrolment() {
  const router = useRouter();
  const [qr, setQr] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const supabase = supabaseBrowser();
      const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (err) throw err;
      setFactorId(data.id);
      setQr(data.totp.qr_code);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start setup.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(code: string) {
    if (!factorId) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = supabaseBrowser();
      const challenge = await supabase.auth.mfa.challenge({ factorId });
      if (challenge.error) throw challenge.error;
      const verified = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.data.id,
        code,
      });
      if (verified.error) throw verified.error;

      const { error: stampError } = await supabase.schema('api').rpc('confirm_mfa_enrolment');
      if (stampError) throw stampError;

      setDoneMessage('Two-step sign-in is on. You will be asked for a code next time you sign in.');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  if (doneMessage) {
    return (
      <Card>
        <CardBody>
          <p role="status" className="text-sm">{doneMessage}</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-5">
        {!qr && (
          <>
            <p className="text-sm text-ink-muted">
              You will need an authenticator app such as 1Password, Authy or Google Authenticator.
            </p>
            <Button onClick={begin} disabled={busy}>
              {busy ? 'Starting…' : 'Start setup'}
            </Button>
          </>
        )}

        {qr && (
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              const code = String(new FormData(event.currentTarget).get('code') ?? '');
              void verify(code);
            }}
          >
            <Image src={qr} alt="Authenticator setup code" width={200} height={200} unoptimized className="self-start" />
            <Field label="Six-digit code" htmlFor="code">
              <Input id="code" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required />
            </Field>
            <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Turn on two-step sign-in'}</Button>
          </form>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
