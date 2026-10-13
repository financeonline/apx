import type { Metadata } from 'next';
import './globals.css';
import { NavigationLoader } from '@/components/loading/page-loading';

export const metadata: Metadata = {
  title: 'APX',
  description: 'APX — finance in motion. Financial intelligence for your business.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        {children}
        <NavigationLoader />
      </body>
    </html>
  );
}
