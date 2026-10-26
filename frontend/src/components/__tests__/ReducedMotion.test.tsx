import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ScoreGauge } from '../ui/ScoreGauge';
import { Skeleton } from '../ui/Skeleton';
import { ProgressBar } from '../ui/ProgressBar';

describe('Reduced Motion Accessibility Verification', () => {
  it('verifies ScoreGauge includes motion-reduce:transition-none on the arc circle', () => {
    const { container } = render(
      <ScoreGauge score={85} maxScore={100} label="ATS Score" />
    );

    const circles = container.querySelectorAll('circle');
    // Second circle is the animated progress arc
    expect(circles.length).toBe(2);
    const progressCircle = circles[1];
    expect(progressCircle.className.baseVal || progressCircle.getAttribute('class')).toContain(
      'motion-reduce:transition-none'
    );
  });

  it('verifies Skeleton loader includes motion-reduce:animate-none', () => {
    const { container } = render(<Skeleton className="w-20 h-4" />);
    const skeletonEl = container.firstElementChild;
    expect(skeletonEl?.getAttribute('class')).toContain('motion-reduce:animate-none');
  });

  it('verifies ProgressBar includes motion-reduce:transition-none on the fill element', () => {
    const { container } = render(<ProgressBar value={60} max={100} label="Upload" />);
    const barFill = container.querySelector('[role="progressbar"] > div');
    expect(barFill?.getAttribute('class')).toContain('motion-reduce:transition-none');
  });
});
