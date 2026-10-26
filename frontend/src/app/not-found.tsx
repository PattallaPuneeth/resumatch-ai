import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Page Not Found | ResuMatch AI',
};

export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-8 shadow-sm text-center space-y-4">
        <span className="text-4xl font-extrabold text-emerald-800">404</span>
        <h1 className="text-xl font-bold text-slate-900">Page Not Found</h1>
        <p className="text-sm text-slate-600">
          The page or resource you requested could not be found. It may have been deleted, moved, or never existed.
        </p>

        <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="w-full sm:w-auto inline-flex items-center justify-center px-5 py-2.5 bg-emerald-700 text-white rounded font-medium text-sm hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-600 min-h-[44px]"
          >
            Go to Dashboard
          </Link>
          <Link
            href="/analyze"
            className="w-full sm:w-auto inline-flex items-center justify-center px-5 py-2.5 bg-white border border-slate-300 text-slate-800 rounded font-medium text-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-600 min-h-[44px]"
          >
            Resume Analysis
          </Link>
        </div>
      </div>
    </div>
  );
}
