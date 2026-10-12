import Link from 'next/link';
import { Sparkles, FileText, Activity } from 'lucide-react';

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto flex h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="p-2 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/20 group-hover:scale-105 transition-transform">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <span className="text-lg font-bold tracking-tight text-white">ResuMatch</span>
            <span className="text-xs ml-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium">
              Phase 1
            </span>
          </div>
        </Link>

        <nav className="flex items-center gap-6 text-sm font-medium">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-slate-300 hover:text-white transition-colors"
          >
            <Activity className="h-4 w-4 text-blue-400" />
            Cluster Health
          </Link>
          <Link
            href="/upload"
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/20 transition-all font-semibold"
          >
            <FileText className="h-4 w-4" />
            Resume Upload
          </Link>
        </nav>
      </div>
    </header>
  );
}
