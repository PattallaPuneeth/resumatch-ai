'use client';

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { buildExportModel, downloadResume, type AcceptedRewrites } from '../lib/resumeExport';

interface ResumeExportProps {
  resumeId: string;
  acceptedRewrites: AcceptedRewrites;
}

export function ResumeExport({ resumeId, acceptedRewrites }: ResumeExportProps) {
  const [busy, setBusy] = useState<'docx' | 'pdf' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['resume-detail', resumeId],
    queryFn: () => apiClient.resumes.get(resumeId),
  });

  const model = useMemo(
    () => (data?.parsedResume ? buildExportModel(data.parsedResume, acceptedRewrites) : null),
    [data, acceptedRewrites]
  );

  if (!model) return null;

  const handleDownload = async (format: 'docx' | 'pdf') => {
    setBusy(format);
    setError(null);
    try {
      await downloadResume(model, format);
    } catch {
      setError('The file could not be created. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const buttonClass =
    'text-sm px-4 py-2 rounded-md font-semibold min-h-[44px] bg-white border border-slate-300 text-slate-900 hover:bg-slate-100 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

  return (
    <section
      aria-labelledby="resume-export-heading"
      className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm my-8"
    >
      <h2 id="resume-export-heading" className="text-xl font-bold text-slate-900">
        Download Your Tailored Resume
      </h2>
      <p className="text-sm text-slate-600 mt-1">
        {model.appliedRewrites > 0
          ? `${model.appliedRewrites} improved bullet${model.appliedRewrites === 1 ? '' : 's'} will be included.`
          : 'Choose "Use in exported resume" on a rewrite above to include it. Without any, you get your resume as parsed.'}{' '}
        The file is a plain single-column layout that applicant tracking systems read cleanly. Check
        it before you send it, because it is rebuilt from the parsed text and your original
        formatting is not kept.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => handleDownload('docx')}>
          {busy === 'docx' ? 'Preparing…' : 'Download Word (.docx)'}
        </button>
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => handleDownload('pdf')}>
          {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
    </section>
  );
}
