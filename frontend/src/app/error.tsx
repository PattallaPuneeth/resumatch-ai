'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log safe error telemetry without exposing sensitive information
    console.error('Unhandled application error:', error.message);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6 shadow-sm text-center space-y-4">
        <div className="w-12 h-12 bg-red-100 text-red-700 rounded-full flex items-center justify-center mx-auto text-xl font-bold">
          !
        </div>

        <h1 className="text-xl font-bold text-slate-900">Something went wrong</h1>

        <p className="text-sm text-slate-600">
          An unexpected error occurred while rendering this page. You can try refreshing the component or return to the dashboard.
        </p>

        {error.digest && (
          <p className="text-xs text-slate-400 font-mono">
            Error digest: {error.digest}
          </p>
        )}

        <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="w-full sm:w-auto px-4 py-2 bg-emerald-700 text-white rounded font-medium text-sm hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-600 min-h-[44px]"
          >
            Try Again
          </button>
          <Link
            href="/dashboard"
            className="w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 bg-white border border-slate-300 text-slate-800 rounded font-medium text-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-600 min-h-[44px]"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
