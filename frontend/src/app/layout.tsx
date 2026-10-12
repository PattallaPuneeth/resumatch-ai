import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { Navbar } from '@/components/Navbar';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'ResuMatch AI - Foundation Console',
  description: 'AI-Powered ATS resume parsing, hybrid job matching, and bullet rewrites.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} min-h-screen bg-slate-950 text-slate-100 flex flex-col`}>
        <Providers>
          <Navbar />
          <main className="flex-1 flex flex-col">{children}</main>
          <footer className="border-t border-slate-900 py-6 text-center text-xs text-slate-400">
            ResuMatch AI • Phase 1 Foundation • PostgreSQL pgvector(384) • Fastify • FastAPI • Next.js
          </footer>
        </Providers>
      </body>
    </html>
  );
}
