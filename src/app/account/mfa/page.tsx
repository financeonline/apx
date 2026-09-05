import { PageHeader } from '@/components/ui/surfaces';
import { MfaEnrolment } from './mfa-enrolment';

export const dynamic = 'force-dynamic';

export default function MfaPage() {
  return (
    <main className="mx-auto w-full max-w-lg px-6 py-12">
      <PageHeader
        title="Two-step sign-in"
        description="Scan the code with an authenticator app, then enter the six-digit code it shows."
      />
      <div className="mt-8">
        <MfaEnrolment />
      </div>
    </main>
  );
}
