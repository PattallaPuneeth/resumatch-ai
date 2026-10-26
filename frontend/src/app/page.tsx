import React from 'react';
import Link from 'next/link';
import {
  FileUp,
  Shield,
  Search,
  ArrowRight,
  CheckCircle2,
  Sparkles,
  Layers,
  Lock,
  Cpu,
  BarChart3,
  FileCheck,
} from 'lucide-react';
import { HealthDashboard } from '@/components/HealthDashboard';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

export default function HomePage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-start px-4 sm:px-6 lg:px-8 py-12 sm:py-16 space-y-20 max-w-7xl mx-auto w-full">
      {/* 1. Hero Section */}
      <section className="w-full max-w-4xl text-center space-y-6 pt-4 animate-in fade-in duration-500">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-semibold tracking-wide shadow-2xs">
          <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span>Production AI Career Engine • Zero Hallucination Guarantee</span>
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-slate-950 leading-[1.15]">
          Simulate Enterprise ATS Ingestion with{' '}
          <span className="text-primary font-black">Hybrid Neural Retrieval</span>
        </h1>

        <p className="text-base sm:text-lg text-slate-600 max-w-2xl mx-auto leading-relaxed">
          ResuMatch AI evaluates your resume against modern ATS algorithms, extracts verified character-grounded entities, and performs hybrid BM25 + dense vector matching with cross-encoder reranking.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 pt-4">
          <Link href="/dashboard" className="inline-block">
            <Button size="lg" className="shadow-md hover:shadow-lg transition-shadow">
              <span>Go to Workspace</span>
              <ArrowRight className="h-4 w-4 ml-2" aria-hidden="true" />
            </Button>
          </Link>
          <Link href="/signup" className="inline-block">
            <Button variant="secondary" size="lg">
              Create Account
            </Button>
          </Link>
        </div>
      </section>

      {/* 2. How It Works (3 Steps) */}
      <section aria-labelledby="how-it-works-heading" className="w-full max-w-5xl space-y-8">
        <div className="text-center space-y-2">
          <span className="text-xs font-bold uppercase tracking-wider text-primary">Workflow</span>
          <h2 id="how-it-works-heading" className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-950">
            How ResuMatch AI Works
          </h2>
          <p className="text-xs sm:text-sm text-slate-600 max-w-lg mx-auto">
            A deterministic, privacy-first evaluation pipeline engineered for career accuracy.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="relative p-6 space-y-4 border-slate-200/80 hover:border-primary/40">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 text-primary font-bold flex items-center justify-center text-sm shadow-2xs">
              1
            </div>
            <h3 className="text-base font-bold text-slate-900">Document Intake & Parsing</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Upload your PDF or DOCX. PyMuPDF extracts raw layout tokens with OCR fallback, evaluating font encoding stability, column uniformity, and ATS readability scoring.
            </p>
          </Card>

          <Card className="relative p-6 space-y-4 border-slate-200/80 hover:border-primary/40">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 text-primary font-bold flex items-center justify-center text-sm shadow-2xs">
              2
            </div>
            <h3 className="text-base font-bold text-slate-900">Hybrid Semantic Matching</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Reciprocal Rank Fusion (RRF) couples BM25 full-text keyword indexing with pgvector dense embeddings and BAAI cross-encoder reranking to produce an objective match score.
            </p>
          </Card>

          <Card className="relative p-6 space-y-4 border-slate-200/80 hover:border-primary/40">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 text-primary font-bold flex items-center justify-center text-sm shadow-2xs">
              3
            </div>
            <h3 className="text-base font-bold text-slate-900">Grounded Bullet Optimization</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Transform weak bullets into high-impact STAR accomplishments. Every generated phrase is verified against source character offsets with a zero-hallucination guard.
            </p>
          </Card>
        </div>
      </section>

      {/* 3. Core Architectural Highlights */}
      <section aria-labelledby="architecture-heading" className="w-full max-w-5xl space-y-6">
        <div className="text-center space-y-2">
          <h2 id="architecture-heading" className="text-xl sm:text-2xl font-bold tracking-tight text-slate-950">
            Built for Engineers, by Engineers
          </h2>
          <p className="text-xs text-slate-600">
            Rigorous backend and distributed-systems discipline backing every AI interaction.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <div className="p-5 rounded-xl border border-slate-200 bg-white space-y-2.5 shadow-2xs">
            <div className="p-2 w-fit rounded-lg bg-emerald-50 text-primary">
              <FileUp className="h-5 w-5" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-slate-900">Multi-Engine Document Pipeline</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Magic-byte mime verification, stream virus inspection limits, and structured span extraction down to character offsets.
            </p>
          </div>

          <div className="p-5 rounded-xl border border-slate-200 bg-white space-y-2.5 shadow-2xs">
            <div className="p-2 w-fit rounded-lg bg-emerald-50 text-primary">
              <Search className="h-5 w-5" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-slate-900">Hybrid Search Engine</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              PostgreSQL tsvector BM25 lexical ranking merged with 384-dimensional cosine distance vector index and cross-encoder score refinement.
            </p>
          </div>

          <div className="p-5 rounded-xl border border-slate-200 bg-white space-y-2.5 shadow-2xs">
            <div className="p-2 w-fit rounded-lg bg-emerald-50 text-primary">
              <BarChart3 className="h-5 w-5" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-slate-900">Atomic Quota Metering</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Race-safe usage counters enforced at database isolation level with instant refund on factual verification rejections.
            </p>
          </div>
        </div>
      </section>

      {/* 4. Trust & Privacy Guarantee */}
      <section aria-labelledby="privacy-heading" className="w-full max-w-5xl">
        <div className="p-6 sm:p-8 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-950 text-white shadow-xl space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-white/10 text-emerald-400">
              <Lock className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <h2 id="privacy-heading" className="text-lg font-bold tracking-tight text-white">
                Strict Privacy & Tenant Isolation Guarantee
              </h2>
              <p className="text-xs text-slate-300 mt-0.5">
                Your career data belongs to you. No model training, no cross-tenant leakage.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 text-xs text-slate-300">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>Resumes stored in private S3/MinIO buckets with short-lived presigned URLs.</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>Row-Level Tenant Isolation on all PostgreSQL queries and pgvector indices.</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>Full account deletion completely purges database records, embeddings, and files.</span>
            </div>
          </div>
        </div>
      </section>

      {/* 5. Cluster Health Diagnostics */}
      <section aria-labelledby="diagnostics-heading" className="w-full max-w-5xl pt-4">
        <div className="mb-4">
          <h2 id="diagnostics-heading" className="text-base font-bold text-slate-900">
            Live Cluster Diagnostics
          </h2>
          <p className="text-xs text-slate-600">
            Status of Fastify Gateway, FastAPI ML Microservice, PostgreSQL, Redis Queue, and MinIO Object Storage.
          </p>
        </div>
        <HealthDashboard />
      </section>
    </div>
  );
}
