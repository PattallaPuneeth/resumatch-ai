'use client';

import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, ResumeSummary } from '@/lib/apiClient';
import Link from 'next/link';
import { FileText, Trash2, AlertCircle, RefreshCw, Award, Clock, Sparkles } from 'lucide-react';
import { formatBytes, formatDate } from '@/components/UsagePanel';
import { useEventStream } from '@/hooks/useEventStream';

interface ResumeListProps {
  onDeleteSuccess?: () => void;
  className?: string;
}

export function ResumeList({ onDeleteSuccess, className }: ResumeListProps) {
  const queryClient = useQueryClient();
  const { isConnected: isSseConnected } = useEventStream();
  const [deleteCandidate, setDeleteCandidate] = useState<ResumeSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Resume details cache for atsScore when status is PARSED
  const [atsScores, setAtsScores] = useState<Record<string, number | null>>({});

  const [pollInterval, setPollInterval] = useState<number | false>(false);

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<{ resumes: ResumeSummary[] }>({
    queryKey: ['resumes'],
    queryFn: () => apiClient.resumes.list(),
    refetchInterval: pollInterval,
    refetchOnWindowFocus: true,
  });

  const resumes = React.useMemo(() => data?.resumes || [], [data?.resumes]);

  // Determine if any resume is still processing and adjust bounded backoff polling
  useEffect(() => {
    // Anything not finished (uploaded, extracting, OCR, ...) is still being worked on
    const hasActiveJobs = resumes.some((r) => r.status !== 'PARSED' && r.status !== 'FAILED');

    if (hasActiveJobs && !isSseConnected) {
      setPollInterval((prev) => {
        if (!prev) return 2000;
        return Math.min(prev * 1.5, 10000);
      });
    } else {
      setPollInterval(false);
    }
  }, [resumes]);

  // For any resume with PARSED status, fetch its details to retrieve atsScore if not already loaded
  useEffect(() => {
    const parsedResumes = resumes.filter((r) => r.status === 'PARSED' && atsScores[r.id] === undefined);
    if (parsedResumes.length === 0) return;

    let isMounted = true;
    parsedResumes.forEach(async (r) => {
      try {
        const details = await apiClient.resumes.get(r.id);
        if (isMounted) {
          setAtsScores((prev) => ({
            ...prev,
            [r.id]: details.parsedResume?.atsScore ?? null,
          }));
        }
      } catch {
        if (isMounted) {
          setAtsScores((prev) => ({ ...prev, [r.id]: null }));
        }
      }
    });

    return () => {
      isMounted = false;
    };
  }, [resumes, atsScores]);

  const handleDelete = async () => {
    if (!deleteCandidate) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      await apiClient.resumes.delete(deleteCandidate.id);
      setDeleteCandidate(null);
      await queryClient.invalidateQueries({ queryKey: ['resumes'] });
      await queryClient.invalidateQueries({ queryKey: ['usage'] });

      if (onDeleteSuccess) {
        onDeleteSuccess();
      }
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete resume');
    } finally {
      setIsDeleting(false);
    }
  };

  const getStatusBadge = (status: ResumeSummary['status']) => {
    switch (status) {
      case 'UPLOAD_PENDING':
        return (
          <span
            data-testid="badge-uploading"
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200"
          >
            <Clock className="h-3 w-3 animate-spin text-blue-600" />
            Uploading
          </span>
        );
      case 'UPLOADED':
      case 'EXTRACTING':
      case 'NEEDS_OCR':
      case 'OCR_PROCESSING':
      case 'PROCESSING':
        return (
          <span
            data-testid="badge-processing"
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300"
          >
            <RefreshCw className="h-3 w-3 animate-spin text-amber-600" />
            Processing
          </span>
        );
      case 'PARSED':
        return (
          <span
            data-testid="badge-parsed"
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-300"
          >
            Parsed
          </span>
        );
      case 'FAILED':
        return (
          <span
            data-testid="badge-failed"
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-800 border border-red-300"
          >
            Failed
          </span>
        );
      default:
        return (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
            {status}
          </span>
        );
    }
  };

  if (isLoading) {
    return (
      <div className={`p-6 bg-card rounded-lg border border-border shadow-sm space-y-4 ${className || ''}`} data-testid="resumes-loading">
        <div className="flex items-center justify-between">
          <div className="h-5 w-32 bg-slate-200 rounded animate-pulse" />
          <div className="h-5 w-20 bg-slate-200 rounded animate-pulse" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-slate-100 rounded-md animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className={`p-6 bg-red-50 border border-red-200 rounded-lg text-red-900 ${className || ''}`} data-testid="resumes-error">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <span className="font-semibold text-sm">Failed to load resumes</span>
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
          {error instanceof Error ? error.message : 'Please check your connection and retry.'}
        </p>
      </div>
    );
  }

  return (
    <div className={`bg-card rounded-lg border border-border p-6 shadow-sm ${className || ''}`} data-testid="resume-list">
      <div className="flex items-center justify-between pb-4 border-b border-border mb-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Your Resumes</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {resumes.length === 1 ? '1 resume uploaded' : `${resumes.length} resumes uploaded`}
          </p>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh resumes list"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-border bg-slate-50 hover:bg-slate-100 text-foreground transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
          <span>{isFetching ? 'Refreshing...' : 'Refresh'}</span>
        </button>
      </div>

      {resumes.length === 0 ? (
        <div className="py-12 text-center" data-testid="resumes-empty">
          <div className="w-12 h-12 rounded-full bg-slate-100 text-muted-foreground flex items-center justify-center mx-auto mb-3">
            <FileText className="h-6 w-6 text-slate-400" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">No resumes uploaded yet</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Upload your resume above to extract structured skills, work history, and calculate your ATS format score.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-border text-muted-foreground font-medium">
                <th className="py-2.5 px-2 sm:px-3">Document</th>
                <th className="py-2.5 px-2 sm:px-3">Status</th>
                <th className="py-2.5 px-3 hidden sm:table-cell">ATS Score</th>
                <th className="py-2.5 px-3 hidden sm:table-cell">Size</th>
                <th className="py-2.5 px-3 hidden sm:table-cell">Uploaded</th>
                <th className="py-2.5 px-2 sm:px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {resumes.map((resume) => {
                const score = atsScores[resume.id] ?? resume.atsScore;

                return (
                  <tr key={resume.id} data-testid={`resume-row-${resume.id}`} className="hover:bg-slate-50/80 transition-colors stagger-item">
                    <td className="py-3 px-2 sm:px-3">
                      <div className="flex items-center gap-2 max-w-[7rem] sm:max-w-xs">
                        <FileText className="h-4 w-4 text-primary shrink-0" />
                        <span className="font-semibold text-foreground truncate block" title={resume.originalFilename}>
                          {resume.originalFilename}
                        </span>
                      </div>
                    </td>

                    <td className="py-3 px-2 sm:px-3">
                      {getStatusBadge(resume.status)}
                      {resume.status === 'PARSED' && score !== null && score !== undefined && (
                        <span className="sm:hidden block mt-1 text-[11px] font-semibold text-emerald-800">
                          ATS {score} / 100
                        </span>
                      )}
                    </td>

                    <td className="py-3 px-3 hidden sm:table-cell">
                      {resume.status === 'PARSED' ? (
                        score !== null && score !== undefined ? (
                          <span
                            data-testid={`ats-score-${resume.id}`}
                            className="inline-flex items-center gap-1 font-bold text-xs text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200"
                          >
                            <Award className="h-3 w-3 text-emerald-600" />
                            {score} / 100
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">Calculating...</span>
                        )
                      ) : (
                        <span className="text-muted-foreground text-[11px]">—</span>
                      )}
                    </td>

                    {/* Size and date are hidden on phones so the actions stay on screen */}
                    <td className="py-3 px-3 text-muted-foreground hidden sm:table-cell">
                      {formatBytes(resume.sizeBytes)}
                    </td>

                    <td className="py-3 px-3 text-muted-foreground hidden sm:table-cell">
                      {formatDate(resume.createdAt)}
                    </td>

                    <td className="py-3 px-2 sm:px-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {resume.status === 'PARSED' && (
                          <Link
                            href={`/analyze?resumeId=${resume.id}`}
                            data-testid={`analyze-resume-link-${resume.id}`}
                            aria-label={`Analyze ${resume.originalFilename}`}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-2 sm:py-1 rounded text-primary hover:text-white bg-emerald-50 hover:bg-primary border border-emerald-200 hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            <Sparkles className="h-4 w-4 sm:h-3 sm:w-3" aria-hidden="true" />
                            <span className="hidden sm:inline">Analyze</span>
                          </Link>
                        )}
                        <button
                          type="button"
                          onClick={() => setDeleteCandidate(resume)}
                          aria-label={`Delete resume ${resume.originalFilename}`}
                          data-testid={`delete-resume-${resume.id}`}
                          className="p-2.5 sm:p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteCandidate && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="bg-white rounded-lg border border-border shadow-xl max-w-md w-full p-6 space-y-4">
            <div>
              <h3 id="delete-dialog-title" className="text-base font-bold text-foreground">
                Delete Resume?
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                This action permanently deletes{' '}
                <span className="font-semibold text-foreground">{deleteCandidate.originalFilename}</span>,
                its parsed text, skills, and object storage bytes. This action cannot be undone.
              </p>
            </div>

            {deleteError && (
              <div role="alert" className="p-2.5 rounded bg-red-50 border border-red-200 text-red-800 text-xs">
                {deleteError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setDeleteCandidate(null)}
                disabled={isDeleting}
                className="px-3.5 py-1.5 rounded-md text-xs font-semibold text-foreground hover:bg-slate-100 transition-colors border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                data-testid="confirm-delete-button"
                className="px-3.5 py-1.5 rounded-md text-xs font-semibold bg-destructive text-white hover:bg-red-700 transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Delete Resume'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
