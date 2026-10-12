'use client';

import { useState } from 'react';
import { UploadCloud, File, AlertCircle, Info, ArrowLeft, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { HealthDashboard } from '@/components/HealthDashboard';
import { api, ApiException } from '@/lib/api';

export default function UploadPage() {
  const [stubStatus, setStubStatus] = useState<string | null>(null);
  const [isCallingStub, setIsCallingStub] = useState(false);

  const testStubEndpoint = async () => {
    setIsCallingStub(true);
    setStubStatus(null);
    try {
      await api.getResumes();
      setStubStatus('Unexpected: Endpoint responded with 200');
    } catch (err) {
      if (err instanceof ApiException) {
        setStubStatus(`Contract Verified: HTTP ${err.statusCode} (${err.errorName}) - "${err.message}"`);
      } else {
        setStubStatus(`Network Error: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
    } finally {
      setIsCallingStub(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-start px-4 sm:px-6 lg:px-8 py-10 space-y-10">
      <div className="w-full max-w-4xl flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Cluster Overview
        </Link>
        <span className="text-xs px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
          Ingestion Shell • Phase 1
        </span>
      </div>

      <div className="w-full max-w-4xl space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Resume Ingestion Shell</h1>
          <p className="text-sm text-slate-400 mt-1">
            Documents will be processed into MinIO S3 and parsed via BullMQ queues in Phase 2.
          </p>
        </div>

        {/* Drag and Drop Shell */}
        <div className="glass-panel border-2 border-dashed border-slate-800 hover:border-slate-700 transition-colors rounded-2xl p-12 text-center space-y-4">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-400 border border-blue-500/20">
            <UploadCloud className="h-8 w-8" />
          </div>

          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-white">Drop your resume here (PDF, DOCX)</h3>
            <p className="text-xs text-slate-400">
              Maximum file size: 10MB • Parsing target: <span className="font-mono text-purple-400">ParsedResume</span> schema
            </p>
          </div>

          <div className="pt-2">
            <button
              disabled
              className="px-5 py-2.5 rounded-xl bg-slate-800 text-slate-400 text-sm font-medium cursor-not-allowed border border-slate-700"
            >
              Upload Disabled in Phase 1 (Foundation Shell Only)
            </button>
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mt-4">
            <Info className="h-4 w-4 shrink-0" />
            <span>Strict Rule: Backend stubs return HTTP 501 Not Implemented until Phase 2 feature implementation.</span>
          </div>
        </div>

        {/* Contract Verification Interactive Probe */}
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-white">Route Stub Contract Probe</h3>
              <p className="text-xs text-slate-400">Verify that Fastify returns 501 Not Implemented on route stubs</p>
            </div>
            <button
              onClick={testStubEndpoint}
              disabled={isCallingStub}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
            >
              {isCallingStub ? 'Calling /resumes...' : 'Test GET /resumes'}
            </button>
          </div>

          {stubStatus && (
            <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{stubStatus}</span>
            </div>
          )}
        </div>

        {/* Live Cluster Health Display */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-white">Dependency Readiness</h2>
          <HealthDashboard />
        </div>
      </div>
    </div>
  );
}
