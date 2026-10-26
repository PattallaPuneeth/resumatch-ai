'use client';

import React from 'react';
import { AnalysisResult, MatchResult } from '@/lib/apiClient';
import { MatchVisualizer } from '@/components/MatchVisualizer';
import { ScoreGauge } from '@/components/ui/ScoreGauge';
import {
  Award,
  CheckCircle2,
  XCircle,
  AlertCircle,
  TrendingUp,
  HelpCircle,
  Sparkles,
  Info,
  ShieldCheck,
  Target,
} from 'lucide-react';

interface ModeBResultsProps {
  analysis: AnalysisResult;
  matchResult: MatchResult | null;
  className?: string;
}

export function ModeBResults({ analysis, matchResult, className = '' }: ModeBResultsProps) {
  const result = analysis.result || {};
  const matchScore = result.match_score ?? analysis.score;
  const atsScore = result.ats_score;
  const verdictBand = result.verdict_band || 'medium';

  // Map verdict band for display badge
  const verdictConfig = {
    strong: {
      label: 'Strong Match',
      color: 'text-emerald-800 bg-emerald-50 border-emerald-200',
      description: 'Your profile exhibits substantial skill and contextual overlap with this role.',
    },
    medium: {
      label: 'Moderate Match',
      color: 'text-teal-800 bg-teal-50 border-teal-200',
      description: 'You meet core requirements but have noticeable gaps in secondary qualifications.',
    },
    weak: {
      label: 'Low Match / Gap',
      color: 'text-amber-800 bg-amber-50 border-amber-200',
      description: 'Consider addressing the missing keywords and critical experience gaps below.',
    },
  }[verdictBand] || {
    label: verdictBand,
    color: 'text-slate-800 bg-slate-50 border-slate-200',
    description: '',
  };

  return (
    <div data-testid="mode-b-results" className={`space-y-6 ${className}`}>
      {/* 1. Score Summary Banner */}
      <section
        aria-labelledby="mode-b-overview-heading"
        className="bg-white rounded-lg border border-border p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6"
      >
        <div className="space-y-1.5 max-w-xl">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 id="mode-b-overview-heading" className="font-bold text-lg text-foreground">
              Overall Job Description Match
            </h3>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {verdictConfig.description}
          </p>
        </div>

        <div className="flex items-center gap-6 shrink-0">
          <ScoreGauge
            score={matchScore}
            maxScore={100}
            label="Match Score"
            statusBand={verdictConfig.label}
            size="sm"
          />

          {/* ATS Score */}
          {atsScore !== null && atsScore !== undefined && (
            <div className="text-right border-l border-border pl-4">
              <span className="text-[11px] font-semibold text-muted-foreground block">
                ATS Score
              </span>
              <div
                data-testid="mode-b-ats-score"
                className="text-2xl font-bold font-mono text-slate-800"
              >
                {atsScore}
                <span className="text-xs text-muted-foreground font-normal ml-0.5">/100</span>
              </div>
            </div>
          )}

          {/* Overall Match Score (Text representation for tests & accessibility) */}
          <div className="hidden sm:block text-right border-l border-border pl-4">
            <span className="text-[11px] font-semibold text-muted-foreground block">
              Match Score
            </span>
            <div
              data-testid="mode-b-match-score"
              className="text-3xl font-extrabold font-mono text-primary"
            >
              {matchScore}
              <span className="text-sm font-normal text-muted-foreground ml-0.5">%</span>
            </div>
            <span
              data-testid="mode-b-verdict-band"
              className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border mt-0.5 ${verdictConfig.color}`}
            >
              {verdictConfig.label}
            </span>
          </div>
        </div>
      </section>

      {/* 2. "How to read this" Helper Card */}
      <aside
        data-testid="how-to-read-helper"
        aria-label="Score interpretation guide"
        className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 space-y-2"
      >
        <div className="flex items-center gap-1.5 font-bold text-foreground">
          <HelpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
          <span>How to read your match analysis:</span>
        </div>
        <p className="leading-relaxed">
          The match score is derived deterministically using a multi-stage hybrid retrieval pipeline combining
          <strong> BM25 keyword frequency</strong>, <strong>semantic embedding vectors</strong>, and
          <strong> cross-encoder deep joint attention</strong>. Numbers represent raw mathematical alignment, never
          rounded or inflated.
        </p>
      </aside>

      {/* 3. Match Visualizer Breakdown */}
      <MatchVisualizer matchResult={matchResult} />

      {/* 4. LLM Status or Executive Summary */}
      {analysis.llmStatus === 'UNAVAILABLE' ? (
        <aside
          data-testid="llm-unavailable-notice"
          aria-label="AI explanation service status"
          className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-3 text-xs text-slate-700"
        >
          <Info className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <h4 className="font-semibold text-foreground">
              AI explanation unavailable, showing deterministic results
            </h4>
            <p className="mt-0.5 text-muted-foreground">
              Deterministic scoring and skill extraction completed successfully. Generative AI commentary is currently
              offline in fail-open mode.
            </p>
          </div>
        </aside>
      ) : (
        result.summary && (
          <section
            aria-labelledby="summary-heading"
            data-testid="mode-b-summary-card"
            className="bg-white rounded-lg border border-border p-5 space-y-2 shadow-sm"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
              <h3 id="summary-heading" className="font-bold text-sm text-foreground">
                Analysis Summary
              </h3>
            </div>
            <p className="text-xs text-slate-700 leading-relaxed">{result.summary}</p>
          </section>
        )
      )}

      {/* 5. Strengths with Verified Evidence Quotes */}
      {result.strengths && result.strengths.length > 0 && (
        <section
          aria-labelledby="strengths-heading"
          data-testid="strengths-section"
          className="bg-white rounded-lg border border-border p-5 space-y-4 shadow-sm"
        >
          <div className="flex items-center gap-2 border-b border-border pb-3">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            <h3 id="strengths-heading" className="font-bold text-sm text-foreground">
              Key Candidate Strengths ({result.strengths.length})
            </h3>
          </div>

          <div className="space-y-3">
            {result.strengths.map((str, idx) => {
              const claim = typeof str === 'string' ? str : str.claim;
              const evidence = typeof str === 'string' ? null : str.evidence;

              return (
                <div
                  key={`strength-${idx}`}
                  data-testid={`strength-item-${idx}`}
                  className="p-3.5 rounded-md bg-emerald-50/40 border border-emerald-100 space-y-1.5 text-xs"
                >
                  <p className="font-semibold text-slate-900 flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{claim}</span>
                  </p>
                  {evidence && (
                    <blockquote className="pl-6 text-[11px] font-mono text-slate-600 italic">
                      &ldquo;{evidence}&rdquo;
                    </blockquote>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 6. Gaps & Prioritized Fixes with Evidence Quotes */}
      {((result.gaps && result.gaps.length > 0) ||
        (result.prioritized_improvements && result.prioritized_improvements.length > 0)) && (
        <section
          aria-labelledby="improvements-heading"
          data-testid="improvements-section"
          className="bg-white rounded-lg border border-border p-5 space-y-4 shadow-sm"
        >
          <div className="flex items-center gap-2 border-b border-border pb-3">
            <TrendingUp className="h-4 w-4 text-amber-600" aria-hidden="true" />
            <h3 id="improvements-heading" className="font-bold text-sm text-foreground">
              Prioritized Improvements & Target Gaps
            </h3>
          </div>

          <div className="space-y-3">
            {result.prioritized_improvements?.map((imp, idx) => {
              const action = typeof imp === 'string' ? imp : imp.action;
              const priority = typeof imp === 'string' ? idx + 1 : imp.priority;
              const evidence = typeof imp === 'string' ? null : imp.evidence;

              return (
                <div
                  key={`imp-${idx}`}
                  data-testid={`improvement-item-${idx}`}
                  className="p-3.5 rounded-md bg-slate-50 border border-slate-200 space-y-1.5 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground flex items-center gap-2">
                      <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-800 font-bold">
                        #{priority}
                      </span>
                      <span>{action}</span>
                    </span>
                  </div>
                  {evidence && (
                    <blockquote className="pl-7 text-[11px] font-mono text-slate-600 italic">
                      Evidence: &ldquo;{evidence}&rdquo;
                    </blockquote>
                  )}
                </div>
              );
            })}

            {/* Direct gaps list if separate */}
            {result.gaps && result.gaps.length > 0 && (
              <div className="pt-2 space-y-2 border-t border-slate-200">
                <h4 className="text-xs font-semibold text-slate-700">Detailed Experience Gaps:</h4>
                <ul className="list-disc list-inside text-xs text-slate-600 space-y-1">
                  {result.gaps.map((gap, gIdx) => (
                    <li key={gIdx}>{typeof gap === 'string' ? gap : gap.gap}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
