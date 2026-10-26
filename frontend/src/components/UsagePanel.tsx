'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient, UserUsageResponse, MeterName, MeterUsageState } from '@/lib/apiClient';
import { AlertTriangle, AlertCircle, CheckCircle, Info, RefreshCw, HardDrive, FileText, Search } from 'lucide-react';

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = parseFloat((bytes / Math.pow(k, i)).toFixed(1));
  return `${val} ${sizes[i]}`;
}

export function formatDate(isoString: string | null): string {
  if (!isoString) return 'Never';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return isoString;
  }
}

const METER_META: Record<
  MeterName,
  { label: string; description: string; icon: React.ComponentType<{ className?: string }> }
> = {
  analyses: {
    label: 'Analyses & Rewrites',
    description: 'AI resume improvements, bullet rewrites, and job match analyses.',
    icon: FileText,
  },
  job_suggestions: {
    label: 'Job Suggestions',
    description: 'Curated job searches matched to candidate skills and experience.',
    icon: Search,
  },
  resume_storage_bytes: {
    label: 'Resume Storage',
    description: 'Total active storage consumed by uploaded resumes in object store.',
    icon: HardDrive,
  },
};

interface UsagePanelProps {
  onRefreshTrigger?: () => void;
  className?: string;
}

export function UsagePanel({ className }: UsagePanelProps) {
  const {
    data: usage,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<UserUsageResponse>({
    queryKey: ['usage'],
    queryFn: () => apiClient.usage.get(),
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <div className={`p-6 bg-card rounded-lg border border-border shadow-sm ${className || ''}`} data-testid="usage-loading">
        <div className="flex items-center justify-between mb-4">
          <div className="h-5 w-32 bg-slate-200 rounded animate-pulse" />
          <div className="h-5 w-20 bg-slate-200 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-4 rounded-md border border-border bg-slate-50 space-y-3">
              <div className="h-4 w-24 bg-slate-200 rounded animate-pulse" />
              <div className="h-6 w-36 bg-slate-200 rounded animate-pulse" />
              <div className="h-2 w-full bg-slate-200 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className={`p-6 bg-red-50 border border-red-200 rounded-lg text-red-800 ${className || ''}`} data-testid="usage-error">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <span className="font-semibold text-sm">Failed to load usage data</span>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-xs font-medium px-3 py-1 bg-white border border-red-300 rounded hover:bg-red-100 text-red-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            Retry
          </button>
        </div>
        <p className="text-xs mt-1 text-red-700">
          {error instanceof Error ? error.message : 'Please check your connection.'}
        </p>
      </div>
    );
  }

  if (!usage) {
    return null;
  }

  const meterKeys: MeterName[] = ['analyses', 'job_suggestions', 'resume_storage_bytes'];

  return (
    <div className={`bg-card rounded-lg border border-border shadow-sm p-6 ${className || ''}`} data-testid="usage-panel">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-border mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">Usage & Quotas</h2>
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
              {usage.planName || usage.plan}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Usage tracking is refreshed automatically. Next quota reset: {formatDate(usage.resetAt)}.
          </p>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh usage data"
          className="self-start sm:self-auto flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-border bg-slate-50 hover:bg-slate-100 text-foreground transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
          <span>{isFetching ? 'Refreshing...' : 'Refresh'}</span>
        </button>
      </div>

      {/* Meters Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {meterKeys.map((key) => {
          const state: MeterUsageState | undefined = usage.meters[key];
          const meta = METER_META[key];
          if (!state) return null;

          const isStorage = key === 'resume_storage_bytes';
          const isUnlimited = state.unlimited || state.limit === null;

          const usedDisplay = isStorage ? formatBytes(state.used) : state.used.toLocaleString();
          const limitDisplay = isUnlimited
            ? 'Unlimited'
            : isStorage
            ? formatBytes(state.limit as number)
            : (state.limit as number).toLocaleString();

          const percent = state.percent ?? (isUnlimited ? 0 : Math.min(100, Math.floor((state.used * 100) / (state.limit || 1))));

          return (
            <div
              key={key}
              data-testid={`meter-${key}`}
              className={`p-4 rounded-lg border bg-white flex flex-col justify-between transition-all ${
                state.blocked
                  ? 'border-red-300 bg-red-50/30'
                  : state.activeThreshold === 90
                  ? 'border-orange-300 bg-orange-50/20'
                  : state.activeThreshold === 70
                  ? 'border-amber-300 bg-amber-50/20'
                  : 'border-border'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-md bg-slate-100 text-slate-700">
                      <meta.icon className="h-4 w-4" />
                    </div>
                    <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                  </div>
                  {isUnlimited ? (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                      Unlimited
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-muted-foreground">
                      {percent}%
                    </span>
                  )}
                </div>

                <div className="mt-3">
                  <div className="flex items-baseline justify-between text-xs mb-1.5">
                    <span className="text-sm font-bold text-foreground">
                      {usedDisplay}
                    </span>
                    <span className="text-muted-foreground">
                      / {limitDisplay}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div
                    role="progressbar"
                    aria-valuenow={isUnlimited ? 0 : percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${meta.label} usage progress`}
                    className="w-full h-2 rounded-full bg-slate-100 overflow-hidden border border-slate-200"
                  >
                    <div
                      className={`h-full transition-all duration-300 ${
                        isUnlimited
                          ? 'bg-emerald-500 w-1/4'
                          : state.blocked
                          ? 'bg-destructive'
                          : state.activeThreshold === 90
                          ? 'bg-orange-600'
                          : state.activeThreshold === 70
                          ? 'bg-amber-500'
                          : 'bg-primary'
                      }`}
                      style={{ width: isUnlimited ? '15%' : `${Math.min(100, Math.max(0, percent))}%` }}
                    />
                  </div>
                </div>

                {/* Reset Information */}
                <div className="mt-2.5 text-[11px] text-muted-foreground flex items-center justify-between">
                  <span>{isStorage ? 'Lifetime total' : 'Monthly quota'}</span>
                  <span>{state.resetAt ? `Resets ${formatDate(state.resetAt)}` : 'Continuous'}</span>
                </div>
              </div>

              {/* SEPARATE Alert Banners per Specification (50%, 70%, 90%, 100%) */}
              {!isUnlimited && (
                <div className="mt-4 pt-3 border-t border-slate-100">
                  {state.blocked ? (
                    <div
                      role="alert"
                      data-testid={`alert-100-${key}`}
                      className="p-2.5 rounded-md bg-red-50 border border-red-300 text-red-900 flex items-start gap-2 text-xs"
                    >
                      <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold block">100% Limit Reached</span>
                        <span>This quota has reached its limit. Further requests will be blocked until reset.</span>
                      </div>
                    </div>
                  ) : state.activeThreshold === 90 ? (
                    <div
                      role="alert"
                      data-testid={`alert-90-${key}`}
                      className="p-2.5 rounded-md bg-orange-50 border border-orange-300 text-orange-950 flex items-start gap-2 text-xs"
                    >
                      <AlertCircle className="h-4 w-4 text-orange-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold block">90% Quota Warning</span>
                        <span>You have used 90% or more of your allocation. Approaching limit.</span>
                      </div>
                    </div>
                  ) : state.activeThreshold === 70 ? (
                    <div
                      role="alert"
                      data-testid={`alert-70-${key}`}
                      className="p-2.5 rounded-md bg-amber-50 border border-amber-300 text-amber-950 flex items-start gap-2 text-xs"
                    >
                      <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold block">70% Quota Notice</span>
                        <span>You have crossed 70% of your usage limit for this period.</span>
                      </div>
                    </div>
                  ) : state.activeThreshold === 50 ? (
                    <div
                      role="alert"
                      data-testid={`alert-50-${key}`}
                      className="p-2.5 rounded-md bg-slate-50 border border-slate-300 text-slate-800 flex items-start gap-2 text-xs"
                    >
                      <Info className="h-4 w-4 text-slate-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold block">50% Quota Update</span>
                        <span>You have utilized half of your current allocation.</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-700">
                      <CheckCircle className="h-3.5 w-3.5" />
                      <span>Within healthy limit</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
