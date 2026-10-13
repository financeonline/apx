import { BrandedScreen } from '@/components/dashboard/branded-screen';

/** Sign-in, sign-up and password pages, in the client's APX split screen (ADR-169). */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <BrandedScreen auth>{children}</BrandedScreen>;
}
