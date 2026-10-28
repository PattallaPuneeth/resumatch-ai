'use client';

import React, { useState, useId } from 'react';
import { apiClient, RewriterResponse, ApiProblemError } from '../lib/apiClient';
import { computeWordDiff } from '../lib/wordDiff';

interface BulletEditorProps {
  resumeId: string;
  bullets: string[];
  jobs?: Array<{ id: string; title: string; company: string }>;
  analysesMeter?: { used: number; limit: number | null };
  onUsageChange?: () => void;
}

export function BulletEditor({
  resumeId,
  bullets,
  jobs = [],
  analysesMeter,
  onUsageChange,
}: BulletEditorProps) {
  const [selectedBullet, setSelectedBullet] = useState<string>(bullets[0] || '');
  const [customBullet, setCustomBullet] = useState<string>('');
  const [useCustom, setUseCustom] = useState<boolean>(false);
  const [targetSkill, setTargetSkill] = useState<string>('');
  const [selectedJobId, setSelectedJobId] = useState<string>('');

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [result, setResult] = useState<RewriterResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isHallucination, setIsHallucination] = useState<boolean>(false);
  const [isUnavailable, setIsUnavailable] = useState<boolean>(false);
  const [isQuotaExceeded, setIsQuotaExceeded] = useState<boolean>(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const bulletSelectId = useId();
  const targetSkillId = useId();
  const jobIdSelectId = useId();

  const activeBullet = useCustom ? customBullet.trim() : selectedBullet;

  const handleRewrite = async () => {
    if (!activeBullet) {
      setErrorMessage('Please select or enter a bullet point to rewrite.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setIsHallucination(false);
    setIsUnavailable(false);
    setIsQuotaExceeded(false);
    setResult(null);

    try {
      const response = await apiClient.rewriter.rewriteBullet({
        resumeId,
        originalBullet: activeBullet,
        targetSkill: targetSkill.trim() || undefined,
        jobId: selectedJobId || undefined,
      });

      setResult(response);
      if (onUsageChange) onUsageChange();
    } catch (err: any) {
      if (onUsageChange) onUsageChange(); // Refetch usage in case of refund

      if (err instanceof ApiProblemError) {
        if (err.status === 429) {
          setIsQuotaExceeded(true);
          setErrorMessage(err.detail || 'Analyses usage limit reached.');
        } else if (err.status === 422 && (err.type?.includes('hallucination') || err.detail?.includes('HALLUCINATION_DETECTED'))) {
          setIsHallucination(true);
          setErrorMessage(
            'The rewrite was rejected because it contained facts not found in your resume; you were not charged.'
          );
        } else if (
          err.status === 503 ||
          err.status === 408 ||
          err.detail?.toLowerCase().includes('unavailable') ||
          err.detail?.toLowerCase().includes('timeout') ||
          err.detail?.toLowerCase().includes('timed out')
        ) {
          setIsUnavailable(true);
          setErrorMessage('AI bullet rewriter timed out or is currently unavailable. Please try again.');
        } else {
          setErrorMessage(err.detail || 'Failed to rewrite bullet. Please try again.');
        }
      } else if (
        err?.message?.toLowerCase().includes('timeout') ||
        err?.message?.toLowerCase().includes('timed out')
      ) {
        setIsUnavailable(true);
        setErrorMessage('AI bullet rewriter timed out. Please try again.');
      } else {
        setErrorMessage(err?.message || 'An unexpected error occurred.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async (text: string, index: number) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 3000);
      }
    } catch {
      // Fallback for clipboard
    }
  };

  return (
    <section aria-labelledby="bullet-editor-heading" className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm my-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-200 gap-2">
        <div>
          <h2 id="bullet-editor-heading" className="text-xl font-bold text-slate-900">
            Improve a Resume Bullet
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Get stronger versions of one bullet point, written only from facts already in your resume.
          </p>
        </div>

        {analysesMeter && (
          <div className="text-xs bg-slate-50 border border-slate-200 px-3 py-1.5 rounded text-slate-700">
            <span className="font-medium text-slate-900">Analyses Quota: </span>
            {analysesMeter.limit === null ? (
              <span className="text-emerald-700 font-semibold">Unlimited</span>
            ) : (
              <span>
                {analysesMeter.used} / {analysesMeter.limit} used ({Math.max(0, analysesMeter.limit - analysesMeter.used)} remaining)
              </span>
            )}
          </div>
        )}
      </div>

      {/* Input Form */}
      <div className="mt-6 space-y-4">
        {bullets.length > 0 && !useCustom ? (
          <div>
            <label htmlFor={bulletSelectId} className="block text-sm font-semibold text-slate-900 mb-1">
              Select an experience bullet from your resume:
            </label>
            <select
              id={bulletSelectId}
              value={selectedBullet}
              onChange={(e) => setSelectedBullet(e.target.value)}
              className="w-full text-sm border border-slate-300 rounded px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {bullets.map((b, idx) => (
                <option key={idx} value={b}>
                  {b.length > 90 ? `${b.slice(0, 90)}...` : b}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setUseCustom(true);
                setCustomBullet(selectedBullet);
              }}
              className="text-xs text-emerald-700 hover:text-emerald-800 underline mt-1.5 block font-medium"
            >
              Or type/paste exact substring manually
            </button>
          </div>
        ) : (
          <div>
            <label htmlFor={bulletSelectId} className="block text-sm font-semibold text-slate-900 mb-1">
              Experience bullet (must be an exact substring of your resume):
            </label>
            <textarea
              id={bulletSelectId}
              rows={3}
              value={customBullet}
              onChange={(e) => setCustomBullet(e.target.value)}
              placeholder="Paste exact bullet line from your resume..."
              className="w-full text-sm border border-slate-300 rounded px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
            {bullets.length > 0 && (
              <button
                type="button"
                onClick={() => setUseCustom(false)}
                className="text-xs text-emerald-700 hover:text-emerald-800 underline mt-1.5 block font-medium"
              >
                Switch back to dropdown selection
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div>
            <label htmlFor={targetSkillId} className="block text-xs font-semibold text-slate-700 mb-1">
              Target Skill (Optional):
            </label>
            <input
              id={targetSkillId}
              type="text"
              maxLength={100}
              value={targetSkill}
              onChange={(e) => setTargetSkill(e.target.value)}
              placeholder="e.g. Distributed Systems, PostgreSQL"
              className="w-full text-sm border border-slate-300 rounded px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>

          <div>
            <label htmlFor={jobIdSelectId} className="block text-xs font-semibold text-slate-700 mb-1">
              Target Job Description (Optional context):
            </label>
            <select
              id={jobIdSelectId}
              value={selectedJobId}
              onChange={(e) => setSelectedJobId(e.target.value)}
              className="w-full text-sm border border-slate-300 rounded px-3 py-2 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              <option value="">None (Resume context only)</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title} at {j.company}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Action Button */}
        <div className="pt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={handleRewrite}
            disabled={isLoading || !activeBullet}
            className="inline-flex items-center justify-center px-5 py-2.5 bg-emerald-700 text-white rounded font-medium text-sm hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 min-h-[44px]"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Rewriting and Verifying Facts...
              </span>
            ) : (
              'Rewrite Bullet (1 Analysis Credit)'
            )}
          </button>
        </div>
      </div>

      {/* Notifications & Error States */}
      <div aria-live="polite" className="mt-4">
        {isQuotaExceeded && (
          <div role="alert" className="p-4 bg-amber-50 border border-amber-200 rounded text-amber-900 text-sm">
            <span className="font-semibold block mb-1">Usage Limit Exceeded</span>
            <span>You have reached your analyses limit. Upgrade your plan or wait for your cycle reset.</span>
          </div>
        )}

        {isHallucination && (
          <div role="alert" className="p-4 bg-amber-50 border border-amber-300 rounded text-amber-900 text-sm">
            <span className="font-semibold block mb-1">Factual Verification Guard Triggered</span>
            <span>{errorMessage}</span>
          </div>
        )}

        {isUnavailable && (
          <div role="alert" className="p-4 bg-slate-50 border border-slate-300 rounded text-slate-800 text-sm">
            <span className="font-semibold block mb-1">AI Rewriter Unavailable</span>
            <span>{errorMessage}</span>
            <button
              type="button"
              onClick={handleRewrite}
              className="mt-2 text-xs font-semibold text-emerald-700 underline block"
            >
              Retry
            </button>
          </div>
        )}

        {!isQuotaExceeded && !isHallucination && !isUnavailable && errorMessage && (
          <div role="alert" className="p-4 bg-red-50 border border-red-200 rounded text-red-900 text-sm">
            <span className="font-semibold block mb-1">Error</span>
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      {/* Results View */}
      {result && result.options && result.options.length > 0 && (
        <div className="mt-8 pt-6 border-t border-slate-200 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-slate-900">
              Suggested Rewrites ({result.options.length})
            </h3>
            <span className="text-xs bg-emerald-100 text-emerald-800 px-2.5 py-0.5 rounded font-semibold">
              Uses only facts from your resume
            </span>
          </div>

          {/* Diff Legend */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-700 flex flex-wrap items-center gap-4">
            <span className="font-semibold text-slate-900">Diff Legend:</span>
            <span className="flex items-center gap-1.5">
              <ins className="no-underline underline decoration-2 decoration-emerald-600 bg-emerald-100 text-emerald-950 font-semibold px-1 rounded">
                + Added words (underlined)
              </ins>
            </span>
            <span className="flex items-center gap-1.5">
              <del className="line-through decoration-2 decoration-red-600 bg-red-100 text-red-950 px-1 rounded opacity-80">
                - Removed words (strikethrough)
              </del>
            </span>
            <span className="text-slate-500">Unchanged words are unformatted text.</span>
          </div>

          <div className="space-y-6">
            {result.options.map((opt, idx) => {
              const diffTokens = computeWordDiff(result.originalBullet, opt.text);

              return (
                <div key={idx} className="border border-slate-200 rounded-lg p-5 bg-slate-50/50 space-y-4 reveal-stagger shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                      Option {idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy(opt.text, idx)}
                      className={`text-xs px-3.5 py-2 rounded-md font-semibold transition-all active:scale-95 duration-150 min-h-[44px] flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                        copiedIndex === idx
                          ? 'bg-emerald-700 text-white shadow-sm'
                          : 'bg-white border border-slate-300 text-slate-800 hover:bg-slate-100 shadow-2xs'
                      }`}
                    >
                      {copiedIndex === idx ? (
                        <>
                          <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                          <span>Copied to Clipboard!</span>
                        </>
                      ) : (
                        <span>Copy Rewritten Bullet</span>
                      )}
                    </button>
                  </div>

                  {/* Side-by-side or stacked diff view */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Original */}
                    <div className="p-3 bg-white border border-slate-200 rounded text-sm">
                      <span className="text-xs font-semibold uppercase text-slate-500 block mb-1">
                        Original Bullet
                      </span>
                      <p className="text-slate-800 leading-relaxed">{result.originalBullet}</p>
                    </div>

                    {/* Rewritten with Word Diff */}
                    <div className="p-3 bg-white border border-slate-200 rounded text-sm">
                      <span className="text-xs font-semibold uppercase text-emerald-700 block mb-1">
                        Rewritten Bullet (with Diff)
                      </span>
                      <p className="text-slate-900 leading-relaxed">
                        {diffTokens.map((token, tIdx) => {
                          if (token.type === 'added') {
                            return (
                              <ins
                                key={tIdx}
                                className="no-underline underline decoration-2 decoration-emerald-600 bg-emerald-50 text-emerald-900 font-semibold px-0.5 rounded"
                              >
                                {token.text}
                              </ins>
                            );
                          }
                          if (token.type === 'removed') {
                            return (
                              <del
                                key={tIdx}
                                className="line-through decoration-2 decoration-red-600 bg-red-50 text-red-900 px-0.5 rounded opacity-75"
                              >
                                {token.text}
                              </del>
                            );
                          }
                          return <span key={tIdx}>{token.text}</span>;
                        })}
                      </p>
                    </div>
                  </div>

                  {/* Grounded Evidence Spans */}
                  {opt.evidenceSpans && opt.evidenceSpans.length > 0 && (
                    <div className="p-3 bg-emerald-50/60 border border-emerald-200 rounded text-xs space-y-2">
                      <span className="font-semibold text-emerald-950 block">
                        Grounded Evidence in Source Resume:
                      </span>
                      <div className="space-y-1.5">
                        {opt.evidenceSpans.map((span, sIdx) => (
                          <div key={sIdx} className="flex items-start gap-2 text-slate-800">
                            <span className="text-emerald-700 font-bold">✓</span>
                            <span>
                              <span className="font-semibold text-slate-900">&ldquo;{span.quote}&rdquo;</span>{' '}
                              <span className="text-slate-500 font-mono text-[11px]">
                                [chars {span.startChar}–{span.endChar}]
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
