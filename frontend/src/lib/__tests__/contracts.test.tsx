/**
 * Cross-service contracts (see contracts/README.md). These read files outside the frontend on
 * purpose: the ML worker's analysis sample and the backend's database enum.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiClient, normalizeAnalysisData, AnalysisResult, ResumeSummary } from '../apiClient';
import { ModeBResults } from '@/components/ModeBResults';
import { ResumeList } from '@/components/ResumeList';

const repoRoot = path.resolve(__dirname, '../../../..');
const analysisSample = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'contracts/analysis-result.json'), 'utf-8')
);

describe('analysis result contract (ML worker -> frontend)', () => {
  it('the normaliser fills every field the screen reads from the worker sample', () => {
    const data = normalizeAnalysisData(analysisSample);
    expect(data.verdict_band).toBe('strong');
    expect(data.match_score).toBe(97.12);
    expect(data.ats_score).toBe(70);
    expect(data.matched_skills).toContain('postgresql');
    expect(data.strengths[0]).toMatchObject({ claim: 'Builds production REST APIs' });
    expect(data.gaps[0]).toMatchObject({ gap: 'Kafka or RabbitMQ', severity: 'nice' });
    expect(data.prioritized_improvements[0]).toMatchObject({ priority: 1, reason: expect.any(String) });
  });

  it('the results screen shows strengths, gaps and improvements from the worker sample', () => {
    const analysis = {
      id: 'a-1', resumeId: 'r-1', jobId: 'j-1', status: 'COMPLETED', llmStatus: 'SUCCESS',
      score: 97.12, result: normalizeAnalysisData(analysisSample),
      createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z',
    } as AnalysisResult;
    render(<ModeBResults analysis={analysis} matchResult={null} />);

    expect(screen.getByTestId('mode-b-verdict-band').textContent).toContain('Strong Match');
    // Regression: these rendered blank because the worker's field names were never mapped
    expect(screen.getByTestId('strength-item-0').textContent).toContain('Builds production REST APIs');
    expect(screen.getByTestId('gap-item-0').textContent).toContain('Kafka or RabbitMQ');
    const improvement = screen.getByTestId('improvement-item-0').textContent ?? '';
    expect(improvement).toContain('#1');
    expect(improvement).toContain('Quantify the PostgreSQL tuning work.');
    expect(improvement).toContain('query tuning');
  });
});

describe('resume status contract (database enum -> frontend)', () => {
  const schema = fs.readFileSync(path.join(repoRoot, 'backend/db/schema.prisma'), 'utf-8');
  const enumBody = schema.match(/enum ResumeStatus \{([^}]*)\}/)?.[1] ?? '';
  const statuses = enumBody.split(/\s+/).filter(Boolean) as ResumeSummary['status'][];

  it('reads the enum from the schema', () => {
    expect(statuses).toContain('PARSED');
    expect(statuses.length).toBeGreaterThanOrEqual(5);
  });

  it('every status gets a real badge in the resume list, none falls back to raw text', async () => {
    vi.spyOn(apiClient.resumes, 'list').mockResolvedValue({
      resumes: statuses.map((status, i) => ({
        id: `r-${i}`, originalFilename: `${status}.pdf`, mimeType: 'application/pdf', sizeBytes: 1000,
        status, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z',
      })),
    });
    vi.spyOn(apiClient.resumes, 'get').mockRejectedValue(new Error('not needed'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <ResumeList />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText('PARSED.pdf')).toBeDefined());
    const known = document.querySelectorAll('[data-testid^="badge-"]');
    expect(known.length).toBe(statuses.length);
  });
});
