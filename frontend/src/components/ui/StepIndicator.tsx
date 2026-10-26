'use client';

import React from 'react';

export interface Step {
  id: string;
  name: string;
  description?: string;
  status: 'complete' | 'current' | 'upcoming';
}

interface StepIndicatorProps {
  steps: Step[];
  className?: string;
}

export function StepIndicator({ steps, className = '' }: StepIndicatorProps) {
  return (
    <nav aria-label="Progress" className={`w-full ${className}`}>
      <ol className="flex items-center justify-between w-full">
        {steps.map((step, idx) => {
          const isComplete = step.status === 'complete';
          const isCurrent = step.status === 'current';

          return (
            <li key={step.id} className="relative flex-1 flex flex-col items-center text-center">
              {/* Connecting line */}
              {idx !== 0 && (
                <div
                  className={`absolute top-4 -left-1/2 w-full h-0.5 -z-10 transition-colors duration-300 ${
                    isComplete || isCurrent ? 'bg-emerald-600' : 'bg-slate-200'
                  }`}
                  aria-hidden="true"
                />
              )}

              {/* Step circle indicator */}
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-all duration-300 ${
                  isComplete
                    ? 'bg-emerald-700 border-emerald-700 text-white'
                    : isCurrent
                    ? 'bg-white border-emerald-600 text-emerald-800 ring-4 ring-emerald-100'
                    : 'bg-white border-slate-300 text-slate-500'
                }`}
                aria-current={isCurrent ? 'step' : undefined}
              >
                {isComplete ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>

              {/* Step label */}
              <span
                className={`mt-2 text-xs font-medium tracking-tight ${
                  isCurrent ? 'text-emerald-900 font-bold' : isComplete ? 'text-slate-900' : 'text-slate-500'
                }`}
              >
                {step.name}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
