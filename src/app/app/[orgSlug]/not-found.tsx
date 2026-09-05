import { ButtonLink } from '@/components/ui/button';

/** One uniform 404 for "does not exist" and "not yours" (SECURITY_MODEL.md §14). */
export default function OrgNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">We could not find that page</h1>
      <p className="text-ink-muted">
        It may have moved, or you may not have access to it. If you think you should, ask an owner
        or administrator of the organisation to check.
      </p>
      <div><ButtonLink href="/select-organization" tone="secondary">Back to your organisations</ButtonLink></div>
    </main>
  );
}
