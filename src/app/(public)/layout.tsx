import { BrandedScreen } from '@/components/dashboard/branded-screen';

/** Sign-in, sign-up and password pages, in the owner's reference design (ADR-155). */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <BrandedScreen>{children}</BrandedScreen>;
}
