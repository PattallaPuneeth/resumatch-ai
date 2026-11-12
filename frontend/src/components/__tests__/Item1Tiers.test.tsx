import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ModeBResults } from '../ModeBResults';
import type { AnalysisResult, MatchResult } from '@/lib/apiClient';

function match(overrides: Record<string, unknown>): MatchResult {
  return {
    id: 'm1',
    resumeId: 'r1',
    jobId: 'j1',
    bm25Score: 0,
    vectorScore: 0,
    rrfScore: 0,
    crossEncoderScore: 0,
    finalScore: 0,
    item1Result: {
      version: 'unified-3.1',
      state: 'SCORED',
      score: 55,
      raw_score: '55',
      capped_score: '55',
      verdict: 'Potential Fit',
      confidence: 'Low',
      verdict_withheld: false,
      withheld_reason: null,
      score_range: [40, 75],
      components: { sk: '0.5' },
      coverage: { ratio: 1 },
      skill_units: [],
      gate_units: [],
      years: {},
      confirm_only: [],
      public_sector_cue: null,
      stuffing_guard_applied: false,
      limitations: [],
      guidance: 'Guidance based on what the resume says.',
      tier: 'Tentative',
      band_range: ['Potential Fit', 'Good Fit'],
      confidence_reasons: ['only 2 requirements could be compared'],
      signals: { jd_level: 'senior', resume_level: 'junior', level_gap: 2, must_haves_missing: ['Chinese fluency'] },
      ...overrides,
    },
    createdAt: '',
    updatedAt: '',
  } as unknown as MatchResult;
}

const analysis = { id: 'a', resumeId: 'r1', jobId: 'j1', status: 'COMPLETED', llmStatus: 'UNAVAILABLE', score: 0, result: {} } as unknown as AnalysisResult;

describe('Item 1 result tiers', () => {
  it('shows a Tentative result with its band range and reason instead of hiding the verdict', () => {
    render(<ModeBResults analysis={analysis} matchResult={match({})} />);
    const note = screen.getByTestId('item1-tentative').textContent ?? '';
    expect(note).toContain('Potential Fit to Good Fit');
    expect(note).toContain('only 2 requirements could be compared');
    expect(screen.getByTestId('mode-b-match-score').textContent).toContain('55');
  });

  it('lists required items that are not evidenced, without capping or blaming', () => {
    render(<ModeBResults analysis={analysis} matchResult={match({})} />);
    expect(screen.getByTestId('item1-must-haves').textContent).toContain('Chinese fluency');
  });

  it('shows how the job role relates to the resume roles', () => {
    render(
      <ModeBResults
        analysis={analysis}
        matchResult={match({
          role_fit: {
            relation: 'different field',
            note: "This job's role (Accountants and Auditors) is in accounting and finance; your recent role (Software Test Engineer) is in software and IT, a different field.",
            source: 'O*NET 31.0',
            jd_role: null,
            resume_role: null,
          },
        })}
      />
    );
    expect(screen.getByTestId('item1-role-fit').textContent).toContain('different field');
  });

  it('shows no tentative note for a Firm result', () => {
    render(<ModeBResults analysis={analysis} matchResult={match({ tier: 'Firm', band_range: ['Good Fit', 'Good Fit'] })} />);
    expect(screen.queryByTestId('item1-tentative')).toBeNull();
  });
});
