import Link from 'next/link';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-12">
      <Link href="/" className="text-sm font-semibold tracking-widest text-ink-muted uppercase">
        MOTION
      </Link>
      {children}
    </div>
  );
}
