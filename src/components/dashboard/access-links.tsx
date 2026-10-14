'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { DENIED_TITLE, deniedBody } from './state-copy';

/**
 * Where a refused page sends its reader (ADR-172 follow-up).
 *
 * `forbidden.tsx` takes no props (Next renders it from a bare `forbidden()` call), yet the refusal is
 * the very moment a 3rd party should be offered "Request more information". The org layout already
 * holds the access context, so it decides the two links once — Home when the reader holds the
 * overview, "Your access" when they may ask for more (`mayRequestAccess`: never an owner, never APX
 * staff) — and hands them down through this context. The forbidden boundary renders inside that
 * layout, so the denied page reads them here. Nothing is decided in the browser: the values are the
 * server's, and the pages they point at check again.
 */

export interface AccessLinks {
  /** `/app/<slug>/home`, or null when the reader does not hold `dashboard.view`. */
  readonly homeHref: string | null;
  /** `/app/<slug>/access`, or null when the reader may not ask for more access. */
  readonly accessHref: string | null;
}

const AccessLinksContext = createContext<AccessLinks>({ homeHref: null, accessHref: null });

export function AccessLinksProvider({ value, children }: { value: AccessLinks; children: ReactNode }) {
  return <AccessLinksContext value={value}>{children}</AccessLinksContext>;
}

/**
 * The §7.4 denied state, with the two ways on. The words still say nothing about what is on the
 * page (a refusal must not describe what it refuses); they only say how to ask.
 */
export function ForbiddenView() {
  const { homeHref, accessHref } = useContext(AccessLinksContext);
  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-2xl">{DENIED_TITLE}</h1>
      <p className="mt-3 text-sm text-ink-muted">{deniedBody()}</p>
      {homeHref || accessHref ? (
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {accessHref ? (
            <ButtonLink href={accessHref}>
              <KeyRound aria-hidden="true" /> Request more information
            </ButtonLink>
          ) : null}
          {homeHref ? <ButtonLink href={homeHref} tone="secondary">Back to Home</ButtonLink> : null}
        </div>
      ) : null}
    </div>
  );
}
