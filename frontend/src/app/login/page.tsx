'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/authContext';
import { sanitizeNextRedirect } from '@/lib/authUtils';
import { ApiProblemError } from '@/lib/apiClient';
import { LogIn, AlertCircle, Clock, Loader2 } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, isAuthenticated, isLoading: isAuthLoading } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null);

  const nextPath = sanitizeNextRedirect(searchParams.get('next'), '/dashboard');

  // If already authenticated, redirect to destination
  useEffect(() => {
    if (!isAuthLoading && isAuthenticated) {
      router.replace(nextPath);
    }
  }, [isAuthenticated, isAuthLoading, router, nextPath]);

  // Lockout countdown timer
  useEffect(() => {
    if (lockoutSeconds === null || lockoutSeconds <= 0) return;
    const interval = setInterval(() => {
      setLockoutSeconds((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [lockoutSeconds]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setErrorMessage('Please enter both your username and password.');
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      await login({ username: username.trim(), password });
      router.push(nextPath);
    } catch (err: unknown) {
      if (err instanceof ApiProblemError) {
        if (err.status === 429) {
          const retryAfter = err.retryAfter ?? 60;
          setLockoutSeconds(retryAfter);
          setErrorMessage(err.detail || `Account temporarily locked due to multiple failed login attempts. Retry in ${retryAfter} seconds.`);
        } else {
          setErrorMessage(err.detail || 'Invalid username or password.');
        }
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to sign in. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md bg-card rounded-xl border border-border p-8 shadow-sm space-y-6">
        <div className="text-center space-y-1.5">
          <div className="w-10 h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg mx-auto mb-2 shadow-sm">
            R
          </div>
          <h1 className="text-xl font-bold text-foreground">Sign in to ResuMatch AI</h1>
          <p className="text-xs text-muted-foreground">
            Enter your credentials to access your resumes, ATS analyses, and usage limits.
          </p>
        </div>

        {/* Lockout / Rate Limit Banner */}
        {lockoutSeconds !== null && lockoutSeconds > 0 && (
          <div
            role="alert"
            data-testid="lockout-banner"
            className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-950 flex items-start gap-2.5 text-xs"
          >
            <Clock className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold block">Account Temporarily Locked</span>
              <span>
                Multiple failed login attempts detected. Please retry in{' '}
                <strong className="font-bold">{lockoutSeconds} seconds</strong>.
              </span>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {errorMessage && lockoutSeconds === null && (
          <div
            role="alert"
            data-testid="login-error-alert"
            className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-900 flex items-start gap-2.5 text-xs"
          >
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="username" className="block text-xs font-semibold text-foreground">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              required
              value={username}
              disabled={isSubmitting || (lockoutSeconds !== null && lockoutSeconds > 0)}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. candidate_jane"
              className="w-full px-3 py-2 text-sm rounded-md border border-input bg-white text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:opacity-50"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-xs font-semibold text-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={isSubmitting || (lockoutSeconds !== null && lockoutSeconds > 0)}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full px-3 py-2 text-sm rounded-md border border-input bg-white text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting || (lockoutSeconds !== null && lockoutSeconds > 0)}
            data-testid="login-submit-button"
            className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-md bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary-hover transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <LogIn className="h-4 w-4" />
                <span>Sign in</span>
              </>
            )}
          </button>
        </form>

        <div className="text-center pt-2 border-t border-border">
          <p className="text-xs text-muted-foreground">
            Don&apos;t have an account?{' '}
            <Link
              href={`/signup${nextPath !== '/dashboard' ? `?next=${encodeURIComponent(nextPath)}` : ''}`}
              className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
            >
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>}>
      <LoginForm />
    </Suspense>
  );
}
