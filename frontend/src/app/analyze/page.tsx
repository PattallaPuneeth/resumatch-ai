'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  ResumeSummary,
  UserUsageResponse,
  ImprovementsResponse,
  AnalysisResult,
  MatchResult,
} from '@/lib/apiClient';
import { Navbar } from '@/components/Navbar';
import { UsagePanel } from '@/components/UsagePanel';
import { AnalyzeSelector, JDInputData, MatchHistoryItem } from '@/components/AnalyzeSelector';
import { ModeAResults } from '@/components/ModeAResults';
import { ModeBResults } from '@/components/ModeBResults';
import { JobSuggestionsList } from '@/components/JobSuggestionsList';
import {
  Sparkles,
  RefreshCw,
  AlertCircle,
  Clock,
  CheckCircle2,
  ChevronRight,
  Layers,
} from 'lucide-react';

function AnalyzePageContent() {
  const searchParams = useSearchParams();
  const queryResumeId = searchParams.get('resumeId');
  const queryClient = useQueryClient();

  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<'A' | 'B'>('A');

  // Operation States
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progressStep, setProgressStep] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Result States
  const [modeAResults, setModeAResults] = useState<ImprovementsResponse | null>(null);
  const [modeBAnalysis, setModeBAnalysis] = useState<AnalysisResult | null>(null);
  const [modeBMatch, setModeBMatch] = useState<MatchResult | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  // Client-tracked per-resume match history (stored by resumeId)
  const [resumeMatchHistory, setResumeMatchHistory] = useState<Record<string, MatchHistoryItem[]>>({});

  // Cancellation ref for leave-safe polling
  const isCancelledRef = useRef(false);

  useEffect(() => {
    isCancelledRef.current = false;
    return () => {
      isCancelledRef.current = true;
    };
  }, []);

  // 1. Fetch user's resumes
  const {
    data: resumesData,
    isLoading: isResumesLoading,
    refetch: refetchResumes,
  } = useQuery<{ resumes: ResumeSummary[] }>({
    queryKey: ['resumes'],
    queryFn: () => apiClient.resumes.list(),
  });

  const resumes = React.useMemo(() => resumesData?.resumes || [], [resumesData?.resumes]);

  // Auto-select resume from query param if available and parsed
  useEffect(() => {
    if (queryResumeId && resumes.length > 0) {
      const match = resumes.find((r) => r.id === queryResumeId);
      if (match && match.status === 'PARSED') {
        setSelectedResumeId(match.id);
      }
    } else if (!selectedResumeId && resumes.length > 0) {
      // Pick first PARSED resume by default
      const firstParsed = resumes.find((r) => r.status === 'PARSED');
      if (firstParsed) {
        setSelectedResumeId(firstParsed.id);
      }
    }
  }, [queryResumeId, resumes, selectedResumeId]);

  // 2. Fetch usage limits and meters
  const { data: usageData, refetch: refetchUsage } = useQuery<UserUsageResponse>({
    queryKey: ['usage'],
    queryFn: () => apiClient.usage.get(),
  });

  // Switch resume resets active results for previous resume
  const handleSelectResume = (id: string) => {
    setSelectedResumeId(id);
    setModeAResults(null);
    setModeBAnalysis(null);
    setModeBMatch(null);
    setCurrentJobId(null);
    setErrorMessage(null);
  };

  // Helper: Sleep with cancellation check
  const sleep = (ms: number): Promise<void> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, ms);
      // Clean up if unmounted
      if (isCancelledRef.current) {
        clearTimeout(timer);
        resolve();
      }
    });
  };

  // -------------------------------------------------------------------------
  // RUN MODE A: Resume Only Improvements
  // -------------------------------------------------------------------------
  const handleRunModeA = async () => {
    if (!selectedResumeId) return;

    setIsSubmitting(true);
    setProgressStep('Running ATS formatting audit & ML role analysis...');
    setErrorMessage(null);
    setModeAResults(null);

    try {
      const res = await apiClient.resumes.getImprovements(selectedResumeId);
      if (isCancelledRef.current) return;

      setModeAResults(res);
      await refetchUsage();
    } catch (err: any) {
      if (isCancelledRef.current) return;
      setErrorMessage(
        err.detail || err.message || 'Failed to complete resume analysis. Please try again.'
      );
    } finally {
      if (!isCancelledRef.current) {
        setIsSubmitting(false);
        setProgressStep(null);
      }
    }
  };

  // -------------------------------------------------------------------------
  // RUN MODE B: Resume + Job Description Matching & Analysis
  // -------------------------------------------------------------------------
  const handleRunModeB = async (jdData: JDInputData) => {
    if (!selectedResumeId) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    setModeBAnalysis(null);
    setModeBMatch(null);

    try {
      // 1. Create Job record
      setProgressStep('Step 1/3: Creating job description record...');
      const createdJob = await apiClient.jobs.create(jdData);
      if (isCancelledRef.current) return;

      const jobId = createdJob.id;
      setCurrentJobId(jobId);

      // 2. Enqueue Match Scoring
      setProgressStep('Step 2/3: Enqueueing hybrid retrieval & cross-encoder matching...');
      await apiClient.jobs.match(jobId, selectedResumeId);
      if (isCancelledRef.current) return;

      // 3. Poll for Match result with bounded exponential backoff
      let pollDelay = 1500;
      const maxMatchWaitMs = 35000;
      const matchStart = Date.now();
      let matchResult: MatchResult | null = null;

      while (Date.now() - matchStart < maxMatchWaitMs) {
        if (isCancelledRef.current) return;
        await sleep(pollDelay);
        if (isCancelledRef.current) return;

        try {
          matchResult = await apiClient.jobs.getMatch(jobId, selectedResumeId);
          if (matchResult) break;
        } catch (pollErr: any) {
          // 404 indicates job still in queue/processing
          if (pollErr.status === 404) {
            pollDelay = Math.min(pollDelay * 1.5, 6000);
            setProgressStep(`Step 2/3: Scoring hybrid match (${Math.round((Date.now() - matchStart) / 1000)}s)...`);
            continue;
          }
          throw pollErr;
        }
      }

      if (!matchResult) {
        throw new Error('Match scoring timed out. The worker queue may be busy. Please check back shortly.');
      }

      setModeBMatch(matchResult);

      // 4. Enqueue Structured Analysis (consumes analyses meter)
      setProgressStep('Step 3/3: Enqueueing structured skill analysis...');
      await apiClient.jobs.createAnalysis(jobId, selectedResumeId);
      if (isCancelledRef.current) return;

      // 5. Poll for Analysis result with bounded exponential backoff
      pollDelay = 1500;
      const maxAnalysisWaitMs = 35000;
      const analysisStart = Date.now();
      let analysisResult: AnalysisResult | null = null;

      while (Date.now() - analysisStart < maxAnalysisWaitMs) {
        if (isCancelledRef.current) return;
        await sleep(pollDelay);
        if (isCancelledRef.current) return;

        try {
          analysisResult = await apiClient.jobs.getAnalysis(jobId, selectedResumeId);
          if (analysisResult) break;
        } catch (pollErr: any) {
          if (pollErr.status === 404) {
            pollDelay = Math.min(pollDelay * 1.5, 6000);
            setProgressStep(`Step 3/3: Generating analysis findings (${Math.round((Date.now() - analysisStart) / 1000)}s)...`);
            continue;
          }
          throw pollErr;
        }
      }

      if (!analysisResult) {
        throw new Error('Structured analysis timed out. The worker queue may be busy. Please retry.');
      }

      setModeBAnalysis(analysisResult);

      // 6. Record match in client history list
      const historyItem: MatchHistoryItem = {
        jobId,
        title: jdData.title,
        company: jdData.company,
        matchScore: matchResult.finalScore,
        date: new Date().toLocaleDateString(),
      };

      setResumeMatchHistory((prev) => {
        const existing = prev[selectedResumeId] || [];
        // Avoid duplicate by jobId
        const filtered = existing.filter((item) => item.jobId !== jobId);
        return {
          ...prev,
          [selectedResumeId]: [historyItem, ...filtered],
        };
      });

      // 7. Refetch usage
      await refetchUsage();
    } catch (err: any) {
      if (isCancelledRef.current) return;
      setErrorMessage(
        err.detail || err.message || 'Failed to complete job description analysis. Please retry.'
      );
    } finally {
      if (!isCancelledRef.current) {
        setIsSubmitting(false);
        setProgressStep(null);
      }
    }
  };

  // Select an existing match from history to display its results immediately
  const handleSelectHistoryMatch = async (item: MatchHistoryItem) => {
    if (!selectedResumeId) return;

    setIsSubmitting(true);
    setProgressStep(`Loading saved match for ${item.title}...`);
    setErrorMessage(null);
    setCurrentJobId(item.jobId);

    try {
      const match = await apiClient.jobs.getMatch(item.jobId, selectedResumeId);
      const analysis = await apiClient.jobs.getAnalysis(item.jobId, selectedResumeId);

      setModeBMatch(match);
      setModeBAnalysis(analysis);
    } catch (err: any) {
      setErrorMessage(
        err.detail || err.message || 'Failed to load historical match details.'
      );
    } finally {
      setIsSubmitting(false);
      setProgressStep(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Navbar />

      <main className="flex-1 container mx-auto px-4 sm:px-6 py-8 max-w-5xl space-y-8">
        {/* Page Header */}
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Analyze Resume & Target Matching
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Evaluate ATS readiness, run deterministic hybrid matching against target job descriptions,
            and explore intelligent job suggestions.
          </p>
        </header>

        {/* Reused 8A Usage Panel */}
        <UsagePanel />

        {/* Analyze Selector (Resume Picker, Mode Switch, JD Paste, History) */}
        <AnalyzeSelector
          resumes={resumes}
          selectedResumeId={selectedResumeId}
          onSelectResume={handleSelectResume}
          selectedMode={selectedMode}
          onSelectMode={(mode) => {
            setSelectedMode(mode);
            setErrorMessage(null);
          }}
          onSubmitModeA={handleRunModeA}
          onSubmitModeB={handleRunModeB}
          isSubmitting={isSubmitting}
          historyMatches={selectedResumeId ? resumeMatchHistory[selectedResumeId] || [] : []}
          onSelectHistoryMatch={handleSelectHistoryMatch}
          usageData={usageData}
        />

        {/* In-Flight Progress State */}
        {isSubmitting && (
          <div
            data-testid="analysis-progress-banner"
            role="status"
            className="p-5 bg-white rounded-lg border border-primary/30 shadow-xs flex items-center gap-3 text-xs text-foreground"
          >
            <RefreshCw className="h-5 w-5 text-primary animate-spin shrink-0" aria-hidden="true" />
            <div className="space-y-0.5">
              <p className="font-bold text-sm text-primary">Analysis In Progress</p>
              <p className="text-muted-foreground">{progressStep || 'Processing your request...'}</p>
            </div>
          </div>
        )}

        {/* Global Error Banner */}
        {errorMessage && (
          <div
            role="alert"
            data-testid="analyze-error-alert"
            className="p-4 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900 flex items-start gap-2.5"
          >
            <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-semibold">Analysis Failed</p>
              <p>{errorMessage}</p>
            </div>
          </div>
        )}

        {/* Mode A Results */}
        {selectedMode === 'A' && modeAResults && (
          <div className="space-y-8 animate-in fade-in duration-300">
            <ModeAResults data={modeAResults} />

            {/* Suggestions Panel for Mode A */}
            {selectedResumeId && (
              <JobSuggestionsList
                resumeId={selectedResumeId}
                usageData={usageData}
                onQuotaConsumed={refetchUsage}
              />
            )}
          </div>
        )}

        {/* Mode B Results */}
        {selectedMode === 'B' && modeBAnalysis && (
          <div className="space-y-8 animate-in fade-in duration-300">
            <ModeBResults analysis={modeBAnalysis} matchResult={modeBMatch} />

            {/* Suggestions Panel for Mode B */}
            {selectedResumeId && (
              <JobSuggestionsList
                resumeId={selectedResumeId}
                targetJobId={currentJobId}
                usageData={usageData}
                onQuotaConsumed={refetchUsage}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function AnalyzePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin text-primary" />
            <span>Loading analyze workspace...</span>
          </div>
        </div>
      }
    >
      <AnalyzePageContent />
    </Suspense>
  );
}
