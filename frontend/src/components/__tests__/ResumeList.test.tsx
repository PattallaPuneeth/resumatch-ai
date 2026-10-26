import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResumeList } from '../ResumeList';
import { apiClient, ResumeSummary, ResumeDetailsResponse } from '@/lib/apiClient';

describe('ResumeList Component (src/components/ResumeList.tsx)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
  });

  const renderWithClient = (ui: React.ReactElement) => {
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  };

  it('renders friendly empty state when user has no uploaded resumes', async () => {
    vi.spyOn(apiClient.resumes, 'list').mockResolvedValue({ resumes: [] });

    renderWithClient(<ResumeList />);

    await waitFor(() => {
      expect(screen.getByTestId('resumes-empty')).toBeDefined();
    });

    expect(screen.getByText('No resumes uploaded yet')).toBeDefined();
  });

  it('renders status badges for UPLOAD_PENDING, PROCESSING, PARSED, FAILED', async () => {
    const mockResumes: ResumeSummary[] = [
      {
        id: 'r-1',
        originalFilename: 'pending.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100000,
        status: 'UPLOAD_PENDING',
        createdAt: '2026-10-26T10:00:00Z',
        updatedAt: '2026-10-26T10:00:00Z',
      },
      {
        id: 'r-2',
        originalFilename: 'processing.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 200000,
        status: 'PROCESSING',
        createdAt: '2026-10-26T10:05:00Z',
        updatedAt: '2026-10-26T10:05:00Z',
      },
      {
        id: 'r-3',
        originalFilename: 'parsed.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 300000,
        status: 'PARSED',
        createdAt: '2026-10-26T10:10:00Z',
        updatedAt: '2026-10-26T10:10:00Z',
        atsScore: 88,
      },
      {
        id: 'r-4',
        originalFilename: 'corrupt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 50000,
        status: 'FAILED',
        createdAt: '2026-10-26T10:15:00Z',
        updatedAt: '2026-10-26T10:15:00Z',
      },
    ];

    vi.spyOn(apiClient.resumes, 'list').mockResolvedValue({ resumes: mockResumes });
    vi.spyOn(apiClient.resumes, 'get').mockResolvedValue({
      id: 'r-3',
      originalFilename: 'parsed.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 300000,
      status: 'PARSED',
      createdAt: '2026-10-26T10:10:00Z',
      updatedAt: '2026-10-26T10:10:00Z',
      parsedResume: {
        id: 'pr-3',
        rawText: 'text',
        atsScore: 88,
        createdAt: '2026-10-26T10:10:00Z',
        updatedAt: '2026-10-26T10:10:00Z',
      },
    } as ResumeDetailsResponse);

    renderWithClient(<ResumeList />);

    await waitFor(() => {
      expect(screen.getByTestId('badge-uploading')).toBeDefined();
      expect(screen.getByTestId('badge-processing')).toBeDefined();
      expect(screen.getByTestId('badge-parsed')).toBeDefined();
      expect(screen.getByTestId('badge-failed')).toBeDefined();
    });

    expect(screen.getByText('pending.pdf')).toBeDefined();
    expect(screen.getByText('processing.docx')).toBeDefined();
    expect(screen.getByText('parsed.pdf')).toBeDefined();
    expect(screen.getByText('corrupt.pdf')).toBeDefined();

    // Verify ATS score is shown for parsed resume
    await waitFor(() => {
      expect(screen.getByTestId('ats-score-r-3')).toBeDefined();
      expect(screen.getByText(/88 \/ 100/)).toBeDefined();
    });
  });

  it('prompts user with confirmation dialog and deletes resume on confirm', async () => {
    const mockResumes: ResumeSummary[] = [
      {
        id: 'del-1',
        originalFilename: 'to_delete.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 150000,
        status: 'PARSED',
        createdAt: '2026-10-26T10:00:00Z',
        updatedAt: '2026-10-26T10:00:00Z',
      },
    ];

    vi.spyOn(apiClient.resumes, 'list').mockResolvedValue({ resumes: mockResumes });
    const deleteSpy = vi.spyOn(apiClient.resumes, 'delete').mockResolvedValue({
      statusCode: 200,
      message: 'Resume deleted successfully',
      id: 'del-1',
    });

    const onDeleteSuccess = vi.fn();
    renderWithClient(<ResumeList onDeleteSuccess={onDeleteSuccess} />);

    await waitFor(() => {
      expect(screen.getByTestId('delete-resume-del-1')).toBeDefined();
    });

    // Click delete icon button
    fireEvent.click(screen.getByTestId('delete-resume-del-1'));

    // Modal opens
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeDefined();
    });
    expect(screen.getByText('Delete Resume?')).toBeDefined();

    // Confirm delete
    const confirmButton = screen.getByTestId('confirm-delete-button');
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('del-1');
      expect(onDeleteSuccess).toHaveBeenCalledTimes(1);
    });
  });
});
