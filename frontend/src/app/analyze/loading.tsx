import React from 'react';

export default function AnalyzeLoading() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-6">
      <div className="h-20 bg-slate-200 rounded-lg animate-pulse" />
      <div className="h-64 bg-slate-100 rounded-lg animate-pulse" />
      <div className="h-48 bg-slate-100 rounded-lg animate-pulse" />
    </div>
  );
}
