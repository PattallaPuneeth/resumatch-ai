import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MatchHistoryList } from '../MatchHistoryList';
import { apiClient, ApiProblemError } from '../../lib/apiClient';

vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/apiClient')>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      resumes: {
        ...actual.apiClient.resumes,
        getMatches: vi.fn(),
      },
    },
  };
});

describe('MatchHistoryList Component', () => {
  const resumeId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading skeleton and then populated match cards', async () => {
    vi.mocked(apiClient.resumes.getMatches).mockResolvedValueOnce({
      matches: [
        {
          id: 'm-1',
          resumeId,
          jobId: 'job-101',
          job: {
            id: 'job-101',
            title: 'Senior Distributed Systems Engineer',
            company: 'Cloudflare',
            location: 'Remote',
          },
          matchScore: 91.8,
          subScores: {
            bm25Score: 0.81,
            vectorScore: 0.79,
            rrfScore: 0.038,
            crossEncoderScore: 91.8,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          analysis: {
            status: 'COMPLETED',
            llmStatus: 'SUCCESS',
            score: 91.8,
          },
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    });

    const onSelectMatch = vi.fn();

    render(
      <MatchHistoryList
        resumeId={resumeId}
        onSelectMatch={onSelectMatch}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Senior Distributed Systems Engineer')).toBeDefined();
    });

    expect(screen.getByText(/Cloudflare/)).toBeDefined();
    expect(screen.getByText('91.8%')).toBeDefined();
    expect(screen.getByText('AI Analyzed')).toBeDefined();

    const viewBtn = screen.getByRole('button', { name: /View Results/i });
    fireEvent.click(viewBtn);
    expect(onSelectMatch).toHaveBeenCalledWith('job-101');
  });

  it('renders empty state when no matches exist', async () => {
    vi.mocked(apiClient.resumes.getMatches).mockResolvedValueOnce({
      matches: [],
      total: 0,
      limit: 10,
      offset: 0,
    });

    render(
      <MatchHistoryList
        resumeId={resumeId}
        onSelectMatch={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/No job descriptions have been matched against this resume yet/i)).toBeDefined();
    });
  });

  it('reloads when refreshKey changes, so a new match appears without a page reload', async () => {
    const match = {
      id: 'm-2',
      resumeId,
      jobId: 'job-202',
      job: { id: 'job-202', title: 'Senior Backend Engineer', company: 'Halcyon Ledger', location: '' },
      matchScore: 97.1,
      subScores: { bm25Score: 0.7, vectorScore: 0.8, rrfScore: 0.03, crossEncoderScore: 98.2 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      analysis: { status: 'COMPLETED', llmStatus: 'SUCCESS', score: 97.1 },
    };
    vi.mocked(apiClient.resumes.getMatches)
      .mockResolvedValueOnce({ matches: [], total: 0, limit: 10, offset: 0 })
      .mockResolvedValueOnce({ matches: [match], total: 1, limit: 10, offset: 0 });

    const { rerender } = render(
      <MatchHistoryList resumeId={resumeId} onSelectMatch={vi.fn()} refreshKey={0} />
    );
    await waitFor(() => {
      expect(screen.getByText(/No job descriptions have been matched/i)).toBeDefined();
    });

    rerender(<MatchHistoryList resumeId={resumeId} onSelectMatch={vi.fn()} refreshKey={1} />);
    await waitFor(() => {
      expect(screen.getByText('Senior Backend Engineer')).toBeDefined();
    });
    expect(apiClient.resumes.getMatches).toHaveBeenCalledTimes(2);
  });

  it('renders error state and handles retry click', async () => {
    vi.mocked(apiClient.resumes.getMatches).mockRejectedValueOnce(
      new ApiProblemError(500, {
        title: 'Internal Server Error',
        detail: 'Database query timed out',
      })
    );

    render(
      <MatchHistoryList
        resumeId={resumeId}
        onSelectMatch={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Error loading match history/i)).toBeDefined();
      expect(screen.getByText(/Database query timed out/i)).toBeDefined();
    });

    vi.mocked(apiClient.resumes.getMatches).mockResolvedValueOnce({
      matches: [],
      total: 0,
      limit: 10,
      offset: 0,
    });

    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText(/No job descriptions have been matched/i)).toBeDefined();
    });
  });

  it('renders load more button when matches count is less than total and appends results', async () => {
    vi.mocked(apiClient.resumes.getMatches).mockResolvedValueOnce({
      matches: [
        {
          id: 'm-1',
          resumeId,
          jobId: 'job-1',
          job: { id: 'job-1', title: 'Backend Eng', company: 'Acme', location: 'Remote' },
          matchScore: 85,
          subScores: {
            bm25Score: 0.8,
            vectorScore: 0.8,
            rrfScore: 0.03,
            crossEncoderScore: 85,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 2,
      limit: 1,
      offset: 0,
    });

    render(
      <MatchHistoryList
        resumeId={resumeId}
        onSelectMatch={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Backend Eng')).toBeDefined();
    });

    const loadMoreBtn = screen.getByRole('button', { name: /Load more/i });
    expect(loadMoreBtn).toBeDefined();

    vi.mocked(apiClient.resumes.getMatches).mockResolvedValueOnce({
      matches: [
        {
          id: 'm-2',
          resumeId,
          jobId: 'job-2',
          job: { id: 'job-2', title: 'Platform Eng', company: 'Globex', location: 'Remote' },
          matchScore: 90,
          subScores: {
            bm25Score: 0.9,
            vectorScore: 0.9,
            rrfScore: 0.04,
            crossEncoderScore: 90,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 2,
      limit: 1,
      offset: 1,
    });

    fireEvent.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getByText('Platform Eng')).toBeDefined();
    });
    expect(screen.getByText('Backend Eng')).toBeDefined();
  });
});
