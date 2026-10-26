'use client';

import React from 'react';

export interface ProgressBarProps {
  value: number;
  max?: number;
  label?: string;
  className?: string;
  variant?: 'brand' | 'warning' | 'danger';
}

export function ProgressBar({
  value,
  max = 100,
  label,
  className = '',
  variant = 'brand',
}: ProgressBarProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));

  const variants = {
    brand: 'bg-primary',
    warning: 'bg-amber-600',
    danger: 'bg-red-600',
  };

  return (
    <div className={`w-full space-y-1.5 ${className}`}>
      {label && (
        <div className="flex justify-between text-xs font-medium text-slate-700">
          <span>{label}</span>
          <span>{Math.round(percentage)}%</span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label || 'Progress'}
        className="w-full h-2 rounded-full bg-slate-100 overflow-hidden"
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out motion-reduce:transition-none ${variants[variant]}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
