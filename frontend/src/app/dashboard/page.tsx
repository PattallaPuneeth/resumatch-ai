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

  if (isLoading || !isAuthenticated) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground font-medium">Verifying session...</span>
      </div>
    );
  }

  const handleUploadSuccess = async () => {
    // Invalidate both resumes and usage meters so the entire dashboard stays up-to-date
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['resumes'] }),
      queryClient.invalidateQueries({ queryKey: ['usage'] }),
    ]);
  };

  const handleDeleteSuccess = async () => {
    await queryClient.invalidateQueries({ queryKey: ['usage'] });
  };

  return (
    <div className="container mx-auto px-4 sm:px-6 py-8 max-w-7xl space-y-8" data-testid="dashboard-page">
      {/* Welcome Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Welcome back, <span className="text-primary">{user?.username}</span>
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Manage your resumes, track object storage consumption, and monitor quota limits.
          </p>
        </div>
      </div>

      {/* Usage Panel (REQUIRED ON DASHBOARD) */}
      <UsagePanel />

      {/* Upload and Resumes Section */}
      <div className="space-y-8">
        <ResumeUpload onUploadSuccess={handleUploadSuccess} />
        <ResumeList onDeleteSuccess={handleDeleteSuccess} />
      </div>
    </div>
  );
}
