import type { Metadata } from 'next';
import Link from 'next/link';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'SnapCart — Storefront',
  description: 'A single-product-checkout clothing store on Next.js, Supabase and Razorpay.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              SnapCart
            </Link>
            <nav className="flex items-center gap-6 text-sm text-muted">
              <Link href="/" className="hover:text-foreground">Shop</Link>
              <Link href="/admin" className="hover:text-foreground">Admin</Link>
              <Link href="/endpoints" className="hover:text-foreground">Endpoints</Link>
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900">
                Razorpay test mode
              </span>
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-6 text-xs text-muted">
            Test mode only — no real payments are processed. Prices in INR.
          </div>
        </footer>
      </body>
    </html>
  );
}
