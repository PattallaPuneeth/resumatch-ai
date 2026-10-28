'use client';

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { tokens } from '@/lib/designTokens';

interface ScoreGaugeProps {
  score: number;
  maxScore?: number;
  label: string;
  sublabel?: string;
  size?: 'sm' | 'md' | 'lg';
  statusBand?: string;
  className?: string;
  /** Element for the label; use 'p' where an h4 would break the page's heading order. */
  labelAs?: 'h4' | 'p';
}

export function ScoreGauge({
  score,
  maxScore = 100,
  label,
  sublabel,
  size = 'md',
  statusBand,
  className = '',
  labelAs: LabelTag = 'h4',
}: ScoreGaugeProps) {
  // Clamp score strictly between 0 and maxScore for visual arc representation
  const reduceMotion = useReducedMotion();
  const clampedScore = Math.max(0, Math.min(score, maxScore));
  const percentage = (clampedScore / maxScore) * 100;

  // Dimensions based on size
  const config = {
    sm: { dimension: 110, strokeWidth: 8, radius: 44, fontSize: 'text-2xl', labelSize: 'text-xs' },
    md: { dimension: 160, strokeWidth: 12, radius: 64, fontSize: 'text-4xl', labelSize: 'text-sm' },
    lg: { dimension: 200, strokeWidth: 14, radius: 82, fontSize: 'text-5xl', labelSize: 'text-base' },
  }[size];

  const circumference = 2 * Math.PI * config.radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  // Semantic color for gauge stroke using design tokens
  let strokeColor: string = tokens.colors.brandUi;
  if (percentage < 50) {
    strokeColor = tokens.colors.dangerUi;
  } else if (percentage < 75) {
    strokeColor = tokens.colors.warningUi;
  }

  return (
    <div
      role="progressbar"
      aria-valuenow={score}
      aria-valuemin={0}
      aria-valuemax={maxScore}
      aria-label={label}
      className={`flex flex-col items-center justify-center text-center ${className}`}
    >
      <div className="relative inline-flex items-center justify-center">
        <svg
          width={config.dimension}
          height={config.dimension}
          viewBox={`0 0 ${config.dimension} ${config.dimension}`}
          className="transform -rotate-90"
          aria-hidden="true"
        >
          {/* Background circle track */}
          <circle
            cx={config.dimension / 2}
            cy={config.dimension / 2}
            r={config.radius}
            fill="transparent"
            stroke="hsl(var(--muted))"
            strokeWidth={config.strokeWidth}
          />
          {/* Animated score arc (non-numeric visual animation only; the numeral never tweens) */}
          <motion.circle
            cx={config.dimension / 2}
            cy={config.dimension / 2}
            r={config.radius}
            fill="transparent"
            stroke={strokeColor}
            strokeWidth={config.strokeWidth}
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: reduceMotion ? strokeDashoffset : circumference }}
            animate={{ strokeDashoffset }}
            transition={{ duration: reduceMotion ? 0 : 1.1, ease: [0.16, 1, 0.3, 1] }}
            strokeLinecap="round"
            className="motion-reduce:transition-none"
          />
        </svg>

        {/* Score display: Renders verbatim API number immediately with NO tweening per S7 */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span
            className={`font-bold tracking-tight text-slate-950 dark:text-slate-50 ${config.fontSize}`}
            data-testid="score-numeral"
          >
            {score}
          </span>
          <span className="text-xs text-slate-500 font-medium">/{maxScore}</span>
        </div>
      </div>

      <div className="mt-3">
        <LabelTag className={`font-semibold text-slate-900 ${config.labelSize}`}>{label}</LabelTag>
        {statusBand && (
          <p className="text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-0.5 mt-1 inline-block">
            {statusBand}
          </p>
        )}
        {sublabel && <p className="text-xs text-slate-500 mt-1">{sublabel}</p>}
      </div>
    </div>
  );
}
