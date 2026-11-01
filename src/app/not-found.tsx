import { ButtonLink } from '@/components/ui/button';

/**
 * The 404 outside a company — an unknown address, and `/portfolio` or `/platform` for anyone who is
 * not APX staff (the uniform not-found, SECURITY_MODEL.md §14). Without it those showed Next's bare,
 * unstyled "404" with no way back (QA, 2 Nov 2026). The same words as the company 404.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">We could not find that page</h1>
      <p className="text-ink-muted">
        It may have moved, or you may not have access to it. If you think you should, ask an owner
        or administrator of the organisation to check.
      </p>
      <div><ButtonLink href="/" tone="secondary">Back to APX</ButtonLink></div>
    </main>
  );
}
