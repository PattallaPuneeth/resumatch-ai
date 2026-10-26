'use client';

import React from 'react';
import { ImprovementsResponse } from '@/lib/apiClient';
import {
  Award,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  FileText,
  Briefcase,
  Sparkles,
  Info,
} from 'lucide-react';

interface ModeAResultsProps {
  data: ImprovementsResponse;
  className?: string;
}

export function ModeAResults({ data, className = '' }: ModeAResultsProps) {
  const atsScore = data.atsScore;

  // Plain-language ATS score band
  let scoreBand = 'Needs Work';
  let scoreBandColor = 'text-amber-800 bg-amber-50 border-amber-200';
  if (atsScore >= 80) {
    scoreBand = 'Strong ATS Compatibility';
    scoreBandColor = 'text-emerald-800 bg-emerald-50 border-emerald-200';
  } else if (atsScore >= 60) {
    scoreBand = 'Moderate ATS Compatibility';
    scoreBandColor = 'text-teal-800 bg-teal-50 border-teal-200';
  }

  return (
    <div data-testid="mode-a-results" className={`space-y-6 ${className}`}>
      {/* 1. ATS Score Banner */}
      <section
        aria-labelledby="ats-score-heading"
        className="bg-white rounded-lg border border-border p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Award className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 id="ats-score-heading" className="font-bold text-lg text-foreground">
              ATS Readability & Formatting Score
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Evaluates standard font encoding, single-column parsing stability, section headings, and contact info visibility.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <div
              data-testid="mode-a-ats-score"
              className="text-3xl font-extrabold font-mono text-primary tracking-tight"
            >
              {atsScore}
              <span className="text-sm font-normal text-muted-foreground ml-1">/ 100</span>
            </div>
            <span
              data-testid="mode-a-score-band"
              className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border mt-0.5 ${scoreBandColor}`}
            >
              {scoreBand}
            </span>
          </div>
        </div>
      </section>

      {/* 2. LLM Status Notice */}
      {data.llmStatus === 'UNAVAILABLE' ? (
        <aside
          data-testid="llm-unavailable-notice"
          className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-3 text-xs text-slate-700"
        >
          <Info className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1">
            <h4 className="font-semibold text-foreground">
              AI explanation unavailable, showing deterministic results
            </h4>
            <p className="text-muted-foreground">
              The AI generative explanation layer is running in deterministic fail-open mode. All ATS score metrics,
              remediation hazards, character span content findings, and role embeddings below are 100% complete and verified.
            </p>
          </div>
        </aside>
      ) : (
        data.explanation && (
          <section
            aria-labelledby="ai-summary-heading"
            data-testid="mode-a-llm-explanation"
            className="bg-white rounded-lg border border-border p-5 space-y-3 shadow-sm"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
              <h3 id="ai-summary-heading" className="font-bold text-sm text-foreground">
                Executive Resume Summary & Next Steps
              </h3>
            </div>
            <p className="text-xs text-slate-700 leading-relaxed">{data.explanation.summary}</p>
            {data.explanation.prioritizedNextSteps && data.explanation.prioritizedNextSteps.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-border">
                <h4 className="text-xs font-semibold text-foreground">Recommended Next Steps:</h4>
                <ul className="list-disc list-inside text-xs text-slate-600 space-y-1">
                  {data.explanation.prioritizedNextSteps.map((step, idx) => (
                    <li key={idx}>{step}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )
      )}

      {/* 3. ATS Fixes / Remediations */}
      {data.atsFixes && data.atsFixes.length > 0 && (
        <section
          aria-labelledby="ats-hazards-heading"
          data-testid="ats-fixes-section"
          className="bg-white rounded-lg border border-border p-5 space-y-4 shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
              <h3 id="ats-hazards-heading" className="font-bold text-sm text-foreground">
                ATS Hazards & Formatting Remediations ({data.atsFixes.length})
              </h3>
            </div>
            <span className="text-xs text-muted-foreground">Prioritized by parsing severity</span>
          </div>

          <div className="space-y-3">
            {data.atsFixes.map((fix, idx) => {
              const isHigh = fix.severity === 'HIGH';
              return (
                <div
                  key={`${fix.hazardCode}-${idx}`}
                  data-testid={`ats-fix-item-${idx}`}
                  className="p-3 rounded-md bg-slate-50 border border-slate-200 space-y-1 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-foreground flex items-center gap-1.5">
                      <span className="font-mono text-slate-500">[{fix.hazardCode}]</span>
                      <span>{fix.issue}</span>
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${
                        isHigh ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {fix.severity}
                    </span>
                  </div>
                  <p className="text-slate-600 pl-1">{fix.recommendation}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 4. Deterministic Content Findings */}
      {data.contentFindings && data.contentFindings.length > 0 && (
        <section
          aria-labelledby="content-findings-heading"
          data-testid="content-findings-section"
          className="bg-white rounded-lg border border-border p-5 space-y-4 shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" aria-hidden="true" />
              <h3 id="content-findings-heading" className="font-bold text-sm text-foreground">
                Content Findings & Span Issues ({data.contentFindings.length})
              </h3>
            </div>
            <span className="text-xs text-muted-foreground">Exact character span highlights</span>
          </div>

          <div className="space-y-3">
            {data.contentFindings.map((finding, idx) => (
              <div
                key={`finding-${idx}`}
                data-testid={`content-finding-${idx}`}
                className="p-3 rounded-md bg-white border border-border space-y-1.5 text-xs shadow-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                    <span>{finding.message}</span>
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                    chars {finding.startChar}–{finding.endChar}
                  </span>
                </div>

                {finding.quote && (
                  <div className="p-2 bg-slate-50 border-l-2 border-primary rounded-r text-slate-700 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">
                    {finding.quote}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5. ML-Ranked Role Suggestions */}
      {data.suggestedRoles && data.suggestedRoles.length > 0 && (
        <section
          aria-labelledby="suggested-roles-heading"
          data-testid="suggested-roles-section"
          className="bg-white rounded-lg border border-border p-5 space-y-4 shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-primary" aria-hidden="true" />
              <h3 id="suggested-roles-heading" className="font-bold text-sm text-foreground">
                ML-Ranked Role Matches ({data.suggestedRoles.length})
              </h3>
            </div>
            <span className="text-xs text-muted-foreground">Derived from career taxonomy chunk embeddings</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {data.suggestedRoles.map((role, idx) => (
              <div
                key={role.title}
                data-testid={`suggested-role-${idx}`}
                className="p-3.5 rounded-lg border border-border bg-slate-50/50 space-y-2 text-xs"
              >
                <div className="flex items-start justify-between gap-1">
                  <h4 className="font-bold text-foreground line-clamp-1">{role.title}</h4>
                  <span
                    data-testid={`role-score-${idx}`}
                    className="font-mono font-bold text-primary px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 shrink-0"
                  >
                    {role.similarityScore}
                  </span>
                </div>

                {role.matchedSkills && role.matchedSkills.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase font-bold text-emerald-800 tracking-wider">
                      Matched Skills:
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {role.matchedSkills.slice(0, 4).map((s) => (
                        <span
                          key={s}
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
