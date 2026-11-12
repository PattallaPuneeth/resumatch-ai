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
  const item1Result = matchResult?.item1Result ?? null;
  const isNewMatch = matchResult !== null;
  const matchScore = isNewMatch
    ? (item1Result?.score ?? null)
    : (result.match_score ?? analysis.score);
  const verdictBand = isNewMatch
    ? item1Result?.verdict ?? null
    : result.verdict_band ||
      (typeof matchScore !== 'number'
        ? 'medium'
        : matchScore >= 75
          ? 'strong'
          : matchScore >= 45
            ? 'medium'
            : 'weak');

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
  }[verdictBand as 'strong' | 'medium' | 'weak'] || {
    label: verdictBand || (item1Result?.verdict_withheld ? 'Verdict withheld' : 'No score available'),
    color: 'text-slate-800 bg-slate-50 border-slate-200',
    description: item1Result?.withheld_reason || 'No Item 1 assessment is available for this match.',
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
          <p className="text-xs text-muted-foreground leading-relaxed">{verdictConfig.description}</p>
          {item1Result && (
            <p data-testid="item1-confidence" className="text-xs text-amber-800">
              Item 1 confidence: {item1Result.confidence}
              {item1Result.score_range && (
                <> · Conditional range {item1Result.score_range[0]}–{item1Result.score_range[1]}</>
              )}
            </p>
          )}
          {item1Result?.tier === 'Tentative' && (
            <p data-testid="item1-tentative" className="text-xs text-amber-800">
              Tentative result
              {item1Result.band_range
                ? item1Result.band_range[0] === item1Result.band_range[1]
                  ? `: ${item1Result.band_range[0]}`
                  : `: ${item1Result.band_range[0]} to ${item1Result.band_range[1]}`
                : ''}
              {item1Result.confidence_reasons && item1Result.confidence_reasons.length > 0
                ? ` (${item1Result.confidence_reasons[item1Result.confidence_reasons.length - 1]})`
                : ''}
            </p>
          )}
          {item1Result?.role_fit?.note && (
            <p data-testid="item1-role-fit" className="text-xs text-slate-700">
              {item1Result.role_fit.note}
            </p>
          )}
          {item1Result?.signals && item1Result.signals.must_haves_missing.length > 0 && (
            <p data-testid="item1-must-haves" className="text-xs text-slate-700">
              Required items not evidenced on the resume: {item1Result.signals.must_haves_missing.join('; ')}
            </p>
          )}
        </div>

        <div className="flex items-center gap-6 shrink-0">
          {typeof matchScore === 'number' ? (
            <ScoreGauge
              score={matchScore}
              maxScore={100}
              label="Item 1 score"
              statusBand={verdictConfig.label}
              size="sm"
            />
          ) : (
            <div data-testid="item1-no-score" className="max-w-40 text-center text-sm text-slate-600">
              No Item 1 score
              <span className="block text-xs">{verdictConfig.label}</span>
            </div>
          )}

          {/* Overall Match Score (Text representation for tests & accessibility) */}
          <div className="hidden sm:block text-right border-l border-border pl-4">
            <span className="text-[11px] font-semibold text-muted-foreground block">
                Item 1 Score
            </span>
            <div
              data-testid="mode-b-match-score"
              className="text-3xl font-extrabold font-mono text-primary"
            >
              {typeof matchScore === 'number' ? (
                <>{matchScore}<span className="text-sm font-normal text-muted-foreground ml-0.5">%</span></>
              ) : (
                <span className="text-base font-semibold">Not scored</span>
              )}
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
          Item 1 is the Resume + Job Description comparison score. Search and retrieval diagnostics below are
          separate and do not change that score. A low-confidence result may show a score while withholding its
          verdict; unresolved gates and date uncertainty are shown as a range.
        </p>
      </aside>

      {/* 3. Match Visualizer Breakdown */}
      <MatchVisualizer matchResult={matchResult} />

      {item1Result?.limitations && item1Result.limitations.length > 0 && (
        <aside data-testid="item1-limitations" className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h4 className="text-sm font-semibold text-amber-900">Item 1 limitations</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-900">
            {item1Result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
          </ul>
          <p className="mt-2 text-xs text-slate-700">{item1Result.guidance}</p>
        </aside>
      )}

      {item1Result?.gaps && item1Result.gaps.length > 0 && (
        <section data-testid="item1-gaps" className="rounded-lg border border-slate-200 bg-white p-4">
          <h4 className="text-sm font-semibold text-foreground">What would raise this score</h4>
          <ul className="mt-2 space-y-1.5 text-xs text-slate-700">
            {item1Result.gaps.map((gap, index) => (
              <li key={index}>
                <span className="font-medium">{gap.requirement}</span> (about +{gap.points_if_closed} points): {gap.tip}
              </li>
            ))}
          </ul>
        </section>
      )}

      {item1Result?.confirm && item1Result.confirm.length > 0 && (
        <section data-testid="item1-confirm" className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h4 className="text-sm font-semibold text-foreground">Please confirm</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-700">
            {item1Result.confirm.map((item, index) => (
              <li key={index}>{item.requirement}: {item.reason}</li>
            ))}
          </ul>
        </section>
      )}

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
              The Item 1 comparison result is shown separately. The supplemental AI summary is not available
              right now.
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
                Supplemental AI summary (not Item 1)
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
              Supplemental strengths (not Item 1) ({result.strengths.length})
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
              Supplemental gaps and improvements (not Item 1)
            </h3>
          </div>

          <div className="space-y-3">
            {result.prioritized_improvements?.map((imp, idx) => {
              const action = typeof imp === 'string' ? imp : imp.action;
              const priority = typeof imp === 'string' ? idx + 1 : imp.priority;
              const evidence = typeof imp === 'string' ? null : imp.evidence;
              const reason = typeof imp === 'string' ? null : imp.reason;

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
                  {reason && <p className="pl-7 text-[11px] text-slate-600">Why: {reason}</p>}
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
                    <li key={gIdx} data-testid={`gap-item-${gIdx}`}>
                      {typeof gap === 'string' ? gap : gap.gap}
                      {typeof gap !== 'string' && gap.recommendation && (
                        <span className="text-slate-500"> ({gap.recommendation})</span>
                      )}
                    </li>
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
