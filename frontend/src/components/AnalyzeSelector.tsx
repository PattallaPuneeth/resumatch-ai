'use client';

import React, { useState, useEffect } from 'react';
import { ResumeSummary, UserUsageResponse } from '@/lib/apiClient';
import {
  FileText,
  Briefcase,
  History,
  PlusCircle,
  AlertCircle,
  Sparkles,
  Award,
  ChevronRight,
  Layers,
} from 'lucide-react';
import { SkillChipsInput, addSkills } from './SkillChipsInput';

export interface JDInputData {
  title: string;
  company: string;
  rawDescription: string;
  location?: string;
  jobType?: string;
  requiredSkills?: string[];
  preferredSkills?: string[];
}

export interface MatchHistoryItem {
  jobId: string;
  title: string;
  company: string;
  matchScore: number;
  date: string;
}

interface AnalyzeSelectorProps {
  resumes: ResumeSummary[];
  selectedResumeId: string | null;
  onSelectResume: (id: string) => void;
  selectedMode: 'A' | 'B';
  onSelectMode: (mode: 'A' | 'B') => void;
  onSubmitModeA: () => void;
  onSubmitModeB: (data: JDInputData) => void;
  isSubmitting: boolean;
  historyMatches: MatchHistoryItem[];
  onSelectHistoryMatch?: (item: MatchHistoryItem) => void;
  usageData?: UserUsageResponse | null;
  className?: string;
}

export function AnalyzeSelector({
  resumes,
  selectedResumeId,
  onSelectResume,
  selectedMode,
  onSelectMode,
  onSubmitModeA,
  onSubmitModeB,
  isSubmitting,
  historyMatches,
  onSelectHistoryMatch,
  usageData,
  className = '',
}: AnalyzeSelectorProps) {
  // JD Form State
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [rawDescription, setRawDescription] = useState('');
  const [location, setLocation] = useState('');
  const [jobType, setJobType] = useState('');
  const [requiredSkills, setRequiredSkills] = useState<string[]>([]);
  const [preferredSkills, setPreferredSkills] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const selectedResume = resumes.find((r) => r.id === selectedResumeId);
  const isResumeParsed = selectedResume?.status === 'PARSED';

  const analysesMeter = usageData?.meters?.analyses;
  const isAnalysesBlocked = analysesMeter?.blocked || false;
  const remainingAnalyses =
    analysesMeter?.limit !== null && analysesMeter?.limit !== undefined
      ? Math.max(0, analysesMeter.limit - analysesMeter.used)
      : 'Unlimited';

  const handleModeBSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const cleanTitle = title.trim();
    const cleanCompany = company.trim();
    const cleanDesc = rawDescription.trim();

    if (!cleanTitle) {
      setValidationError('Job Title is required (1-200 characters).');
      return;
    }
    if (cleanTitle.length > 200) {
      setValidationError('Job Title exceeds maximum 200 characters.');
      return;
    }
    if (!cleanCompany) {
      setValidationError('Company Name is required (1-200 characters).');
      return;
    }
    if (cleanCompany.length > 200) {
      setValidationError('Company Name exceeds maximum 200 characters.');
      return;
    }
    if (cleanDesc.length < 20) {
      setValidationError(
        `Job description must be at least 20 characters (currently ${cleanDesc.length}).`
      );
      return;
    }

    onSubmitModeB({
      title: cleanTitle,
      company: cleanCompany,
      rawDescription: cleanDesc,
      location: location.trim() || undefined,
      jobType: jobType.trim() || undefined,
      // Empty lists are left out: the ML worker then reads required vs preferred from the text.
      requiredSkills: requiredSkills.length > 0 ? requiredSkills : undefined,
      preferredSkills: preferredSkills.length > 0 ? preferredSkills : undefined,
    });
  };

  const moveToPreferred = (skill: string) => {
    setRequiredSkills((cur) => cur.filter((s) => s !== skill));
    setPreferredSkills((cur) => addSkills(cur, [skill]));
  };

  const moveToRequired = (skill: string) => {
    setPreferredSkills((cur) => cur.filter((s) => s !== skill));
    setRequiredSkills((cur) => addSkills(cur, [skill]));
  };

  const handleResetJD = () => {
    setTitle('');
    setCompany('');
    setRawDescription('');
    setLocation('');
    setJobType('');
    setRequiredSkills([]);
    setPreferredSkills([]);
    setValidationError(null);
  };

  return (
    <div
      data-testid="analyze-selector-container"
      className={`bg-white rounded-lg border border-border p-6 shadow-sm space-y-6 ${className}`}
    >
      {/* 1. Step 1: Resume Selection */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label
            htmlFor="resume-select"
            className="block text-xs font-bold uppercase tracking-wider text-muted-foreground"
          >
            Step 1: Choose Resume
          </label>
          <span
            data-testid="analyses-quota-indicator"
            className="text-xs px-2.5 py-0.5 rounded bg-slate-100 text-slate-700 font-medium border border-slate-200"
          >
            Analyses Quota:{' '}
            <span className="font-semibold text-foreground">
              {typeof remainingAnalyses === 'number'
                ? `${remainingAnalyses} remaining`
                : remainingAnalyses}
            </span>
          </span>
        </div>

        {resumes.length === 0 ? (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-xs text-muted-foreground text-center">
            No resumes uploaded yet. Please upload a resume first to begin analysis.
          </div>
        ) : (
          <select
            id="resume-select"
            data-testid="resume-select-dropdown"
            value={selectedResumeId || ''}
            onChange={(e) => onSelectResume(e.target.value)}
            className="w-full text-xs font-medium px-3.5 py-2.5 bg-white border border-slate-300 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <option value="" disabled>
              Select a parsed resume...
            </option>
            {resumes.map((r) => {
              const isParsed = r.status === 'PARSED';
              return (
                <option
                  key={r.id}
                  value={r.id}
                  disabled={!isParsed}
                >
                  {r.originalFilename} — [{r.status}]
                  {r.status === 'PARSED' && r.atsScore ? ` (ATS: ${r.atsScore})` : ''}
                  {!isParsed ? ' (Processing incomplete)' : ''}
                </option>
              );
            })}
          </select>
        )}

        {selectedResume && !isResumeParsed && (
          <div
            role="alert"
            data-testid="resume-not-parsed-alert"
            className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 flex items-start gap-2"
          >
            <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              This resume is currently in <strong>{selectedResume.status}</strong> status. Only
              PARSED resumes can be analyzed.
            </span>
          </div>
        )}
      </div>

      {/* 2. Step 2: Choose Mode */}
      {selectedResumeId && isResumeParsed && (
        <div className="space-y-4 pt-2 border-t border-border">
          <label className="block text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Step 2: Select Analysis Mode
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="radiogroup" aria-label="Analysis Mode">
            {/* Mode A Pill */}
            <button
              type="button"
              role="radio"
              aria-checked={selectedMode === 'A'}
              data-testid="mode-a-btn"
              onClick={() => onSelectMode('A')}
              className={`p-4 rounded-lg border text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                selectedMode === 'A'
                  ? 'border-primary bg-emerald-50/50 shadow-xs ring-1 ring-primary'
                  : 'border-border bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <FileText
                  className={`h-4 w-4 ${selectedMode === 'A' ? 'text-primary' : 'text-muted-foreground'}`}
                  aria-hidden="true"
                />
                <span className="font-bold text-sm text-foreground">Mode A: Resume Only</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                Deterministic ATS score audit, formatting hazards, character span content findings, and
                ML-ranked role suggestions.
              </p>
            </button>

            {/* Mode B Pill */}
            <button
              type="button"
              role="radio"
              aria-checked={selectedMode === 'B'}
              data-testid="mode-b-btn"
              onClick={() => onSelectMode('B')}
              className={`p-4 rounded-lg border text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                selectedMode === 'B'
                  ? 'border-primary bg-emerald-50/50 shadow-xs ring-1 ring-primary'
                  : 'border-border bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <Briefcase
                  className={`h-4 w-4 ${selectedMode === 'B' ? 'text-primary' : 'text-muted-foreground'}`}
                  aria-hidden="true"
                />
                <span className="font-bold text-sm text-foreground">
                  Mode B: Resume + Job Description
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                Hybrid keyword (BM25) & deep cross-encoder matching, skill gap analysis, and tailored
                relevance scoring.
              </p>
            </button>
          </div>
        </div>
      )}

      {/* 3. Mode A Action Form */}
      {selectedResumeId && isResumeParsed && selectedMode === 'A' && (
        <div className="pt-2 border-t border-border space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Consumes 1 unit of your <strong>analyses</strong> monthly meter.
            </span>
            <button
              type="button"
              data-testid="run-mode-a-btn"
              onClick={onSubmitModeA}
              disabled={isSubmitting || isAnalysesBlocked}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-[hsl(var(--primary-hover))] text-primary-foreground text-xs font-semibold rounded-md shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span>{isSubmitting ? 'Analyzing Resume...' : 'Run Resume Analysis'}</span>
            </button>
          </div>
        </div>
      )}

      {/* 4. Mode B JD Input Form & History */}
      {selectedResumeId && isResumeParsed && selectedMode === 'B' && (
        <div className="pt-2 border-t border-border space-y-6">
          {/* Match History for this Resume */}
          {historyMatches && historyMatches.length > 0 && (
            <div data-testid="jd-history-section" className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                  <History className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  <span>Job Descriptions Matched with this Resume ({historyMatches.length})</span>
                </div>
                <button
                  type="button"
                  onClick={handleResetJD}
                  data-testid="add-another-jd-btn"
                  className="text-xs font-semibold text-primary hover:text-[hsl(var(--primary-hover))] flex items-center gap-1 underline hover:no-underline"
                >
                  <PlusCircle className="h-3 w-3" />
                  <span>Add another JD</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {historyMatches.map((m, idx) => (
                  <button
                    key={`${m.jobId}-${idx}`}
                    type="button"
                    data-testid={`history-match-item-${idx}`}
                    onClick={() => onSelectHistoryMatch && onSelectHistoryMatch(m)}
                    className="p-2.5 rounded-md border border-border bg-slate-50/60 hover:bg-slate-100 hover:border-slate-300 text-left transition-colors flex items-center justify-between"
                  >
                    <div>
                      <h4 className="font-semibold text-xs text-foreground line-clamp-1">{m.title}</h4>
                      <p className="text-[11px] text-muted-foreground line-clamp-1">{m.company}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="font-mono font-bold text-xs text-primary">{m.matchScore}%</span>
                      <span className="block text-[10px] text-muted-foreground">{m.date}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Paste JD Input Form */}
          <form onSubmit={handleModeBSubmit} className="space-y-4" data-testid="jd-input-form">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="jd-title" className="block text-xs font-semibold text-slate-700 mb-1">
                  Job Title *
                </label>
                <input
                  id="jd-title"
                  type="text"
                  required
                  maxLength={200}
                  placeholder="e.g. Senior Backend Engineer"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>

              <div>
                <label htmlFor="jd-company" className="block text-xs font-semibold text-slate-700 mb-1">
                  Company Name *
                </label>
                <input
                  id="jd-company"
                  type="text"
                  required
                  maxLength={200}
                  placeholder="e.g. Acme Corporation"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="jd-location" className="block text-xs font-semibold text-slate-700 mb-1">
                  Location (Optional)
                </label>
                <input
                  id="jd-location"
                  type="text"
                  maxLength={200}
                  placeholder="e.g. Remote / New York, NY"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>

              <div>
                <label htmlFor="jd-job-type" className="block text-xs font-semibold text-slate-700 mb-1">
                  Job Type (Optional)
                </label>
                <input
                  id="jd-job-type"
                  type="text"
                  maxLength={50}
                  placeholder="e.g. Full-time, Contract"
                  value={jobType}
                  onChange={(e) => setJobType(e.target.value)}
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>
            </div>

            {/* Raw Description Textarea with Live Counter */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor="jd-raw-description" className="block text-xs font-semibold text-slate-700">
                  Job Description Text *
                </label>
                <span
                  data-testid="jd-char-counter"
                  className={`text-[11px] font-mono ${
                    rawDescription.length < 20 ? 'text-amber-700' : 'text-slate-500'
                  }`}
                >
                  {rawDescription.length} chars (min 20)
                </span>
              </div>
              <textarea
                id="jd-raw-description"
                rows={6}
                required
                placeholder="Paste the full job description text here (requirements, qualifications, responsibilities)..."
                value={rawDescription}
                onChange={(e) => setRawDescription(e.target.value)}
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary font-mono leading-relaxed"
              />
            </div>

            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                Optional. Required skills drive the skill-coverage score; preferred skills count
                half as much. Leave both empty to have them read from the description.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SkillChipsInput
                  id="jd-required-skills"
                  label="Required Skills (Optional)"
                  skills={requiredSkills}
                  onChange={setRequiredSkills}
                  onMove={moveToPreferred}
                  moveLabel="Move to preferred"
                  tone="required"
                />
                <SkillChipsInput
                  id="jd-preferred-skills"
                  label="Preferred Skills (Optional)"
                  skills={preferredSkills}
                  onChange={setPreferredSkills}
                  onMove={moveToRequired}
                  moveLabel="Move to required"
                  tone="preferred"
                />
              </div>
            </div>

            {validationError && (
              <div
                role="alert"
                data-testid="jd-validation-error"
                className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-900 flex items-center gap-2"
              >
                <AlertCircle className="h-4 w-4 text-red-600 shrink-0" aria-hidden="true" />
                <span>{validationError}</span>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <span className="text-[11px] text-muted-foreground">
                Consumes 1 unit of your <strong>analyses</strong> monthly meter upon analysis generation.
              </span>
              <button
                type="submit"
                data-testid="run-mode-b-btn"
                disabled={isSubmitting || isAnalysesBlocked}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-[hsl(var(--primary-hover))] text-primary-foreground text-xs font-semibold rounded-md shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                <span>{isSubmitting ? 'Matching & Analyzing...' : 'Match & Analyze JD'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
