import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnalyzeSelector } from '../AnalyzeSelector';
import { ModeAResults } from '../ModeAResults';
import { ModeBResults } from '../ModeBResults';
import { MatchVisualizer } from '../MatchVisualizer';
import { JobSuggestionsList } from '../JobSuggestionsList';
import {
  apiClient,
  ResumeSummary,
  ImprovementsResponse,
  AnalysisResult,
  MatchResult,
  JobSuggestionsResponse,
  UserUsageResponse,
  normalizeAnalysisData,
} from '@/lib/apiClient';

describe('Phase 8B: Analyze Flow & Results Components', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  const renderWithClient = (ui: React.ReactElement) => {
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  };

  const sampleResumes: ResumeSummary[] = [
    {
      id: 'res-parsed-1',
      originalFilename: 'senior_backend.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 250000,
      status: 'PARSED',
      createdAt: '2026-10-26T10:00:00Z',
      updatedAt: '2026-10-26T10:00:00Z',
      atsScore: 84.5,
    },
    {
      id: 'res-processing-2',
      originalFilename: 'in_progress.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 150000,
      status: 'PROCESSING',
      createdAt: '2026-10-26T10:05:00Z',
      updatedAt: '2026-10-26T10:05:00Z',
    },
  ];

  // =========================================================================
  // 1. ANALYZE SELECTOR & JD VALIDATION TESTS
  // =========================================================================
  describe('AnalyzeSelector Component', () => {
    it('disables non-PARSED resumes in dropdown and shows guidance', () => {
      renderWithClient(
        <AnalyzeSelector
          resumes={sampleResumes}
          selectedResumeId="res-parsed-1"
          onSelectResume={vi.fn()}
          selectedMode="A"
          onSelectMode={vi.fn()}
          onSubmitModeA={vi.fn()}
          onSubmitModeB={vi.fn()}
          isSubmitting={false}
          historyMatches={[]}
        />
      );

      const dropdown = screen.getByTestId('resume-select-dropdown') as HTMLSelectElement;
      expect(dropdown).toBeDefined();

      const options = screen.getAllByRole('option');
      const processingOption = options.find((o) => o.textContent?.includes('in_progress.docx'));
      expect(processingOption?.hasAttribute('disabled')).toBe(true);
    });

    it('allows switching between Mode A (Resume only) and Mode B (Resume + JD)', () => {
      const onSelectMode = vi.fn();
      renderWithClient(
        <AnalyzeSelector
          resumes={sampleResumes}
          selectedResumeId="res-parsed-1"
          onSelectResume={vi.fn()}
          selectedMode="A"
          onSelectMode={onSelectMode}
          onSubmitModeA={vi.fn()}
          onSubmitModeB={vi.fn()}
          isSubmitting={false}
          historyMatches={[]}
        />
      );

      const modeBBtn = screen.getByTestId('mode-b-btn');
      fireEvent.click(modeBBtn);
      expect(onSelectMode).toHaveBeenCalledWith('B');
    });

    it('enforces JD validation rules: title, company, min 20 chars for description', () => {
      const onSubmitModeB = vi.fn();
      renderWithClient(
        <AnalyzeSelector
          resumes={sampleResumes}
          selectedResumeId="res-parsed-1"
          onSelectResume={vi.fn()}
          selectedMode="B"
          onSelectMode={vi.fn()}
          onSubmitModeA={vi.fn()}
          onSubmitModeB={onSubmitModeB}
          isSubmitting={false}
          historyMatches={[]}
        />
      );

      const form = screen.getByTestId('jd-input-form');

      // 1. Submit with empty fields
      fireEvent.submit(form);
      expect(onSubmitModeB).not.toHaveBeenCalled();
      expect(screen.getByTestId('jd-validation-error').textContent).toMatch(/Job Title is required/i);

      // 2. Fill Title, submit again
      fireEvent.change(screen.getByLabelText(/Job Title/i), { target: { value: 'Staff Engineer' } });
      fireEvent.submit(form);
      expect(onSubmitModeB).not.toHaveBeenCalled();
      expect(screen.getByTestId('jd-validation-error').textContent).toMatch(/Company Name is required/i);

      // 3. Fill Company, short description (<20 chars)
      fireEvent.change(screen.getByLabelText(/Company Name/i), { target: { value: 'Acme Cloud' } });
      fireEvent.change(screen.getByLabelText(/Job Description Text/i), { target: { value: 'Short desc' } });
      fireEvent.submit(form);
      expect(onSubmitModeB).not.toHaveBeenCalled();
      expect(screen.getByTestId('jd-validation-error').textContent).toMatch(/at least 20 characters/i);

      // 4. Fill valid description (>20 chars)
      const validDesc = 'We are seeking a senior distributed systems engineer with deep Go and Kubernetes expertise.';
      fireEvent.change(screen.getByLabelText(/Job Description Text/i), { target: { value: validDesc } });
      fireEvent.submit(form);
      expect(onSubmitModeB).toHaveBeenCalledWith({
        title: 'Staff Engineer',
        company: 'Acme Cloud',
        rawDescription: validDesc,
        location: undefined,
        jobType: undefined,
      });
    });

    it('renders JD match history and triggers onSelectHistoryMatch when clicked', () => {
      const onSelectHistoryMatch = vi.fn();
      const mockHistory = [
        {
          jobId: 'job-1',
          title: 'Senior DevOps Architect',
          company: 'CloudFlow',
          matchScore: 91.2,
          date: '10/26/2026',
        },
      ];

      renderWithClient(
        <AnalyzeSelector
          resumes={sampleResumes}
          selectedResumeId="res-parsed-1"
          onSelectResume={vi.fn()}
          selectedMode="B"
          onSelectMode={vi.fn()}
          onSubmitModeA={vi.fn()}
          onSubmitModeB={vi.fn()}
          isSubmitting={false}
          historyMatches={mockHistory}
          onSelectHistoryMatch={onSelectHistoryMatch}
        />
      );

      expect(screen.getByTestId('jd-history-section')).toBeDefined();
      const itemBtn = screen.getByTestId('history-match-item-0');
      expect(itemBtn.textContent).toContain('Senior DevOps Architect');
      expect(itemBtn.textContent).toContain('91.2%');

      fireEvent.click(itemBtn);
      expect(onSelectHistoryMatch).toHaveBeenCalledWith(mockHistory[0]);
    });
  });

  // =========================================================================
  // 2. MODE A (RESUME ONLY) & EXACT ATS SCORE DISPLAY TESTS
  // =========================================================================
  describe('ModeAResults Component', () => {
    const mockModeAData: ImprovementsResponse = {
      atsScore: 78.4,
      atsFixes: [
        {
          hazardCode: 'TWO_COLUMN_LAYOUT',
          severity: 'HIGH',
          issue: 'Multi-column layout detected',
          recommendation: 'Convert to a clean single-column layout for ATS parser stability.',
          priority: 1,
        },
      ],
      contentFindings: [
        {
          type: 'NO_METRIC_OR_NUMBER',
          severity: 'MEDIUM',
          message: 'Achievement bullet lacks quantifiable metrics',
          startChar: 140,
          endChar: 210,
          quote: 'Optimized internal databases and reduced application load times.',
        },
      ],
      suggestedRoles: [
        {
          title: 'Staff Backend Architect',
          similarityScore: 0.88,
          matchedSkills: ['python', 'postgresql', 'docker'],
          missingSkills: ['kubernetes'],
        },
      ],
      explanation: null,
      llmStatus: 'UNAVAILABLE',
    };

    it('renders ATS score verbatim without rounding or alteration (Rule 4)', () => {
      render(<ModeAResults data={mockModeAData} />);

      const scoreEl = screen.getByTestId('mode-a-ats-score');
      // Must contain exact string "78.4"
      expect(scoreEl.textContent).toContain('78.4');
      expect(screen.getByTestId('mode-a-score-band').textContent).toContain('Moderate ATS Compatibility');
    });

    it('renders neutral notice when llmStatus is UNAVAILABLE without error styling', () => {
      render(<ModeAResults data={mockModeAData} />);

      const notice = screen.getByTestId('llm-unavailable-notice');
      expect(notice).toBeDefined();
      expect(notice.textContent).toMatch(/AI explanation unavailable, showing deterministic results/i);
    });

    it('renders ATS fixes, character span content findings, and suggested roles', () => {
      render(<ModeAResults data={mockModeAData} />);

      expect(screen.getByTestId('ats-fix-item-0').textContent).toContain('TWO_COLUMN_LAYOUT');
      expect(screen.getByTestId('content-finding-0').textContent).toContain('chars 140–210');
      expect(screen.getByTestId('content-finding-0').textContent).toContain(
        'Optimized internal databases and reduced application load times.'
      );
      expect(screen.getByTestId('suggested-role-0').textContent).toContain('Staff Backend Architect');
      expect(screen.getByTestId('role-score-0').textContent).toContain('0.88');
    });
  });

  // =========================================================================
  // 3. MODE B (RESUME + JD) & MATCH VISUALIZER TESTS
  // =========================================================================
  describe('ModeBResults & MatchVisualizer Components', () => {
    const mockMatchResult: MatchResult = {
      id: 'match-1',
      resumeId: 'res-1',
      jobId: 'job-1',
      bm25Score: 0.68,
      vectorScore: 0.84,
      rrfScore: 0.031,
      crossEncoderScore: 0.89,
      finalScore: 82.7,
      explanation: {
        skillGap: {
          matched: ['python', 'fastapi'],
          missing: ['kubernetes', 'grpc'],
          partial: ['docker'],
          coverage_ratio: 0.5,
        },
        scoringBreakdown: {
          bm25TopScore: 0.68,
          vectorSimilarity: 0.84,
          rrfScore: 0.031,
          crossEncoderScore: 0.89,
          skillCoverage: 0.5,
        },
      },
      createdAt: '2026-10-26T12:00:00Z',
      updatedAt: '2026-10-26T12:00:00Z',
    };

    const mockAnalysisResult: AnalysisResult = {
      id: 'analysis-1',
      resumeId: 'res-1',
      jobId: 'job-1',
      status: 'COMPLETED',
      llmStatus: 'UNAVAILABLE',
      score: 82.7,
      result: {
        summary: 'Deterministic scoring completed. LLM multi-tier analysis is currently unavailable.',
        strengths: [
          {
            claim: 'Demonstrated extensive backend API design with Python and FastAPI.',
            evidence: 'Architected high-throughput REST APIs handling 5,000 req/sec in FastAPI.',
          },
        ],
        gaps: [
          {
            gap: 'No evidence of production Kubernetes cluster administration.',
            severity: 'HIGH',
          },
        ],
        prioritized_improvements: [
          {
            priority: 1,
            action: 'Add specific Kubernetes container orchestration bullet points to experience section.',
            evidence: 'Containerized microservices deployed using Docker.',
          },
        ],
        match_score: 82.7,
        ats_score: 85.0,
        verdict_band: 'strong',
        matched_skills: ['python', 'fastapi'],
        missing_skills: ['kubernetes', 'grpc'],
        partial_skills: ['docker'],
      },
      createdAt: '2026-10-26T12:00:00Z',
      updatedAt: '2026-10-26T12:00:00Z',
    };

    it('renders Mode B overall match score and ATS score verbatim (Rule 4)', () => {
      render(<ModeBResults analysis={mockAnalysisResult} matchResult={mockMatchResult} />);

      const matchScoreEl = screen.getByTestId('mode-b-match-score');
      expect(matchScoreEl.textContent).toContain('82.7');

      const atsScoreEl = screen.getByTestId('mode-b-ats-score');
      expect(atsScoreEl.textContent).toContain('85');

      expect(screen.getByTestId('mode-b-verdict-band').textContent).toContain('Strong Match');
    });

    it('shows the verdict from the real camelCase API payload, not a default', () => {
      // Shape returned by GET /v1/jobs/:id/analysis/:resumeId (captured from the live backend)
      const apiResult = {
        summary: 'Candidate shows relevant experience for the role.',
        strengths: [],
        gaps: [],
        prioritizedImprovements: [{ priority: 1, action: 'Add a Kafka project.' }],
        matchScore: 97.12,
        atsScore: 70,
        verdictBand: 'strong',
        matchedSkills: ['docker', 'postgresql'],
        missingSkills: [],
        partialSkills: [],
      };
      render(
        <ModeBResults
          analysis={{ ...mockAnalysisResult, score: 97.12, result: normalizeAnalysisData(apiResult) }}
          matchResult={mockMatchResult}
        />
      );

      expect(screen.getByTestId('mode-b-verdict-band').textContent).toContain('Strong Match');
      expect(screen.getByTestId('mode-b-ats-score').textContent).toContain('70');
      expect(screen.getByTestId('improvement-item-0').textContent).toContain('Add a Kafka project.');
    });

    it('works out the verdict from the score when a result has none', () => {
      const result = normalizeAnalysisData({ matchScore: 30 });
      render(
        <ModeBResults analysis={{ ...mockAnalysisResult, score: 30, result }} matchResult={mockMatchResult} />
      );
      expect(screen.getByTestId('mode-b-verdict-band').textContent).toContain('Low Match');
    });

    it('renders MatchVisualizer with exact sub-scores and missing keywords', () => {
      render(<MatchVisualizer matchResult={mockMatchResult} />);

      expect(screen.getByTestId('match-visualizer')).toBeDefined();
      expect(screen.getByTestId('visualizer-final-score').textContent).toContain('82.7');

      // Check sub-scores
      expect(screen.getByTestId('score-bar-bm25').textContent).toContain('0.68');
      expect(screen.getByTestId('score-bar-vector').textContent).toContain('0.84');
      expect(screen.getByTestId('score-bar-cross-encoder').textContent).toContain('0.89');

      // Check missing keywords list
      const missingList = screen.getByTestId('missing-keywords-list');
      expect(missingList.textContent).toContain('kubernetes');
      expect(missingList.textContent).toContain('grpc');
    });

    it('handles visualizer gracefully when sub-scores are omitted or missing in API response', () => {
      const minimalMatch: MatchResult = {
        id: 'match-min',
        resumeId: 'res-1',
        jobId: 'job-1',
        bm25Score: 0,
        vectorScore: 0,
        rrfScore: 0,
        crossEncoderScore: 0,
        finalScore: 70.0,
        explanation: null,
        createdAt: '2026-10-26T12:00:00Z',
        updatedAt: '2026-10-26T12:00:00Z',
      };

      render(<MatchVisualizer matchResult={minimalMatch} />);
      expect(screen.getByTestId('visualizer-final-score').textContent).toContain('70');
    });

    it('renders verified strength quotes and prioritized fixes', () => {
      render(<ModeBResults analysis={mockAnalysisResult} matchResult={mockMatchResult} />);

      expect(screen.getByTestId('strength-item-0').textContent).toContain(
        'Demonstrated extensive backend API design with Python and FastAPI.'
      );
      expect(screen.getByTestId('strength-item-0').textContent).toContain(
        'Architected high-throughput REST APIs handling 5,000 req/sec in FastAPI.'
      );

      expect(screen.getByTestId('improvement-item-0').textContent).toContain(
        'Add specific Kubernetes container orchestration bullet points'
      );
    });
  });

  // =========================================================================
  // 4. JOB SUGGESTIONS UI & SAMPLE BADGE TESTS
  // =========================================================================
  describe('JobSuggestionsList Component', () => {
    const mockSampleSuggestions: JobSuggestionsResponse = {
      resumeId: 'res-1',
      totalFound: 1,
      source: 'mock',
      isSample: true,
      suggestions: [
        {
          title: 'Senior Distributed Systems Architect',
          company: 'Acme Cloud Corp',
          location: 'Remote',
          sourceUrl: 'https://boards.greenhouse.io/acme/jobs/101',
          matchScore: 94.6,
          matchedSkills: ['python', 'docker', 'postgresql'],
          missingSkills: ['raft'],
          fetchedAt: '2026-10-26T12:00:00Z',
        },
      ],
    };

    const mockLiveSuggestions: JobSuggestionsResponse = {
      ...mockSampleSuggestions,
      source: 'firecrawl',
      isSample: false,
    };

    const mockUsage: UserUsageResponse = {
      plan: 'demo',
      planName: 'Demo Plan',
      period: 'monthly',
      periodStart: '2026-10-01T00:00:00Z',
      resetAt: '2026-11-01T00:00:00Z',
      meters: {
        analyses: {
          used: 2,
          limit: 10,
          unlimited: false,
          percent: 20,
          activeThreshold: null,
          crossedThresholds: [],
          blocked: false,
          periodStart: null,
          resetAt: null,
        },
        job_suggestions: {
          used: 3,
          limit: 5,
          unlimited: false,
          percent: 60,
          activeThreshold: 50,
          crossedThresholds: [50],
          blocked: false,
          periodStart: null,
          resetAt: null,
        },
        resume_storage_bytes: {
          used: 1000000,
          limit: 5242880,
          unlimited: false,
          percent: 19,
          activeThreshold: null,
          crossedThresholds: [],
          blocked: false,
          periodStart: null,
          resetAt: null,
        },
      },
    };

    it('shows remaining quota note before running', () => {
      render(
        <JobSuggestionsList
          resumeId="res-1"
          usageData={mockUsage}
        />
      );

      const quotaNote = screen.getByTestId('suggestions-quota-note');
      expect(quotaNote.textContent).toContain('2 remaining');
    });

    it('renders prominent Sample data badge and explanation ONLY when isSample is true', async () => {
      vi.spyOn(apiClient.resumes, 'getSuggestions').mockResolvedValue(mockSampleSuggestions);

      render(
        <JobSuggestionsList
          resumeId="res-1"
          usageData={mockUsage}
        />
      );

      const fetchBtn = screen.getByTestId('fetch-suggestions-btn');
      fireEvent.click(fetchBtn);

      await waitFor(() => {
        expect(screen.getByTestId('sample-data-badge')).toBeDefined();
      });

      expect(screen.getByTestId('sample-data-badge-banner').textContent).toMatch(
        /Demonstration Job Listings/i
      );
      expect(screen.getByTestId('sample-data-badge-banner').textContent).toMatch(
        /synthetic demo job listings formatted from ATS fixtures/i
      );

      // Verify exact score verbatim (Rule 4)
      const scoreEl = screen.getByTestId('suggestion-score-0');
      expect(scoreEl.textContent).toContain('94.6%');
    });

    it('does NOT render Sample data badge when isSample is false', async () => {
      vi.spyOn(apiClient.resumes, 'getSuggestions').mockResolvedValue(mockLiveSuggestions);

      render(
        <JobSuggestionsList
          resumeId="res-1"
          usageData={mockUsage}
        />
      );

      fireEvent.click(screen.getByTestId('fetch-suggestions-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('suggestions-grid')).toBeDefined();
      });

      expect(screen.queryByTestId('sample-data-badge')).toBeNull();
    });

    it('handles empty results displaying API message', async () => {
      vi.spyOn(apiClient.resumes, 'getSuggestions').mockResolvedValue({
        resumeId: 'res-1',
        totalFound: 0,
        source: 'mock',
        isSample: true,
        suggestions: [],
        message: 'No matching job suggestions found for the provided criteria.',
      });

      render(
        <JobSuggestionsList
          resumeId="res-1"
          usageData={mockUsage}
        />
      );

      fireEvent.click(screen.getByTestId('fetch-suggestions-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('suggestions-empty-state')).toBeDefined();
      });

      expect(screen.getByTestId('suggestions-empty-state').textContent).toContain(
        'No matching job suggestions found for the provided criteria.'
      );
    });

    it('handles HTTP 429 quota limit exceeded gracefully', async () => {
      const err = new Error('Quota exceeded') as any;
      err.status = 429;
      err.detail = 'Job suggestions monthly quota reached. Upgrade or wait until reset.';

      vi.spyOn(apiClient.resumes, 'getSuggestions').mockRejectedValue(err);

      render(
        <JobSuggestionsList
          resumeId="res-1"
          usageData={mockUsage}
        />
      );

      fireEvent.click(screen.getByTestId('fetch-suggestions-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('suggestions-error-banner')).toBeDefined();
      });

      expect(screen.getByTestId('suggestions-error-banner').textContent).toMatch(/Quota Exceeded/i);
    });

    it('handles HTTP 500 error showing refunded notice and retry button', async () => {
      const err = new Error('Downstream server error') as any;
      err.status = 502;
      err.detail = 'Job search service encountered a temporary error.';

      vi.spyOn(apiClient.resumes, 'getSuggestions').mockRejectedValue(err);

      render(
        <JobSuggestionsList
          resumeId="res-1"
          usageData={mockUsage}
        />
      );

      fireEvent.click(screen.getByTestId('fetch-suggestions-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('suggestions-error-banner')).toBeDefined();
      });

      expect(screen.getByTestId('suggestions-error-banner').textContent).toMatch(/quota was refunded/i);
    });
  });
});
