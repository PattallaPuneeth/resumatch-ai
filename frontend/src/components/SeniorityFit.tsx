'use client';

import React from 'react';
import { Briefcase } from 'lucide-react';
import type { MatchExplanation } from '@/lib/apiClient';

const STATUS_TEXT = {
  meets: { label: 'Meets the experience asked for', tone: 'bg-accent text-accent-foreground' },
  close: { label: 'A little short on experience', tone: 'bg-highlight text-highlight-foreground' },
  below: { label: 'Well short of the experience asked for', tone: 'bg-highlight text-highlight-foreground' },
} as const;

function years(n: number): string {
  if (n < 1) return 'under a year';
  const rounded = Math.round(n);
  return `about ${rounded} year${rounded === 1 ? '' : 's'}`;
}

/** Experience asked for vs shown on the resume. Shown for context; it does not change the score. */
export function SeniorityFit({ seniority }: { seniority?: MatchExplanation['seniority'] }) {
  if (!seniority || seniority.status === 'unknown' || seniority.requiredYears === null) return null;
  const status = STATUS_TEXT[seniority.status];
  return (
    <div className="border-t border-border pt-4 space-y-2" data-testid="seniority-fit">
      <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Experience</h4>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-foreground">
          Job asks for {seniority.requiredYears}+ years
          {seniority.jobLevel ? ` (${seniority.jobLevel} role)` : ''}; your resume shows {years(seniority.resumeYears)}.
        </span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
      </div>
      <p className="text-xs text-muted-foreground">Shown for context. It does not change the match score.</p>
    </div>
  );
}
