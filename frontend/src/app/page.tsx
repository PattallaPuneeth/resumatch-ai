import Link from 'next/link';
import { FileUp, Shield, Cpu, Search, ArrowRight, CheckCircle, BarChart3 } from 'lucide-react';
import { HealthDashboard } from '@/components/HealthDashboard';

export default function HomePage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-start px-4 sm:px-6 lg:px-8 py-12 space-y-16">
      {/* Hero Section */}
      <div className="max-w-4xl text-center space-y-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold uppercase tracking-wider">
          <CheckCircle className="h-3.5 w-3.5 text-primary" />
          Production Engineering Platform • Phase 8A
        </div>

        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-foreground">
          Intelligent ATS Resume Parsing &{' '}
          <span className="text-primary font-bold">Hybrid Job Matching</span>
        </h1>

        <p className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          ResuMatch AI simulates enterprise ATS ingestion, extracts grounded resume entities with exact character spans, and evaluates matching through BM25 lexical search, pgvector dense embeddings, and cross-encoder reranking.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 px-6 py-3 rounded-md bg-primary hover:bg-primary-hover text-primary-foreground font-semibold shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Go to Dashboard
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/login"
            className="flex items-center gap-2 px-6 py-3 rounded-md bg-white hover:bg-slate-50 text-foreground border border-border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Sign in
          </Link>
        </div>
      </div>

      {/* Feature Highlights Grid */}
      <section className="w-full max-w-5xl space-y-6">
        <div className="text-center space-y-1.5">
          <h2 className="text-xl font-bold tracking-tight text-foreground">Core System Foundations</h2>
          <p className="text-xs text-muted-foreground">Rigorous backend engineering with measurable retrieval and usage metering</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 rounded-lg border border-border bg-card space-y-3 shadow-sm">
            <div className="p-2.5 w-fit rounded-md bg-emerald-50 text-primary">
              <FileUp className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">ATS Document Intake</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Extracts text from PDF/DOCX via PyMuPDF with OCR fallback, validates magic bytes, and scores formatting compliance.
            </p>
          </div>

          <div className="p-6 rounded-lg border border-border bg-card space-y-3 shadow-sm">
            <div className="p-2.5 w-fit rounded-md bg-slate-100 text-slate-800">
              <Search className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Hybrid RRF Matching</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Combines BM25 tsvector scoring with 384-dimensional pgvector cosine search and cross-encoder reranking.
            </p>
          </div>

          <div className="p-6 rounded-lg border border-border bg-card space-y-3 shadow-sm">
            <div className="p-2.5 w-fit rounded-md bg-slate-100 text-slate-800">
              <BarChart3 className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Usage Quota Metering</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Race-safe atomic quota consumption in PostgreSQL with distinct threshold banners at 50%, 70%, 90%, and 100%.
            </p>
          </div>
        </div>
      </section>

      {/* Cluster Health Diagnostics */}
      <section className="w-full max-w-5xl pt-4">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground">Infrastructure Diagnostics</h2>
          <p className="text-xs text-muted-foreground">Real-time health of Fastify backend, FastAPI ML service, PostgreSQL, Redis, and MinIO.</p>
        </div>
        <HealthDashboard />
      </section>
    </div>
  );
}
