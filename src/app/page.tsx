import { redirect } from 'next/navigation';

/**
 * The front page is the sign-in page (owner, 2026-10-14: "directly uses sign-in"). A signed-in
 * visitor never gets here: middleware sends `/` with a session to their own home (§8.6).
 */
export default function LandingPage() {
  redirect('/sign-in');
}
