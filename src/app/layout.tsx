import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MOTION',
  description: 'Financial intelligence for your business.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-dvh bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
