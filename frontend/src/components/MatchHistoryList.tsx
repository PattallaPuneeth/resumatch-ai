'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { apiClient, ResumeMatchHistoryItem, ApiProblemError } from '../lib/apiClient';

interface MatchHistoryListProps {
  resumeId: string;
  activeJobId?: string | null;
  onSelectMatch: (jobId: string) => void;
  onAddJobClick?: () => void;
  /** Bump after a new match finishes so the list reloads without a page refresh */
  refreshKey?: number;
}

export function MatchHistoryList({
  resumeId,
  activeJobId,
  onSelectMatch,
  onAddJobClick,
  refreshKey = 0,
}: MatchHistoryListProps) {
  const [matches, setMatches] = useState<ResumeMatchHistoryItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMatches = useCallback(
    async (offset = 0, isLoadMore = false, quiet = false) => {
      // A quiet reload keeps the current list on screen instead of flashing the skeleton
      if (isLoadMore) setIsLoadingMore(true);
      else if (!quiet) setIsLoading(true);
      setError(null);

      try {
        const response = await apiClient.resumes.getMatches(resumeId, {
          limit: 10,
          offset,
        });

        if (isLoadMore) {
          setMatches((prev) => [...prev, ...response.matches]);
        } else {
          setMatches(response.matches);
        }
        setTotal(response.total);
      } catch (err: any) {
        if (err instanceof ApiProblemError) {
          setError(err.detail || 'Failed to load match history.');
        } else {
          setError(err?.message || 'Failed to load match history.');
        }
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [resumeId]
  );

  useEffect(() => {
    fetchMatches(0, false);
  }, [fetchMatches]);

  useEffect(() => {
    if (refreshKey > 0) fetchMatches(0, false, true);
  }, [refreshKey, fetchMatches]);

  if (isLoading) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-5 my-6">
        <div className="flex items-center justify-between pb-3 border-b border-slate-200">
          <div className="h-5 bg-slate-200 rounded w-48 animate-pulse" />
          <div className="h-4 bg-slate-200 rounded w-20 animate-pulse" />
        </div>
        <div className="space-y-3 mt-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-slate-100 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 my-6 text-sm text-red-900 flex items-center justify-between">
        <div>
          <span className="font-semibold block">Error loading match history</span>
          <span>{error}</span>
        </div>
        <button
          type="button"
          onClick={() => fetchMatches(0, false)}
          className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-900 rounded font-medium text-xs min-h-[36px]"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <section aria-labelledby="history-heading" className="bg-white border border-slate-200 rounded-lg p-5 my-6 shadow-sm">
      <div className="flex items-center justify-between pb-3 border-b border-slate-200">
        <div>
          <h3 id="history-heading" className="text-base font-bold text-slate-900">
            Target Job Matches ({total})
          </h3>
          <p className="text-xs text-slate-600 mt-0.5">
            Historical evaluations for this resume. Results persist across page refreshes.
          </p>
        </div>

        {onAddJobClick && (
          <button
            type="button"
            onClick={onAddJobClick}
            className="text-xs px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded font-semibold min-h-[36px]"
          >
            + Match New JD
          </button>
        )}
      </div>

      {matches.length === 0 ? (
        <div className="text-center py-8 text-slate-500 text-sm">
          <p>No job descriptions have been matched against this resume yet.</p>
          <p className="text-xs text-slate-400 mt-1">
            Choose &ldquo;Resume + job description&rdquo; above to calculate your match score.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-2.5">
          {matches.map((item) => {
            const isActive = activeJobId === item.jobId;
            const formattedDate = new Date(item.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });

            return (
              <div
                key={item.id}
                className={`p-3.5 rounded-lg border transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 stagger-item ${
                  isActive
                    ? 'border-emerald-600 bg-emerald-50/50 ring-1 ring-emerald-600'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-900 text-sm">
                      {item.job.title}
                    </span>
                    <span className="text-slate-400 text-xs">at</span>
                    <span className="text-slate-700 text-xs font-medium">
                      {item.job.company}
                    </span>

                    {item.analysis?.llmStatus === 'SUCCESS' && (
                      <span className="text-[11px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-medium">
                        AI Analyzed
                      </span>
                    )}
                    {item.analysis?.llmStatus === 'UNAVAILABLE' && (
                      <span className="text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-medium">
                        Score only
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
                    <span>Evaluated {formattedDate}</span>
                    {item.subScores?.crossEncoderScore !== undefined && item.subScores.crossEncoderScore !== null && (
                      <span>Requirement fit: {item.subScores.crossEncoderScore}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 self-end sm:self-center">
                  <div className="text-right">
                    <span className="text-xs text-slate-500 block">Match Score</span>
                    <span className="text-base font-bold text-slate-900">
                      {item.matchScore}%
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelectMatch(item.jobId)}
                    disabled={isActive}
                    className={`px-3 py-1.5 rounded text-xs font-medium min-h-[36px] ${
                      isActive
                        ? 'bg-emerald-700 text-white cursor-default'
                        : 'bg-white border border-slate-300 text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    {isActive ? 'Viewing' : 'View Results'}
                  </button>
                </div>
              </div>
            );
          })}

          {matches.length < total && (
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={() => fetchMatches(matches.length, true)}
                disabled={isLoadingMore}
                className="text-xs text-emerald-700 hover:text-emerald-800 font-semibold underline min-h-[36px] px-3 py-1"
              >
                {isLoadingMore ? 'Loading more...' : `Load more (${total - matches.length} remaining)`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
