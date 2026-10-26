'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/authContext';
import { sanitizeNextRedirect, validateUsername, validatePassword } from '@/lib/authUtils';
import { ApiProblemError } from '@/lib/apiClient';
import { UserPlus, AlertCircle, CheckCircle, Copy, Check, ArrowRight, Loader2 } from 'lucide-react';

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { register, isAuthenticated, isLoading: isAuthLoading } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copiedCodes, setCopiedCodes] = useState(false);

  const nextPath = sanitizeNextRedirect(searchParams.get('next'), '/dashboard');

  useEffect(() => {
    if (!isAuthLoading && isAuthenticated && !recoveryCodes) {
      router.replace(nextPath);
    }
  }, [isAuthenticated, isAuthLoading, router, nextPath, recoveryCodes]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const userCheck = validateUsername(username);
    if (!userCheck.valid) {
      setErrorMessage(userCheck.error || 'Invalid username.');
      return;
    }

    const passCheck = validatePassword(password, username);
    if (!passCheck.valid) {
      setErrorMessage(passCheck.error || 'Invalid password.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await register({ username: username.trim(), password });
      if (res.recoveryCodes && res.recoveryCodes.length > 0) {
        setRecoveryCodes(res.recoveryCodes);
      } else {
        router.push(nextPath);
      }
    } catch (err: unknown) {
      if (err instanceof ApiProblemError) {
        setErrorMessage(err.detail);
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to create account. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyCodes = () => {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join('\n'));
    setCopiedCodes(true);
    setTimeout(() => setCopiedCodes(false), 3000);
  };

  if (recoveryCodes) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-lg bg-card rounded-xl border border-border p-8 shadow-sm space-y-6" data-testid="recovery-codes-view">
          <div className="text-center space-y-1.5">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-xl mx-auto mb-2">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground">Save Your Recovery Codes</h1>
            <p className="text-xs text-muted-foreground">
              These 10 one-time recovery codes are your only way to regain access if you forget your password. Each code can only be used once. Store them securely.
            </p>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 font-mono text-xs text-slate-800 grid grid-cols-2 gap-2">
            {recoveryCodes.map((code, idx) => (
              <div key={idx} className="p-1.5 bg-white border border-slate-200 rounded text-center tracking-wider">
                {code}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleCopyCodes}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-md border border-border bg-white hover:bg-slate-50 text-foreground text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {copiedCodes ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
              <span>{copiedCodes ? 'Copied to Clipboard!' : 'Copy All Codes'}</span>
            </button>

            <button
              type="button"
              onClick={() => router.push(nextPath)}
              data-testid="proceed-to-dashboard-button"
              className="flex-1 flex items-center justify-center gap-1.5 py-2 px-4 rounded-md bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary-hover transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span>Continue to Dashboard</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md bg-card rounded-xl border border-border p-8 shadow-sm space-y-6">
        <div className="text-center space-y-1.5">
          <div className="w-10 h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg mx-auto mb-2 shadow-sm">
            R
          </div>
          <h1 className="text-xl font-bold text-foreground">Create an Account</h1>
          <p className="text-xs text-muted-foreground">
            Get started with AI-powered resume analysis, ATS verification, and usage limits.
          </p>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div
            role="alert"
            data-testid="signup-error-alert"
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
              disabled={isSubmitting}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. candidate_jane"
              className="w-full px-3 py-2 text-sm rounded-md border border-input bg-white text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:opacity-50"
            />
            <p className="text-[11px] text-muted-foreground">
              3 to 32 characters (letters, numbers, hyphens, underscores).
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-xs font-semibold text-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              disabled={isSubmitting}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full px-3 py-2 text-sm rounded-md border border-input bg-white text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:opacity-50"
            />
            <div className="text-[11px] text-muted-foreground space-y-0.5 pt-1">
              <p>• Minimum 12 characters (maximum 128)</p>
              <p>• Must not contain your username</p>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            data-testid="signup-submit-button"
            className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-md bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary-hover transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Creating account...</span>
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4" />
                <span>Create account</span>
              </>
            )}
          </button>
        </form>

        <div className="text-center pt-2 border-t border-border">
          <p className="text-xs text-muted-foreground">
            Already have an account?{' '}
            <Link
              href={`/login${nextPath !== '/dashboard' ? `?next=${encodeURIComponent(nextPath)}` : ''}`}
              className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading...</div>}>
      <SignupForm />
    </Suspense>
  );
}
