'use client';

import React from 'react';
import { MatchResult, MatchExplanation } from '@/lib/apiClient';
import { BarChart3, CheckCircle2, XCircle, AlertCircle, HelpCircle } from 'lucide-react';
import { MatchPassages } from './MatchPassages';
import { SeniorityFit } from './SeniorityFit';

interface MatchVisualizerProps {
  matchResult: MatchResult | null;
  className?: string;
}

export function MatchVisualizer({ matchResult, className = '' }: MatchVisualizerProps) {
  if (!matchResult) {
    return null;
  }

  const breakdown = matchResult.explanation?.scoringBreakdown || {};
  const skillGap = matchResult.explanation?.skillGap || {
    matched: [],
    missing: [],
    partial: [],
  };

  // Convert scores to 0-100 percentage display values strictly for visual presentation
  // Note: We always display the raw/exact number as text as required by Rule 4.
  const bm25Raw = breakdown.bm25TopScore ?? matchResult.bm25Score;
  const vectorRaw = breakdown.vectorSimilarity ?? matchResult.vectorScore;
  const rrfRaw = breakdown.rrfScore ?? matchResult.rrfScore;
  const crossEncoderRaw = breakdown.crossEncoderScore ?? matchResult.crossEncoderScore;
  const skillCoverageRaw = breakdown.skillCoverage;
  const finalScoreRaw = matchResult.finalScore;

  const clampPercent = (val: number | undefined | null): number => {
    if (val === undefined || val === null || isNaN(val)) return 0;
    // Normalized 0..1 scale maps to 0..100; if already > 1.0 (e.g. 85.5), clamp directly
    const normalized = val > 1.0 ? val : val * 100;
    return Math.max(0, Math.min(100, normalized));
  };

  return (
    <div
      data-testid="match-visualizer"
      className={`bg-white rounded-lg border border-border p-5 space-y-6 shadow-sm ${className}`}
    >
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" aria-hidden="true" />
          <h3 className="font-bold text-base text-foreground">
            How your score is built
          </h3>
        </div>
        <span
          data-testid="visualizer-final-score"
          className="text-xs font-semibold px-2.5 py-1 rounded bg-slate-100 text-slate-800 border border-slate-200"
        >
          Match score: <span className="font-mono text-primary font-bold">{finalScoreRaw}</span>
        </span>
      </div>

      {/* Component breakdown bars */}
      <div className="space-y-4">
        {/* 1. Lexical BM25 */}
        <div className="space-y-1.5" data-testid="score-bar-bm25">
          <div className="flex justify-between items-center text-xs">
            <span className="font-medium text-foreground flex items-center gap-1.5">
              <span>Shared keywords</span>
            </span>
            <span className="font-mono font-semibold text-slate-700">
              {bm25Raw !== undefined && bm25Raw !== null ? String(bm25Raw) : 'N/A'}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">Words and skills that appear in both (0 to 1).</p>
          <div
            className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200"
            role="progressbar"
            aria-valuenow={clampPercent(bm25Raw)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Shared keywords"
          >
            <div
              className="bg-primary h-2.5 rounded-full transition-all duration-300"
              style={{ width: `${clampPercent(bm25Raw)}%` }}
            />
          </div>
        </div>

        {/* 2. Semantic Vector Similarity */}
        <div className="space-y-1.5" data-testid="score-bar-vector">
          <div className="flex justify-between items-center text-xs">
            <span className="font-medium text-foreground flex items-center gap-1.5">
              <span>Similar meaning</span>
            </span>
            <span className="font-mono font-semibold text-slate-700">
              {vectorRaw !== undefined && vectorRaw !== null ? String(vectorRaw) : 'N/A'}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">How close your best passage is to the job in meaning, even with different words (0 to 1).</p>
          <div
            className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200"
            role="progressbar"
            aria-valuenow={clampPercent(vectorRaw)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Similar meaning"
          >
            <div
              className="bg-emerald-600 h-2.5 rounded-full transition-all duration-300"
              style={{ width: `${clampPercent(vectorRaw)}%` }}
            />
          </div>
        </div>

        {/* 3. Cross-Encoder Reranker */}
        <div className="space-y-1.5" data-testid="score-bar-cross-encoder">
          <div className="flex justify-between items-center text-xs">
            <span className="font-medium text-foreground flex items-center gap-1.5">
              <span>Fit to the job&apos;s requirements</span>
            </span>
            <span className="font-mono font-semibold text-slate-700">
              {crossEncoderRaw !== undefined && crossEncoderRaw !== null ? String(crossEncoderRaw) : 'N/A'}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">A model reads your resume passages next to the job&apos;s requirements (0 to 100). This counts most.</p>
          <div
            className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200"
            role="progressbar"
            aria-valuenow={clampPercent(crossEncoderRaw)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Fit to the job requirements"
          >
            <div
              className="bg-teal-600 h-2.5 rounded-full transition-all duration-300"
              style={{ width: `${clampPercent(crossEncoderRaw)}%` }}
            />
          </div>
        </div>

        {/* 4. Skill Coverage (if exposed) */}
        {skillCoverageRaw !== undefined && (
          <div className="space-y-1.5" data-testid="score-bar-skill-coverage">
            <div className="flex justify-between items-center text-xs">
              <span className="font-medium text-foreground flex items-center gap-1.5">
                <span>Required skills found</span>
              </span>
              <span className="font-mono font-semibold text-slate-700">
                {String(skillCoverageRaw)}
              </span>
            </div>
          <p className="text-[11px] text-muted-foreground">Share of the job&apos;s required skills found in your resume (0 to 1).</p>
            <div
              className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200"
              role="progressbar"
              aria-valuenow={clampPercent(skillCoverageRaw)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Required skills found"
            >
              <div
                className="bg-emerald-700 h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${clampPercent(skillCoverageRaw)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Missing Keywords & Skills Section */}
      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Keyword & Skill Alignment
        </h4>

        {/* Missing Skills */}
        {skillGap.missing && skillGap.missing.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Missing Keywords (Required by JD):</span>
            </div>
            <div className="flex flex-wrap gap-1.5" data-testid="missing-keywords-list">
              {skillGap.missing.map((skill) => (
                <span
                  key={skill}
                  className="stagger-item text-xs font-mono px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-200"
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span>No missing required skills identified for this job description.</span>
          </div>
        )}

        {/* Matched Skills */}
        {skillGap.matched && skillGap.matched.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              <span>Matched Skills Found:</span>
            </div>
            <div className="flex flex-wrap gap-1.5" data-testid="matched-skills-list">
              {skillGap.matched.map((skill) => (
                <span
                  key={skill}
                  className="stagger-item text-xs font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Preferred Skills (count at reduced weight in coverage) */}
        {((skillGap.preferred_matched?.length ?? 0) > 0 ||
          (skillGap.preferred_missing?.length ?? 0) > 0) && (
          <div className="space-y-1.5 pt-1" data-testid="preferred-skills">
            <div className="text-xs font-medium text-slate-700">
              Preferred Skills (nice to have, weigh less than required):
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(skillGap.preferred_matched ?? []).map((skill) => (
                <span
                  key={`pm-${skill}`}
                  className="stagger-item text-xs font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
                >
                  ✓ {skill}
                </span>
              ))}
              {(skillGap.preferred_missing ?? []).map((skill) => (
                <span
                  key={`px-${skill}`}
                  className="stagger-item text-xs font-mono px-2 py-0.5 rounded bg-slate-50 text-slate-500 border border-slate-200"
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Partial Skills */}
        {skillGap.partial && skillGap.partial.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
              <AlertCircle className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
              <span>Partially Matched Skills:</span>
            </div>
            <div className="flex flex-wrap gap-1.5" data-testid="partial-skills-list">
              {skillGap.partial.map((skill) => (
                <span
                  key={skill}
                  className="stagger-item text-xs font-mono px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200"
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <SeniorityFit seniority={matchResult.explanation?.seniority} />

      {/* Match Inspector: the passages the reranker scored highest, matched terms highlighted */}
      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Match Inspector
        </h4>
        <MatchPassages
          chunks={matchResult.explanation?.topMatchingChunks ?? []}
          highlight={[
            ...(skillGap.matched ?? []),
            ...(skillGap.partial ?? []),
            ...(skillGap.preferred_matched ?? []),
          ]}
          totalEvaluated={matchResult.explanation?.totalChunksEvaluated}
        />
      </div>
    </div>
  );
}
