'use client';

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const STAGES = [
  { title: 'Read the file', detail: 'PyMuPDF and python-docx, with Tesseract OCR for scanned PDFs.' },
  { title: 'Split and embed', detail: 'Section-aware chunks, embedded with all-MiniLM-L6-v2.' },
  { title: 'Search two ways', detail: 'BM25 keyword search plus pgvector similarity search.' },
  { title: 'Fuse the rankings', detail: 'Reciprocal Rank Fusion merges both result lists.' },
  { title: 'Rerank passages', detail: 'A cross-encoder reads each passage next to the job.' },
  { title: 'Score and explain', detail: 'Skill coverage, the top passages, and how your experience compares.' },
];

/** The six real stages of the matching pipeline, as a timeline that draws in on scroll. */
export function PipelineFlow() {
  const reduce = useReducedMotion();
  return (
    <div className="relative">
      {/* Connector line (desktop): draws left to right once visible */}
      <div className="absolute left-0 right-0 top-[19px] hidden h-px bg-border lg:block" aria-hidden="true">
        <motion.div
          className="h-px origin-left bg-primary"
          initial={reduce ? false : { scaleX: 0 }}
          whileInView={{ scaleX: 1 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 1.4, ease: [0.65, 0, 0.35, 1] }}
        />
      </div>
      <ol className="relative grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-6 lg:gap-5">
        {STAGES.map((stage, i) => (
          <motion.li
            key={stage.title}
            initial={reduce ? false : { opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ delay: reduce ? 0 : 0.15 + i * 0.18, duration: 0.4 }}
            className="flex gap-4 lg:flex-col lg:gap-3"
          >
            <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-white text-sm font-semibold text-primary">
              {i + 1}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{stage.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{stage.detail}</p>
            </div>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}
