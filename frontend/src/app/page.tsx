import Link from 'next/link';
import { FileUp, Shield, Cpu, Search, Sparkles, ArrowRight } from 'lucide-react';
import { HealthDashboard } from '@/components/HealthDashboard';

export default function HomePage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-start px-4 sm:px-6 lg:px-8 py-12 space-y-16">
      {/* Hero Section */}
      <div className="max-w-4xl text-center space-y-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider">
          <Sparkles className="h-3.5 w-3.5" />
          Foundation Architecture • Phase 1
        </div>

        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white">
          Intelligent ATS Resume Parsing &{' '}
          <span className="gradient-text">Hybrid Vector Matching</span>
        </h1>

        <p className="text-lg text-slate-300 max-w-2xl mx-auto leading-relaxed">
          ResuMatch AI simulates enterprise ATS ingestion, extracts grounded resume entities, identifies skill gaps, and matches candidates with job opportunities via BM25 + dense <span className="font-mono text-blue-400">vector(384)</span> Reciprocal Rank Fusion.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
          <Link
            href="/upload"
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow-lg shadow-blue-600/30 transition-all hover:gap-3"
          >
            Launch Resume Upload Shell
            <ArrowRight className="h-4 w-4" />
          </Link>
          <a
            href="https://github.com/PattallaPuneeth/resumatch-ai"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 font-semibold transition-colors"
          >
            Repository & Contracts
          </a>
        </div>
      </div>

      {/* Live Health Status Section */}
      <section className="w-full">
        <HealthDashboard />
      </section>

      {/* Pipeline Architectural Capabilities */}
      <section className="w-full max-w-5xl space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-white">Core System Pipelines</h2>
          <p className="text-sm text-slate-400">Phase 1 establishes the verified contract layer for these upcoming pipelines</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="glass-panel p-6 rounded-2xl border border-slate-800/80 space-y-3">
            <div className="p-3 w-fit rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <FileUp className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white">ATS Document Intake</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              Extracts raw text, identifies contact spans, structured work experience, and calculates ATS formatting compliance scores.
            </p>
          </div>

          <div className="glass-panel p-6 rounded-2xl border border-slate-800/80 space-y-3">
            <div className="p-3 w-fit rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <Search className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white">Hybrid RRF Matching</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              Fuses BM25 full-text indices with 384-dimensional dense vectors using Reciprocal Rank Fusion and Cross-Encoder reranking.
            </p>
          </div>

          <div className="glass-panel p-6 rounded-2xl border border-slate-800/80 space-y-3">
            <div className="p-3 w-fit rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Shield className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white">Fact-Grounded Rewriter</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              Generates STAR-method bullet improvements strictly anchored to validated candidate facts, preventing LLM hallucination.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
