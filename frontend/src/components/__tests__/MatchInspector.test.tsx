import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MatchVisualizer } from '../MatchVisualizer';
import { MatchPassages, highlightTerms } from '../MatchPassages';
import type { MatchResult } from '@/lib/apiClient';

const baseMatch: MatchResult = {
  id: 'm1',
  resumeId: 'r1',
  jobId: 'j1',
  bm25Score: 0.4,
  vectorScore: 0.6,
  rrfScore: 0.03,
  crossEncoderScore: 82,
  finalScore: 78,
  createdAt: '2026-10-28T00:00:00Z',
  updatedAt: '2026-10-28T00:00:00Z',
  explanation: {
    skillGap: {
      matched: ['general ledger', 'Excel'],
      missing: ['tax'],
      partial: [],
      preferred_matched: ['payroll'],
      preferred_missing: ['audit'],
    },
    topMatchingChunks: [
      {
        chunkId: 'c1',
        sectionType: 'EXPERIENCE',
        crossEncoderScore: 91.4,
        snippet: 'Owned the General Ledger close and payroll runs; built Excel models.',
      },
      { chunkId: 'c2', sectionType: 'SKILLS', snippet: 'Skills: QuickBooks, Excel' },
    ],
    totalChunksEvaluated: 4,
  },
};

describe('highlightTerms', () => {
  it('marks whole-word, case-insensitive matches and keeps the rest as text', () => {
    render(<p>{highlightTerms('Excel and excellence, EXCEL.', ['excel'])}</p>);
    const marks = screen.getAllByText(/excel/i, { selector: 'mark' });
    expect(marks.map((m) => m.textContent)).toEqual(['Excel', 'EXCEL']);
  });

  it('renders markup in resume text as plain text, never as HTML', () => {
    const { container } = render(
      <p>{highlightTerms('<img src=x onerror=alert(1)> Python', ['python'])}</p>
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('treats regex characters in skill names literally', () => {
    render(<p>{highlightTerms('C++ and C# and Node.js', ['c++', 'node.js'])}</p>);
    expect(screen.getByText('C++', { selector: 'mark' })).toBeTruthy();
    expect(screen.getByText('Node.js', { selector: 'mark' })).toBeTruthy();
  });
});

describe('Match Inspector', () => {
  it('lists the top passages with section, relevance and highlighted skills', () => {
    render(<MatchVisualizer matchResult={baseMatch} />);
    const passages = screen.getByTestId('match-passages');
    expect(within(passages).getByText(/top 2 of 4 evaluated/)).toBeTruthy();
    expect(within(passages).getByText(/#1 · Experience/)).toBeTruthy();
    expect(within(passages).getByText('relevance 91')).toBeTruthy();
    const marked = within(passages)
      .getAllByText(/./, { selector: 'mark' })
      .map((m) => m.textContent);
    expect(marked).toEqual(expect.arrayContaining(['General Ledger', 'payroll', 'Excel']));
  });

  it('shows preferred skills separately from required ones', () => {
    render(<MatchVisualizer matchResult={baseMatch} />);
    const preferred = screen.getByTestId('preferred-skills');
    expect(within(preferred).getByText('✓ payroll')).toBeTruthy();
    expect(within(preferred).getByText('audit')).toBeTruthy();
    expect(within(screen.getByTestId('missing-keywords-list')).queryByText('audit')).toBeNull();
  });

  it('handles a match with no passages', () => {
    render(<MatchPassages chunks={[]} highlight={['python']} />);
    expect(screen.getByTestId('match-passages-empty')).toBeTruthy();
  });
});
