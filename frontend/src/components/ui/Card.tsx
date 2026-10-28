'use client';

import React from 'react';

export function Card({
  children,
  className = '',
  as: Component = 'div',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { as?: any }) {
  return (
    <Component
      className={`bg-card rounded-xl border border-border shadow-[0_1px_2px_rgba(28,25,23,0.04)] overflow-hidden transition-shadow duration-200 hover:shadow-[0_4px_16px_-6px_rgba(28,25,23,0.12)] ${className}`}
      {...props}
    >
      {children}
    </Component>
  );
}

export function CardHeader({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`p-6 border-b border-border/60 ${className}`} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  className = '',
  as: Component = 'h3',
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: any }) {
  return (
    <Component className={`text-lg font-bold tracking-tight text-slate-900 ${className}`} {...props}>
      {children}
    </Component>
  );
}

export function CardDescription({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={`text-xs text-slate-600 mt-1 leading-relaxed ${className}`} {...props}>
      {children}
    </p>
  );
}

export function CardContent({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`p-6 ${className}`} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`p-6 pt-0 flex items-center justify-between gap-4 ${className}`} {...props}>
      {children}
    </div>
  );
}
