import { BrandedScreen } from '@/components/dashboard/branded-screen';

export default function TermsPage() {
  return (
    <BrandedScreen width="2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Terms of use</h1>
      <p className="mt-4 text-ink-muted">
        APX helps you understand information you give it. It does not provide accounting, audit,
        tax, legal, investment or lending advice, and nothing in it is a lending decision or a
        guarantee of funding.
      </p>
      <p className="mt-4 text-ink-muted">
        The accuracy of what APX shows depends partly on the source information you or your
        systems supply. Every figure can be traced back to the record it came from so you can check it.
      </p>
    </BrandedScreen>
  );
}
