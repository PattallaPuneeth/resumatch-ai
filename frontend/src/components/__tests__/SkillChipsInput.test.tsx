import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnalyzeSelector } from '../AnalyzeSelector';
import { addSkills, parseSkillInput, MAX_SKILLS } from '../SkillChipsInput';
import type { ResumeSummary } from '@/lib/apiClient';

describe('SkillChipsInput helpers', () => {
  it('splits pasted text on commas, semicolons and newlines', () => {
    expect(parseSkillInput(' Python, SQL ;Docker\n\n  Kubernetes ')).toEqual([
      'Python',
      'SQL',
      'Docker',
      'Kubernetes',
    ]);
  });

  it('dedupes case-insensitively and caps the list', () => {
    expect(addSkills(['Python'], ['python', 'SQL'])).toEqual(['Python', 'SQL']);
    const many = Array.from({ length: MAX_SKILLS + 5 }, (_, i) => `s${i}`);
    expect(addSkills([], many)).toHaveLength(MAX_SKILLS);
  });
});

describe('AnalyzeSelector required/preferred skill chips', () => {
  const resumes: ResumeSummary[] = [
    {
      id: 'res-1',
      originalFilename: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
      status: 'PARSED',
    } as ResumeSummary,
  ];

  const renderForm = (onSubmitModeB = vi.fn()) => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <AnalyzeSelector
          resumes={resumes}
          selectedResumeId="res-1"
          onSelectResume={vi.fn()}
          selectedMode="B"
          onSelectMode={vi.fn()}
          onSubmitModeA={vi.fn()}
          onSubmitModeB={onSubmitModeB}
          isSubmitting={false}
          historyMatches={[]}
        />
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText(/Job Title/i), { target: { value: 'Accountant' } });
    fireEvent.change(screen.getByLabelText(/Company Name/i), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(/Job Description Text/i), {
      target: { value: 'Maintain the general ledger and support month-end close.' },
    });
    return onSubmitModeB;
  };

  it('sends typed skills, and lets a chip move between lists', () => {
    const onSubmit = renderForm();
    const required = screen.getByLabelText(/Required Skills/i);
    fireEvent.change(required, { target: { value: 'General Ledger, Excel' } });
    fireEvent.keyDown(required, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Move to preferred: Excel' }));

    fireEvent.submit(screen.getByTestId('jd-input-form'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ requiredSkills: ['General Ledger'], preferredSkills: ['Excel'] })
    );
  });

  it('leaves skill lists out when none were entered', () => {
    const onSubmit = renderForm();
    fireEvent.submit(screen.getByTestId('jd-input-form'));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent.requiredSkills).toBeUndefined();
    expect(sent.preferredSkills).toBeUndefined();
  });

  it('removes a chip', () => {
    renderForm();
    const preferred = screen.getByLabelText(/Preferred Skills/i);
    fireEvent.change(preferred, { target: { value: 'Payroll' } });
    fireEvent.keyDown(preferred, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Payroll' }));
    expect(screen.queryByText('Payroll')).toBeNull();
  });
});
