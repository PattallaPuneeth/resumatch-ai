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
        <Providers>
          <Navbar />
          <main className="flex-1 flex flex-col">{children}</main>
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
