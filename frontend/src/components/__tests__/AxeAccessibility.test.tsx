import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import HomePage from '../../app/page';
import NotFound from '../../app/not-found';
import GlobalError from '../../app/error';
import LoginPage from '../../app/login/page';
import SignupPage from '../../app/signup/page';
import DashboardPage from '../../app/dashboard/page';
import AccountPage from '../../app/account/page';
import { BulletEditor } from '../BulletEditor';
import { MatchHistoryList } from '../MatchHistoryList';
import { ModeAResults } from '../ModeAResults';
import { ModeBResults } from '../ModeBResults';

// Mock apiClient and AuthContext
vi.mock('../../lib/apiClient', () => ({
  apiClient: {
    resumes: {
      list: vi.fn().mockResolvedValue({ resumes: [] }),
      get: vi.fn().mockResolvedValue({ id: '1', originalFilename: 'resume.pdf' }),
      getMatches: vi.fn().mockResolvedValue({ matches: [], total: 0 }),
    },
    usage: {
      get: vi.fn().mockResolvedValue({
        plan: 'demo',
        planName: 'Demo Plan',
        meters: {
          analyses: { used: 0, limit: 10, percent: 0 },
          job_suggestions: { used: 0, limit: 5, percent: 0 },
          resume_storage_bytes: { used: 1000, limit: 5000000, percent: 0.02 },
        },
        alerts: [],
      }),
    },
    rewriter: {
      rewriteBullet: vi.fn(),
    },
    auth: {
      deleteAccount: vi.fn(),
      login: vi.fn(),
      register: vi.fn(),
    },
  },
  ApiProblemError: class extends Error {
    status: number;
    detail?: string;
    constructor(status: number, data: any) {
      super(data.detail);
      this.status = status;
      this.detail = data.detail;
    }
  },
}));

vi.mock('../../lib/authContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'testuser' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

async function runAxe(container: HTMLElement) {
  // In jsdom environment, color-contrast checks are inconclusive because no layout/canvas engine exists
  // We test all contrast rules programmatically with exact luminance math in contrast.test.ts!
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
    },
  });
  return results.violations;
}

describe('Automated Axe Accessibility Suite (Part 3.1 - All Main Screens)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  const renderWithClient = (ui: React.ReactElement) => {
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  };

  it('passes axe audit on Home / Landing page', async () => {
    const { container } = renderWithClient(<HomePage />);
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on Login screen', async () => {
    const { container } = renderWithClient(<LoginPage />);
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on Signup screen', async () => {
    const { container } = renderWithClient(<SignupPage />);
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on Dashboard screen', async () => {
    const { container } = renderWithClient(<DashboardPage />);
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on Account screen', async () => {
    const { container } = renderWithClient(<AccountPage />);
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on 404 Not Found screen', async () => {
    const { container } = renderWithClient(<NotFound />);
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on Global Error Boundary screen', async () => {
    const { container } = renderWithClient(
      <GlobalError error={new Error('Test error')} reset={() => {}} />
    );
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on BulletEditor primitive', async () => {
    const { container } = renderWithClient(
      <BulletEditor
        resumeId="11111111-1111-1111-1111-111111111111"
        bullets={['Engineered high-throughput streaming systems.']}
        analysesMeter={{ used: 2, limit: 10 }}
      />
    );
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on MatchHistoryList primitive', async () => {
    let containerEl: HTMLElement;
    await act(async () => {
      const { container } = renderWithClient(
        <MatchHistoryList
          resumeId="11111111-1111-1111-1111-111111111111"
          onSelectMatch={() => {}}
        />
      );
      containerEl = container;
    });
    const violations = await runAxe(containerEl!);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on ModeAResults screen', async () => {
    const mockImprovements = {
      resumeId: '1',
      atsScore: 90,
      subScores: {
        formatCompliance: 92,
        keywordOptimization: 88,
        readability: 90,
        sectionStructure: 90,
      },
      contentFindings: [
        {
          id: 'cf-1',
          severity: 'medium' as const,
          category: 'quantification',
          message: 'Include quantifiable impact in senior engineering roles.',
          evidenceSpan: { startChar: 0, endChar: 20, quote: 'Engineered systems' },
        },
      ],
      suggestedRoles: [
        {
          title: 'Senior Backend Engineer',
          similarityScore: 94,
          rationale: 'Strong backend skills in Node.js and PostgreSQL.',
          matchedSkills: ['TypeScript', 'PostgreSQL'],
        },
      ],
      llmStatus: 'UNAVAILABLE' as const,
    };

    const { container } = renderWithClient(<ModeAResults data={mockImprovements as any} />);
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });

  it('passes axe audit on ModeBResults screen', async () => {
    const mockAnalysis = {
      id: 'analysis-1',
      score: 93.47,
      llmStatus: 'UNAVAILABLE' as const,
      result: {
        match_score: 93.47,
        ats_score: 88,
        verdict_band: 'strong',
        strengths: [{ claim: 'Strong TypeScript', evidence: 'TypeScript developer' }],
        gaps: [],
        prioritized_improvements: [],
        matched_skills: ['TypeScript', 'Node.js'],
        missing_skills: [],
      },
      createdAt: '2026-10-26T12:00:00Z',
      updatedAt: '2026-10-26T12:00:00Z',
    };

    const mockMatch = {
      id: 'match-1',
      resumeId: '1',
      jobId: 'job-1',
      score: 93.47,
      subScores: {
        lexicalScore: 0.89,
        semanticScore: 0.94,
        crossEncoderScore: 0.95,
        skillCoverageScore: 0.92,
      },
      matchedSkills: ['TypeScript', 'Node.js'],
      missingSkills: [],
      status: 'COMPLETED',
      createdAt: '2026-10-26T12:00:00Z',
    };

    const { container } = renderWithClient(
      <ModeBResults analysis={mockAnalysis as any} matchResult={mockMatch as any} />
    );
    const violations = await runAxe(container);
    expect(violations).toEqual([]);
  });
});
