import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { Navbar } from '@/components/Navbar';

export const metadata: Metadata = {
  title: 'ResuMatch AI - ATS Resume Analysis & Matching',
  description: 'Production-grade AI resume platform with ATS format compliance, hybrid matching, and usage metering.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground flex flex-col font-sans">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-2 focus:bg-emerald-700 focus:text-white focus:rounded focus:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-600 font-semibold text-sm"
        >
          Skip to main content
        </a>
        <Providers>
          <Navbar />
          <main id="main-content" tabIndex={-1} className="flex-1 flex flex-col focus:outline-none">
            {children}
          </main>
          <footer className="border-t border-border bg-slate-50 py-6 text-center text-xs text-muted-foreground">
            <div className="container mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
              <span>ResuMatch AI • Production AI Resume & Job Matching Platform</span>
              <span>Fastify • PostgreSQL pgvector(384) • FastAPI • Next.js</span>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
