'use client';

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  description: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  className = '',
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={`p-6 rounded-xl border border-red-200 bg-red-50/50 text-center flex flex-col items-center justify-center space-y-3 ${className}`}
    >
      <div className="w-10 h-10 rounded-full bg-red-100 text-red-600 flex items-center justify-center">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="space-y-1 max-w-sm">
        <h4 className="text-sm font-bold text-red-900">{title}</h4>
        <p className="text-xs text-red-800 leading-relaxed">{description}</p>
      </div>
      {onRetry && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onRetry}
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          className="border-red-300 text-red-900 hover:bg-red-100 mt-2"
        >
          Try Again
        </Button>
      )}
    </div>
  );
}
