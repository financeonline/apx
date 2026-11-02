import { redirect } from 'next/navigation';

/**
 * No public sign-up (owner, 2026-11-02: "only super admin can create the company and the user and
 * password"). Companies, their owners and APX's analysts are created on the Platform; a person who
 * arrives here is sent to sign in. The form component (`AuthForm mode="sign-up"`) is kept for the
 * day this is switched back on.
 */
export default function Page() {
  redirect('/sign-in');
}
