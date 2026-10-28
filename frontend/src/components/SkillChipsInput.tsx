'use client';

import React, { useState } from 'react';
import { X, ArrowLeftRight } from 'lucide-react';

export const MAX_SKILLS = 50;
export const MAX_SKILL_LENGTH = 80;

interface SkillChipsInputProps {
  id: string;
  label: string;
  skills: string[];
  onChange: (skills: string[]) => void;
  /** Moves one chip to the other list (required <-> preferred). */
  onMove?: (skill: string) => void;
  moveLabel?: string;
  placeholder?: string;
  tone?: 'required' | 'preferred';
}

/** Splits typed or pasted text on commas, semicolons and newlines into clean skill names. */
export function parseSkillInput(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0)
    .map((s) => s.slice(0, MAX_SKILL_LENGTH));
}

/** Adds skills case-insensitively without duplicates, up to MAX_SKILLS. */
export function addSkills(current: string[], incoming: string[]): string[] {
  const seen = new Set(current.map((s) => s.toLowerCase()));
  const next = [...current];
  for (const s of incoming) {
    if (next.length >= MAX_SKILLS) break;
    if (!seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      next.push(s);
    }
  }
  return next;
}

export function SkillChipsInput({
  id,
  label,
  skills,
  onChange,
  onMove,
  moveLabel = 'Move',
  placeholder = 'Type a skill and press Enter',
  tone = 'required',
}: SkillChipsInputProps) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const parsed = parseSkillInput(draft);
    if (parsed.length > 0) onChange(addSkills(skills, parsed));
    setDraft('');
  };

  const chipClass =
    tone === 'required'
      ? 'bg-blue-50 border-blue-200 text-blue-900'
      : 'bg-slate-50 border-slate-200 text-slate-700';

  return (
    <div className="space-y-1" data-testid={`${id}-chips`}>
      <label htmlFor={id} className="block text-xs font-semibold text-slate-700">
        {label}
      </label>
      <div className="flex flex-wrap gap-1.5 p-2 border border-slate-300 rounded-md min-h-[2.5rem] focus-within:ring-2 focus-within:ring-primary">
        {skills.map((skill) => (
          <span
            key={skill.toLowerCase()}
            className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border ${chipClass}`}
          >
            {skill}
            {onMove && (
              <button
                type="button"
                onClick={() => onMove(skill)}
                aria-label={`${moveLabel}: ${skill}`}
                title={moveLabel}
                className="hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
              >
                <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onChange(skills.filter((s) => s !== skill))}
              aria-label={`Remove ${skill}`}
              className="hover:text-red-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={draft}
          maxLength={MAX_SKILL_LENGTH * 4}
          disabled={skills.length >= MAX_SKILLS}
          placeholder={skills.length === 0 ? placeholder : ''}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && draft === '' && skills.length > 0) {
              onChange(skills.slice(0, -1));
            }
          }}
          onBlur={commit}
          className="flex-1 min-w-[8rem] text-xs bg-transparent focus-visible:outline-none"
        />
      </div>
    </div>
  );
}
