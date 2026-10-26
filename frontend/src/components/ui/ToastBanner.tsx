'use client';

import React from 'react';
import { AlertCircle, CheckCircle2, Info, AlertTriangle, X } from 'lucide-react';

export interface ToastBannerProps {
  type?: 'success' | 'warning' | 'error' | 'info';
  title?: string;
  message: string;
  onDismiss?: () => void;
  className?: string;
}

export function ToastBanner({
  type = 'info',
  title,
  message,
  onDismiss,
  className = '',
}: ToastBannerProps) {
  const configs = {
    success: {
      bg: 'bg-emerald-50 border-emerald-200 text-emerald-900',
      icon: <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />,
    },
    warning: {
      bg: 'bg-amber-50 border-amber-200 text-amber-900',
      icon: <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />,
    },
    error: {
      bg: 'bg-red-50 border-red-200 text-red-900',
      icon: <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />,
    },
    info: {
      bg: 'bg-blue-50 border-blue-200 text-blue-900',
      icon: <Info className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />,
    },
  }[type];

  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={`p-4 rounded-lg border shadow-xs flex items-start gap-3 text-xs leading-relaxed animate-in fade-in slide-in-from-top-2 duration-200 ${configs.bg} ${className}`}
    >
      {configs.icon}
      <div className="flex-1 space-y-0.5">
        {title && <p className="font-semibold text-sm">{title}</p>}
        <p>{message}</p>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss banner"
          className="p-1 rounded hover:bg-black/5 text-current opacity-70 hover:opacity-100 transition-opacity min-h-[32px] min-w-[32px] flex items-center justify-center"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
