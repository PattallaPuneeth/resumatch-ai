'use client';

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, Minus } from 'lucide-react';
import { ScoreGauge } from '@/components/ui/ScoreGauge';

const MATCHED = ['Node.js', 'TypeScript', 'PostgreSQL', 'Docker', 'REST API'];
const MISSING = ['Kubernetes'];

/**
 * A sample result card for the landing page, labelled as an example. Same parts as the real
 * results screen: the score, matched and missing skills, and the passage that scored highest.
 */
export function HeroDemoCard() {
  const reduce = useReducedMotion();
  const appear = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 4 },
          animate: { opacity: 1, y: 0 },
          transition: { delay, duration: 0.35, ease: [0.16, 1, 0.3, 1] as const },
        };

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
      className="relative w-full max-w-md"
    >
      {/* Offset paper sheet behind the card */}
      <div
        className="absolute inset-0 translate-x-3 translate-y-3 rounded-2xl border border-border bg-highlight"
        aria-hidden="true"
      />
      <div className="relative rounded-2xl border border-border bg-white p-6 shadow-[0_12px_32px_-16px_rgba(28,25,23,0.25)] text-left">
        <div className="flex items-start justify-between border-b border-border pb-4">
          <div>
            <p className="text-xs text-muted-foreground">Sample result</p>
            <p className="mt-0.5 font-semibold text-foreground">Senior Backend Engineer</p>
            <p className="text-xs text-muted-foreground">Halcyon Ledger · Chicago</p>
          </div>
          <ScoreGauge score={86} label="Match" size="sm" labelAs="p" />
        </div>

        <div className="grid grid-cols-2 gap-4 py-4 text-sm">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">You have</p>
            <ul className="space-y-1.5">
              {MATCHED.map((s, i) => (
                <motion.li key={s} {...appear(0.5 + i * 0.07)} className="flex items-center gap-2 text-foreground">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-primary">
                    <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
                  </span>
                  {s}
                </motion.li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Missing</p>
            <ul className="space-y-1.5">
              {MISSING.map((s, i) => (
                <motion.li
                  key={s}
                  {...appear(0.9 + i * 0.07)}
                  className="flex items-center gap-2 text-highlight-foreground"
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-highlight">
                    <Minus className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
                  </span>
                  {s}
                </motion.li>
              ))}
            </ul>
          </div>
        </div>

        <motion.blockquote
          {...appear(1.1)}
          className="rounded-lg bg-secondary px-4 py-3 text-sm leading-relaxed text-foreground border-l-2 border-primary"
        >
          <p className="mb-1 text-xs text-muted-foreground">Best-matching passage · Experience</p>
          Built <mark className="rounded bg-accent px-0.5 text-accent-foreground">Node.js</mark> and{' '}
          <mark className="rounded bg-accent px-0.5 text-accent-foreground">TypeScript</mark> ledger services on{' '}
          <mark className="rounded bg-accent px-0.5 text-accent-foreground">PostgreSQL</mark>, shipped in{' '}
          <mark className="rounded bg-accent px-0.5 text-accent-foreground">Docker</mark>.
        </motion.blockquote>
      </div>
    </motion.div>
  );
}
