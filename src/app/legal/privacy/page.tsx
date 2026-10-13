import { BrandedScreen } from '@/components/dashboard/branded-screen';

export default function PrivacyPage() {
  return (
    <BrandedScreen width="2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-4 text-ink-muted">
        Your organisation&rsquo;s data is isolated from every other organisation, enforced by the
        database itself and not only by the application.
      </p>
      <p className="mt-4 text-ink-muted">
        Important changes and material events are recorded in an audit log that owners and
        administrators can read. Access by APX staff is recorded there too.
      </p>
    </BrandedScreen>
  );
}
