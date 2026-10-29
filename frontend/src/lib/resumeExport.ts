import type { ParsedResumeDetails } from './apiClient';

// Plain single-column layout on purpose: no tables, columns, text boxes or images, so the
// exported file parses cleanly in applicant tracking systems

export interface ExportExperience {
  heading: string;
  dates: string;
  bullets: string[];
}

export interface ExportModel {
  name: string;
  contact: string[];
  summary: string;
  skills: string[];
  experience: ExportExperience[];
  education: string[];
  appliedRewrites: number;
}

export type AcceptedRewrites = Record<string, string>;

const BULLET_PREFIX = /^\s*[•●▪◦\-*–—]\s*/;

export function normalizeBullet(text: string): string {
  return text.replace(BULLET_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanLine(text: string): string {
  return text.replace(BULLET_PREFIX, '').replace(/\s+/g, ' ').trim();
}

function joinNonEmpty(parts: Array<string | null | undefined>, separator: string): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join(separator);
}

export function buildExportModel(
  parsed: ParsedResumeDetails,
  accepted: AcceptedRewrites = {}
): ExportModel {
  const lookup = new Map<string, string>();
  for (const [original, rewritten] of Object.entries(accepted)) {
    const key = normalizeBullet(original);
    const value = cleanLine(rewritten);
    if (key && value) lookup.set(key, value);
  }

  let appliedRewrites = 0;
  const experience: ExportExperience[] = (parsed.experience ?? []).map((entry) => {
    const withBullets = entry as typeof entry & { bullets?: unknown };
    const rawLines: string[] = Array.isArray(withBullets.bullets)
      ? withBullets.bullets.filter((b): b is string => typeof b === 'string')
      : (entry.description ?? '').split('\n');

    const bullets = rawLines
      .map(cleanLine)
      .filter((line) => line.length > 0)
      .map((line) => {
        const replacement = lookup.get(normalizeBullet(line));
        if (replacement !== undefined) {
          appliedRewrites += 1;
          return replacement;
        }
        return line;
      });

    return {
      heading: joinNonEmpty([entry.title, entry.company, entry.location], ' | '),
      dates: joinNonEmpty([entry.startDate, entry.endDate], ' - '),
      bullets,
    };
  });

  const contact = parsed.contactInfo
    ? [
        parsed.contactInfo.email,
        parsed.contactInfo.phone,
        parsed.contactInfo.location,
        parsed.contactInfo.linkedin,
        parsed.contactInfo.github,
      ]
        .map((c) => (c ?? '').trim())
        .filter((c) => c.length > 0)
    : [];

  return {
    name: (parsed.candidateName ?? '').trim() || 'Resume',
    contact,
    summary: (parsed.summary ?? '').trim(),
    skills: (parsed.skills ?? []).map((s) => s.name.trim()).filter((s) => s.length > 0),
    experience,
    education: (parsed.education ?? [])
      .map((e) => joinNonEmpty([e.degree, e.institution, e.year, e.gpa ? `GPA ${e.gpa}` : ''], ' | '))
      .filter((e) => e.length > 0),
    appliedRewrites,
  };
}

export function exportFilename(model: ExportModel, extension: 'docx' | 'pdf'): string {
  const base = model.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'resume'}-tailored.${extension}`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function buildDocxBlob(model: ExportModel): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import('docx');

  const heading = (text: string) =>
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 80 },
      children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 24 })],
    });

  const body = (text: string) =>
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text, size: 22 })] });

  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: model.name, bold: true, size: 36 })],
    }),
  ];

  if (model.contact.length > 0) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: model.contact.join(' | '), size: 20 })],
      })
    );
  }

  if (model.summary) {
    children.push(heading('Summary'), body(model.summary));
  }

  if (model.skills.length > 0) {
    children.push(heading('Skills'), body(model.skills.join(', ')));
  }

  if (model.experience.length > 0) {
    children.push(heading('Experience'));
    for (const entry of model.experience) {
      if (entry.heading) {
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 20 },
            children: [new TextRun({ text: entry.heading, bold: true, size: 22 })],
          })
        );
      }
      if (entry.dates) {
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: entry.dates, italics: true, size: 20 })],
          })
        );
      }
      for (const bullet of entry.bullets) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: [new TextRun({ text: bullet, size: 22 })],
          })
        );
      }
    }
  }

  if (model.education.length > 0) {
    children.push(heading('Education'));
    for (const line of model.education) children.push(body(line));
  }

  const doc = new Document({
    creator: 'ResuMatch AI',
    title: `${model.name} - Resume`,
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}

export async function buildPdfBlob(model: ExportModel): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
  pdf.setProperties({ title: `${model.name} - Resume`, creator: 'ResuMatch AI' });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 54;
  const textWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
  };

  const write = (
    text: string,
    opts: { size?: number; bold?: boolean; italic?: boolean; indent?: number; center?: boolean; after?: number } = {}
  ) => {
    const size = opts.size ?? 10.5;
    const indent = opts.indent ?? 0;
    pdf.setFont('helvetica', opts.bold ? 'bold' : opts.italic ? 'italic' : 'normal');
    pdf.setFontSize(size);
    const lines: string[] = pdf.splitTextToSize(text, textWidth - indent);
    const lineHeight = size * 1.3;
    for (const line of lines) {
      ensureSpace(lineHeight);
      if (opts.center) {
        pdf.text(line, pageWidth / 2, y + size, { align: 'center' });
      } else {
        pdf.text(line, margin + indent, y + size);
      }
      y += lineHeight;
    }
    y += opts.after ?? 2;
  };

  const heading = (text: string) => {
    ensureSpace(30);
    y += 8;
    write(text.toUpperCase(), { size: 12, bold: true, after: 3 });
    pdf.setDrawColor(150);
    pdf.line(margin, y - 2, pageWidth - margin, y - 2);
    y += 3;
  };

  write(model.name, { size: 20, bold: true, center: true, after: 4 });
  if (model.contact.length > 0) {
    write(model.contact.join(' | '), { size: 9.5, center: true, after: 6 });
  }
  if (model.summary) {
    heading('Summary');
    write(model.summary);
  }
  if (model.skills.length > 0) {
    heading('Skills');
    write(model.skills.join(', '));
  }
  if (model.experience.length > 0) {
    heading('Experience');
    for (const entry of model.experience) {
      if (entry.heading) write(entry.heading, { bold: true, after: 0 });
      if (entry.dates) write(entry.dates, { italic: true, size: 9.5, after: 2 });
      for (const bullet of entry.bullets) {
        // A hyphen is plain text, so the bullet survives text extraction in any ATS
        write(`- ${bullet}`, { indent: 10, after: 1 });
      }
      y += 4;
    }
  }
  if (model.education.length > 0) {
    heading('Education');
    for (const line of model.education) write(line);
  }

  return pdf.output('blob');
}

export async function downloadResume(model: ExportModel, format: 'docx' | 'pdf'): Promise<void> {
  const blob = format === 'docx' ? await buildDocxBlob(model) : await buildPdfBlob(model);
  download(blob, exportFilename(model, format));
}
