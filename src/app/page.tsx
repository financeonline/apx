import { AnimatedLogo } from '@/components/dashboard/animated-logo';
import { BrandedScreen } from '@/components/dashboard/branded-screen';
import { ButtonLink } from '@/components/ui/button';

/** The front page (owner, 2026-10-14): the animated logo on the sign-in page's ribbon background. */
export default function LandingPage() {
  return (
    <BrandedScreen auth wide logo={<AnimatedLogo label="APX, finance in motion" className="w-[min(19rem,78vw)] sm:w-[21rem]" />}>
      <div className="flex flex-col gap-6">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Know how your business is doing, and what to do next.
        </h1>
        <p className="text-lg text-ink-muted">
          APX turns the files you already have — bank statements, ledgers, invoices — into plain
          answers you can act on, with every number traceable back to the document it came from.
        </p>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/sign-up">Create an account</ButtonLink>
          <ButtonLink href="/sign-in" tone="secondary">Sign in</ButtonLink>
        </div>
      </div>
    </BrandedScreen>
  );
}
