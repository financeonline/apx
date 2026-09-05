import { ButtonLink } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <p className="text-sm font-semibold tracking-widest text-ink-muted uppercase">MOTION</p>
      <h1 className="text-4xl font-semibold tracking-tight">
        Know how your business is doing, and what to do next.
      </h1>
      <p className="text-lg text-ink-muted">
        MOTION turns the files you already have — bank statements, ledgers, invoices — into plain
        answers you can act on, with every number traceable back to the document it came from.
      </p>
      <div className="flex flex-wrap gap-3">
        <ButtonLink href="/sign-up">Create an account</ButtonLink>
        <ButtonLink href="/sign-in" tone="secondary">Sign in</ButtonLink>
      </div>
    </main>
  );
}
