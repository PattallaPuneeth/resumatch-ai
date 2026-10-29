import { describe, it, expect } from 'vitest';
import {
  buildExportModel,
  buildDocxBlob,
  buildPdfBlob,
  exportFilename,
  normalizeBullet,
} from '../resumeExport';
import type { ParsedResumeDetails } from '../apiClient';

const parsed = {
  id: 'p1',
  rawText: 'raw',
  candidateName: 'Ada Lovelace',
  contactInfo: { email: 'ada@example.com', phone: null, location: 'London' },
  summary: 'Engineer.',
  skills: [{ name: 'Python', category: 'lang', confidence: 1, startChar: 0, endChar: 6 }],
  experience: [
    {
      title: 'Engineer',
      company: 'Analytical Co',
      startDate: '2020',
      endDate: '2023',
      description: '• Built an engine for tables.\n- Reduced errors by 20%.',
      startChar: 0,
      endChar: 10,
    },
  ],
  education: [{ degree: 'BSc Maths', institution: 'UoL', year: '2019', startChar: 0, endChar: 5 }],
  createdAt: '',
  updatedAt: '',
} as unknown as ParsedResumeDetails;

function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('resume export', () => {
  it('normalizes bullet markers and spacing', () => {
    expect(normalizeBullet('•  Built   an engine ')).toBe('built an engine');
  });

  it('keeps the resume as parsed when nothing is accepted', () => {
    const model = buildExportModel(parsed);
    expect(model.appliedRewrites).toBe(0);
    expect(model.experience[0].bullets).toEqual(['Built an engine for tables.', 'Reduced errors by 20%.']);
    expect(model.experience[0].heading).toBe('Engineer | Analytical Co');
    expect(model.contact).toEqual(['ada@example.com', 'London']);
  });

  it('replaces only the accepted bullet, matching despite bullet markers', () => {
    const model = buildExportModel(parsed, {
      'Reduced errors by 20%.': 'Cut table errors by 20% with automated checks.',
    });
    expect(model.appliedRewrites).toBe(1);
    expect(model.experience[0].bullets[1]).toBe('Cut table errors by 20% with automated checks.');
    expect(model.experience[0].bullets[0]).toBe('Built an engine for tables.');
  });

  it('builds a safe filename', () => {
    expect(exportFilename(buildExportModel(parsed), 'pdf')).toBe('ada-lovelace-tailored.pdf');
  });

  it('produces a DOCX (zip) and a PDF with the right signatures', async () => {
    const model = buildExportModel(parsed);
    const docx = await bytesOf(await buildDocxBlob(model));
    expect(String.fromCharCode(docx[0], docx[1])).toBe('PK');
    const pdf = await bytesOf(await buildPdfBlob(model));
    expect(String.fromCharCode(...pdf.slice(0, 5))).toBe('%PDF-');
  });
});
