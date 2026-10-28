'use client';

import React from 'react';
import { FileSearch } from 'lucide-react';
import type { MatchExplanation } from '@/lib/apiClient';

type Chunk = NonNullable<MatchExplanation['topMatchingChunks']>[number];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits `text` into plain and highlighted parts for the given terms (case-insensitive,
 * whole-word). Returns React nodes only, so resume text is never injected as HTML.
 */
export function highlightTerms(text: string, terms: string[]): React.ReactNode[] {
  const clean = Array.from(
    new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))
  ).sort((a, b) => b.length - a.length);
  if (clean.length === 0) return [text];

  const pattern = new RegExp(
    `(?<![\\w])(${clean.map(escapeRegExp).join('|')})(?![\\w])`,
    'gi'
  );
  const nodes: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <mark key={`${start}-${m[0]}`} className="bg-emerald-100 text-emerald-900 rounded px-0.5">
        {m[0]}
      </mark>
    );
    last = start + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const SECTION_LABELS: Record<string, string> = {
  experience: 'Experience',
  skills: 'Skills',
  education: 'Education',
  summary: 'Summary',
  projects: 'Projects',
  certifications: 'Certifications',
};

interface MatchPassagesProps {
  chunks: Chunk[];
  highlight: string[];
  totalEvaluated?: number;
}

/** The resume passages the cross-encoder ranked highest for this job, best first. */
export function MatchPassages({ chunks, highlight, totalEvaluated }: MatchPassagesProps) {
  if (chunks.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="match-passages-empty">
        No resume passages were scored for this match.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="match-passages">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
        <FileSearch className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        <span>
          Most relevant resume passages
          {totalEvaluated ? ` (top ${chunks.length} of ${totalEvaluated} evaluated)` : ''}:
        </span>
      </div>
      <ol className="space-y-2">
        {chunks.map((c, i) => {
          const section = c.sectionType
            ? SECTION_LABELS[c.sectionType.toLowerCase()] ?? c.sectionType
            : null;
          return (
            <li
              key={c.chunkId || i}
              className="stagger-item p-2.5 rounded-md border border-border bg-slate-50/60 text-xs leading-relaxed transition-colors hover:border-primary/40"
            >
              <div className="flex items-center justify-between mb-1 text-[11px] text-muted-foreground">
                <span className="font-semibold">
                  #{i + 1}
                  {section ? ` · ${section}` : ''}
                </span>
                {typeof c.crossEncoderScore === 'number' && (
                  <span className="font-mono" title="Cross-encoder relevance (0-100)">
                    relevance {Math.round(c.crossEncoderScore)}
                  </span>
                )}
              </div>
              <p className="text-foreground whitespace-pre-line">
                {highlightTerms(c.snippet, highlight)}
                {c.snippet.length >= 250 ? '…' : ''}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
