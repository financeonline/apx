import { AnimatedLogo } from '@/components/dashboard/animated-logo';
import { BrandedScreen } from '@/components/dashboard/branded-screen';

/**
 * Sign-in, sign-up and password pages, in the client's APX split screen (ADR-169), with the animated
 * logo (owner, 2026-10-14: "uses the animation of the logo on the sign-in page"). It lives in the
 * layout, so moving between these pages does not replay it.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <BrandedScreen auth logo={<AnimatedLogo label="APX, finance in motion" className="w-[min(19rem,78vw)] sm:w-[20rem]" />}>
      {children}
    </BrandedScreen>
  );
}
