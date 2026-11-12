'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/authContext';
import { UsagePanel } from '@/components/UsagePanel';
import { ResumeUpload } from '@/components/ResumeUpload';
import { ResumeList } from '@/components/ResumeList';
import { Loader2 } from 'lucide-react';

export default function DashboardPage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/login?next=/dashboard');
    }
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    document.title = 'Dashboard | ResuMatch AI';
  }, []);

  if (isLoading || !isAuthenticated) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground font-medium">Verifying session...</span>
      </div>
    );
  }

  const handleUploadSuccess = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['resumes'] }),
      queryClient.invalidateQueries({ queryKey: ['usage'] }),
    ]);
  };

  const handleDeleteSuccess = async () => {
    await queryClient.invalidateQueries({ queryKey: ['usage'] });
  };

  return (
    <div className="container mx-auto px-4 sm:px-6 py-8 max-w-7xl space-y-10 animate-in fade-in duration-300" data-testid="dashboard-page">
      {/* Welcome Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-slate-950">
            Welcome back, <span className="text-primary">{user?.username}</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-1">
            Upload resumes, get improvement tips, and keep an eye on your monthly usage.
          </p>
        </div>
      </div>

      {/* Usage Panel (REQUIRED ON DASHBOARD) */}
      <UsagePanel />

      {/* Upload Dropzone */}
      <section aria-label="Resume upload section">
        <ResumeUpload onUploadSuccess={handleUploadSuccess} />
      </section>

      {/* Resume Management List */}
      <section aria-label="Uploaded resumes repository">
        <ResumeList onDeleteSuccess={handleDeleteSuccess} />
      </section>
    </div>
  );
}
