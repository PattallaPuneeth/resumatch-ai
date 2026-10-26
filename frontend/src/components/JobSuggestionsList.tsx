'use client';

import React, { useState } from 'react';
import {
  apiClient,
  JobSuggestionsResponse,
  ScoredJobSuggestion,
  UserUsageResponse,
} from '@/lib/apiClient';
import { validateExternalUrl } from '@/lib/safeUrl';
import {
  Briefcase,
  ExternalLink,
  MapPin,
  Calendar,
  Sparkles,
  AlertCircle,
  RefreshCw,
  Info,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

interface JobSuggestionsListProps {
  resumeId: string;
  targetJobId?: string | null;
  usageData?: UserUsageResponse | null;
  onQuotaConsumed?: () => void;
  className?: string;
}

export function JobSuggestionsList({
  resumeId,
  targetJobId,
  usageData,
  onQuotaConsumed,
  className = '',
}: JobSuggestionsListProps) {
  const [location, setLocation] = useState('');
  const [seniority, setSeniority] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isQuotaExceeded, setIsQuotaExceeded] = useState(false);
  const [suggestionsData, setSuggestionsData] = useState<JobSuggestionsResponse | null>(null);

  const meter = usageData?.meters?.job_suggestions;
  const isMeterBlocked = meter?.blocked || false;
  const remainingQuota =
    meter?.limit !== null && meter?.limit !== undefined
      ? Math.max(0, meter.limit - meter.used)
      : 'Unlimited';

  const fetchSuggestions = async () => {
    setIsLoading(true);
    setError(null);
    setIsQuotaExceeded(false);

    try {
      const response = await apiClient.resumes.getSuggestions(resumeId, {
        limit: 10,
        location: location.trim() || undefined,
        seniority: seniority.trim() || undefined,
        jobId: targetJobId || undefined,
      });

      setSuggestionsData(response);
      if (onQuotaConsumed) {
        onQuotaConsumed();
      }
    } catch (err: any) {
      if (err.status === 429) {
        setIsQuotaExceeded(true);
        setError(
          err.detail ||
            err.message ||
            'Job suggestions monthly quota reached. Upgrade or wait until reset.'
        );
      } else if (err.status >= 500) {
        setError(
          `${err.detail || err.message || 'Job search service encountered a temporary error.'} Your quota was refunded. Please retry.`
        );
      } else {
        setError(err.detail || err.message || 'Failed to fetch job suggestions.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section
      data-testid="job-suggestions-panel"
      aria-labelledby="job-suggestions-title"
      className={`bg-white rounded-lg border border-border p-5 space-y-6 shadow-sm ${className}`}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Briefcase className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 id="job-suggestions-title" className="font-bold text-base text-foreground">
              Suggested Job Listings
            </h3>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Discover roles matching your resume embedding and parsed skill profile.
          </p>
        </div>

        {/* Quota Indicator */}
        <div className="flex items-center gap-2">
          <span
            data-testid="suggestions-quota-note"
            className="text-xs px-2.5 py-1 rounded bg-slate-100 text-slate-700 font-medium border border-slate-200"
          >
            Quota:{' '}
            <span className="font-semibold text-foreground">
              {typeof remainingQuota === 'number' ? `${remainingQuota} remaining` : remainingQuota}
            </span>
          </span>
        </div>
      </div>

      {/* Filter and Trigger Bar */}
      <div className="flex flex-col md:flex-row gap-3">
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="suggest-location" className="block text-xs font-semibold text-slate-700 mb-1">
              Location Filter (Optional)
            </label>
            <input
              id="suggest-location"
              type="text"
              placeholder="e.g. Remote, New York, NY"
              maxLength={100}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          </div>

          <div>
            <label htmlFor="suggest-seniority" className="block text-xs font-semibold text-slate-700 mb-1">
              Seniority Filter (Optional)
            </label>
            <input
              id="suggest-seniority"
              type="text"
              placeholder="e.g. Senior, Lead, Mid-Level"
              maxLength={50}
              value={seniority}
              onChange={(e) => setSeniority(e.target.value)}
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          </div>
        </div>

        <div className="flex items-end">
          <button
            type="button"
            data-testid="fetch-suggestions-btn"
            onClick={fetchSuggestions}
            disabled={isLoading || isMeterBlocked}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 bg-primary hover:bg-[hsl(var(--primary-hover))] text-primary-foreground text-xs font-semibold rounded-md shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {isLoading ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>Searching & Scoring...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Find Matched Jobs</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error / Quota Notice */}
      {error && (
        <div
          role="alert"
          data-testid="suggestions-error-banner"
          className={`p-3 rounded-md text-xs flex items-start gap-2 border ${
            isQuotaExceeded
              ? 'bg-amber-50 text-amber-900 border-amber-200'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" aria-hidden="true" />
          <div className="flex-1 space-y-1">
            <p className="font-semibold">{isQuotaExceeded ? 'Quota Exceeded' : 'Request Error'}</p>
            <p>{error}</p>
            {!isQuotaExceeded && (
              <button
                type="button"
                onClick={fetchSuggestions}
                className="mt-1 inline-flex items-center gap-1 font-semibold underline hover:no-underline"
              >
                <RefreshCw className="h-3 w-3" />
                Retry Search
              </button>
            )}
          </div>
        </div>
      )}

      {/* Sample Data Banner */}
      {suggestionsData && suggestionsData.isSample && (
        <div
          data-testid="sample-data-badge-banner"
          className="p-3 bg-slate-50 border border-slate-200 rounded-md flex items-start gap-2 text-xs text-slate-700"
        >
          <Info className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <div className="flex items-center gap-2">
              <span
                data-testid="sample-data-badge"
                className="font-bold uppercase tracking-wider text-[10px] px-2 py-0.5 rounded bg-slate-200 text-slate-800"
              >
                Sample data
              </span>
              <span className="font-semibold text-foreground">Demonstration Job Listings</span>
            </div>
            <p className="mt-1 text-muted-foreground text-[11px]">
              These are synthetic demo job listings formatted from ATS fixtures because live external
              scraping credentials are not active. All scoring runs through the real Phase 3 ML matching engine.
            </p>
          </div>
        </div>
      )}

      {/* Empty State */}
      {suggestionsData && suggestionsData.suggestions.length === 0 && (
        <div
          data-testid="suggestions-empty-state"
          className="text-center py-8 border border-dashed border-border rounded-lg p-6 space-y-2"
        >
          <Briefcase className="h-8 w-8 text-muted-foreground mx-auto" aria-hidden="true" />
          <p className="text-sm font-semibold text-foreground">
            {suggestionsData.message || 'No matching job suggestions found.'}
          </p>
          <p className="text-xs text-muted-foreground">
            Try adjusting or removing your location and seniority filters to see more results.
          </p>
        </div>
      )}

      {/* Results Grid */}
      {suggestionsData && suggestionsData.suggestions.length > 0 && (
        <div
          data-testid="suggestions-grid"
          className="grid grid-cols-1 md:grid-cols-2 gap-4"
        >
          {suggestionsData.suggestions.map((job, idx) => {
            const urlValidation = validateExternalUrl(job.sourceUrl);

            return (
              <article
                key={`${job.company}-${job.title}-${idx}`}
                data-testid={`suggestion-card-${idx}`}
                className="bg-white border border-border rounded-lg p-4 space-y-3 hover:border-slate-300 transition-colors shadow-sm flex flex-col justify-between"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="font-bold text-sm text-foreground line-clamp-1">
                        {job.title}
                      </h4>
                      <p className="text-xs font-medium text-muted-foreground line-clamp-1">
                        {job.company}
                      </p>
                    </div>

                    {/* Exact Score Display - Never Rounded or Altered */}
                    <div
                      data-testid={`suggestion-score-${idx}`}
                      className="shrink-0 text-xs font-mono font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
                    >
                      {job.matchScore}%
                    </div>
                  </div>

                  {job.location && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="line-clamp-1">{job.location}</span>
                    </div>
                  )}

                  {/* Matched Skills */}
                  {job.matchedSkills && job.matchedSkills.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[11px] font-semibold text-emerald-800 block">
                        Matched Skills:
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {job.matchedSkills.map((skill) => (
                          <span
                            key={skill}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
                          >
                            {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Missing Skills */}
                  {job.missingSkills && job.missingSkills.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[11px] font-semibold text-slate-600 block">
                        Missing Skills:
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {job.missingSkills.map((skill) => (
                          <span
                            key={skill}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200"
                          >
                            {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer with Validated External Link and Timestamp */}
                <div className="border-t border-border pt-3 mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Calendar className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span>{new Date(job.fetchedAt).toLocaleDateString()}</span>
                  </div>

                  {urlValidation.isValid ? (
                    <a
                      href={urlValidation.safeUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      data-testid={`suggestion-link-${idx}`}
                      className="inline-flex items-center gap-1 font-medium text-primary hover:text-[hsl(var(--primary-hover))] underline hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
                    >
                      <span>{urlValidation.hostname}</span>
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="text-slate-400 italic">No verified URL</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
