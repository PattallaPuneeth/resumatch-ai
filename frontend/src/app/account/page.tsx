'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/authContext';
import { apiClient, ApiProblemError } from '@/lib/apiClient';
import { UsagePanel } from '@/components/UsagePanel';
import { User, ShieldAlert, AlertCircle, Loader2, Calendar } from 'lucide-react';
import { formatDate } from '@/components/UsagePanel';

export default function AccountPage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Account Settings | ResuMatch AI';
  }, []);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/login?next=/account');
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || !isAuthenticated) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground font-medium">Verifying session...</span>
      </div>
    );
  }

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typedConfirmation.trim() !== 'DELETE') {
      setDeleteError('Please type DELETE to confirm.');
      return;
    }
    if (!password) {
      setDeleteError('Please enter your account password.');
      return;
    }

    setIsDeleting(true);
    setDeleteError(null);

    try {
      await apiClient.auth.deleteAccount({ password });
      await logout();
      router.push('/signup');
    } catch (err: unknown) {
      if (err instanceof ApiProblemError) {
        setDeleteError(err.detail);
      } else if (err instanceof Error) {
        setDeleteError(err.message);
      } else {
        setDeleteError('Failed to delete account. Please verify your password.');
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="container mx-auto px-4 sm:px-6 py-8 max-w-5xl space-y-8" data-testid="account-page">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Account Settings</h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
          Manage your account profile, plan allocation, and security settings.
        </p>
      </div>

      {/* Profile Details Card */}
      <div className="bg-card rounded-lg border border-border p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-3 pb-3 border-b border-border">
          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-primary">
            <User className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">{user?.username}</h2>
            <span className="text-xs text-muted-foreground">Candidate Account</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div className="p-3 bg-slate-50 rounded-md border border-border">
            <span className="text-muted-foreground block text-[11px]">Username</span>
            <span className="font-semibold text-foreground text-sm" data-testid="account-username">
              {user?.username}
            </span>
          </div>

          <div className="p-3 bg-slate-50 rounded-md border border-border">
            <span className="text-muted-foreground block text-[11px]">Member Since</span>
            <div className="flex items-center gap-1.5 font-semibold text-foreground text-sm">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{formatDate(user?.createdAt || null)}</span>
            </div>
          </div>
        </div>

        <div className="pt-2">
          <a
            href="#usage-summary"
            className="text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          >
            Jump to Usage & Quota Summary ↓
          </a>
        </div>
      </div>

      {/* Usage Panel (REQUIRED ON ACCOUNT PAGE) */}
      <div id="usage-summary">
        <UsagePanel />
      </div>

      {/* Danger Zone: Delete Account */}
      <div className="bg-red-50/50 rounded-lg border border-red-200 p-6 shadow-sm space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-md bg-red-100 text-destructive shrink-0">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-red-950">Danger Zone</h2>
            <p className="text-xs text-red-800 mt-0.5">
              Permanently delete your user account, credentials, uploaded resumes, object storage files, and audit records.
            </p>
          </div>
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => setShowDeleteModal(true)}
            data-testid="open-delete-account-modal"
            className="px-4 py-2 text-xs font-semibold rounded-md bg-destructive text-white hover:bg-red-700 transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            Delete Account
          </button>
        </div>
      </div>

      {/* Typed Confirmation Modal */}
      {showDeleteModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="bg-white rounded-lg border border-border shadow-xl max-w-md w-full p-6 space-y-4" data-testid="delete-account-modal">
            <div>
              <h3 id="delete-account-title" className="text-base font-bold text-foreground">
                Delete Account Confirmation
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                This action is permanent and immediate. All your stored files, parsing results, and usage history will be erased from PostgreSQL and object storage.
              </p>
            </div>

            {deleteError && (
              <div role="alert" className="p-2.5 rounded bg-red-50 border border-red-200 text-red-900 text-xs flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                <span>{deleteError}</span>
              </div>
            )}

            <form onSubmit={handleDeleteAccount} className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="confirm-typed" className="block text-xs font-semibold text-foreground">
                  Type <span className="font-mono text-red-700 bg-red-50 px-1 py-0.5 rounded border border-red-200">DELETE</span> to confirm:
                </label>
                <input
                  id="confirm-typed"
                  type="text"
                  required
                  value={typedConfirmation}
                  disabled={isDeleting}
                  onChange={(e) => setTypedConfirmation(e.target.value)}
                  placeholder="DELETE"
                  className="w-full px-3 py-2 text-xs rounded-md border border-input bg-white text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="confirm-password" className="block text-xs font-semibold text-foreground">
                  Confirm Password:
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  required
                  value={password}
                  disabled={isDeleting}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full px-3 py-2 text-xs rounded-md border border-input bg-white text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowDeleteModal(false);
                    setDeleteError(null);
                    setTypedConfirmation('');
                    setPassword('');
                  }}
                  disabled={isDeleting}
                  className="px-3.5 py-1.5 rounded-md text-xs font-semibold text-foreground hover:bg-slate-100 transition-colors border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isDeleting || typedConfirmation.trim() !== 'DELETE' || !password}
                  data-testid="confirm-delete-account-button"
                  className="px-3.5 py-1.5 rounded-md text-xs font-semibold bg-destructive text-white hover:bg-red-700 transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-50"
                >
                  {isDeleting ? 'Deleting Account...' : 'Permanently Delete'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
