'use client';

import React from 'react';
import { ImprovementsResponse } from '@/lib/apiClient';
import {
  AlertTriangle,
  AlertCircle,
  FileText,
  Briefcase,
  Sparkles,
  Info,
  Wand2,
} from 'lucide-react';

interface ModeAResultsProps {
  data: ImprovementsResponse;
  className?: string;
  onFixBullet?: (bullet: string) => void;
}

interface FindingBadgeConfig {
  label: string;
  className: string;
}

function getFindingBadge(type: string, message: string): FindingBadgeConfig {
  const t = type?.toUpperCase() || '';
  const m = message?.toLowerCase() || '';

  if (t === 'NO_ACTION_VERB' || m.includes('action verb')) {
    return {
      label: 'Action Verb Needed',
      className: 'bg-amber-100 text-amber-900 border-amber-200',
    };
  }
  if (t === 'MISSING_SECTION' || m.includes('missing standard')) {
    return {
      label: 'Format Warning',
      className: 'bg-rose-100 text-rose-900 border-rose-200',
    };
  }
  if (t === 'WEAK_PHRASE' || m.includes('weak phrase')) {
    return {
      label: 'Weak Phrase',
      className: 'bg-orange-100 text-orange-900 border-orange-200',
    };
  }
  if (t === 'OVERLY_LONG_BULLET' || m.includes('long')) {
    return {
      label: 'Length Warning',
      className: 'bg-blue-100 text-blue-900 border-blue-200',
    };
  }
  if (t === 'NO_METRIC_OR_NUMBER' || m.includes('metric') || m.includes('number') || m.includes('quantif')) {
    return {
      label: 'Impact / Metric Needed',
      className: 'bg-purple-100 text-purple-900 border-purple-200',
    };
  }
  if (t === 'REPEATED_OPENING_VERB' || m.includes('repeat')) {
    return {
      label: 'Repetition',
      className: 'bg-slate-100 text-slate-800 border-slate-200',
    };
  }
  return {
    label: 'Format Warning',
    className: 'bg-amber-100 text-amber-900 border-amber-200',
  };
}

export function ModeAResults({ data, className = '', onFixBullet }: ModeAResultsProps) {


  return (
    <div data-testid="mode-a-results" className={`space-y-6 ${className}`}>
      {/* 4. LLM Status Notice */}
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
              The written AI summary is not available right now. Your formatting checks, content
              findings and role suggestions below are complete.
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

      {/* 5. Formatting and structure tips (no score) */}
      {data.atsFixes && data.atsFixes.length > 0 && (
        <section
          aria-labelledby="resume-fixes-heading"
          data-testid="resume-fixes-section"
          className="bg-white rounded-lg border border-border p-5 space-y-4 shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
              <h3 id="resume-fixes-heading" className="font-bold text-sm text-foreground">
                Formatting & Structure Tips ({data.atsFixes.length})
              </h3>
            </div>
            <span className="text-xs text-muted-foreground">Most important first</span>
          </div>

          <div className="space-y-3">
            {data.atsFixes.map((fix, idx) => {
              const isHigh = fix.severity === 'HIGH';
              return (
                <div
                  key={`${fix.hazardCode}-${idx}`}
                  data-testid={`resume-fix-item-${idx}`}
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

      {/* 6. Deterministic Content Findings */}
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
            <span className="text-xs text-muted-foreground">Actionable resume fixes found by automatic checks</span>
          </div>

          <div className="space-y-3">
            {data.contentFindings.map((finding, idx) => {
              const badge = getFindingBadge(finding.type, finding.message);
              return (
                <div
                  key={`finding-${idx}`}
                  data-testid={`content-finding-${idx}`}
                  className="p-3.5 rounded-lg bg-white border border-border space-y-2 text-xs shadow-xs"
                >
                  <div className="flex items-start sm:items-center justify-between gap-2 flex-wrap">
                    <span className="font-semibold text-foreground flex items-center gap-1.5 flex-1 min-w-[200px]">
                      <AlertCircle className="h-4 w-4 text-slate-500 shrink-0" aria-hidden="true" />
                      <span>{finding.message}</span>
                    </span>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${badge.className}`}>
                        {badge.label}
                      </span>
                      <span
                        data-testid={`content-finding-span-${idx}`}
                        className="text-[10px] font-mono text-slate-400"
                        title={`Offset characters ${finding.startChar} to ${finding.endChar} in canonical resume text`}
                      >
                        chars {finding.startChar}–{finding.endChar}
                      </span>
                      {finding.quote && onFixBullet && (
                        <button
                          type="button"
                          onClick={() => onFixBullet(finding.quote)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-300 rounded transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-600 cursor-pointer"
                        >
                          <Wand2 className="h-3 w-3 text-emerald-700" aria-hidden="true" />
                          <span>Fix with AI</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {finding.quote && (
                    <div className="p-2.5 bg-slate-50 border-l-2 border-primary rounded-r text-slate-800 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">
                      {finding.quote}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 7. ML-Ranked Role Suggestions */}
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
